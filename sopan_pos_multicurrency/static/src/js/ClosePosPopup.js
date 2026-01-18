/** @odoo-module */

import { ClosePosPopup } from "@point_of_sale/app/components/popups/closing_popup/closing_popup";
import { MoneyDetailsPopup } from "@point_of_sale/app/components/popups/money_details_popup/money_details_popup";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { ConnectionLostError } from "@web/core/network/rpc";
import { ask } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

let new_props = ['oc_details']
let extended = [...ClosePosPopup.props, ...new_props];

patch(ClosePosPopup, {
    props: extended
});

 /// Helper functions
function resolveCurrency(pos, currencyOrId) {
    if (!currencyOrId) return null;
    if (typeof currencyOrId === "object") return currencyOrId;
    return pos?.models?.["res.currency"]?.get?.(currencyOrId) || null;
}

function parseCurrencyString(str) {
    if (str == null) return 0;
    if (typeof str === "number") return str;
    if (typeof str !== "string") return 0;
    // Remove grouping separators and any non-numeric chars except '.' and '-'
    const cleaned = str.replace(/,/g, "").replace(/[^\d.-]/g, "");
    return parseFloat(cleaned) || 0;
}

function findCurrencyByName(pos, currencyName) {
    if (!pos?.models?.["res.currency"]) return null;
    let currencies = [];
    try {
        currencies = pos.models["res.currency"].getAll?.() || 
                     pos.models["res.currency"].all || 
                     Object.values(pos.models["res.currency"].records || {});
    } catch (e) {
    }
    return currencies.find(c => c?.name?.toUpperCase() === currencyName.toUpperCase()) || null;
}

function getPaymentMethodCurrency(pos, paymentMethod) {
    let cur = paymentMethod?.currency_of_cash_control;
    
    if (Array.isArray(cur) && cur.length > 0) {
        cur = cur[0];
    }
    
    if (!cur && paymentMethod?.id && pos?.models?.["pos.payment.method"]) {
        try {
            const fullPaymentMethod = pos.models["pos.payment.method"].get?.(paymentMethod.id);
            if (fullPaymentMethod) {
                let modelCur = fullPaymentMethod.currency_of_cash_control;
                if (Array.isArray(modelCur) && modelCur.length > 0) {
                    modelCur = modelCur[0];
                }
                if (modelCur) {
                    cur = modelCur;
                }
            }
        } catch (e) {
        }
    }
    
    if (!cur) {
        return pos?.currency;
    }
    
    let resolved = resolveCurrency(pos, cur);
    if (!resolved) {
        let currencyId = null;
        if (typeof cur === 'object' && cur.id) {
            currencyId = cur.id;
        } else if (typeof cur === 'number') {
            currencyId = cur;
        } else if (typeof cur === 'string' && !isNaN(cur)) {
            currencyId = Number(cur);
        }
        if (currencyId) {
            resolved = pos?.models?.["res.currency"]?.get?.(currencyId) || null;
        }
    }
    
    return resolved || pos?.currency;
}

