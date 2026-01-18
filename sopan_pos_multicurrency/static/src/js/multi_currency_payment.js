/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { _t } from "@web/core/l10n/translation";

function resolveCurrency(env, currencyOrId) {
    if (!currencyOrId) return null;
    // Handle m2o values that can arrive as [id, display_name]
    if (Array.isArray(currencyOrId) && currencyOrId.length) {
        return resolveCurrency(pos, currencyOrId[0]);
    }
    // Handle already-resolved record objects
    if (typeof currencyOrId === "object") {
        // If it looks like a record with an id, keep it.
        if (currencyOrId.id) return currencyOrId;
        // Otherwise (e.g. plain object), try common shapes.
        if (currencyOrId[0]) return resolveCurrency(pos, currencyOrId[0]);
        return null;
    }
    const models = env?.models || env;
    return models?.["res.currency"]?.get?.(currencyOrId) || null;
}

function getPaymentCurrency(env, paymentMethod) {
    const cur = paymentMethod?.currency_of_cash_control;
    return resolveCurrency(env, cur);
}

patch(PosOrder.prototype, {
    addPaymentline(payment_method) {
        this.assertEditable();
        
        // Override base validation to allow multiple cash payment lines with different currencies
        // Check if payment method is cash (using is_cash_count like base Odoo)
        const existingCash = this.payment_ids.find((pl) => pl.payment_method_id.is_cash_count);
        
        if (this.electronicPaymentInProgress()) {
            return {
                status: false,
                data: _t("There is already an electronic payment in progress."),
            };
        }
        
        // REMOVED: Base validation that blocks multiple cash payment lines
        // Allow multiple cash payment lines for multi-currency support
        // The validation is completely removed to allow any number of cash payment lines
        // Users can configure different currencies in payment methods to distinguish them
        
        // Create the payment line (same as base Odoo logic)
        const totalAmountDue = this.getDefaultAmountDueToPayIn(payment_method);
        const newPaymentLine = this.models["pos.payment"].create({
            pos_order_id: this,
            payment_method_id: payment_method,
        });
        this.selectPaymentline(newPaymentLine);
        newPaymentLine.setAmount(totalAmountDue);

        if (
            (payment_method.payment_terminal && !this.isRefund) ||
            payment_method.payment_method_type === "qr_code"
        ) {
            newPaymentLine.setPaymentStatus("pending");
        }

        // Update currency fields if foreign currency.
        // IMPORTANT (Odoo 19): PosOrder doesn't have `this.pos` nor `session.pos`.
        // Always resolve currencies through the model store `this.models`.
        const payCurrency = getPaymentCurrency(this.models, payment_method);
        if (payCurrency && this.currency?.id && payCurrency.id !== this.currency.id) {
                // In this dynamic module:
                // - payCurrency.rate = foreign per 1 base currency unit (e.g., IQD≈1300, EUR≈0.9)
                // Base -> Foreign: foreign = base * rate
                const rate = payCurrency.rate || 1;
                const foreignAmount = (newPaymentLine.amount || 0) * rate;
                newPaymentLine.update({
                    payment_currency_id: payCurrency,
                    payment_currency_rate: rate,
                    currency_amount_total: foreignAmount,
                });
        }
        
        return { status: true, data: newPaymentLine };
    },
    
    add_paymentline(payment_method) {
        // This method is called after addPaymentline, update currency fields here
        const line = super.add_paymentline(...arguments);
        if (!line) return line;

        const payCurrency = getPaymentCurrency(this.models, payment_method);
        if (payCurrency && this.currency?.id && payCurrency.id !== this.currency.id) {
            const rate = payCurrency.rate || 1;
            // Store display/reference amounts in foreign currency while keeping `amount` in base currency.
            // Convert base currency to foreign: foreign = base * rate
            const foreignAmount = (line.amount || 0) * rate;
            line.update({
                payment_currency_id: payCurrency,
                payment_currency_rate: rate,
                currency_amount_total: foreignAmount,
            });
        } else {
            line.update({
                payment_currency_id: false,
                payment_currency_rate: 0,
                currency_amount_total: 0,
            });
        }
        return line;
    },
});

