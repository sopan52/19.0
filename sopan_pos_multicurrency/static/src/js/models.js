/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";

patch(PosStore.prototype, {
    
    async setup() {
        await super.setup(...arguments);
        
        // Get all currencies
        this.currencies = this.models["res.currency"].getAll();
        this.currencies_rate = {};
        this.currencies_symbol = {};
        this.currenciesById = {};
        this.currenciesByName = {};
        
        this.currencies.forEach(curr => {
            this.currencies_rate[curr.name] = curr.rate;
            this.currencies_symbol[curr.name] = curr.symbol;
            this.currenciesById[curr.id] = curr;
            this.currenciesByName[curr.name] = curr;
        });
        
        // Convenience: USD currency (used by optional USD price tool in v1)
        // Kept for compatibility, but the dynamic cash control itself does not depend on USD/EUR.
        this.usd_currency = this.currenciesByName.USD || null;
        
        // Group bills by currency
        const allBills = this.models?.["pos.bill"]?.getAll?.() || [];
        const baseCurrencyId = this.currency?.id;
        
        this.billsByCurrencyId = {};
        for (const bill of allBills) {
            let curId = null;
            if (bill.currency_id) {
                if (Array.isArray(bill.currency_id)) {
                    curId = bill.currency_id[0];
                } else if (typeof bill.currency_id === 'object' && bill.currency_id.id) {
                    curId = bill.currency_id.id;
                } else if (typeof bill.currency_id === 'number') {
                    curId = bill.currency_id;
                }
            }
            
            // Default to base currency
            if (!curId) {
                curId = baseCurrencyId;
            }
            
            if (curId) {
                if (!this.billsByCurrencyId[curId]) {
                    this.billsByCurrencyId[curId] = [];
                }
                this.billsByCurrencyId[curId].push(bill);
            }
        }
        
        this.bills_base = baseCurrencyId ? this.billsByCurrencyId[baseCurrencyId] || [] : [];
    },
    
});