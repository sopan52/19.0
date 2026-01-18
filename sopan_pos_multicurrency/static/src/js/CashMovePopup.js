/** @odoo-module */

import { CashMovePopup } from "@point_of_sale/app/components/popups/cash_move_popup/cash_move_popup";
import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
import { useRef } from "@odoo/owl";
import { parseFloat } from "@web/views/fields/parsers";
import { CashMoveReceipt } from "@point_of_sale/app/components/popups/cash_move_popup/cash_move_receipt/cash_move_receipt";

function resolveCurrency(pos, currencyOrId) {
    if (!currencyOrId) return null;
    if (typeof currencyOrId === "object") return currencyOrId;
    return pos?.models?.["res.currency"]?.get?.(currencyOrId) || null;
}

patch(CashMovePopup.prototype, {
    setup() {
        super.setup();
        this.oc_select = useRef("oc_select");
        this.onSelectChange = this.onSelectChange.bind(this);
        this.other_currency = "";
        
        // Initialize payment method selection
        const cashMethods = (this.pos.config.payment_method_ids || []).filter((pm) => pm.type === "cash");
        if (cashMethods.length > 0 && !this.state.payment_method_id) {
            this.state.payment_method_id = cashMethods[0]?.id || null;
        }
        
        // Initialize currency selection
        if (this.showCurrencySelection) {
            const defaultMethod = cashMethods[0];
            if (defaultMethod && defaultMethod.currency_of_cash_control) {
                this.state.selected_currency_id = defaultMethod.currency_of_cash_control.id || this.pos.currency.id;
            } else {
                this.state.selected_currency_id = this.pos.currency.id;
            }
        }
    },

    get showCurrencySelection() {
        // Dynamic module: allow cashier to choose the currency for cash in/out.
        // This drives `foreign_currency_id` + `amount_currency` so closing dialog can group moves correctly.
        return true;
    },

    get availableCurrencies() {
        const currencies = [];
        const baseCurrency = this.pos.currency;
        if (baseCurrency) {
            currencies.push(baseCurrency);
        }
        
        // Add currencies from payment methods
        const cashMethods = (this.pos.config.payment_method_ids || []).filter((pm) => pm.type === "cash");
        const currencyIds = new Set();
        if (baseCurrency) currencyIds.add(baseCurrency.id);
        
        for (const pm of cashMethods) {
            if (pm.currency_of_cash_control) {
                const curId = typeof pm.currency_of_cash_control === "object" 
                    ? pm.currency_of_cash_control.id 
                    : pm.currency_of_cash_control;
                if (curId && !currencyIds.has(curId)) {
                    const currency = resolveCurrency(this.pos, curId);
                    if (currency) {
                        currencies.push(currency);
                        currencyIds.add(curId);
                    }
                }
            }
        }
        
        return currencies;
    },

    get selectedCurrency() {
        if (this.showCurrencySelection && this.state.selected_currency_id) {
            return resolveCurrency(this.pos, this.state.selected_currency_id);
        }
        if (this.state.payment_method_id) {
            const cashMethods = (this.pos.config.payment_method_ids || []).filter((pm) => pm.type === "cash");
            const selectedMethod = cashMethods.find(pm => pm.id === this.state.payment_method_id);
            if (selectedMethod && selectedMethod.currency_of_cash_control) {
                return resolveCurrency(this.pos, selectedMethod.currency_of_cash_control);
            }
        }
        return this.pos.currency;
    },

    onSelectChange() {
        if (this.oc_select.el) {
            const selectedValue = this.oc_select.el.value;
            // Convert to integer if it's a number string
            const currencyId = parseInt(selectedValue, 10) || selectedValue;
            // Update state reactively to trigger template re-render
            this.state.selected_currency_id = currencyId;
            
            // Get currency name for display
            const currency = resolveCurrency(this.pos, currencyId);
            this.other_currency = currency?.name || selectedValue;
        }
    },

    onPaymentMethodChange(ev) {
        const methodId = parseInt(ev.target.value);
        const cashMethods = (this.pos.config.payment_method_ids || []).filter((pm) => pm.type === "cash");
        const selectedMethod = cashMethods.find(pm => pm.id === methodId);
        
        if (!this.showCurrencySelection && selectedMethod && selectedMethod.currency_of_cash_control) {
            const curId = typeof selectedMethod.currency_of_cash_control === "object"
                ? selectedMethod.currency_of_cash_control.id
                : selectedMethod.currency_of_cash_control;
            this.state.selected_currency_id = curId || this.pos.currency.id;
        }
    },   

    async confirm() {
        let amount = parseFloat(this.state.amount);
        if (!amount) {
            this.notification.add(_t("Cash in/out of %s is ignored.", this.env.utils.formatCurrency(amount)));
            return this.props.close();
        }

        const type = this.state.type;
        const translatedType = _t(type);
        const reason = this.state.reason.trim();

        // Determine currency
        let currencyId = null;
        let amountCurrency = amount;
        let oc_name = '';

        if (this.showCurrencySelection && this.state.selected_currency_id) {
            // Ensure currencyId is a number (ID), not a string name
            let selectedId = this.state.selected_currency_id;
            if (typeof selectedId === 'string' && isNaN(selectedId)) {
                // If it's a currency name string, find the currency by name
                const currency = this.pos.currencies.find(c => c.name === selectedId);
                currencyId = currency ? currency.id : null;
            } else {
                // It's already an ID (number or numeric string)
                currencyId = typeof selectedId === 'number' ? selectedId : parseInt(selectedId, 10);
            }
            const currency = resolveCurrency(this.pos, currencyId);
            oc_name = currency?.name || this.other_currency || this.pos.currency.name;
        } else if (this.state.payment_method_id) {
            const cashMethods = (this.pos.config.payment_method_ids || []).filter((pm) => pm.type === "cash");
            const selectedMethod = cashMethods.find(pm => pm.id === this.state.payment_method_id);
            if (selectedMethod && selectedMethod.currency_of_cash_control) {
                currencyId = typeof selectedMethod.currency_of_cash_control === "object"
                    ? selectedMethod.currency_of_cash_control.id
                    : selectedMethod.currency_of_cash_control;
                const currency = resolveCurrency(this.pos, currencyId);
                oc_name = currency?.name || '';
            }
        }

        // Convert amount if currency is different from base
        const selectedCurrency = resolveCurrency(this.pos, currencyId);
        const baseCurrency = this.pos.currency;
        let amountBase = amount;

        if (selectedCurrency && baseCurrency && selectedCurrency.id !== baseCurrency.id) {
            // IMPORTANT: The backend will use amount_currency directly, so we MUST send the correct foreign amount
            // The amountBase is only used for accounting, but amount_currency is what gets displayed
            amountCurrency = amount; // Keep original foreign currency amount (e.g., 10 EUR)
            
            // Convert foreign currency to base currency for accounting purposes
            let rate = selectedCurrency.rate;
            let inverseRate = selectedCurrency.inverse_rate;
            
            console.log(`🔵 Currency conversion: ${selectedCurrency.name} -> ${baseCurrency.name}`);
            console.log(`🔵   rate=${rate}, inverse_rate=${inverseRate}, amount=${amount}`);
            console.log(`🔵   selectedCurrency object:`, selectedCurrency);
            
            // Dynamic module semantics:
            // - rate         = foreign per 1 base
            // - inverse_rate = base per 1 foreign
            // Convert foreign -> base: base = foreign / rate, fallback base = foreign * inverse_rate
            if (rate && rate > 0) {
                amountBase = amount / rate;
                console.log(`✅ Conversion (rate): ${amount} ${selectedCurrency.name} / ${rate} = ${amountBase} ${baseCurrency.name}`);
            } else if (inverseRate && inverseRate > 0) {
                amountBase = amount * inverseRate;
                console.log(`✅ Conversion (inverse_rate): ${amount} ${selectedCurrency.name} * ${inverseRate} = ${amountBase} ${baseCurrency.name}`);
            } else {
                // Fallback: try to get rate from pos.currencies
                const posCurrency = this.pos.currencies?.find(c => c.id === selectedCurrency.id);
                const posRate = posCurrency?.rate;
                const posInv = posCurrency?.inverse_rate;
                if (posRate && posRate > 0) {
                    amountBase = amount / posRate;
                } else if (posInv && posInv > 0) {
                    amountBase = amount * posInv;
                } else {
                    amountBase = amount;
                }
            }
        } else {
            amountCurrency = amount;
        }

        const formattedAmount = this.env.utils.formatCurrency(amountBase);
        const extras = { formattedAmount, translatedType, oc_name };

        // Find the correct payment method based on selected currency
        let targetPaymentMethodId = this.state.payment_method_id;
        
        // If currency is selected and it's different from base currency, find payment method with matching currency
        if (currencyId && currencyId !== this.pos.currency?.id) {
            const cashMethods = (this.pos.config.payment_method_ids || []).filter((pm) => pm.type === "cash");
            const matchingMethod = cashMethods.find(pm => {
                if (!pm.currency_of_cash_control) return false;
                const pmCurrencyId = typeof pm.currency_of_cash_control === "object"
                    ? pm.currency_of_cash_control.id
                    : pm.currency_of_cash_control;
                return pmCurrencyId === currencyId && pm.journal_id;
            });
            
            if (matchingMethod) {
                targetPaymentMethodId = matchingMethod.id;
            } else {
                // If no matching payment method found, log warning but continue
                console.warn(`⚠️ No payment method found with currency_of_cash_control=${currencyId}. Using selected payment method.`);
            }
        }

        // Prepare kwargs for foreign currency
        const kwargs = {};
        const baseCurrencyId = this.pos.currency?.id;
        if (currencyId && currencyId !== baseCurrencyId) {
            kwargs.foreign_currency_id = currencyId;
            kwargs.amount_currency = amountCurrency;
            console.log(`🔵 Cash move: Sending to backend - foreign_currency_id=${currencyId}, amount_currency=${amountCurrency}, amountBase=${amountBase}`);
        } else {
            console.log(`🔵 Cash move: Base currency transaction - currencyId=${currencyId}, baseCurrencyId=${baseCurrencyId}`);
        }

        // Use try_cash_in_out_multi if payment_method_id is set, otherwise use standard method
        if (targetPaymentMethodId) {
            await this.pos.data.call(
                "pos.session",
                "try_cash_in_out_multi",
                [this.pos.session.id, targetPaymentMethodId, type, amountBase, reason, extras],
                kwargs,
                true
            );
        } else {
        await this.pos.data.call(
            "pos.session",
            "try_cash_in_out",
                this._prepareTryCashInOutPayload(type, amountBase, reason, this.partnerId, extras),
            {},
            true
        );
        }

        // Format notification message with currency
        let notificationAmount = formattedAmount;
        let notificationMessage = _t("Successfully made a cash %s of %s.", type, notificationAmount);
        
        // If foreign currency, show foreign currency amount in notification
        if (selectedCurrency && baseCurrency && selectedCurrency.id !== baseCurrency.id) {
            // Format foreign currency amount (without currency symbol, we'll add it manually)
            const foreignFormatted = this.env.utils.formatCurrency(amountCurrency, false);
            const foreignSymbol = selectedCurrency.symbol || selectedCurrency.name;
            notificationAmount = `${foreignFormatted} ${foreignSymbol}`;
            notificationMessage = _t("Successfully made a cash %s of %s.", type, notificationAmount);
        }

        await this.pos.logEmployeeMessage(
            `${_t("Cash")} ${translatedType} - ${_t("Amount")}: ${notificationAmount}`,
            "CASH_DRAWER_ACTION"
        );
        await this.printer.print(CashMoveReceipt, {
            reason,
            translatedType,
            formattedAmount,
            date: new Date().toLocaleString(),
        });

        this.props.close();
        this.notification.add(
            notificationMessage,
            3000
        );
    },
});
