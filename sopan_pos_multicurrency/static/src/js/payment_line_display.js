/** @odoo-module */

import { PosPayment } from "@point_of_sale/app/models/pos_payment";
import { patch } from "@web/core/utils/patch";

// Helper function to get payment method currency
function getPaymentMethodCurrency(pos, paymentMethod) {
    if (!paymentMethod) return null;
    
    let cur = paymentMethod.currency_of_cash_control;
    
    // Handle array format [id, name]
    if (Array.isArray(cur) && cur.length > 0) {
        cur = cur[0];
    }
    
    if (!cur) return null;
    
    // Resolve currency object
    if (typeof cur === 'object' && cur.id) {
        return cur;
    } else if (typeof cur === 'number') {
        return pos?.models?.["res.currency"]?.get?.(cur);
    }
    
    return null;
}

patch(PosPayment.prototype, {
    /**
     * Get the formatted currency amount display for foreign currency payments
     * @returns {string|false} Formatted string like "(10.00 $)" or false if not applicable
     */
    getCurrencyAmountDisplay() {
        // Get base currency from order (order always has currency)
        const baseCurrency = this.pos_order_id?.currency;
        if (!baseCurrency) {
            return false;
        }

        // First, try to get currency from payment line data (if amount is entered)
        let payCurrency = null;
        let amount = 0;
        
        if (this.payment_currency_id) {
            // Currency is already set on the payment line
            payCurrency = this.payment_currency_id;
            if (typeof payCurrency === 'number') {
                // If it's just an ID, get the currency object from models
                const currencyModel = this.pos_order_id?.models?.["res.currency"] || 
                                     this.models?.["res.currency"];
                if (currencyModel) {
                    payCurrency = currencyModel.get?.(payCurrency);
                }
            }
            
            // Use stored currency_amount_total if available, otherwise calculate
            if (this.currency_amount_total && this.currency_amount_total > 0) {
                amount = this.currency_amount_total;
            } else if (this.amount > 0 && payCurrency) {
                // Calculate the amount in foreign currency
                const rate = payCurrency.rate || 1;
                // In this dynamic module `rate` = foreign per 1 base, so:
                // foreign = base * rate
                amount = this.amount * rate;
            }
        } else {
            // Currency data not set yet, get it from payment method
            const pos = this.pos_order_id?.pos || null;
            payCurrency = getPaymentMethodCurrency(pos, this.payment_method_id);
            
            if (payCurrency && this.amount > 0) {
                // Calculate the amount in foreign currency
                const rate = payCurrency.rate || 1;
                // foreign = base * rate
                amount = this.amount * rate;
            }
        }

        if (!payCurrency) {
            return false;
        }

        // Check if it's different from base currency
        if (payCurrency.id === baseCurrency.id) {
            return false;
        }

        // Format and return the display string
        if (amount > 0) {
            const amountStr = amount.toFixed(2);
            const symbol = payCurrency.symbol || payCurrency.name;
            const display = `(${amountStr} ${symbol})`;
            return display;
        } else {
            // Show just the currency symbol if no amount yet
            const symbol = payCurrency.symbol || payCurrency.name;
            const display = `(${symbol})`;
            return display;
        }
    },
});