patch(PaymentScreen.prototype, {
    // Removed addNewPaymentLine override - let Odoo handle payment method selection normally
    // No popup will be shown when payment method is selected

    async addNewPaymentLine(paymentMethod) {
        const result = await super.addNewPaymentLine(...arguments);
        if (result && result.status && result.data) {
            // After creating a payment line, initialize number buffer with the correct currency amount
            // Use setTimeout to ensure payment line is fully initialized
            setTimeout(() => {
                this._syncNumberBufferWithPaymentLine();
            }, 10);
        }
        return result;
    },

    selectPaymentLine(uuid) {
        const line = this.paymentLines.find((line) => line.uuid === uuid);
        this.currentOrder.selectPaymentline(line);
        // Don't reset the buffer - sync it with the payment line's currency amount instead
        this._syncNumberBufferWithPaymentLine();
    },

    _syncNumberBufferWithPaymentLine() {
        // Sync number buffer with the selected payment line's currency amount
        const paymentLine = this.currentOrder.getSelectedPaymentline();
        if (!paymentLine) {
            return;
        }

        const pm = paymentLine.payment_method_id;
        const payCurrency = getPaymentCurrency(this.pos, pm);
        const isForeign = payCurrency && this.pos.currency?.id && payCurrency.id !== this.pos.currency.id;
        
        // Use setTimeout to ensure this runs after Odoo's reset
        setTimeout(() => {
            if (isForeign) {
                // For foreign currency, use currency_amount_total if available, otherwise calculate from base amount
                if (paymentLine.currency_amount_total && paymentLine.currency_amount_total > 0) {
                    this.numberBuffer.set(paymentLine.currency_amount_total.toString());
                } else if (paymentLine.amount && paymentLine.amount > 0) {
                    // Calculate foreign amount from base amount
                    const rate = payCurrency.rate || 1;
                    const foreignAmount = paymentLine.amount * rate;
                    this.numberBuffer.set(foreignAmount.toString());
                } else {
                    this.numberBuffer.reset();
                }
            } else {
                // For base currency, use the base amount
                if (paymentLine.amount && paymentLine.amount > 0) {
                    this.numberBuffer.set(paymentLine.amount.toString());
                } else {
                    this.numberBuffer.reset();
                }
            }
        }, 0);
    },

    updateSelectedPaymentline(amount = false) {
        if (this.paymentLines.every((line) => line.paid)) {
            this.currentOrder.add_paymentline(this.payment_methods_from_config[0]);
        }
        if (!this.selectedPaymentLine) {
            return;
        }

        // Foreign currency handling: cashier types the amount in the payment currency.
        const pm = this.selectedPaymentLine.payment_method_id;
        const payCurrency = getPaymentCurrency(this.pos, pm);
        const isForeign =
            payCurrency && this.pos.currency?.id && payCurrency.id !== this.pos.currency.id;
        
        const rate = isForeign ? payCurrency.rate || 1 : 1;

        if (amount === false) {
            if (this.numberBuffer.get() === null) {
                amount = null;
            } else if (this.numberBuffer.get() === "") {
                amount = 0;
            } else {
                amount = this.numberBuffer.getFloat();
            }
            
            // For foreign currency payment lines:
            // - When increment buttons (+10, +20, +50) are clicked, NumberBuffer adds the increment
            //   directly to the buffer. The buffer is already in foreign currency, so adding 10
            //   means adding 10 foreign currency units (e.g., 10 EUR), not 10 base currency units.
            // - When user types manually, they type in foreign currency.
            // - The buffer should ALWAYS be in foreign currency for foreign payment lines.
            // - We should NOT convert the buffer value - it's already in foreign currency.
            // - Only convert to base currency when setting the payment line amount.
            
            // The buffer is already in foreign currency, so we use it directly
            // No conversion needed here - the conversion happens later when we calculate amountBase
        }

        const payment_terminal = this.selectedPaymentLine.payment_method_id.payment_terminal;
        const hasCashPaymentMethod = this.payment_methods_from_config.some((method) => method.type === "cash");

        // Convert foreign currency amount to base currency
        // With `rate` = foreign per 1 base: base = foreign / rate
        const amountBase = amount === null ? null : (isForeign ? (amount / rate) : amount);

        if (
            !hasCashPaymentMethod &&
            amountBase !== null &&
            amountBase > this.currentOrder.remainingDue + this.selectedPaymentLine.amount
        ) {
            this.selectedPaymentLine.setAmount(0);
            this.numberBuffer.set(this.currentOrder.remainingDue.toString());
            amount = this.currentOrder.remainingDue;
            return this.showMaxValueError();
        }
        if (
            payment_terminal &&
            !["pending", "retry"].includes(this.selectedPaymentLine.getPaymentStatus())
        ) {
            return;
        }

        if (amountBase === null) {
            this.deletePaymentLine(this.selectedPaymentLine.uuid);
            return;
        }

        this.selectedPaymentLine.setAmount(amountBase);
        if (isForeign) {
            this.selectedPaymentLine.update({
                payment_currency_id: payCurrency,
                payment_currency_rate: rate,
                currency_amount_total: amount, // amount is already in foreign currency from number buffer
            });
            // CRITICAL: Don't reset the buffer during typing - let it accumulate digits naturally
            // The number buffer automatically accumulates digits (e.g., "3" -> "30" -> "300")
            // We should NOT call numberBuffer.set() here as it interrupts the natural accumulation
            // Only sync the buffer if it's empty/null (initial state) or if we're setting from external source
            // During normal typing, the buffer should be left alone to accumulate digits
        } else {
            this.selectedPaymentLine.update({
                payment_currency_id: false,
                payment_currency_rate: 0,
                currency_amount_total: 0,
            });
        }
    },

    getNumpadButtons() {
        // Get default enhanced buttons from parent
        const defaultButtons = super.getNumpadButtons();
        
        // Check if we have a selected payment line
        if (!this.selectedPaymentLine) {
            return defaultButtons;
        }

        const pm = this.selectedPaymentLine.payment_method_id;
        const payCurrency = getPaymentCurrency(this.pos, pm);
        const isForeign = payCurrency && this.pos.currency?.id && payCurrency.id !== this.pos.currency.id;
        
        // For foreign currency payment lines, we need to patch the number buffer's _updateBuffer method
        // to ensure increments are added in foreign currency, not base currency
        if (isForeign && this.numberBuffer) {
            // Store reference to this payment screen and currency info for increment handling
            this.numberBuffer._paymentScreen = this;
            this.numberBuffer._isForeignCurrency = true;
            this.numberBuffer._foreignCurrency = payCurrency;
            this.numberBuffer._baseCurrency = this.pos.currency;
        } else if (this.numberBuffer) {
            // Clear foreign currency flags for base currency payment lines
            this.numberBuffer._isForeignCurrency = false;
            this.numberBuffer._foreignCurrency = null;
            this.numberBuffer._baseCurrency = null;
        }
        
        // Base currency increment factor feature removed.
        
        // Return default buttons for foreign currency or if factor is 100
        return defaultButtons;
    },
});
