/** @odoo-module */

import { OpeningControlPopup } from "@point_of_sale/app/components/popups/opening_control_popup/opening_control_popup";
import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";
import { MoneyDetailsPopup } from "@point_of_sale/app/components/popups/money_details_popup/money_details_popup";
import { RPCError } from "@web/core/network/rpc";

patch(OpeningControlPopup.prototype, {
    setup() {
        super.setup(...arguments);
        this.usd_bal = 0;
		this.vef_bal = 0;
        this.all_currency_total = {};
        
        // Load existing opening balances from session
        const activeCurrencies = this.getActiveCurrencies();
        
        // Load base currency opening cash amount from session (same as USD/EUR)
        const baseCurrency = this.pos?.currency;
        // IMPORTANT: do not force the base input to blank.
        // If no stored value exists yet, show 0.00 (matches expected UX).
        const existingOpeningCash = this.state.openingCash;
        let baseOpening = null;
        if (this.pos.session && baseCurrency) {
            // Priority 1: Use stored JSON details (always contains base key, even when amount is 0)
            if (this.pos.session.oc_opening_cash_details) {
                try {
                    const details = JSON.parse(this.pos.session.oc_opening_cash_details);
                    if (details && typeof details === "object") {
                        const baseKey = `Total ${String(baseCurrency.name || "").toUpperCase()}`;
                        if (details[baseKey] !== undefined) {
                            baseOpening = parseFloat(details[baseKey]) || 0;
                        } else if (details["Total"] !== undefined) {
                            // Backward compatibility key
                            baseOpening = parseFloat(details["Total"]) || 0;
                        }
                    }
                } catch (e) {
                    // ignore
                }
            }
            // Priority 2: Use oc_opening_bal_ids if present
            if (baseOpening === null && this.pos.session.oc_opening_bal_ids) {
                const baseBalance = this.pos.session.oc_opening_bal_ids.find(
                    (oc) => oc.currency_id && oc.currency_id.id === baseCurrency.id
                );
                if (baseBalance && baseBalance.opening_total !== undefined && baseBalance.opening_total !== null) {
                    baseOpening = parseFloat(baseBalance.opening_total) || 0;
                }
            }
        }

        if (baseOpening !== null) {
            this.state.openingCash = this.env.utils.formatCurrency(baseOpening, false);
        } else if (existingOpeningCash !== undefined && existingOpeningCash !== null && String(existingOpeningCash).trim() !== "") {
            // Keep whatever core implementation already provided
            this.state.openingCash = existingOpeningCash;
        } else {
            // Default to 0.00 instead of blank
            this.state.openingCash = this.env.utils.formatCurrency(0, false);
        }
        
        // Load foreign currency opening cash amounts from session
        activeCurrencies.forEach(currency => {
            const key = `openingCash_${currency.id}`;
            
            // Try to get from oc_opening_bal_ids (other currency opening balances)
            if (this.pos.session && this.pos.session.oc_opening_bal_ids) {
                const ocBalance = this.pos.session.oc_opening_bal_ids.find(
                    oc => oc.currency_id && oc.currency_id.id === currency.id
                );
                if (ocBalance && ocBalance.opening_total) {
                    this.state[key] = this.env.utils.formatCurrency(ocBalance.opening_total, false);
                    return;
                }
            }
            
            // Fallback: try to get from session fields (usd_opening_cash, eur_opening_cash, etc.)
            // Initialize empty if no existing value
            if (!this.state[key]) {
                this.state[key] = '';
            }
        });
    },

    getActiveCurrencies() {
        /**
         * Get all active currencies from cash payment methods.
         * Returns array of currency objects (excluding base currency).
         */
        if (!this.pos || !this.pos.config) {
            return [];
        }
        
        // In Odoo POS, `pos.config.payment_method_ids` can be:
        // - records (preferred), or
        // - ids (numbers), depending on load/serialization
        // So build a reliable list of payment method records.
        const configPMs = this.pos.config.payment_method_ids || [];
        const modelPMs = this.pos.models?.["pos.payment.method"]?.getAll?.() || [];
        
        const configIds = new Set();
        if (Array.isArray(configPMs)) {
            for (const pm of configPMs) {
                if (typeof pm === "number") {
                    configIds.add(pm);
                } else if (pm && typeof pm === "object" && pm.id) {
                    configIds.add(pm.id);
                }
            }
        }
        
        const paymentMethods = (Array.isArray(configPMs) && configPMs.length && typeof configPMs[0] === "object")
            ? configPMs
            : (configIds.size ? modelPMs.filter(pm => configIds.has(pm.id)) : modelPMs);
        
        // Use the same cash detection as Odoo cash control: `is_cash_count`
        const cashMethods = paymentMethods.filter(
            pm => (pm?.is_cash_count || pm?.type === "cash") && pm?.currency_of_cash_control
        );
        
        const baseCurrencyId = this.pos.currency ? this.pos.currency.id : null;
        const currenciesMap = new Map();
        
        cashMethods.forEach(pm => {
            let currency = pm.currency_of_cash_control;
            if (currency) {
                // currency_of_cash_control (Many2one) can arrive as:
                // - object: {id, name, ...}
                // - array: [id, display_name]
                // - number: id
                let currencyId = null;
                let currencyName = "";
                
                if (Array.isArray(currency) && currency.length) {
                    currencyId = currency[0];
                    currencyName = currency[1] || "";
                } else if (typeof currency === "object") {
                    currencyId = currency.id;
                    currencyName = currency.name || "";
                } else {
                    currencyId = currency;
                }
                
                if (!currencyName) {
                    currencyName =
                        this.pos.currencies?.find((c) => c.id === currencyId)?.name ||
                        this.pos.models?.["res.currency"]?.get?.(currencyId)?.name ||
                        "";
                }
                
                // Only add if it's different from base currency
                if (currencyId && currencyId !== baseCurrencyId && !currenciesMap.has(currencyId)) {
                    currenciesMap.set(currencyId, {
                        id: currencyId,
                        name: currencyName,
                    });
                }
            }
        });
        
        return Array.from(currenciesMap.values());
    },

    updateOpeningNotes() {
        /**
         * Update opening notes with currency-wise breakdown of all input values.
         * ALWAYS reads from input fields first (source of truth).
         * IMPORTANT: Must properly parse formatted currency strings (e.g., "2,100.00" -> 2100.00)
         */
        const notesParts = [];
        const baseCurrencyName = this.pos?.currency?.name?.toUpperCase() || '';
        const currencyAmounts = {};
        
        // Helper function to parse formatted currency string (handles "2,100.00" -> 2100.00)
        const parseCurrencyString = (str) => {
            if (!str || typeof str !== 'string') return 0;
            // Remove commas first (they cause parseFloat to stop), then remove other non-numeric chars
            const cleaned = str.replace(/,/g, '').replace(/[^\d.-]/g, '');
            return parseFloat(cleaned) || 0;
        };
        
        // ALWAYS read from input fields first (input fields are the source of truth)
        const baseCashStr = this.state.openingCash || '';
        const baseCash = parseCurrencyString(baseCashStr);
        if (baseCash > 0) {
            currencyAmounts[`Total ${baseCurrencyName}`] = baseCash;
        }
        
        // Read ALL foreign currencies from input fields
        const activeCurrencies = this.getActiveCurrencies();
        activeCurrencies.forEach(currency => {
            const key = `openingCash_${currency.id}`;
            const inputValue = this.state[key];
            if (inputValue && inputValue.trim() !== '') {
                // Use parseCurrencyString to properly handle formatted values like "2,100.00"
                const amount = parseCurrencyString(inputValue);
                if (amount > 0) {
                    currencyAmounts[`Total ${currency.name}`] = amount;
                }
            }
        });
        
        // Update all_currency_total to sync with input fields (input fields are source of truth)
        this.all_currency_total = currencyAmounts;
        
        // Generate notes from collected amounts
        const baseKey = `Total ${baseCurrencyName}`;
        if (currencyAmounts[baseKey]) {
            const baseAmount = parseFloat(currencyAmounts[baseKey]) || 0;
            if (baseAmount > 0) {
                notesParts.push(`${this.env.utils.formatCurrency(baseAmount, false)} ${this.pos.currency.name}`);
            }
        }
        
        // Add all foreign currencies
        for (const [key, value] of Object.entries(currencyAmounts)) {
            if (key !== baseKey) {
                const currencyName = key.replace('Total ', '').replace('Total', '').trim();
                const amount = parseFloat(value) || 0;
                if (amount > 0) {
                    notesParts.push(`${this.env.utils.formatCurrency(amount, false)} ${currencyName}`);
                }
            }
        }
        
        // Format notes
        if (notesParts.length > 0) {
            this.state.notes = `Opening Balance: ${notesParts.join(', ')}`;
        } else {
            // Always clear notes if there are no amounts.
            // Otherwise old notes can remain visible when user sets a currency (e.g. EUR) back to 0.
            this.state.notes = '';
        }
    },

    async confirm() {
        try {
            // Ensure notes reflect the latest input values before posting opening control.
            // (Opening chatter message uses these notes and/or stored opening JSON.)
            this.updateOpeningNotes();

            // Helper function to parse formatted currency string (handles "2,100.00" -> 2100.00)
            const parseCurrencyString = (str) => {
                if (!str || typeof str !== 'string') return 0;
                // Remove commas first (they cause parseFloat to stop), then remove other non-numeric chars
                const cleaned = str.replace(/,/g, '').replace(/[^\d.-]/g, '');
                return parseFloat(cleaned) || 0;
            };
            
            // Get base currency opening cash (must parse formatted string correctly)
            const baseCashStr = this.state.openingCash || '';
            const baseCash = parseCurrencyString(baseCashStr);
            
            // Collect currency amounts from input fields (prioritize input fields over all_currency_total)
            const currencyAmounts = {};
            const activeCurrencies = this.getActiveCurrencies();
            
            // Get base currency name
                const baseCurrencyName = this.pos?.currency?.name?.toUpperCase() || '';
            currencyAmounts[`Total ${baseCurrencyName}`] = baseCash;
            
            // Collect foreign currency amounts from input fields
            activeCurrencies.forEach(currency => {
                const key = `openingCash_${currency.id}`;
                const inputValue = this.state[key];
                // Parse the formatted currency string using helper (handles "2,100.00" correctly)
                const amount = inputValue ? parseCurrencyString(inputValue) : 0;
                if (amount > 0) {
                    currencyAmounts[`Total ${currency.name}`] = amount;
                }
            });
                
            // Merge with all_currency_total from money details popup for any missing currencies
            // But prioritize input field values
            if (this.all_currency_total && Object.keys(this.all_currency_total).length > 0) {
                for (const [key, value] of Object.entries(this.all_currency_total)) {
                    // Only add if not already set from input fields
                    if (!currencyAmounts[key]) {
                        currencyAmounts[key] = value;
                    }
                }
            }
            
            // Store opening balances dynamically for ALL currencies.
                await this.pos.data.call(
                    "pos.session",
                    "set_other_currency_opening_bal",
                [this.pos.session.id, currencyAmounts],
                    {},
                    true
                );

            // CRITICAL: `set_opening_control` must receive TOTAL opening cash expressed in base currency.
            // Otherwise Odoo expects 0 opening cash and creates a "Cash difference observed" move at closing.
            let baseCashTotalToSend = baseCash || 0;
            try {
                const baseCurrency = this.pos?.currency;
                const resCurrencyModel = this.pos?.models?.["res.currency"];
                if (baseCurrency && resCurrencyModel) {
                    activeCurrencies.forEach((currency) => {
                        if (!currency || currency.id === baseCurrency.id) return;
                        const key = `openingCash_${currency.id}`;
                        const inputValue = this.state[key];
                        const foreignAmount = inputValue ? parseCurrencyString(inputValue) : 0;
                        if (!foreignAmount) return;

                        const currencyObj = resCurrencyModel.get(currency.id);
                        if (currencyObj && currencyObj.inverse_rate && currencyObj.inverse_rate > 0) {
                            // inverse_rate = base per 1 foreign
                            baseCashTotalToSend += foreignAmount * currencyObj.inverse_rate;
                        } else if (currencyObj && currencyObj.rate && currencyObj.rate > 0) {
                            // rate = foreign per 1 base => base = foreign / rate
                            baseCashTotalToSend += foreignAmount / currencyObj.rate;
                        }
                    });
                }
            } catch (e) {
                // fallback: keep baseCash only
            }

            // Now open the session (this will post the opening chatter message).
            // Important: do this AFTER storing opening details so the message can compute totals.
            await this.pos.data.call(
                "pos.session",
                "set_opening_control",
                [this.pos.session.id, baseCashTotalToSend, this.state.notes],
                {},
                true
            );
                
                // Reload session data to ensure pos.session has the updated values
                const updatedSession = await this.pos.data.call(
                    "pos.session",
                    "read",
                    [[this.pos.session.id], ["oc_opening_bal_ids"]],
                    {},
                    true
                );
                
                if (updatedSession && updatedSession.length > 0) {
                    const sessionData = updatedSession[0];
                
                // Update oc_opening_bal_ids if available
                if (sessionData.oc_opening_bal_ids) {
                    this.pos.session.oc_opening_bal_ids = sessionData.oc_opening_bal_ids;
                }
            }
        } catch (error) {
            if (
                error instanceof RPCError &&
                error.data.name === "odoo.exceptions.MissingError" &&
                (await this.pos.isSessionDeleted())
            ) {
                return window.location.reload();
            }
            throw error;
        }
        this.pos.session.state = "opened";
        this.props.close();
    },

    openDetailsPopupBaseCurrency() {
        /**
         * Wrapper method for opening money details popup for base currency.
         * This is used in the template to ensure proper method binding.
         * Matches the base Odoo openDetailsPopup signature (no parameters).
         * Shows ALL currencies (no filter) when called from base currency button.
         */
        console.log("🔵🔵🔵 openDetailsPopupBaseCurrency CALLED - showing ALL currencies");
        console.log("🔵 this:", this);
        console.log("🔵 this.dialog:", this.dialog);
        console.log("🔵 this.pos:", this.pos);
        try {
            // Pass null as filterCurrency to show all currencies
            const result = this.openDetailsPopupMultiCurrency(null, null, null);
            console.log("🔵 openDetailsPopupMultiCurrency returned:", result);
            return result;
        } catch (error) {
            console.error("❌❌❌ Error in openDetailsPopupBaseCurrency:", error);
            console.error("❌ Error stack:", error.stack);
            throw error;
        }
    },

    async openDetailsPopup() {
        /**
         * Override base Odoo method to call our multi-currency version.
         * This ensures compatibility with base Odoo template.
         */
        console.log("🔵 openDetailsPopup (base override) CALLED");
        return this.openDetailsPopupMultiCurrency(null, null);
    },

    async openDetailsPopupMultiCurrency(ev, currencyId = null, filterCurrencyOverride = undefined) {
        /**
         * Open money details popup for a specific currency.
         * If currencyId is provided, update only that currency's input.
         * If currencyId is null, update base currency input.
         * If filterCurrencyOverride is null, show all currencies (no filter).
         * If filterCurrencyOverride is undefined, use default behavior (filter by currency).
         */
        console.log("🔵 openDetailsPopupMultiCurrency CALLED - currencyId:", currencyId, "ev:", ev, "filterCurrencyOverride:", filterCurrencyOverride);
        const action = _t("Cash control - opening");
        try {
        this.hardwareProxy.openCashbox(action);
        } catch (error) {
            console.error("❌ Error opening cashbox:", error);
        }
        
        // Determine which currency we're working with
        const targetCurrencyId = currencyId || (this.pos.currency ? this.pos.currency.id : null);
        const isBaseCurrency = !currencyId || (this.pos.currency && currencyId === this.pos.currency.id);
        
        // Store the target currency for use in the callback
        const targetCurrency = currencyId ? 
            this.getActiveCurrencies().find(c => c.id === currencyId) : 
            null;
        
        // Determine filterCurrency:
        // - If filterCurrencyOverride is null, show all currencies (no filter)
        // - If filterCurrencyOverride is undefined, use default behavior (filter by currency)
        // - Otherwise use the override value
        let filterCurrency;
        if (filterCurrencyOverride === null) {
            // Show all currencies
            filterCurrency = null;
        } else if (filterCurrencyOverride !== undefined) {
            // Use override value
            filterCurrency = filterCurrencyOverride;
        } else {
            // Default behavior: filter by currency
            filterCurrency = isBaseCurrency ? this.pos.currency : targetCurrency;
        }
        
        console.log("🔵 About to add MoneyDetailsPopup to dialog");
        console.log("🔵 filterCurrency:", filterCurrency);
        console.log("🔵 this.moneyDetails:", this.moneyDetails);
        
        this.dialog.add(MoneyDetailsPopup, {
            moneyDetails: this.moneyDetails,
            action: action,
            ...(filterCurrency !== null && filterCurrency !== undefined ? { filterCurrency: filterCurrency } : {}), // Only pass filterCurrency if it's not null/undefined
            getPayload: (payload) => {
                if (payload) {
                    const { total, moneyDetails, moneyDetailsNotes, all_currency_total } = payload;
                    
                    // Store moneyDetails first
                    this.moneyDetails = moneyDetails;
                    
                    // CRITICAL: First, collect ALL current input field values (preserve existing manual inputs)
                    // This ensures we don't lose any values when coins popup is used
                    const currentInputValues = {};
                    const baseCurrencyName = this.pos?.currency?.name?.toUpperCase() || '';
                    
                    // Helper function to parse formatted currency string (handles "2,100.00" -> 2100.00)
                    const parseCurrencyString = (str) => {
                        if (!str || typeof str !== 'string') return 0;
                        // Remove all non-digit characters except decimal point and minus sign
                        // Explicitly remove commas first, then remove other non-numeric chars
                        const cleaned = str.replace(/,/g, '').replace(/[^\d.-]/g, '');
                        return parseFloat(cleaned) || 0;
                    };
                    
                    // Get base currency from input field
                    const baseCashStr = this.state.openingCash || '';
                    const baseCash = parseCurrencyString(baseCashStr);
                    if (baseCash > 0) {
                        currentInputValues[`Total ${baseCurrencyName}`] = baseCash;
                    }
                    
                    // Get ALL foreign currencies from input fields (CRITICAL: preserve ALL existing values)
                    const activeCurrencies = this.getActiveCurrencies();
                    activeCurrencies.forEach(currency => {
                        const key = `openingCash_${currency.id}`;
                        const inputValue = this.state[key];
                        // IMPORTANT: Check if input has any value (even if empty string, we want to preserve it)
                        if (inputValue !== undefined && inputValue !== null) {
                            if (inputValue.trim() !== '') {
                                // Use parseCurrencyString to properly handle formatted values like "2,100.00"
                                const amount = parseCurrencyString(inputValue);
                                if (amount > 0) {
                                    // Preserve existing input values
                                    currentInputValues[`Total ${currency.name}`] = amount;
                                }
                            }
                        }
                    });
                    
                    // Also preserve existing all_currency_total values (from previous coins popup usage)
                    // This ensures we don't lose currencies that were entered via popup before
                    if (this.all_currency_total && Object.keys(this.all_currency_total).length > 0) {
                        for (const [key, value] of Object.entries(this.all_currency_total)) {
                            // Only add if not already in currentInputValues (input fields take priority)
                            if (!currentInputValues[key]) {
                                const amount = parseFloat(value) || 0;
                                if (amount > 0) {
                                    currentInputValues[key] = amount;
                                }
                            }
                        }
                    }
                    
                    // Now merge with new values from popup
                    // IMPORTANT: If a currency already exists in currentInputValues, ADD the popup value to it
                    // If it doesn't exist, use the popup value directly
                    if (all_currency_total && Object.keys(all_currency_total).length > 0) {
                        // Merge: preserve all existing values, ADD popup values to existing currencies
                        for (const [key, value] of Object.entries(all_currency_total)) {
                            const popupAmount = parseFloat(value) || 0;
                            if (popupAmount > 0 || popupAmount === 0) { // Include 0 values too
                                // Normalize base currency key: "Total" -> "Total ${baseCurrencyName}"
                                let normalizedKey = key;
                                if (key === 'Total' && baseCurrencyName) {
                                    normalizedKey = `Total ${baseCurrencyName}`;
                                }
                                
                                // If currency already exists, ADD the popup value to existing value
                                if (currentInputValues[normalizedKey] !== undefined) {
                                    const existingAmount = parseFloat(currentInputValues[normalizedKey]) || 0;
                                    currentInputValues[normalizedKey] = existingAmount + popupAmount;
                                } else {
                                    // If currency doesn't exist, use popup value directly
                                    currentInputValues[normalizedKey] = popupAmount;
                                }
                            }
                        }
                    } else {
                        // If no all_currency_total from popup, update only the target currency from total
                        if (isBaseCurrency) {
                            const existingBase = parseFloat(currentInputValues[`Total ${baseCurrencyName}`] || 0) || 0;
                            currentInputValues[`Total ${baseCurrencyName}`] = existingBase + (parseFloat(total) || 0);
                        } else if (targetCurrency) {
                            const existingTarget = parseFloat(currentInputValues[`Total ${targetCurrency.name}`] || 0) || 0;
                            currentInputValues[`Total ${targetCurrency.name}`] = existingTarget + (parseFloat(total) || 0);
                        }
                    }
                    
                    // Update all_currency_total with merged values (preserves all currencies)
                    this.all_currency_total = currentInputValues;
                    
                    // Update ALL input fields from merged values (ensures all currencies are displayed)
                    const baseKey = `Total ${baseCurrencyName}`;
                    // Check for base currency in merged values (handle both "Total ${baseCurrencyName}" and "Total" for backward compatibility)
                    const baseAmount = currentInputValues[baseKey] !== undefined 
                        ? parseFloat(currentInputValues[baseKey]) || 0
                        : (currentInputValues['Total'] !== undefined ? parseFloat(currentInputValues['Total']) || 0 : 0);
                    
                    if (baseAmount > 0) {
                        this.state.openingCash = this.env.utils.formatCurrency(baseAmount, false);
                    } else if (currentInputValues[baseKey] !== undefined || currentInputValues['Total'] !== undefined) {
                        // Even if amount is 0, update the field to show 0 (clears any previous value)
                        this.state.openingCash = '';
                    }
                    
                    // Update ALL foreign currency input fields (preserve all existing values)
                    activeCurrencies.forEach(currency => {
                        const key = `Total ${currency.name}`;
                        const amount = currentInputValues[key] || currentInputValues[`Total ${currency.name.toUpperCase()}`];
                        const currencyKey = `openingCash_${currency.id}`;
                        
                        // Always update from merged values if available
                        if (amount !== undefined && amount !== null) {
                            const amountValue = parseFloat(amount) || 0;
                            // Update with merged value (this preserves all currencies from currentInputValues)
                            this.state[currencyKey] = amountValue > 0 ? this.env.utils.formatCurrency(amountValue, false) : '';
                        } else {
                            // If amount is undefined in merged values, preserve current input field value
                            // This happens when a currency wasn't in the merge, so we keep what's already there
                            const currentValue = this.state[currencyKey];
                            if (currentValue === undefined || currentValue === null) {
                                this.state[currencyKey] = '';
                            }
                            // Otherwise, leave it as is (preserve existing value)
                        }
                    });
                    
                    // Update notes from merged values (this includes all currencies)
                    this.updateOpeningNotes();
                }
            },
            context: "Opening",
        });
    },

    handleInputChange() {
        /**
         * Handle input change for base currency opening cash.
         * Updates notes with currency breakdown.
         */
        if (!this.env.utils.isValidFloat(this.state.openingCash)) {
            return;
        }
        // Update notes with currency breakdown
        this.updateOpeningNotes();
    },

});