patch(ClosePosPopup.prototype, {
    async setup() {
        super.setup();
        // State is already initialized with useState in base class
        // Just ensure currencyCounts exists
        if (!this.state.currencyCounts) {
            this.state.currencyCounts = {};
        }
        // Initialize notes if not already set
        if (this.state.notes === undefined || this.state.notes === null) {
            this.state.notes = '';
        }
        this._cashMovementsCurrencyInfo = {};
        this._currencyInfoLoaded = false;
        this._currencyInfoPromise = null;
        this._openingByCurrencyId = null; // {currency_id: opening_total}
        this.all_currency_total = {}; // Initialize for coins popup values
        this._validationNotes = {}; // Track validation messages per currency
        this._currencyGroupsCache = []; // Cache for currency groups to avoid async issues - initialize as empty array
        
        // Initialize currencyGroups in state (reactive) so template can access it
        if (!this.state.currencyGroups) {
            this.state.currencyGroups = [];
        }

        // IMPORTANT: Bank "count" differences should not block closing.
        // We auto-fill bank counted = bank collected amount so diff is 0 (and we hide the inputs in XML).
        try {
            if (this.props?.non_cash_payment_methods && Array.isArray(this.props.non_cash_payment_methods)) {
                for (const pm of this.props.non_cash_payment_methods) {
                    if (pm?.type === "bank" && pm?.id) {
                        if (!this.state.payments) this.state.payments = {};
                        if (!this.state.payments[pm.id]) this.state.payments[pm.id] = {};
                        // Store as a plain numeric string (no currency symbol) to satisfy isValidFloat.
                        this.state.payments[pm.id].counted = String(pm.amount || 0);
                    }
                }
            }
        } catch (e) {
            // ignore
        }
        
        await this._loadCashMovementsCurrencyInfo();
        // Populate currency groups cache during setup so template has data
        try {
            const groups = await this.getPaymentMethodsByCurrency();
            this._currencyGroupsCache = groups || [];
            // Update state to trigger template re-render
            this.state.currencyGroups = groups || [];
        } catch (error) {
            this._currencyGroupsCache = [];
            this.state.currencyGroups = [];
        }
    },

    async _loadCashMovementsCurrencyInfo() {
        const session = this.pos?.session;
        if (!session || !session.id) {
            this._cashMovementsCurrencyInfo = {};
            this._currencyInfoLoaded = true;
            return;
        }
        
        if (this._currencyInfoPromise) {
            return this._currencyInfoPromise;
        }
        
        this._currencyInfoPromise = (async () => {
            try {
                const [currencyInfoResult, openingFromServer] = await Promise.all([
                    this.pos.data.call("pos.session", "get_cash_movements_with_currency", [session.id]),
                    this.pos.data.call("pos.session", "get_opening_balances_by_currency", [session.id]),
                ]);
                
                this._cashMovementsCurrencyInfo = currencyInfoResult || {};
                this._currencyInfoLoaded = true;

                // Build dynamic opening balance map from loaded `other.currency.opening.balance` records.
                // This supports any currencies (USD base + EUR/AED/IQD etc) without hardcoding.
                const openingMap = {};
                // Prefer authoritative server result
                if (openingFromServer && typeof openingFromServer === "object") {
                    for (const [cid, amt] of Object.entries(openingFromServer)) {
                        const currencyId = Number(cid);
                        if (currencyId) {
                            openingMap[currencyId] = parseFloat(amt) || 0;
                        }
                    }
                }
                try {
                    const lines = this.pos?.models?.["other.currency.opening.balance"]?.getAll?.() || [];
                    for (const l of lines) {
                        const currencyId = Array.isArray(l.currency_id) ? l.currency_id[0] : (l.currency_id?.id || l.currency_id);
                        if (currencyId) {
                            // Don't overwrite server values if present
                            if (openingMap[currencyId] == null) {
                                openingMap[currencyId] = parseFloat(l.opening_total) || 0;
                            }
                        }
                    }
                } catch (e) {
                    // Fallback: session may carry oc_opening_bal_ids in some loads
                    const lines = session.oc_opening_bal_ids || [];
                    for (const l of lines) {
                        const currencyId = Array.isArray(l.currency_id) ? l.currency_id[0] : (l.currency_id?.id || l.currency_id);
                        if (currencyId) {
                            if (openingMap[currencyId] == null) {
                                openingMap[currencyId] = parseFloat(l.opening_total) || 0;
                            }
                        }
                    }
                }
                this._openingByCurrencyId = openingMap;
            } catch (error) {
                this._cashMovementsCurrencyInfo = {};
                this._currencyInfoLoaded = true;
            } finally {
                this._currencyInfoPromise = null;
            }
        })();
        
        return this._currencyInfoPromise;
    },

    async getPaymentMethodsByCurrency() {
        try {
            // CRITICAL: Ensure currency info is loaded before processing cash movements
            // This is essential for correct currency categorization
            // If not loaded yet, wait for it (but don't block if it fails)
            if (!this._currencyInfoLoaded) {
                if (this._currencyInfoPromise) {
                    try {
                        // Wait for currency info to load (with timeout to avoid hanging)
                        await Promise.race([
                            this._currencyInfoPromise,
                            new Promise(resolve => setTimeout(resolve, 1000)) // 1 second timeout
                        ]);
                    } catch (e) {
                        // Continue anyway - we have fallback logic using foreign_currency_id from moves
                    }
                } else {
                    // If promise doesn't exist, try to load it now (but don't wait too long)
                    try {
                        await Promise.race([
                            this._loadCashMovementsCurrencyInfo(),
                            new Promise(resolve => setTimeout(resolve, 500)) // 500ms timeout
                        ]);
                    } catch (e) {
                        // Continue anyway - we have fallback logic using foreign_currency_id from moves
                    }
                }
            }
            
            // Return cached result if available and currency info hasn't changed
            // Only return if cache is non-empty (empty array means we need to compute)
            if (this._currencyGroupsCache && Array.isArray(this._currencyGroupsCache) && this._currencyGroupsCache.length > 0 && this._currencyInfoLoaded) {
                return this._currencyGroupsCache;
            }
            
            const currencyGroups = {};
            const baseCurrency = this.pos?.currency;
            const session = this.pos?.session || null;

            if (!this.pos || !baseCurrency) {
                return [];
            }
            

            const getCurrencyId = (currency) => {
                if (!currency) return baseCurrency?.id;
                const id = typeof currency === "object" ? currency.id : currency;
                return id != null ? Number(id) : id;
            };
            
            // Helper function to round difference and handle floating point precision issues
            const roundDifference = (counted, expected) => {
                const diff = counted - expected;
                // Round to 2 decimal places to handle floating point precision
                const rounded = Math.round(diff * 100) / 100;
                // If the absolute difference is very small (less than 0.01), treat as zero
                if (Math.abs(rounded) < 0.01) {
                    return 0;
                }
                return rounded;
            };

            // Process default cash details - ALWAYS create base currency group
            if (this.props.default_cash_details) {
                const defaultCurrency = getPaymentMethodCurrency(this.pos, this.props.default_cash_details);
                const defaultCashCurrencyId = getCurrencyId(defaultCurrency);
                const currencyId = defaultCashCurrencyId;
                
                
                if (!currencyGroups[currencyId]) {
                    currencyGroups[currencyId] = {
                        currency: defaultCurrency || baseCurrency,
                        paymentMethods: [],
                        opening: 0,
                        cashMovements: [],
                        cashMovementsTotal: 0,
                        paymentsCollected: 0,
                        // DISPLAY ONLY: bank payments collected (do NOT affect cash expected ending / difference)
                        bankPaymentsCollected: 0,
                        changeAmount: 0, // Add change amount field
                        expectedEnding: 0,
                        // DISPLAY ONLY: cash expected ending + bank payments (for user reference)
                        expectedEndingWithBank: 0,
                        counted: 0,
                        difference: 0,
                    };
                }

                const group = currencyGroups[currencyId];
                group.paymentMethods.push(this.props.default_cash_details);
                
                const currencyName = defaultCurrency?.name?.toUpperCase();
                
                if (currencyId === getCurrencyId(baseCurrency)) {
                    const baseId = getCurrencyId(baseCurrency);
                    const opening = this._openingByCurrencyId?.[baseId];
                    if (opening != null) {
                        group.opening = parseFloat(opening) || 0;
                    } else if (this.props.default_cash_details?.opening != null) {
                        group.opening = parseFloat(this.props.default_cash_details.opening) || 0;
                    } else {
                        group.opening = 0;
                    }
                    
                    // DO NOT add foreign currency openings to base currency group
                    // Each currency group should only show its own opening balance
                    // Foreign currencies will have their own groups created separately
                } else {
                    const opening = this._openingByCurrencyId?.[currencyId];
                    group.opening = opening != null ? opening : (this.props.default_cash_details.opening ?? 0);
                }
                
                // Only add payment_amount if this is the base currency group
                // Foreign currency payments are handled separately
                if (currencyId === getCurrencyId(baseCurrency) && this.props.default_cash_details.payment_amount) {
                    group.paymentsCollected += this.props.default_cash_details.payment_amount || 0;
                }

                // Bank payments are filled later from `bankPaymentsByCurrency` (display only).
                
                // Initialize changeAmount if not set
                if (group.changeAmount === undefined) {
                    group.changeAmount = 0;
                }
                
                // If change_amount is available from default_cash_details, use it (will be updated later from changeByCurrency)
                // CRITICAL: Change is ALWAYS in base currency, so only set it for base currency group
                if (currencyId === getCurrencyId(baseCurrency) && this.props.default_cash_details.change_amount) {
                    group.changeAmount = -Math.abs(this.props.default_cash_details.change_amount);
                } else {
                    group.changeAmount = 0; // Foreign currency groups don't have change
                }
                
                // Expected ending = Opening + Payments Collected - Change + Cash Movements
                // Note: changeAmount is already negative, so we add it (subtracting change)
                group.expectedEnding = group.opening + group.paymentsCollected + (group.changeAmount || 0) + group.cashMovementsTotal;
                group.expectedEndingWithBank = group.expectedEnding + (group.bankPaymentsCollected || 0);
                
                if (currencyId === getCurrencyId(baseCurrency)) {
                    // CRITICAL: Use actual TZS counted from currencyCounts, NOT the converted total from state.payments
                    // The converted total (from _updateBaseCurrencyCashCount) is for display only, not for base_ending_cash
                    const stateCounted = this.state.currencyCounts?.[currencyId];
                    if (stateCounted !== undefined && stateCounted !== null && stateCounted !== "") {
                        group.counted = parseCurrencyString(stateCounted);
                    } else {
                        // Fallback: use state.payments (but this might be the converted total, so prefer currencyCounts)
                        const countedStr = this.state.payments?.[this.props.default_cash_details.id]?.counted || "0";
                        group.counted = parseCurrencyString(countedStr);
                    }
                } else {
                    group.counted = 0;
                }
                
                const expectedForDiff = group.expectedEndingWithBank != null
                    ? group.expectedEndingWithBank
                    : (group.expectedEnding + (group.bankPaymentsCollected || 0));
                group.difference = roundDifference(group.counted, expectedForDiff);
            }

            // Process other cash payment methods
            // IMPORTANT: These are already included in paymentsByCurrency calculation above
            // We just need to create/update the currency groups and set paymentsCollected from paymentsByCurrency
            // CRITICAL: Exclude bank payment methods (mobile money, etc.) - they should not appear in cash control
            if (this.props.non_cash_payment_methods) {
                this.props.non_cash_payment_methods.forEach((pm, idx) => {
                    // Only include cash payment methods (exclude bank type like mobile money)
                    if (pm.type === 'cash' && pm.is_cash_count && pm.currency_of_cash_control) {
                        const pmCurrency = getPaymentMethodCurrency(this.pos, pm);
                        const currencyId = getCurrencyId(pmCurrency);
                        
                        
                        if (!currencyGroups[currencyId]) {
                            currencyGroups[currencyId] = {
                                currency: pmCurrency || baseCurrency,
                                paymentMethods: [],
                                opening: 0,
                                cashMovements: [],
                                cashMovementsTotal: 0,
                                paymentsCollected: 0,
                                changeAmount: 0, // Add change amount field
                                expectedEnding: 0,
                                expectedEndingWithBank: 0,
                                counted: 0,
                                difference: 0,
                            };
                        }

                        const group = currencyGroups[currencyId];
                        group.paymentMethods.push(pm);
                        
                        const currencyName = pmCurrency?.name?.toUpperCase();
                        
                        if (currencyId === getCurrencyId(baseCurrency)) {
                            const opening = this._openingByCurrencyId?.[currencyId];
                            group.opening = opening != null ? opening : 0;
                        } else {
                            const opening = this._openingByCurrencyId?.[currencyId];
                            group.opening = opening != null ? opening : 0;
                        }
                        
                        // Payments collected will be set from paymentsByCurrency after calculation
                    }
                });
            }

            // Calculate payments collected per currency from all payment methods
            // This must be done AFTER processing groups to ensure all payment methods are considered
            // IMPORTANT: Group by payment method's currency_of_cash_control, not base currency
            const paymentsByCurrency = {};
            const changeByCurrency = {}; // Track change amounts per currency

            // Payment lines always store `amount` in base currency.
            // For foreign-currency payment methods, this module stores the entered foreign amount in:
            // - `currency_amount_total` (preferred)
            // - `payment_currency_rate` (for conversion fallback)
            const getPaymentAmountInCurrency = (payment, pmCurrencyId) => {
                const baseCurrencyId = getCurrencyId(baseCurrency);
                const amountBase = payment?.amount || 0;
                if (!pmCurrencyId || pmCurrencyId === baseCurrencyId) {
                    return amountBase;
                }
                // Prefer explicit foreign amount stored on the payment line
                const foreignStored = payment?.currency_amount_total;
                if (foreignStored != null && foreignStored !== 0) {
                    return foreignStored;
                }
                // Fallback: compute from base using stored rate (or currency rate)
                let rate = payment?.payment_currency_rate;
                if (!rate || rate === 0) {
                    const currencyObj = resolveCurrency(this.pos, pmCurrencyId);
                    rate = currencyObj?.rate || 1;
                }
                // If rate < 1: foreign = base * rate, else foreign = base / rate
                return rate < 1 ? amountBase * rate : amountBase / rate;
            };
            
            // Process orders to get actual payments and change
            // IMPORTANT: Get change payments from orders (is_change=True)
            const allOrders = this.pos.models["pos.order"]?.getAll?.() || [];
            const ordersHavePayments = allOrders.some(
                (o) => (o.state === "paid" || o.state === "done") && o.payment_ids && o.payment_ids.length
            );
            // BANK payments by currency (DISPLAY ONLY; not included in expected cash).
            const bankPaymentsByCurrency = {};
            allOrders.forEach(order => {
                if (order.state === 'paid' || order.state === 'done') {
                    order.payment_ids.forEach(payment => {
                        // Resolve payment method record reliably (payment_method_id can be id/array/object)
                        const pmField = payment.payment_method_id;
                        const pmId = Array.isArray(pmField) ? pmField[0] : (pmField?.id || pmField);
                        const pm = this.pos?.models?.["pos.payment.method"]?.get?.(pmId) || (typeof pmField === "object" ? pmField : null);
                        const pmType = pm?.type;

                        const baseCurrencyId = getCurrencyId(baseCurrency);

                        // BANK payments: track separately for display in their currency group.
                        if (pmType === "bank") {
                            if (payment.is_change) {
                                return;
                            }
                            const payCurField = payment.payment_currency_id;
                            const payCurId = Array.isArray(payCurField)
                                ? payCurField[0]
                                : (payCurField?.id || payCurField);
                            const pmCur = getPaymentMethodCurrency(this.pos, pm);
                            const pmCurId = getCurrencyId(pmCur);
                            const targetCurrencyId = payCurId || pmCurId || baseCurrencyId;
                            if (!bankPaymentsByCurrency[targetCurrencyId]) {
                                bankPaymentsByCurrency[targetCurrencyId] = 0;
                            }
                            let amountInTarget = 0;
                            if (targetCurrencyId === baseCurrencyId) {
                                amountInTarget = payment.amount || 0;
                            } else if (payment.currency_amount_total != null && payment.currency_amount_total !== 0) {
                                amountInTarget = payment.currency_amount_total;
                            } else {
                                // Fallback: convert base amount to target currency using currency rate.
                                // POS semantics in this module:
                                // - rate         = foreign per 1 base
                                // - inverse_rate = base per 1 foreign
                                const currencyObj = resolveCurrency(this.pos, targetCurrencyId);
                                const baseAmount = payment.amount || 0;
                                if (currencyObj?.rate && currencyObj.rate > 0) {
                                    // foreign = base * (foreign per base)
                                    amountInTarget = baseAmount * currencyObj.rate;
                                } else if (currencyObj?.inverse_rate && currencyObj.inverse_rate > 0) {
                                    // foreign = base / (base per foreign)
                                    amountInTarget = baseAmount / currencyObj.inverse_rate;
                                } else {
                                    amountInTarget = getPaymentAmountInCurrency(payment, targetCurrencyId) || 0;
                                }
                            }
                            bankPaymentsByCurrency[targetCurrencyId] += amountInTarget;
                            return;
                        }

                        // Only CASH drawers contribute to per-currency cash control.
                        if (pmType !== "cash") {
                            return;
                        }

                        // Track change separately (always base currency)
                        if (payment.is_change) {
                            if (!changeByCurrency[baseCurrencyId]) {
                                changeByCurrency[baseCurrencyId] = 0;
                            }
                            changeByCurrency[baseCurrencyId] += Math.abs(payment.amount || 0);
                            return;
                        }

                        // Determine the actual payment currency for display/collection.
                        // Prefer payment_currency_id stored on pos.payment; fallback to payment method currency.
                        const payCurField = payment.payment_currency_id;
                        const payCurId = Array.isArray(payCurField)
                            ? payCurField[0]
                            : (payCurField?.id || payCurField);
                        const targetCurrencyId = payCurId || getCurrencyId(getPaymentMethodCurrency(this.pos, pm)) || baseCurrencyId;

                        if (!paymentsByCurrency[targetCurrencyId]) {
                            paymentsByCurrency[targetCurrencyId] = 0;
                        }

                        let amountInTarget = 0;
                        if (targetCurrencyId === baseCurrencyId) {
                            amountInTarget = payment.amount || 0;
                        } else if (payment.currency_amount_total != null && payment.currency_amount_total !== 0) {
                            amountInTarget = payment.currency_amount_total;
                        } else {
                            amountInTarget = getPaymentAmountInCurrency(payment, targetCurrencyId) || 0;
                        }

                        paymentsByCurrency[targetCurrencyId] += amountInTarget;
                    });
                }
            });
            
            // Process default_cash_details - use currency_of_cash_control to identify currency
            // NOTE: This is ONLY a fallback when orders/payments are not available in the frontend.
            if (!ordersHavePayments && this.props.default_cash_details && this.props.default_cash_details.payment_amount) {
                // Get currency from payment method's currency_of_cash_control field
                const defaultCurrency = getPaymentMethodCurrency(this.pos, this.props.default_cash_details);
                const defaultCurrencyId = getCurrencyId(defaultCurrency);
                
                // If no currency_of_cash_control, default to base currency
                const targetCurrencyId = defaultCurrencyId || getCurrencyId(baseCurrency);
                
                if (!paymentsByCurrency[targetCurrencyId]) {
                    paymentsByCurrency[targetCurrencyId] = 0;
                }
                
                // Convert amount to target currency if needed
                let amountInTargetCurrency = this.props.default_cash_details.payment_amount || 0;
                if (defaultCurrency && defaultCurrencyId !== getCurrencyId(baseCurrency)) {
                    // payment_amount is in base currency, convert to foreign currency
                    const rate = defaultCurrency.rate || 1;
                    // If rate < 1: multiply (e.g., 0.0004), if rate >= 1: divide (e.g., 2200)
                    amountInTargetCurrency = rate < 1 ? amountInTargetCurrency * rate : amountInTargetCurrency / rate;
                }
                
                // Add payment amount in the target currency (only if not already set from orders)
                if (paymentsByCurrency[targetCurrencyId] === 0) {
                paymentsByCurrency[targetCurrencyId] += amountInTargetCurrency;
                }
            }
            
            // Also get change_amount from default_cash_details if available (backend provides it)
            // CRITICAL: Change is ALWAYS in base currency (TZS), regardless of payment method currency
            if (!Object.keys(changeByCurrency).length && this.props.default_cash_details && this.props.default_cash_details.change_amount) {
                // Always use base currency for change
                const baseCurrencyId = getCurrencyId(baseCurrency);
                
                if (!changeByCurrency[baseCurrencyId]) {
                    changeByCurrency[baseCurrencyId] = 0;
                }
                // Backend provides change_amount as positive in base currency, but we need to show it as negative
                changeByCurrency[baseCurrencyId] = Math.abs(this.props.default_cash_details.change_amount);
            }
            
            // Process cash payment methods only (fallback when orders/payments are not available in frontend)
            // CRITICAL: Only process CASH payment methods, exclude bank payment methods (mobile money, etc.)
            // NOTE: This is ONLY a fallback when orders/payments are not available in the frontend.
            if (!ordersHavePayments && this.props.non_cash_payment_methods) {
                this.props.non_cash_payment_methods.forEach(pm => {
                    // CRITICAL: Only process cash payment methods (exclude bank type like mobile money)
                    // Non-cash payment methods prop includes all PMs except default cash, but we only want cash PMs here
                    if (pm.type !== 'cash' || !pm.is_cash_count) {
                        return; // Skip bank and non-cash-count payment methods
                    }
                    // Process only cash payment methods that have amount
                    if (pm.amount && pm.amount !== 0) {
                        // Get currency from payment method's currency_of_cash_control field
                        const pmCurrency = getPaymentMethodCurrency(this.pos, pm);
                        const pmCurrencyId = getCurrencyId(pmCurrency);
                        
                        // If payment method has currency_of_cash_control, use that currency
                        // If not, default to base currency
                        const targetCurrencyId = pmCurrencyId || getCurrencyId(baseCurrency);
                        
                        if (!paymentsByCurrency[targetCurrencyId]) {
                            paymentsByCurrency[targetCurrencyId] = 0;
                        }
                        
                        // Convert amount to target currency if needed
                        let amountInTargetCurrency = pm.amount;
                        if (pmCurrency && pmCurrencyId !== getCurrencyId(baseCurrency)) {
                            // pm.amount is in base currency, convert to foreign currency
                            const rate = pmCurrency.rate || 1;
                            // If rate < 1: multiply (e.g., 0.0004), if rate >= 1: divide (e.g., 2200)
                            amountInTargetCurrency = rate < 1 ? pm.amount * rate : pm.amount / rate;
                        }
                        
                        // Add amount in the target currency
                        paymentsByCurrency[targetCurrencyId] += amountInTargetCurrency;
                    }
                });
            }

            // Process bank payment methods (fallback when orders/payments are not available in frontend)
            // This is needed after a browser refresh: the in-memory paid orders are not present,
            // but backend props still provide per-payment-method totals (`pm.amount`).
            if (!ordersHavePayments && this.props.non_cash_payment_methods) {
                this.props.non_cash_payment_methods.forEach((pm) => {
                    if (pm.type !== "bank") {
                        return;
                    }
                    if (!pm.amount || pm.amount === 0) {
                        return;
                    }
                    const baseCurrencyId = getCurrencyId(baseCurrency);
                    const pmCur = getPaymentMethodCurrency(this.pos, pm);
                    const pmCurId = getCurrencyId(pmCur);
                    const targetCurrencyId = pmCurId || baseCurrencyId;

                    if (!bankPaymentsByCurrency[targetCurrencyId]) {
                        bankPaymentsByCurrency[targetCurrencyId] = 0;
                    }

                    let amountInTarget = pm.amount; // pm.amount is in base currency
                    if (targetCurrencyId !== baseCurrencyId) {
                        const currencyObj = resolveCurrency(this.pos, targetCurrencyId);
                        if (currencyObj?.rate && currencyObj.rate > 0) {
                            // foreign = base * (foreign per base)
                            amountInTarget = pm.amount * currencyObj.rate;
                        } else if (currencyObj?.inverse_rate && currencyObj.inverse_rate > 0) {
                            // foreign = base / (base per foreign)
                            amountInTarget = pm.amount / currencyObj.inverse_rate;
                        }
                    }

                    bankPaymentsByCurrency[targetCurrencyId] += amountInTarget;
                });
            }

            // Create currency groups for ALL foreign currencies that have payments or opening
            // This works generically for USD, EUR, and any other currency
            // NOTE: We do this even if session doesn't exist, to create groups from payment methods
            if (true) {
                // Dynamic opening balances: use the map built from `other.currency.opening.balance`
                const currencyOpenings = { ...(this._openingByCurrencyId || {}) };
                // Safety fallback: session may carry oc_opening_bal_ids
                if (session?.oc_opening_bal_ids && Array.isArray(session.oc_opening_bal_ids)) {
                    session.oc_opening_bal_ids.forEach((oc) => {
                        if (oc.currency_id && oc.opening_total != null) {
                            const currencyId = getCurrencyId(oc.currency_id);
                            if (currencyId) {
                                currencyOpenings[currencyId] = (currencyOpenings[currencyId] || 0) + (oc.opening_total || 0);
                            }
                        }
                    });
                }
                
                // Get all unique currencies from paymentsByCurrency
                const allCurrencyIds = new Set();
                Object.keys(paymentsByCurrency).forEach(id => {
                    if (paymentsByCurrency[id] > 0) {
                        allCurrencyIds.add(Number(id));
                    }
                });
                
                // Add currencies that have opening balances
                Object.keys(currencyOpenings).forEach(id => {
                    allCurrencyIds.add(Number(id));
                });
                
                // CRITICAL: Also add currencies from payment methods that have currency_of_cash_control
                // This ensures groups are created even if there are no payments/opening balances yet
                if (this.props.non_cash_payment_methods) {
                    this.props.non_cash_payment_methods.forEach(pm => {
                        if (pm.currency_of_cash_control) {
                            const pmCurrency = getPaymentMethodCurrency(this.pos, pm);
                            if (pmCurrency) {
                                const pmCurrencyId = getCurrencyId(pmCurrency);
                                if (pmCurrencyId && pmCurrencyId !== getCurrencyId(baseCurrency)) {
                                    allCurrencyIds.add(pmCurrencyId);
                                }
                            }
                        }
                    });
                }
                
                // Also check default_cash_details for currency_of_cash_control
                if (this.props.default_cash_details && this.props.default_cash_details.currency_of_cash_control) {
                    const defaultCurrency = getPaymentMethodCurrency(this.pos, this.props.default_cash_details);
                    if (defaultCurrency) {
                        const defaultCurrencyId = getCurrencyId(defaultCurrency);
                        if (defaultCurrencyId && defaultCurrencyId !== getCurrencyId(baseCurrency)) {
                            allCurrencyIds.add(defaultCurrencyId);
                        }
                    }
                }
                
                
                // Create currency groups for all currencies (even if no payments/opening)
                allCurrencyIds.forEach(currencyId => {
                    // Skip base currency (already handled)
                    if (currencyId === getCurrencyId(baseCurrency)) {
                        return;
                    }
                    
                    // Get currency object
                    const currency = this.pos.models["res.currency"]?.get?.(currencyId);
                    if (!currency) {
                        return;
                    }
                    
                    const opening = currencyOpenings[currencyId] || 0;
                    const paymentsCollected = paymentsByCurrency[currencyId] || 0;
                    
                    
                    // Create group even if opening and payments are 0 (for cash movements)
                    if (!currencyGroups[currencyId]) {
                        currencyGroups[currencyId] = {
                            currency: currency,
                            paymentMethods: [],
                            opening: opening,
                            cashMovements: [],
                            cashMovementsTotal: 0,
                            paymentsCollected: paymentsCollected,
                                changeAmount: 0, // Add change amount field
                                expectedEnding: opening + paymentsCollected, // Will be updated after change is calculated
                                expectedEndingWithBank: opening + paymentsCollected, // display-only (bank added later)
                            counted: 0,
                            difference: 0,
                        };
                    } else {
                        // Update existing group with opening amount and payments
                        currencyGroups[currencyId].opening = opening;
                        currencyGroups[currencyId].paymentsCollected = paymentsCollected;
                        // Initialize changeAmount if not set
                        if (currencyGroups[currencyId].changeAmount === undefined) {
                            currencyGroups[currencyId].changeAmount = 0;
                        }
                        // Expected ending = Opening + Payments Collected - Change + Cash Movements
                        currencyGroups[currencyId].expectedEnding = opening + paymentsCollected + (currencyGroups[currencyId].changeAmount || 0) + currencyGroups[currencyId].cashMovementsTotal;
                        currencyGroups[currencyId].expectedEndingWithBank =
                            currencyGroups[currencyId].expectedEnding + (currencyGroups[currencyId].bankPaymentsCollected || 0);
                    }
                });
            }

            // Now update all currency groups with payments collected from paymentsByCurrency,
            // bank payments (display only) from bankPaymentsByCurrency, and change amounts.
            // CRITICAL: Change is ALWAYS in base currency (TZS), so only add it to base currency group
            const baseCurrencyId = getCurrencyId(baseCurrency);
            Object.keys(currencyGroups).forEach(currencyIdStr => {
                const currencyId = Number(currencyIdStr);
                const group = currencyGroups[currencyId];
                if (paymentsByCurrency[currencyId]) {
                    group.paymentsCollected = paymentsByCurrency[currencyId];
                }
                if (bankPaymentsByCurrency[currencyId]) {
                    group.bankPaymentsCollected = bankPaymentsByCurrency[currencyId];
                } else {
                    group.bankPaymentsCollected = 0;
                }
                // Add change amount ONLY to base currency group (change is always in base currency)
                if (currencyId === baseCurrencyId && changeByCurrency[baseCurrencyId]) {
                    group.changeAmount = -changeByCurrency[baseCurrencyId]; // Negative for display
                } else {
                    group.changeAmount = 0; // Foreign currency groups don't have change
                }
                // Recalculate expected ending: Opening + Payments Collected - Change + Cash Movements
                // Note: changeAmount is already negative, so we add it (which subtracts change)
                group.expectedEnding = group.opening + group.paymentsCollected + (group.changeAmount || 0) + group.cashMovementsTotal;
                group.expectedEndingWithBank = group.expectedEnding + (group.bankPaymentsCollected || 0);
            });

            // Process cash movements from ALL payment methods
            // Collect moves from default_cash_details and all non_cash_payment_methods
            const allMoves = [];
            let moveIndex = 0;
            
            // Add moves from default cash details
            if (this.props.default_cash_details?.moves) {
                this.props.default_cash_details.moves.forEach(move => {
                    allMoves.push({ ...move, _source_pm: this.props.default_cash_details });
                });
            }
            
            // Add moves from all other payment methods
            if (this.props.non_cash_payment_methods) {
                this.props.non_cash_payment_methods.forEach(pm => {
                    if (pm.moves && Array.isArray(pm.moves)) {
                        pm.moves.forEach(move => {
                            allMoves.push({ ...move, _source_pm: pm });
                        });
                    }
                });
            }
            
            const currencyInfoMap = this._cashMovementsCurrencyInfo || {};
            
            if (allMoves && allMoves.length > 0) {
                allMoves.forEach((move, index) => {
                    const moveAmountBase = move.amount || 0;
                    const moveAmountAbs = Math.abs(moveAmountBase);
                    const isCashOut = moveAmountBase < 0;
                    
                    // USE foreign_currency_id DIRECTLY FROM STATEMENT LINE (most reliable)
                    // This field is ALWAYS available from backend, so it works even if currency info isn't loaded yet
                    let targetCurrencyId = null;
                    let moveAmountInCurrency = moveAmountAbs;
                    
                    // PRIORITY 1: Use foreign_currency_id directly from statement line (most reliable)
                    // This field is ALWAYS available from backend, so it works even if currency info isn't loaded yet
                    if (move.foreign_currency_id) {
                        targetCurrencyId = Number(move.foreign_currency_id);
                        
                        // CRITICAL: Use other_curr_amt if available and non-zero (foreign currency amount)
                        // If not available or zero, convert base amount to foreign currency
                        if (move.other_curr_amt != null && move.other_curr_amt !== 0 && move.other_curr_amt !== '0') {
                            moveAmountInCurrency = Math.abs(Number(move.other_curr_amt));
                        } else {
                            // Convert base currency amount to foreign currency
                            const foreignCurrency = resolveCurrency(this.pos, targetCurrencyId);
                            if (foreignCurrency) {
                                // Dynamic module semantics:
                                // - rate         = foreign per 1 base
                                // - inverse_rate = base per 1 foreign
                                if (foreignCurrency.rate && foreignCurrency.rate > 0) {
                                    // base -> foreign
                                    moveAmountInCurrency = moveAmountAbs * foreignCurrency.rate;
                                } else if (foreignCurrency.inverse_rate && foreignCurrency.inverse_rate > 0) {
                                    // base -> foreign
                                    moveAmountInCurrency = moveAmountAbs / foreignCurrency.inverse_rate;
                                } else {
                                    moveAmountInCurrency = moveAmountAbs;
                                }
                            } else {
                                // Fallback: use base amount (shouldn't happen, but better than wrong amount)
                                moveAmountInCurrency = moveAmountAbs;
                            }
                        }
                    }
                    // PRIORITY 2: Get from currency info map by statement line ID
                    else if (move.statement_line_id && currencyInfoMap[`statement_line_${move.statement_line_id}`]) {
                        const currencyInfo = currencyInfoMap[`statement_line_${move.statement_line_id}`];
                        if (currencyInfo && currencyInfo.foreign_currency_id) {
                            targetCurrencyId = Number(currencyInfo.foreign_currency_id);
                            moveAmountInCurrency = currencyInfo.amount_currency || moveAmountAbs;
                        }
                    } 
                    // PRIORITY 3: Get from currency info map by journal ID
                    else if (move.journal_id && currencyInfoMap[`journal_${move.journal_id}`]) {
                        const currencyInfo = currencyInfoMap[`journal_${move.journal_id}`];
                        if (currencyInfo && currencyInfo.foreign_currency_id) {
                            targetCurrencyId = Number(currencyInfo.foreign_currency_id);
                            moveAmountInCurrency = currencyInfo.amount_currency || moveAmountAbs;
                        }
                    } 
                    // PRIORITY 4: Check other_curr or other_curr_symbol fields (if available)
                    else if (move.other_curr && move.other_curr.trim() !== "") {
                        // Try to find currency by name from other_curr field
                        const currencyName = move.other_curr.trim().toUpperCase();
                        const foundCurrency = findCurrencyByName(this.pos, currencyName);
                        if (foundCurrency && foundCurrency.id !== baseCurrency?.id) {
                            targetCurrencyId = getCurrencyId(foundCurrency);
                            // CRITICAL: Use other_curr_amt if available (foreign currency amount)
                            // If not available, convert base amount to foreign currency
                            if (move.other_curr_amt && move.other_curr_amt !== 0) {
                                moveAmountInCurrency = Math.abs(move.other_curr_amt);
                            } else {
                                // Convert base currency amount to foreign currency
                                if (foundCurrency && foundCurrency.rate) {
                                    // base -> foreign
                                    moveAmountInCurrency = moveAmountAbs * foundCurrency.rate;
                                } else {
                                    moveAmountInCurrency = moveAmountAbs;
                                }
                            }
                        }
                    }
                    // PRIORITY 5: Use source payment method's currency_of_cash_control
                    else if (move._source_pm && move._source_pm.currency_of_cash_control) {
                        const sourcePMCurrency = getPaymentMethodCurrency(this.pos, move._source_pm);
                        if (sourcePMCurrency && sourcePMCurrency.id !== baseCurrency?.id) {
                            targetCurrencyId = getCurrencyId(sourcePMCurrency);
                            moveAmountInCurrency = moveAmountAbs;
                        }
                    }
                    // PRIORITY 6: Try to find currency from payment_ref or name in currencyInfoMap
                    else if (move.payment_ref && currencyInfoMap[move.payment_ref]) {
                        const currencyInfo = currencyInfoMap[move.payment_ref];
                        if (currencyInfo && currencyInfo.foreign_currency_id) {
                            targetCurrencyId = Number(currencyInfo.foreign_currency_id);
                            moveAmountInCurrency = currencyInfo.amount_currency || moveAmountAbs;
                        }
                    }
                    // PRIORITY 7: Try to find by name
                    else if (move.name && currencyInfoMap[move.name]) {
                        const currencyInfo = currencyInfoMap[move.name];
                        if (currencyInfo && currencyInfo.foreign_currency_id) {
                            targetCurrencyId = Number(currencyInfo.foreign_currency_id);
                            moveAmountInCurrency = currencyInfo.amount_currency || moveAmountAbs;
                        }
                    }
                    
                    // Default to base currency ONLY if no foreign currency found after all checks
                    if (!targetCurrencyId) {
                        targetCurrencyId = baseCurrency?.id ? Number(baseCurrency.id) : baseCurrency?.id;
                        moveAmountInCurrency = moveAmountAbs;
                    }
                    
                    // Find or create currency group for this currency
                    let targetGroup = currencyGroups[targetCurrencyId];
                    if (!targetGroup) {
                        targetGroup = currencyGroups[String(targetCurrencyId)];
                    }
                    if (!targetGroup) {
                        // Try to find by iterating through groups
                        for (const [key, group] of Object.entries(currencyGroups)) {
                            const groupCurrencyId = group.currency?.id ? Number(group.currency.id) : null;
                            if (groupCurrencyId === targetCurrencyId) {
                                targetGroup = group;
                                break;
                            }
                        }
                    }
                    
                    // CRITICAL FIX: If group doesn't exist, CREATE IT for foreign currencies
                    // This ensures cash movements in USD/EUR are properly categorized even if
                    // those currencies don't have payments or opening balances
                    if (!targetGroup && targetCurrencyId !== getCurrencyId(baseCurrency)) {
                        const moveCurrency = resolveCurrency(this.pos, targetCurrencyId);
                        if (moveCurrency) {
                            // Get opening balance for this currency
                            let opening = 0;
                            if (this._openingByCurrencyId?.[targetCurrencyId] != null) {
                                opening = parseFloat(this._openingByCurrencyId[targetCurrencyId]) || 0;
                            } else if (session?.oc_opening_bal_ids) {
                                const ocBalance = session.oc_opening_bal_ids.find(
                                    (oc) => oc.currency_id && Number(oc.currency_id.id) === targetCurrencyId
                                );
                                if (ocBalance && ocBalance.opening_total != null) {
                                    opening = parseFloat(ocBalance.opening_total) || 0;
                                }
                            }
                            
                            // Get payments collected for this currency
                            const paymentsCollected = paymentsByCurrency[targetCurrencyId] || 0;
                            
                            // Create the currency group
                            targetGroup = {
                                currency: moveCurrency,
                                paymentMethods: [],
                                opening: opening,
                                cashMovements: [],
                                cashMovementsTotal: 0,
                                paymentsCollected: paymentsCollected,
                                expectedEnding: opening + paymentsCollected,
                                counted: 0,
                                difference: 0,
                            };
                            
                            // Add to currencyGroups
                            currencyGroups[targetCurrencyId] = targetGroup;
                            
                        }
                    }
                    
                    // If still no group found, use base currency group as fallback
                    if (!targetGroup) {
                        targetGroup = currencyGroups[getCurrencyId(baseCurrency)];
                    }
                    
                    if (targetGroup) {
                        // Get currency object for display
                        const moveCurrency = targetCurrencyId !== baseCurrency?.id ? resolveCurrency(this.pos, targetCurrencyId) : baseCurrency;
                        
                        // Convert to base currency for display in Cash In/Out Movements section
                        // ALWAYS convert to base currency for display, regardless of which group the move is in
                        // moveAmountInCurrency is in the currency of the move (could be base or foreign)
                        // moveAmountAbs is always in base currency (from move.amount)
                        let baseAmount = moveAmountAbs; // Default: use base amount from move
                        
                        // Check if this is a foreign currency move and convert to base currency
                        // Priority 1: Use other_curr_amt (most reliable - directly from backend)
                        if (move.other_curr_amt != null && move.other_curr_amt !== 0 && move.other_curr_amt !== '0') {
                            const foreignAmount = Math.abs(Number(move.other_curr_amt));
                            console.log(`[Cash Control] Processing move: ${move.name}, other_curr_amt=${move.other_curr_amt}, foreignAmount=${foreignAmount}, moveAmountAbs=${moveAmountAbs}`);
                            
                            // Find the foreign currency ID - try multiple sources in priority order
                            let foreignCurrencyId = null;
                            
                            // Priority 1a: Use foreign_currency_id from move (most reliable)
                            if (move.foreign_currency_id) {
                                const moveForeignId = Number(move.foreign_currency_id);
                                if (moveForeignId && moveForeignId !== baseCurrency?.id) {
                                    foreignCurrencyId = moveForeignId;
                                }
                            }
                            
                            // Priority 1b: Find currency from other_curr field (e.g., "EUR", "USD")
                            if (!foreignCurrencyId && move.other_curr && move.other_curr.trim() !== "") {
                                const foundCurrency = findCurrencyByName(this.pos, move.other_curr.trim().toUpperCase());
                                if (foundCurrency && foundCurrency.id !== baseCurrency?.id) {
                                    foreignCurrencyId = foundCurrency.id;
                                }
                            }
                            
                            // Priority 1c: Try to find currency from journal_id (cash movements with foreign currency payment methods)
                            if (!foreignCurrencyId && move.journal_id) {
                                // Find payment method with this journal
                                const paymentMethod = this.pos.config.payment_method_ids.find(
                                    pm => pm.journal_id && pm.journal_id[0] === move.journal_id
                                );
                                if (paymentMethod && paymentMethod.currency_of_cash_control) {
                                    const pmCurrency = Array.isArray(paymentMethod.currency_of_cash_control) 
                                        ? paymentMethod.currency_of_cash_control[0] 
                                        : paymentMethod.currency_of_cash_control;
                                    if (pmCurrency && pmCurrency !== baseCurrency?.id) {
                                        foreignCurrencyId = pmCurrency;
                                        console.log(`[Cash Control] Found currency from journal payment method: ${pmCurrency}`);
                                    }
                                }
                            }
                            
                            // Priority 1c: Use targetCurrencyId if it's different from base
                            if (!foreignCurrencyId && targetCurrencyId && targetCurrencyId !== baseCurrency?.id) {
                                foreignCurrencyId = targetCurrencyId;
                            }
                            
                            // Priority 1d: Try to find currency from existing currency groups
                            if (!foreignCurrencyId && Object.keys(currencyGroups).length > 0) {
                                for (const [groupId, group] of Object.entries(currencyGroups)) {
                                    if (group.currency && group.currency.id !== baseCurrency?.id) {
                                        // Check if currency name matches other_curr
                                        if (move.other_curr && move.other_curr.trim() !== "") {
                                            const otherCurrUpper = move.other_curr.trim().toUpperCase();
                                            const groupCurrencyName = (group.currency.name || "").toUpperCase();
                                            if (groupCurrencyName === otherCurrUpper || otherCurrUpper.includes(groupCurrencyName) || groupCurrencyName.includes(otherCurrUpper)) {
                                                foreignCurrencyId = group.currency.id;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            
                            // Convert foreign amount to base currency using the same approach as _updateBaseCurrencyCashCount
                            if (foreignCurrencyId && foreignCurrencyId !== baseCurrency?.id) {
                                let currencyObj = null;
                                
                                // Try to get currency from pos.models first (most reliable)
                                if (this.pos?.models?.["res.currency"]) {
                                    currencyObj = this.pos.models["res.currency"].get(foreignCurrencyId);
                                }
                                
                                // Fallback: try to get from pos.currencies array
                                if (!currencyObj && this.pos?.currencies) {
                                    currencyObj = this.pos.currencies.find(c => c && c.id === foreignCurrencyId);
                                }
                                
                                // Fallback: try resolveCurrency helper
                                if (!currencyObj) {
                                    currencyObj = resolveCurrency(this.pos, foreignCurrencyId);
                                }
                                
                                if (currencyObj) {
                                    console.log(`[Cash Control] Found currency object for ID ${foreignCurrencyId}:`, {
                                        name: currencyObj.name,
                                        inverse_rate: currencyObj.inverse_rate,
                                        rate: currencyObj.rate
                                    });
                                    
                                    // Convert foreign -> base robustly (same rule as _updateBaseCurrencyCashCount)
                                    if (currencyObj.inverse_rate && currencyObj.inverse_rate > 0) {
                                        baseAmount = foreignAmount * currencyObj.inverse_rate;
                                        console.log(`[Cash Control] Using inverse_rate: ${foreignAmount} * ${currencyObj.inverse_rate} = ${baseAmount}`);
                                    } else if (currencyObj.rate && currencyObj.rate > 0) {
                                        baseAmount = currencyObj.rate >= 1
                                            ? (foreignAmount / currencyObj.rate)
                                            : (foreignAmount * currencyObj.rate);
                                        console.log(`[Cash Control] Using rate: ${foreignAmount} with rate=${currencyObj.rate} => base=${baseAmount}`);
                                    } else {
                                        // If no rate available, we cannot convert accurately
                                        // move.amount might be in journal currency (not base currency), so we can't use it
                                        // Log a warning and use moveAmountAbs as fallback (might be wrong, but better than nothing)
                                        console.warn(`[Cash Control] No conversion rate found for currency ${foreignCurrencyId}. Cannot convert ${foreignAmount} to base currency. Using moveAmountAbs=${moveAmountAbs} as fallback.`);
                                        // baseAmount stays as moveAmountAbs (fallback - might be incorrect)
                                    }
                                } else {
                                    console.warn(`[Cash Control] Currency object not found for ID ${foreignCurrencyId}. Cannot convert ${foreignAmount} to base currency.`);
                                }
                            }
                        }
                        // Priority 2: Use targetCurrencyId if it indicates foreign currency
                        else if (targetCurrencyId && targetCurrencyId !== baseCurrency?.id) {
                            const foreignAmount = Math.abs(moveAmountInCurrency);
                            let currencyObj = null;
                            
                            // Try to get currency from pos.models first (most reliable)
                            if (this.pos?.models?.["res.currency"]) {
                                currencyObj = this.pos.models["res.currency"].get(targetCurrencyId);
                            }
                            
                            // Fallback: try to get from pos.currencies array
                            if (!currencyObj && this.pos?.currencies) {
                                currencyObj = this.pos.currencies.find(c => c && c.id === targetCurrencyId);
                            }
                            
                            // Fallback: try resolveCurrency helper
                            if (!currencyObj) {
                                currencyObj = resolveCurrency(this.pos, targetCurrencyId);
                            }
                            
                            if (currencyObj) {
                                if (currencyObj.inverse_rate && currencyObj.inverse_rate > 0) {
                                    baseAmount = foreignAmount * currencyObj.inverse_rate;
                                } else if (currencyObj.rate && currencyObj.rate > 0) {
                                    baseAmount = currencyObj.rate >= 1
                                        ? (foreignAmount / currencyObj.rate)
                                        : (foreignAmount * currencyObj.rate);
                                }
                            }
                        }
                        // If move is in base currency, baseAmount is already set to moveAmountAbs
                        
                        // Ensure baseAmount is always a valid number
                        if (!baseAmount || isNaN(baseAmount)) {
                            baseAmount = moveAmountAbs;
                        }
                        
                        // Always set base_amount - use calculated value if available, otherwise use moveAmountAbs
                        const finalBaseAmount = isCashOut ? -baseAmount : baseAmount;
                        
                        const moveObj = {
                            id: index,
                            name: move.name,
                            amount: isCashOut ? -moveAmountInCurrency : moveAmountInCurrency,
                            payment_ref: move.payment_ref || move.name,
                            original_currency: moveCurrency || baseCurrency,
                            original_amount: moveAmountInCurrency,
                            base_amount: finalBaseAmount, // Amount in base currency for display in Cash In/Out section - ALWAYS set
                        };
                        console.log(`[Cash Control] Created moveObj for ${move.name}:`, {
                            original_amount: moveObj.original_amount,
                            base_amount: moveObj.base_amount,
                            original_currency: moveObj.original_currency?.name || 'N/A'
                        });
                        targetGroup.cashMovements.push(moveObj);
                        targetGroup.cashMovementsTotal += moveObj.amount;
                        
                        // Update expected ending after adding cash movement
                        // Expected ending (cash-only) = Opening + Payments Collected - Change + Cash Movements
                        targetGroup.expectedEnding = targetGroup.opening + targetGroup.paymentsCollected + (targetGroup.changeAmount || 0) + targetGroup.cashMovementsTotal;
                        // Display-only: add bank payments for user reference (do NOT use for cash difference)
                        targetGroup.expectedEndingWithBank = targetGroup.expectedEnding + (targetGroup.bankPaymentsCollected || 0);
                    }
                });
                
                // Update expected ending for all groups (in case any were missed)
                // Expected ending = Opening + Payments Collected - Change + Cash Movements
                Object.values(currencyGroups).forEach(group => {
                    if (group.changeAmount === undefined) {
                        group.changeAmount = 0;
                    }
                    group.expectedEnding = group.opening + group.paymentsCollected + (group.changeAmount || 0) + group.cashMovementsTotal;
                    group.expectedEndingWithBank = group.expectedEnding + (group.bankPaymentsCollected || 0);
                });
            }

            // Convert to array and sort
            const groupsArray = Object.values(currencyGroups);
            groupsArray.forEach(group => {
                const currencyId = group.currency?.id;
                const stateCounted = this.state.currencyCounts?.[currencyId];
                if (stateCounted !== undefined && stateCounted !== null && stateCounted !== "") {
                    group.counted = parseCurrencyString(stateCounted);
                } else if (group.counted !== undefined && group.counted !== null) {
                    group.counted = parseCurrencyString(group.counted);
                } else {
                    group.counted = 0;
                }
                const expectedForDiff = group.expectedEndingWithBank != null
                    ? group.expectedEndingWithBank
                    : (group.expectedEnding + (group.bankPaymentsCollected || 0));
                group.difference = roundDifference(group.counted, expectedForDiff);
            });

            groupsArray.sort((a, b) => {
                const aIsBase = a.currency?.id === baseCurrency?.id;
                const bIsBase = b.currency?.id === baseCurrency?.id;
                if (aIsBase && !bIsBase) return -1;
                if (!aIsBase && bIsBase) return 1;
                return (a.currency?.name || "").localeCompare(b.currency?.name || "");
            });

            // Update cache for synchronous access (template uses this)
            this._currencyGroupsCache = groupsArray;
            
            // CRITICAL: Update state.currencyGroups to trigger template re-render
            // Owl.js tracks state changes and will re-render when this changes
            this.state.currencyGroups = groupsArray;
            
            
            return groupsArray;
        } catch (error) {
            return [];
        }
    },

    updateCurrencyCounted(currencyGroup, value) {
        if (!currencyGroup || !currencyGroup.currency) {
            return;
        }
        
        const currencyId = currencyGroup.currency.id;
        
        if (!this.state.currencyCounts) {
            this.state.currencyCounts = {};
        }
        
        // Helper function to parse formatted currency string
        const parseCurrencyString = (str) => {
            if (!str || typeof str !== 'string') return 0;
            // Remove commas and other formatting, but preserve decimal point and digits
            const cleaned = str.replace(/,/g, '').replace(/[^\d.]/g, '');
            return parseFloat(cleaned) || 0;
        };
        
        // Store the value as-is (preserve what user types)
        // Only parse for calculations, don't reformat the display value
        let actualAmount = 0;
        let valueToStore = value;
        
        if (value != null && value !== "") {
            if (typeof value === 'string') {
                // Parse to get numeric value for calculations
                actualAmount = parseCurrencyString(value);
                // Store the raw value as user types it (don't reformat)
                valueToStore = value;
            } else {
                // If it's already a number, convert to string
                actualAmount = parseFloat(value) || 0;
                valueToStore = value.toString();
            }
        } else {
            valueToStore = "";
            actualAmount = 0;
        }
        
        // No validation - allow any amount to be entered (user can enter more or less than expected)
        // Clear any previous validation notes
            if (this._validationNotes && this._validationNotes[currencyId]) {
                delete this._validationNotes[currencyId];
        }
        
        // Store the value as-is (preserve user input)
        // Create a new object to ensure reactivity in Owl.js
        this.state.currencyCounts = {
            ...this.state.currencyCounts,
            [currencyId]: valueToStore
        };
        
        // Update currency group with actual numeric amount for calculations
        currencyGroup.counted = actualAmount;
        // Difference compares against Expected (Cash + Bank) to allow counting total receipts.
        const expectedForDiff = currencyGroup.expectedEndingWithBank != null
            ? currencyGroup.expectedEndingWithBank
            : ((currencyGroup.expectedEnding || 0) + (currencyGroup.bankPaymentsCollected || 0));
        // Round difference to handle floating point precision issues
        const roundedDifference = Math.round((actualAmount - expectedForDiff) * 100) / 100;
        // If difference is very small (less than 0.01), treat as zero
        currencyGroup.difference = Math.abs(roundedDifference) < 0.01 ? 0 : roundedDifference;
        
        this._updateBaseCurrencyCashCount();
        
        // Update closing notes when input changes
        this.updateClosingNotes();
    },
    
    /**
     * Validate currency counted input value
     * Returns true if valid, false if invalid
     * NOTE: Validation removed - users can enter any amount (no limit on exceeding expected ending balance)
     */
    validateCurrencyCounted(currencyGroup, value) {
        // No validation - allow any amount to be entered
        // Only check if value is a valid number format
        if (!currencyGroup || !currencyGroup.currency) {
            return true;
        }
        
        // Only validate that it's a valid number format, not the amount itself
        if (value == null || value === "") {
            return true; // Empty is allowed
        }
        
        // Check if it's a valid number format
        const numValue = typeof value === 'string' ? parseFloat(value.replace(/,/g, '')) : parseFloat(value);
        return !isNaN(numValue);
    },
    
    copyExpectedEnding(currencyGroup) {
        /**
         * Copy the expected ending balance to the counted input field for this currency.
         */
        if (!currencyGroup || !currencyGroup.currency) {
            return;
        }
        
        const currencyId = currencyGroup.currency.id;
        // Copy Expected (Cash + Bank) into the input so cashier can count total receipts.
        // Accounting posting will still use cash-only by subtracting bank collected when computing base cash count.
        const expectedEnding = currencyGroup.expectedEndingWithBank != null
            ? currencyGroup.expectedEndingWithBank
            : ((currencyGroup.expectedEnding || 0) + (currencyGroup.bankPaymentsCollected || 0));
        
        if (!this.state.currencyCounts) {
            this.state.currencyCounts = {};
        }
        
        // Store the actual currency amount (not converted) - this is the REAL amount in the currency
        // Format the value as string with 2 decimal places (same format as input expects)
        const valueStr = expectedEnding.toFixed(2);
        // Create a new object to ensure reactivity in Owl.js
        this.state.currencyCounts = {
            ...this.state.currencyCounts,
            [currencyId]: valueStr
        };
        
        // Update the currency group counted value
        currencyGroup.counted = expectedEnding;
        // Round difference to handle floating point precision issues
        const expectedForDiff = expectedEnding;
        const roundedDiff = Math.round((expectedEnding - expectedForDiff) * 100) / 100;
        currencyGroup.difference = Math.abs(roundedDiff) < 0.01 ? 0 : roundedDiff; // Should be 0
        
        // Update base currency cash count (converts all currencies to base)
        this._updateBaseCurrencyCashCount();
        
        // CRITICAL: Update closing notes immediately to include the copied value
        // This ensures the copied value appears in the closing notes
        this.updateClosingNotes();
    },

    async copyExpectedEndingWithBank(currencyGroup) {
        /**
         * Copy the display-only expected (cash + bank) to the clipboard.
         *
         * IMPORTANT: We do NOT put this value into the cash counted input, because that would
         * incorrectly treat bank as cash-in-drawer and can create "cash difference observed" moves.
         */
        if (!currencyGroup || !currencyGroup.currency) {
            return;
        }
        const expectedWithBank =
            currencyGroup.expectedEndingWithBank ??
            ((currencyGroup.expectedEnding || 0) + (currencyGroup.bankPaymentsCollected || 0));
        const text = Number(expectedWithBank || 0).toFixed(2);
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }
        } catch (e) {
            // fallback below
        }
        // Fallback for environments without navigator.clipboard
        try {
            const el = document.createElement("textarea");
            el.value = text;
            el.setAttribute("readonly", "");
            el.style.position = "absolute";
            el.style.left = "-9999px";
            document.body.appendChild(el);
            el.select();
            document.execCommand("copy");
            document.body.removeChild(el);
        } catch (e) {
            // Silently ignore if clipboard is not available
        }
    },
    
    async openDetailsPopup(ev, currencyGroup = null) {
        /**
         * Open money details popup for a specific currency.
         * If currencyGroup is null/undefined, show all currencies (for base Cash Count button).
         * If currencyGroup is provided, filter to show only that currency.
         */
        const action = _t("Cash control - closing");
        this.hardwareProxy.openCashbox(action);
        
        // If no currencyGroup provided (base Cash Count button), show all currencies
        const filterCurrency = currencyGroup && currencyGroup.currency ? currencyGroup.currency : null;
        const currencyName = currencyGroup && currencyGroup.currency ? currencyGroup.currency.name : null;
        
        this.dialog.add(MoneyDetailsPopup, {
            moneyDetails: this.moneyDetails,
            action: action,
            ...(filterCurrency !== null && filterCurrency !== undefined ? { filterCurrency: filterCurrency } : {}), // Only pass filterCurrency if it's not null/undefined
            getPayload: async (payload) => {
                if (payload) {
                    const { total, moneyDetails, moneyDetailsNotes, all_currency_total } = payload;
                    
                    // Store moneyDetails
                    this.moneyDetails = moneyDetails;
                    
                    // Helper function to parse formatted currency string
                    const parseCurrencyString = (str) => {
                        if (!str || typeof str !== 'string') return 0;
                        const cleaned = str.replace(/,/g, '').replace(/[^\d.-]/g, '');
                        return parseFloat(cleaned) || 0;
                    };
                    
                    // Get currency groups for matching.
                    // IMPORTANT: Only currencies present in these groups are valid for this session closing.
                    // Never create "temporary" currencies from `pos.currencies`, otherwise stale currencies
                    // (e.g. EUR) can leak into currencyCounts and be sent to the backend.
                    const currencyGroups = await this.getPaymentMethodsByCurrency() || [];
                    
                    // If all_currency_total exists, use it directly to update inputs
                    if (all_currency_total && Object.keys(all_currency_total).length > 0) {
                        // Ensure state.currencyCounts exists
                        if (!this.state.currencyCounts) {
                            this.state.currencyCounts = {};
                        }
                        
                        // Collect all updates first
                        const updates = {};
                        
                        // Process each currency from all_currency_total
                        for (const [key, value] of Object.entries(all_currency_total)) {
                            // Parse value - handle both number and string
                            let amount = 0;
                            if (typeof value === 'string') {
                                const numMatch = value.match(/[\d,]+\.?\d*/);
                                if (numMatch) {
                                    amount = parseFloat(numMatch[0].replace(/,/g, '')) || 0;
                                } else {
                                    amount = parseFloat(value) || 0;
                                }
                            } else {
                                amount = parseFloat(value) || 0;
                            }
                            
                            if (amount > 0) {
                                // Find matching currency group (STRICT: must be part of this session's currencyGroups)
                                let matchingGroup = null;
                                
                                // Handle base currency key "Total" (without currency name)
                                if (key === "Total" || key.toUpperCase() === "TOTAL" || key.trim() === "") {
                                    const baseCurrency = this.pos?.currency;
                                    if (baseCurrency) {
                                        matchingGroup = currencyGroups.find(g => g.currency.id === baseCurrency.id);
                                    }
                                } else {
                                    // Extract currency name from key (e.g., "Total EUR" -> "EUR", "Total USD" -> "USD")
                                    const normalizedKey = key.toUpperCase().trim();
                                    const currencyNameFromKey = normalizedKey.replace(/^TOTAL\s*/i, '').trim();
                                    
                                    // Find matching currency group by name (case-insensitive, exact match first)
                                    matchingGroup = currencyGroups.find(g => {
                                        if (!g.currency || !g.currency.name) return false;
                                        const groupCurrencyName = g.currency.name.toUpperCase().trim();
                                        return groupCurrencyName === currencyNameFromKey;
                                    });

                                    // Fallback: try partial match if exact match failed
                                    if (!matchingGroup) {
                                        matchingGroup = currencyGroups.find(g => {
                                            if (!g.currency || !g.currency.name) return false;
                                            const groupCurrencyName = g.currency.name.toUpperCase().trim();
                                            return normalizedKey.includes(groupCurrencyName) || groupCurrencyName.includes(currencyNameFromKey);
                                        });
                                    }
                                }
                                
                                // Store update if we found a matching group (only valid session currencies)
                                if (matchingGroup && matchingGroup.currency) {
                                    const currencyId = matchingGroup.currency.id;
                                    // Ensure currencyId is a number
                                    const currencyIdNum = Number(currencyId);
                                    updates[currencyIdNum] = {
                                        amount: amount,
                                        group: matchingGroup
                                    };
                                }
                            }
                        }
                        
                        // Apply all updates at once (reactive update)
                        if (Object.keys(updates).length > 0) {
                            const newCurrencyCounts = { ...this.state.currencyCounts };
                            
                            for (const [currencyId, update] of Object.entries(updates)) {
                                // Ensure currencyId is a number (not string)
                                const currencyIdNum = Number(currencyId);
                                const valueToStore = update.amount.toFixed(2);
                                newCurrencyCounts[currencyIdNum] = valueToStore;
                                
                                // Update currency group
                                update.group.counted = update.amount;
                                // Round difference to handle floating point precision issues
                                const roundedDiff = Math.round((update.amount - update.group.expectedEnding) * 100) / 100;
                                update.group.difference = Math.abs(roundedDiff) < 0.01 ? 0 : roundedDiff;
                            }
                            
                            // Update state reactively
                            // Since state is created with useState, just assign the new object
                            // Owl.js will detect the change automatically
                            this.state.currencyCounts = newCurrencyCounts;
                        }
                        
                        // Update base currency cash count
                        this._updateBaseCurrencyCashCount();
                        
                        // Update closing notes
                        this.updateClosingNotes();
                        
                        // Return early - we've handled all_currency_total
                        return;
                    }
                    
                    // Fallback: If no all_currency_total, use total for the selected currency
                    if (total > 0) {
                        let targetCurrencyId = null;
                        
                        if (currencyName) {
                            // Find currency group by name
                            const targetGroup = currencyGroups.find(g => g.currency?.name === currencyName);
                            if (targetGroup) {
                                targetCurrencyId = targetGroup.currency.id;
                            }
                        } else {
                            // Base currency
                            const baseCurrency = this.pos?.currency;
                            if (baseCurrency) {
                                targetCurrencyId = baseCurrency.id;
                            }
                        }
                        
                        if (targetCurrencyId) {
                            // Ensure state.currencyCounts exists
                            if (!this.state.currencyCounts) {
                                this.state.currencyCounts = {};
                            }
                            
                            // Store value reactively
                            this.state.currencyCounts = {
                                ...this.state.currencyCounts,
                                [targetCurrencyId]: total.toFixed(2)
                            };
                            
                            // Update currency group
                            const targetGroup = currencyGroups.find(g => g.currency.id === targetCurrencyId);
                            if (targetGroup) {
                                targetGroup.counted = total;
                                // Round difference to handle floating point precision issues
                                const roundedDiff = Math.round((total - targetGroup.expectedEnding) * 100) / 100;
                                targetGroup.difference = Math.abs(roundedDiff) < 0.01 ? 0 : roundedDiff;
                            }
                            
                            // Update base currency cash count
                            this._updateBaseCurrencyCashCount();
                            
                            // Update closing notes
                            this.updateClosingNotes();
                        }
                    }
                    
                }
            },
            context: "Closing",
        });
    },
    
    updateClosingNotes() {
        /**
         * Update closing notes with currency-wise breakdown of all counted values.
         * Similar to opening notes but for closing.
         * IMPORTANT: Shows actual currency amounts (not converted to base currency).
         * Reads ONLY from state.currencyCounts which contains the actual currency amounts entered by user.
         */
        const notesParts = [];
        const currencyAmounts = {};
        
        // Helper function to parse formatted currency string
        const parseCurrencyString = (str) => {
            if (!str || typeof str !== 'string') return 0;
            const cleaned = str.replace(/,/g, '').replace(/[^\d.-]/g, '');
            return parseFloat(cleaned) || 0;
        };
        
        // Ensure state.currencyCounts exists
        if (!this.state.currencyCounts) {
            this.state.currencyCounts = {};
        }
        
        // PRIMARY SOURCE: Read from currencyCounts (per-currency input fields)
        // These contain the ACTUAL currency amounts entered by the user (not converted)
        // This includes values from:
        // 1. Manual input changes (via updateCurrencyCounted)
        // 2. Copy button (via copyExpectedEnding)
        // 3. Coins popup (via openDetailsPopup)
        if (Object.keys(this.state.currencyCounts).length > 0) {
            // Use cached currency groups (available after first async call)
            const currencyGroups = this._currencyGroupsCache || [];
            
            for (const [currencyIdStr, value] of Object.entries(this.state.currencyCounts)) {
                // Skip if value is empty, null, undefined, or "0"
                if (!value || value === "0" || value === 0 || value === "") {
                    continue;
                }
                
                const currencyId = Number(currencyIdStr);
                if (isNaN(currencyId)) {
                    continue;
                }
                
                const group = currencyGroups.find(g => g.currency && g.currency.id === currencyId);
                if (group && group.currency) {
                    const currencyName = group.currency.name || '';
                    // Parse the value - it might be a string like "100.00" or "2,100.00"
                    // Handle both string and number values
                    let amount = 0;
                    if (typeof value === 'string') {
                        amount = parseCurrencyString(value);
                    } else if (typeof value === 'number') {
                        amount = value;
                    } else {
                        amount = parseFloat(value) || 0;
                    }
                    
                    if (amount > 0 && !isNaN(amount)) {
                        // Store with actual currency name - this is the REAL currency amount
                        const formattedKey = `Total ${currencyName}`;
                        currencyAmounts[formattedKey] = amount;
                        console.log(`[Closing Notes] Added from currencyCounts: ${formattedKey} = ${amount} (currencyId=${currencyId})`);
                    }
                } else {
                    console.warn(`[Closing Notes] Currency group not found for currencyId=${currencyId}, value=${value}`);
                }
            }
        }
        
        // SECONDARY SOURCE: Merge with all_currency_total from coins popup (if available)
        // This ensures values from coins popup are included, but prioritize input fields
        // CRITICAL: Only use all_currency_total if state.currencyCounts is empty or incomplete
        // to avoid overwriting user-entered values with stale data
        const hasCurrencyCounts = Object.keys(this.state.currencyCounts || {}).length > 0;
        if (!hasCurrencyCounts && this.all_currency_total && Object.keys(this.all_currency_total).length > 0) {
            // Use cached currency groups (available after first async call)
            const currencyGroups = this._currencyGroupsCache || [];
            for (const [key, value] of Object.entries(this.all_currency_total)) {
                const amount = parseFloat(value) || 0;
                if (amount > 0) {
                    // Normalize key and update currencyAmounts
                    const normalizedKey = key.toUpperCase().trim();
                    const currencyNameFromKey = normalizedKey.replace(/^TOTAL\s*/i, '').trim();
                    
                    // Find matching currency group
                    const matchingGroup = currencyGroups.find(g => {
                        const groupCurrencyName = g.currency?.name?.toUpperCase() || '';
                        return groupCurrencyName === currencyNameFromKey;
                    });
                    
                    if (matchingGroup) {
                        const formattedKey = `Total ${matchingGroup.currency.name}`;
                        // Only add if not already set from input fields (input fields take priority)
                        if (!currencyAmounts[formattedKey]) {
                            currencyAmounts[formattedKey] = amount;
                        }
                    } else if (normalizedKey === 'TOTAL' || normalizedKey === '') {
                        // Base currency total (key is just "Total" without currency name)
                        const baseCurrencyName = this.pos?.currency?.name || '';
                        const baseKey = `Total ${baseCurrencyName}`;
                        if (!currencyAmounts[baseKey]) {
                            currencyAmounts[baseKey] = amount;
                        }
                    }
                }
            }
        }
        
        // Update all_currency_total to sync with final currencyAmounts
        // CRITICAL: Only sync if currencyAmounts was built from state.currencyCounts (primary source)
        // This prevents stale all_currency_total from overwriting correct values
        if (Object.keys(currencyAmounts).length > 0) {
            this.all_currency_total = currencyAmounts;
            console.log('[Closing Notes] Final currencyAmounts:', currencyAmounts);
        }
        
        // Generate notes from collected amounts - show ACTUAL currency amounts (not converted)
        const baseCurrency = this.pos?.currency;
        const baseKey = baseCurrency ? `Total ${baseCurrency.name}` : '';
        
        // Add base currency first
        if (currencyAmounts[baseKey] && baseCurrency) {
            const baseAmount = parseFloat(currencyAmounts[baseKey]) || 0;
            if (baseAmount > 0) {
                notesParts.push(`${this.env.utils.formatCurrency(baseAmount, false)} ${baseCurrency.name}`);
            }
        }
        
        // Add all foreign currencies - show ACTUAL amounts (not converted)
        for (const [key, value] of Object.entries(currencyAmounts)) {
            if (key !== baseKey) {
                const currencyName = key.replace('Total ', '').replace('Total', '').trim();
                const amount = parseFloat(value) || 0;
                if (amount > 0) {
                    notesParts.push(`${this.env.utils.formatCurrency(amount, false)} ${currencyName}`);
                }
            }
        }
        
        // Add validation notes if any values were capped
        if (this._validationNotes && Object.keys(this._validationNotes).length > 0) {
            const validationMessages = Object.values(this._validationNotes);
            if (validationMessages.length > 0) {
                notesParts.push(`Validation: ${validationMessages.join('; ')}`);
            }
        }
        
        // Format notes - directly assign to state.notes (same as base Odoo)
        if (notesParts.length > 0) {
            // Separate closing balance from validation notes
            const balanceParts = notesParts.filter(p => !p.startsWith('Validation:'));
            const validationParts = notesParts.filter(p => p.startsWith('Validation:'));
            
            let newNotes = '';
            if (balanceParts.length > 0) {
                newNotes = `Closing Balance: ${balanceParts.join(', ')}`;
            }
            if (validationParts.length > 0) {
                if (newNotes) {
                    newNotes += '. ' + validationParts.join('. ');
                } else {
                    newNotes = validationParts.join('. ');
                }
            }
            
            // Direct assignment like base Odoo does
            this.state.notes = newNotes;
        } else {
            // Clear notes if no amounts
            this.state.notes = '';
        }
    },
    
    getCurrencyGroupsForTemplate() {
        /**
         * Synchronous getter for currency groups to use in template.
         * Returns state.currencyGroups (reactive) or cached groups or empty array.
         * This is called from the template, so it must be synchronous.
         * Uses state.currencyGroups which is reactive and will trigger re-renders.
         */
        // Prefer state.currencyGroups (reactive) over cache
        const groups = this.state.currencyGroups || this._currencyGroupsCache || [];
        return groups;
    },
    
    async _getCurrencyGroups() {
        /**
         * Get all currency groups from the popup state.
         * This is a helper to access currency groups.
         * Uses getPaymentMethodsByCurrency() which returns an array.
         */
        try {
            const groups = await this.getPaymentMethodsByCurrency();
            if (groups && Array.isArray(groups) && groups.length > 0) {
                return groups;
            }
        } catch (e) {
        }
        // Fallback: return empty array
        return [];
    },
    
    getMaxDifference() {
        /**
         * Override to use rounded differences to handle floating point precision issues.
         * This prevents warnings when difference is essentially zero (e.g., -0.00€).
         * Combines differences from both base currency (default cash) and foreign currencies.
         */
        // Prefer computing base currency difference from the currency groups (consistent with multi-currency logic).
        // IMPORTANT: backend provides `default_cash_details.amount` (expected) but not `default_cash_details.expected`.
        // Using `.expected` makes expected=0 and triggers false "payment difference" equal to the full counted amount.
        const baseCurrencyId = this.pos?.currency?.id;
        const currencyGroups = this._currencyGroupsCache || this.state.currencyGroups || [];
        const baseGroup = baseCurrencyId
            ? currencyGroups.find(g => g?.currency?.id === baseCurrencyId)
            : null;

        let baseDifference = 0;
        if (baseGroup) {
            baseDifference = baseGroup.difference || 0;
        } else if (this.props.default_cash_details) {
            const counted = parseCurrencyString(this.state.payments?.[this.props.default_cash_details.id]?.counted || "0");
            const expected =
                this.props.default_cash_details.amount ??
                this.props.default_cash_details.expected ??
                0;
            baseDifference = counted - expected;
        }
        
        // Get differences from foreign currency groups
        const foreignDifferences = currencyGroups
            .filter(group => group.currency && group.currency.id !== baseCurrencyId)
            .map(group => group.difference || 0);
        
        // Combine all differences (base + foreign currencies)
        const allDifferences = [baseDifference, ...foreignDifferences];
        
        // Round each difference and filter out very small values
        const roundedDifferences = allDifferences.map(diff => {
            const rounded = Math.round(diff * 100) / 100;
            // If very small (less than 0.01), treat as zero
            return Math.abs(rounded) < 0.01 ? 0 : rounded;
        });
        
        // Return the maximum absolute difference
        const maxDiff = Math.max(...roundedDifferences.map(d => Math.abs(d)), 0);
        
        // If all differences are essentially zero, return 0 to avoid warnings
        return maxDiff < 0.01 ? 0 : maxDiff;
    },
    
    /**
     * Get currency differences for display in dialog
     * Returns array of {currency, difference} objects for currencies with non-zero differences
     */
    getCurrencyDifferences() {
        const differences = [];
        const baseCurrency = this.pos?.currency;
        
        // Get differences from all currency groups (including base currency)
        // This ensures we get the correct expectedEnding calculation that includes change
        const currencyGroups = this._currencyGroupsCache || this.state.currencyGroups || [];
        
        currencyGroups.forEach(group => {
            if (group.currency && group.difference !== undefined && group.difference !== null) {
                const diff = Math.round((group.difference || 0) * 100) / 100;
                // Only add if difference is significant
                if (Math.abs(diff) >= 0.01) {
                    differences.push({
                        currency: group.currency,
                        difference: diff
                    });
                }
            }
        });
        
        // Also check base currency from default_cash_details if not found in groups
        if (differences.length === 0 && this.props.default_cash_details && baseCurrency) {
            const counted = parseCurrencyString(this.state.payments?.[this.props.default_cash_details.id]?.counted || "0");
            const expected = this.props.default_cash_details.amount || 0; // Use amount as expected
            const diff = Math.round((counted - expected) * 100) / 100;
            if (Math.abs(diff) >= 0.01) {
                differences.push({
                    currency: baseCurrency,
                    difference: diff
                });
            }
        }
        
        return differences;
    },
    
    async confirm() {
        /**
         * Override to show currency-specific differences in the dialog.
         * Shows which currencies have differences and their amounts.
         */
        if (!this.pos.config.cash_control || this.pos.currency.isZero(this.getMaxDifference())) {
            await this.closeSession();
            return;
        }
        
        // Get currency differences
        const currencyDifferences = this.getCurrencyDifferences();
        
        // Build message showing which currencies have differences
        let bodyMessage = _t("The money counted doesn't match what we expected. Want to log the difference for the books?");
        
        if (currencyDifferences.length > 0) {
            const diffLines = currencyDifferences.map(({ currency, difference }) => {
                const currencyName = currency.name || currency.symbol || 'Unknown';
                const formattedDiff = this.env.utils.formatCurrency(Math.abs(difference), false);
                const sign = difference >= 0 ? '+' : '-';
                return `  • ${currencyName}: ${sign}${formattedDiff}`;
            });
            
            bodyMessage = _t("The money counted doesn't match what we expected. Want to log the difference for the books?") + 
                         "\n\n" + 
                         _t("Differences by currency:") + 
                         "\n" + 
                         diffLines.join("\n");
        }
        
        if (this.hasUserAuthority()) {
            const response = await ask(this.dialog, {
                title: _t("Payments Difference"),
                body: bodyMessage,
                confirmLabel: _t("Proceed Anyway"),
                cancelLabel: _t("Discard"),
            });
            if (response) {
                return this.closeSession();
            }
            return;
        }
        
        // If user doesn't have authority, show manager dialog
        this.dialog.add(ConfirmationDialog, {
            title: _t("Payments Difference"),
            body: _t(
                "The maximum difference allowed is %s.\nPlease contact your manager to accept the closing difference.",
                this.env.utils.formatCurrency(this.props.amount_authorized_diff)
            ) + (currencyDifferences.length > 0 ? 
                "\n\n" + _t("Differences by currency:") + "\n" + 
                currencyDifferences.map(({ currency, difference }) => {
                    const currencyName = currency.name || currency.symbol || 'Unknown';
                    const formattedDiff = this.env.utils.formatCurrency(Math.abs(difference), false);
                    const sign = difference >= 0 ? '+' : '-';
                    return `  • ${currencyName}: ${sign}${formattedDiff}`;
                }).join("\n") : ""),
        });
    },
    
    _updateBaseCurrencyCashCount() {
        /**
         * Update the "Total Cash Count in TSH" read-only field with converted total.
         * This is the SINGLE base-currency input Odoo uses for cash control.
         * It is computed from the per-currency counted inputs in the custom currency sections.
         */
        try {
            const baseCurrency = this.pos?.currency;
            if (!baseCurrency) {
                return;
            }
            if (!this.state.currencyCounts) {
                this.state.currencyCounts = {};
            }
            
            let totalInBaseCurrency = 0;
            const currencyCounts = this.state.currencyCounts || {};
            // NOTE: For this customization we consider bank-type payments as part of the "counted" totals,
            // so we do NOT subtract bankPaymentsCollected from counted values.
            
            for (const [currencyIdStr, countedValue] of Object.entries(currencyCounts)) {
                const currencyId = Number(currencyIdStr);
                const counted = countedValue;
                
                if (counted != null && counted !== "" && !isNaN(counted)) {
                    const countedAmount = parseCurrencyString(counted);
                    
                    if (countedAmount > 0) {
                        if (currencyId === baseCurrency.id) {
                            // Base currency: use actual counted amount (not converted)
                            totalInBaseCurrency += countedAmount;
                        } else {
                            // Foreign currencies: convert to base
                            let currencyObj = null;
                            if (this.pos?.models?.["res.currency"]) {
                                currencyObj = this.pos.models["res.currency"].get(currencyId);
                            }
                            
                            if (currencyObj) {
                                // Convert foreign -> base (company currency) robustly.
                                //
                                // Odoo semantics (backend UI):
                                // - `rate`         : "Unit per USD" (foreign per 1 base)  e.g. IQD=1432, EUR=0.78
                                // - `inverse_rate` : "USD per Unit" (base per 1 foreign) e.g. IQD=0.000698, EUR=1.28
                                //
                                // Some databases / loads may expose only one of them; handle both safely.
                                let convertedAmount = 0;
                                if (currencyObj.inverse_rate && currencyObj.inverse_rate > 0) {
                                    // base = foreign * (base per 1 foreign)
                                    convertedAmount = countedAmount * currencyObj.inverse_rate;
                                    console.log(`[Base Currency Total] ${countedAmount} ${currencyObj.name} * ${currencyObj.inverse_rate} (inverse_rate) = ${convertedAmount} ${baseCurrency.name}`);
                                } else if (currencyObj.rate && currencyObj.rate > 0) {
                                    // If rate is foreign per base (most common when rate >= 1), base = foreign / rate
                                    // If rate is base per foreign (common when rate < 1), base = foreign * rate
                                    convertedAmount = currencyObj.rate >= 1
                                        ? (countedAmount / currencyObj.rate)
                                        : (countedAmount * currencyObj.rate);
                                    console.log(`[Base Currency Total] ${countedAmount} ${currencyObj.name} / ${currencyObj.rate} (rate) = ${convertedAmount} ${baseCurrency.name}`);
                                }
                                totalInBaseCurrency += convertedAmount;
                            }
                        }
                    }
                }
            }
            
            if (totalInBaseCurrency > 0 && this.pos && this.pos.round_decimals_currency) {
                totalInBaseCurrency = this.pos.round_decimals_currency(totalInBaseCurrency);
            }
            
            console.log(`[Base Currency Total] Final total in ${baseCurrency.name}: ${totalInBaseCurrency}`);
            
            if (this.props.default_cash_details && this.props.default_cash_details.id) {
                if (!this.state.payments) {
                    this.state.payments = {};
                }
                const paymentId = this.props.default_cash_details.id;
                if (!this.state.payments[paymentId]) {
                    this.state.payments[paymentId] = {};
                }
                
                // Store converted total in the base cash control counted field (read-only).
                // IMPORTANT: must be a plain number string (no currency symbol), otherwise isValidFloat fails
                const formattedValue = totalInBaseCurrency >= 0
                    ? String(Number(totalInBaseCurrency).toFixed(2))
                    : "0";
                
                this.state.payments[paymentId].counted = formattedValue;
                
                // Update closing notes when base currency cash count changes
                this.updateClosingNotes();
            }
        } catch (error) {
        }
    },

    get cashMoveData() {
        const { total, moves } = this.props.default_cash_details.moves.reduce(
            (acc, move, i) => {
                acc.total += move.amount;
                acc.moves.push({
                    id: i,
                    name: move.name,
                    amount: move.amount,
                    other_curr : move.other_curr,
                    other_curr_amt : move.other_curr_amt,
                    other_curr_symbol : move.other_curr_symbol,
                });
                return acc;
            },
            { total: 0, moves: [] }
        );
        return { total, moves };
    },
    
    async closeSession() {
        /**
         * Override to send currency_counts when closing session.
         * This allows the backend to store ending balances per currency.
         * Must follow the same flow as base implementation to ensure proper closing.
         */
        this.pos._resetConnectedCashier();
        // If there are orders in the db left unsynced, we try to sync.
        const syncSuccess = await this.pos.pushOrdersWithClosingPopup();
        if (!syncSuccess) {
            return;
        }
        if (this.pos.config.cash_control) {
            // Get currency counts from state (contains counted amounts per currency)
            let currencyCounts = this.state.currencyCounts || {};
            // NOTE: For this customization we consider bank-type payments as part of the "counted" totals,
            // so we do NOT subtract bankPaymentsCollected from counted values.
            
            // CRITICAL: Also collect counts from currency groups if state.currencyCounts is empty or incomplete
            // This ensures we capture all currency counts even if state wasn't updated properly
            if (this.state.currencyGroups && Array.isArray(this.state.currencyGroups)) {
                this.state.currencyGroups.forEach((group) => {
                    if (group.currency && group.currency.id && (group.counted !== undefined && group.counted !== null)) {
                        const currencyId = Number(group.currency.id);
                        // Keep the UI value as-is; we send what the user sees as the closing balance per currency.
                        const uiCounted = parseCurrencyString(group.counted);
                        if (!isNaN(currencyId) && !isNaN(uiCounted)) {
                            currencyCounts[currencyId] = uiCounted;
                        }
                    }
                });
            }
            
            // Use the read-only "total in base currency" as the base counted cash for Odoo cash control.
            // This total is computed from the per-currency inputs in the custom currency sections.
            const baseCounted = parseCurrencyString(
                this.state.payments?.[this.props.default_cash_details?.id]?.counted || "0"
            );
            
            // Only send currencies that are part of the current closing UI currency groups.
            // This prevents stale currencies (e.g. EUR from a previous coins popup) from being sent/stored.
            const allowedCurrencyIds = new Set();
            if (this.state.currencyGroups && Array.isArray(this.state.currencyGroups)) {
                for (const g of this.state.currencyGroups) {
                    const cid = g?.currency?.id;
                    if (cid != null) allowedCurrencyIds.add(Number(cid));
                }
            }
            // Always allow base currency.
            const baseCurrency = this.pos?.currency;
            if (baseCurrency?.id != null) allowedCurrencyIds.add(Number(baseCurrency.id));

            // Ensure all currency IDs are numbers (not strings) for consistency
            const normalizedCurrencyCounts = {};
            for (const [currencyId, amount] of Object.entries(currencyCounts)) {
                const normalizedId = Number(currencyId);
                if (!allowedCurrencyIds.has(normalizedId)) {
                    continue;
                }
                const normalizedAmount = parseCurrencyString(amount);
                if (!isNaN(normalizedId) && !isNaN(normalizedAmount) && normalizedAmount > 0) {
                    normalizedCurrencyCounts[normalizedId] = normalizedAmount;
                }
            }
            
            console.log('[ClosePosPopup] Sending closing cash details:', {
                sessionId: this.pos.session.id,
                baseCounted: baseCounted,
                currencyCounts: normalizedCurrencyCounts,
                originalCurrencyCounts: currencyCounts,
                currencyGroups: this.state.currencyGroups?.map(g => ({
                    currencyId: g.currency?.id,
                    currencyName: g.currency?.name,
                    counted: g.counted
                }))
            });
            
            const response = await this.pos.data.call(
                "pos.session",
                "post_closing_cash_details",
                [this.pos.session.id],
                {
                    counted_cash: baseCounted,
                    currency_counts: normalizedCurrencyCounts,  // Send currency counts for ALL currencies including base
                }
            );

            if (!response.successful) {
                return this.handleClosingError(response);
            }
        }

        try {
            // Call with notes as parameter (not in kwargs) to match base implementation
            await this.pos.data.call("pos.session", "update_closing_control_state_session", [
                this.pos.session.id,
                this.state.notes || "",
            ]);
        } catch (error) {
            // We have to handle the error manually otherwise the validation check stops the script.
            // In case of "rescue session", we want to display the next popup with "handleClosingError".
            if (!error.data || error.data.message !== "This session is already closed.") {
                throw error;
            }
        }

        try {
            // Handle bank payment method diffs (same as base implementation)
            const bankPaymentMethodDiffPairs = this.props.non_cash_payment_methods
                .filter((pm) => pm.type == "bank")
                .map((pm) => [pm.id, this.getDifference(pm.id)]);
            
            // Call close_session_from_ui with bank payment method diff pairs
            // Note: base implementation passes bankPaymentMethodDiffPairs as second parameter, not in kwargs
            const response = await this.pos.data.call(
                "pos.session",
                "close_session_from_ui",
                [this.pos.session.id, bankPaymentMethodDiffPairs],
                {
                    context: {
                        device_identifier: this.pos.device.identifier,
                    },
                }
            );
            
            if (!response.successful) {
                return this.handleClosingError(response);
            }
            
            // Mark session as closed and close router (same as base implementation)
            this.pos.session.state = "closed";
            this.pos.router.close();
        } catch (error) {
            // Handle connection errors and other errors
            if (error instanceof ConnectionLostError) {
                throw error;
            } else {
                await this.handleClosingControlError();
            }
        } finally {
            // Clean up localStorage (same as base implementation)
            const odoo = window.odoo || {};
            const pos_config_id = odoo.pos_config_id || this.pos?.config?.id;
            if (pos_config_id) {
                localStorage.removeItem(`pos.session.${pos_config_id}`);
            }
        }
    },
});
