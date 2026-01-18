/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { numberBufferService } from "@point_of_sale/app/services/number_buffer_service";

// Patch the number buffer service to handle custom increment values like +1000, +2000, +5000
// The core INPUT_KEYS only includes +10, +20, +50, so we need to allow custom increments
// The issue is that _onInput checks ALLOWED_KEYS before calling _handleInput, so we need to
// intercept at sendKey level for custom increments
patch(numberBufferService, {
    start(env, deps) {
        const numberBuffer = super.start(...arguments);
        
        // Store original methods
        const originalSendKey = numberBuffer.sendKey.bind(numberBuffer);
        const originalHandleInput = numberBuffer._handleInput.bind(numberBuffer);
        
        // Patch sendKey to handle custom increment values directly
        // This bypasses the ALLOWED_KEYS check in _onInput
        numberBuffer.sendKey = function(key) {
            // Check if key is a custom increment value (starts with "+" followed by number > 50)
            if (typeof key === "string" && key.length > 1 && key[0] === "+") {
                const numericPart = key.slice(1);
                const numValue = parseFloat(numericPart);
                // Check if it's a valid positive number greater than standard max (50)
                // This catches +100, +1000, +2000, +5000, etc. but allows standard +10, +20, +50
                if (!isNaN(numValue) && numValue > 50 && isFinite(numValue)) {
                    // This is a custom increment - handle it directly
                    this._handleInput(key);
                    return;
                }
            }
            // For all other keys, use the original sendKey (which goes through _onInput)
            return originalSendKey(key);
        };
        
        // Also patch _handleInput as a safety net (in case it's called directly)
        numberBuffer._handleInput = function(key) {
            // Check if key is a string starting with "+" followed by a number
            if (typeof key === "string" && key.length > 1 && key[0] === "+") {
                const numericPart = key.slice(1);
                const numValue = parseFloat(numericPart);
                // If it's a valid positive number, process it as an increment
                if (!isNaN(numValue) && numValue > 0 && isFinite(numValue)) {
                    // Get the current buffer value BEFORE any sync
                    const currentBufferValue = this.getFloat();
                    
                    // For foreign currency payment lines, ensure buffer is synced BEFORE increment
                    // Get the payment screen from the number buffer's stored reference
                    const paymentScreen = this._paymentScreen;
                    let isForeign = false;
                    let syncedValue = currentBufferValue;
                    
                    if (paymentScreen) {
                        // Sync immediately (synchronously) before processing increment
                        const paymentLine = paymentScreen.currentOrder?.getSelectedPaymentline();
                        if (paymentLine) {
                            const pm = paymentLine.payment_method_id;
                            if (pm) {
                                // Get currency from payment method - handle different formats
                                let payCurrency = null;
                                const cur = pm.currency_of_cash_control;
                                if (cur) {
                                    if (typeof cur === 'object' && cur.id) {
                                        payCurrency = cur;
                                    } else if (typeof cur === 'number') {
                                        payCurrency = paymentScreen.pos?.models?.["res.currency"]?.get?.(cur);
                                    } else if (Array.isArray(cur) && cur.length > 0) {
                                        payCurrency = paymentScreen.pos?.models?.["res.currency"]?.get?.(cur[0]);
                                    }
                                }
                                
                                isForeign = payCurrency && paymentScreen.pos.currency?.id && payCurrency.id !== paymentScreen.pos.currency.id;
                                
                                if (isForeign) {
                                    // Sync buffer to foreign currency amount immediately
                                    if (paymentLine.currency_amount_total && paymentLine.currency_amount_total > 0) {
                                        syncedValue = paymentLine.currency_amount_total;
                                        this.state.buffer = syncedValue.toString();
                                    } else if (paymentLine.amount && paymentLine.amount > 0) {
                                        const rate = payCurrency.rate || 1;
                                        syncedValue = rate < 1 ? paymentLine.amount * rate : paymentLine.amount / rate;
                                        this.state.buffer = syncedValue.toString();
                                    } else {
                                        syncedValue = 0;
                                        this.state.buffer = "";
                                    }
                                }
                            }
                        }
                    }
                    
                    // Now add the increment to the synced value
                    const newValue = syncedValue + numValue;
                    this.state.buffer = newValue.toString();
                    
                    // Trigger the input callback if configured - this will call updateSelectedPaymentline
                    if (this.config?.triggerAtInput) {
                        this.config.triggerAtInput({
                            buffer: this.state.buffer,
                            key,
                        });
                    }
                    // Return early to skip the original INPUT_KEYS check
                    return;
                }
            }
            
            // For all other keys, use the original handler
            return originalHandleInput(key);
        };
        
        return numberBuffer;
    },
});

