/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { MoneyDetailsPopup } from "@point_of_sale/app/components/popups/money_details_popup/money_details_popup";
import { patch } from "@web/core/utils/patch";
import { useState } from "@odoo/owl";
import { floatIsZero } from "@web/core/utils/numbers";

// Add filterCurrency prop to MoneyDetailsPopup
patch(MoneyDetailsPopup, {
    props: {
        ...MoneyDetailsPopup.props,
        filterCurrency: { type: [Object, String, Number, null], optional: true },
    },
});

patch(MoneyDetailsPopup.prototype, {
    setup() {
        super.setup();
        
        // Get filter currency from props (if provided)
        const filterCurrency = this.props.filterCurrency || null;
        const filterCurrencyName = filterCurrency ? (filterCurrency.name || filterCurrency) : null;
        const baseCurrency = this.pos.currency;
        const baseCurrencyId = baseCurrency ? baseCurrency.id : null;
        // Normalize currency names for comparison (case-insensitive)
        const normalizedFilterName = filterCurrencyName ? filterCurrencyName.toUpperCase() : null;
        const normalizedBaseName = baseCurrency ? baseCurrency.name.toUpperCase() : null;
        const isFilteringBaseCurrency = normalizedFilterName && normalizedFilterName === normalizedBaseName;
        
        // Get all bills first
        const allBills = this.pos.models["pos.bill"].getAll();
        
        // Filter bills based on currency
        let bills = allBills.filter((bill) => {
            if (!bill) return false;
            
            // Get currency_id from bill
            let billCurrencyId = null;
            if (bill.currency_id) {
                if (Array.isArray(bill.currency_id)) {
                    billCurrencyId = bill.currency_id[0];
                } else if (typeof bill.currency_id === 'object' && bill.currency_id.id) {
                    billCurrencyId = bill.currency_id.id;
                } else if (typeof bill.currency_id === 'number') {
                    billCurrencyId = bill.currency_id;
                }
            }
            
            // If filtering by currency
            if (filterCurrencyName) {
                if (isFilteringBaseCurrency) {
                    // Show base currency bills: bills without currency_id OR bills with base currency_id
                    return !billCurrencyId || billCurrencyId === false || billCurrencyId === null || billCurrencyId === baseCurrencyId;
                } else {
                    // Show only bills for the filtered foreign currency
                    // Get currency from bill
                    let billCurrency = null;
                    if (billCurrencyId) {
                        billCurrency = this.pos.models["res.currency"]?.get?.(billCurrencyId);
                    }
                    if (billCurrency && billCurrency.name) {
                        return billCurrency.name.toUpperCase() === normalizedFilterName;
                    }
                    return false;
                }
            }
            // No filter: show base currency bills (bills without currency_id or with base currency_id)
            return !billCurrencyId || billCurrencyId === false || billCurrencyId === null || billCurrencyId === baseCurrencyId;
        });
        
        var initialState = {
            moneyDetails: Object.fromEntries(bills.map(bill =>[bill.value, 0])),
            total: 0,
        };
        
        // Group foreign currency bills (skip base currency bills)
        const grouped = allBills.reduce((acc, obj) => {
          if (!obj) return acc;
          
          // Get currency_id from bill
          let billCurrencyId = null;
          if (obj.currency_id) {
            if (Array.isArray(obj.currency_id)) {
              billCurrencyId = obj.currency_id[0];
            } else if (typeof obj.currency_id === 'object' && obj.currency_id.id) {
              billCurrencyId = obj.currency_id.id;
            } else if (typeof obj.currency_id === 'number') {
              billCurrencyId = obj.currency_id;
            }
          }
          
          // Skip base currency bills (those without currency_id or with base currency_id)
          if (!billCurrencyId || billCurrencyId === false || billCurrencyId === null || billCurrencyId === baseCurrencyId) {
            return acc;
          }
          
          // Get currency object
          let currency = null;
          if (billCurrencyId) {
            currency = this.pos.models["res.currency"]?.get?.(billCurrencyId);
            }
          
          if (currency && currency.name) {
            // If filtering by currency, only include bills for that currency
            if (filterCurrencyName) {
                const normalizedCurrencyName = currency.name.toUpperCase();
                if (normalizedCurrencyName === normalizedFilterName) {
                    (acc[currency.name] ??= []).push(obj);
                }
            } else {
            (acc[currency.name] ??= []).push(obj);
            }
          }
          return acc;
        }, {});
        this.otherCurrencies = Object.keys(grouped);
        this.otherCurrencies.forEach(key => {
            let mdKey = `moneyDetails${key}`;
            let mdVals = {};
            grouped[key].forEach(oc => {
                if (oc.name != null) {
                    mdVals[oc.name] =  0; 
                }
            });
            initialState[mdKey] = mdVals;
            initialState[`total${key}`] = 0;

        });
        this.state = useState(initialState);
        this.moneyDetailKeys = Object.keys(this.state).filter(k => k.startsWith("moneyDetails"));
        
        // Store filter currency for template use
        this.filterCurrencyName = filterCurrencyName;
    },
    
    getFilteredCurrencyKeys() {
        /**
         * Get filtered currency keys based on filterCurrencyName.
         * Returns only the currency keys that match the filter, or all if no filter.
         * NOTE: Always excludes 'moneyDetails' (base currency) since it's shown separately.
         */
        if (!this.filterCurrencyName) {
            // No filter: return all foreign currency keys (exclude base currency)
            return this.moneyDetailKeys.filter(k => k !== 'moneyDetails' && k.replace('moneyDetails', '') !== '');
        }
        
        // Normalize for case-insensitive comparison
        const normalizedFilterName = this.filterCurrencyName.toUpperCase();
        const normalizedBaseName = this.pos.currency ? this.pos.currency.name.toUpperCase() : '';
        
        // If filtering by base currency, return empty array (base currency is shown separately)
        if (normalizedFilterName === normalizedBaseName) {
            return [];
        }
        
        // Filter foreign currency keys only (always exclude 'moneyDetails')
        return this.moneyDetailKeys.filter(k => {
            if (k === 'moneyDetails') {
                return false; // Always exclude base currency key
            }
            const currencyName = k.replace('moneyDetails', '');
            return currencyName.toUpperCase() === normalizedFilterName;
        });
    },
    
    shouldShowBaseCurrency() {
        /**
         * Check if base currency section should be shown.
         * Returns true if filtering by base currency or no filter.
         */
        if (!this.filterCurrencyName) {
            return true;
        }
        // Normalize for case-insensitive comparison
        const filterName = this.filterCurrencyName.toUpperCase();
        const baseName = this.pos.currency ? this.pos.currency.name.toUpperCase() : '';
        return filterName === baseName;
    },

    getCurrencyKeyByIndex(index) {
        if (index >= 0 && index < this.moneyDetailKeys.length) {
            return this.moneyDetailKeys[index];
        }
        return null;
    },

    computeTotalAllCurrencywithSymbol(){
        let curr_vals = {};
        let total = Object.entries(this.state.moneyDetails).reduce((total, [value, inputQty]) => {
            const quantity = isNaN(inputQty) ? 0 : inputQty;
            return total + parseFloat(value) * quantity;
        }, 0);
        curr_vals[`Total`] = this.env.utils.formatCurrency(total)
        this.moneyDetailKeys.forEach(key => {
            let curr_key = key.replace('moneyDetails', '');
            if(curr_key){
                let oc_total = Object.entries(this.state[key]).reduce((total, [value, inputQty]) => {
                    const quantity = isNaN(inputQty) ? 0 : inputQty;
                    return total + parseFloat(value) * quantity;
                }, 0);
                curr_vals[`Total ${curr_key}`] = `${oc_total} ${ this.currency_symbol(curr_key) }`;
            }
        });
        return curr_vals;
    },

    computeTotalAllCurrency(){
        let curr_vals = {};
        let total = Object.entries(this.state.moneyDetails).reduce((total, [value, inputQty]) => {
            const quantity = isNaN(inputQty) ? 0 : inputQty;
            return total + parseFloat(value) * quantity;
        }, 0);
        
        // Use base currency name in the key (e.g., "Total TZS" instead of just "Total")
        // This matches what OpeningControlPopup expects
        const baseCurrencyName = this.pos?.currency?.name?.toUpperCase() || '';
        if (baseCurrencyName) {
            curr_vals[`Total ${baseCurrencyName}`] = total;
        } else {
            // Fallback to "Total" if base currency name is not available
            curr_vals[`Total`] = total;
        }
        
        this.moneyDetailKeys.forEach(key => {
            let curr_key = key.replace('moneyDetails', '');
            if(curr_key){
                let oc_total = Object.entries(this.state[key]).reduce((total, [value, inputQty]) => {
                    const quantity = isNaN(inputQty) ? 0 : inputQty;
                    return total + parseFloat(value) * quantity;
                }, 0);
                curr_vals[`Total ${curr_key}`] = oc_total;
            }
        });
        return curr_vals;
    },

    computeGrandTotalBase() {
        // Calculate total in base currency by converting all foreign currencies
        const baseCurrency = this.pos?.currency;
        if (!baseCurrency) return 0;
        
        let totalBase = 0;
        
        // Add base currency total
        const baseTotal = Object.entries(this.state.moneyDetails).reduce((total, [value, inputQty]) => {
            const quantity = isNaN(inputQty) ? 0 : inputQty;
            return total + parseFloat(value) * quantity;
        }, 0);
        totalBase += baseTotal;
        
        // Add foreign currency totals converted to base currency
        this.moneyDetailKeys.forEach(key => {
            let curr_key = key.replace('moneyDetails', '');
            if(curr_key){
                let oc_total = Object.entries(this.state[key]).reduce((total, [value, inputQty]) => {
                    const quantity = isNaN(inputQty) ? 0 : inputQty;
                    return total + parseFloat(value) * quantity;
                }, 0);
                
                // Convert to base currency using exchange rate
                if (oc_total > 0 && this.pos.currencies_rate[curr_key]) {
                    const rate = this.pos.currencies_rate[curr_key];
                    // Convert: foreign_amount / foreign_rate = base_amount
                    const convertedAmount = oc_total / rate;
                    totalBase += convertedAmount;
                }
            }
        });
        
        return totalBase;
    },

    currency_symbol(curr_key){
        let symbol = this.pos.currencies_symbol[curr_key];
        if(!symbol || symbol == undefined){
            symbol = this.pos.currency.symbol;
        }
        return symbol
    },

    confirm() {
        let moneyDetailsNotes = !floatIsZero(this.computeTotal(), this.currency.decimal_places)
            ? this.props.context + " details: \n"
            : "details: \n";

        this.pos.models["pos.bill"].forEach((bill) => {
            if (this.state.moneyDetails[bill.value]) {
                moneyDetailsNotes +=
                    "\t" +
                    `${this.state.moneyDetails[bill.value]} x ${this.env.utils.formatCurrency(
                        bill.value
                    )}\n`;
            }
        });

        this.moneyDetailKeys.forEach(key => {
            let curr_key = key.replace('moneyDetails', '');
            if(curr_key){
                let bills = this.pos.models["pos.bill"].filter((bill) => {
                    if (!bill || !bill.currency_id) return false;
                    let currency = null;
                    if (Array.isArray(bill.currency_id)) {
                        currency = this.pos.models["res.currency"]?.get?.(bill.currency_id[0]);
                    } else if (typeof bill.currency_id === 'object' && bill.currency_id.name) {
                        currency = bill.currency_id;
                    } else if (typeof bill.currency_id === 'number') {
                        currency = this.pos.models["res.currency"]?.get?.(bill.currency_id);
                    }
                    return currency && currency.name == curr_key;
                });

                bills.forEach((bill) => {
                    if (this.state[key][bill.name]) {
                        let currency = null;
                        if (Array.isArray(bill.currency_id)) {
                            currency = this.pos.models["res.currency"]?.get?.(bill.currency_id[0]);
                        } else if (typeof bill.currency_id === 'object' && bill.currency_id.symbol) {
                            currency = bill.currency_id;
                        } else if (typeof bill.currency_id === 'number') {
                            currency = this.pos.models["res.currency"]?.get?.(bill.currency_id);
                        }
                        if (currency && currency.symbol) {
                            let val = this.env.utils.formatCurrency(bill.value, false);
                            val = `${val} ${currency.symbol}`;
                        moneyDetailsNotes +=
                            "\t" +
                            `${this.state[key][bill.name]} x ${ val } \n`;
                        }
                    }
                });
            }          
        });
        // Use computeGrandTotalBase() to get total in base currency
        let total = this.computeGrandTotalBase();

        if (moneyDetailsNotes) {
            moneyDetailsNotes += _t(
                "Total: %s",
                this.env.utils.formatCurrency(total)
            );
        }
        this.props.getPayload({
            total: total,
            moneyDetailsNotes,
            moneyDetails: { ...this.state.moneyDetails },
            action: this.props.action,
            all_currency_total : this.computeTotalAllCurrency(),
        });
        this.props.close();
    },

    incrementDenomination(mdKey, moneyValue) {
        if (!this.state[mdKey]) {
            this.state[mdKey] = {};
        }
        const currentValue = this.state[mdKey][moneyValue] || 0;
        this.state[mdKey][moneyValue] = currentValue + 1;
    },

    decrementDenomination(mdKey, moneyValue) {
        if (!this.state[mdKey]) {
            this.state[mdKey] = {};
        }
        const currentValue = this.state[mdKey][moneyValue] || 0;
        this.state[mdKey][moneyValue] = Math.max(0, currentValue - 1);
    },

});