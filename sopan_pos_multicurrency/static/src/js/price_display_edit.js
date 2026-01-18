/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import { ProductCard } from "@point_of_sale/app/components/product_card/product_card";
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { NumberPopup } from "@point_of_sale/app/components/popups/number_popup/number_popup";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { _t } from "@web/core/l10n/translation";

patch(ProductCard.prototype, {
    setup() {
        super.setup(...arguments);
        this.pos = usePos();
    },
});

patch(ControlButtons.prototype, {
    async clickUsdPrice() {
        const order = this.pos.getOrder();
        const line = order?.getSelectedOrderline?.();
        if (!order || !line) {
            return;
        }
        const usd = this.pos.usd_currency;
        if (!usd || !usd.rate) {
            this.notification.add(_t("USD currency/rate is not configured for POS."));
            return;
        }
        const usdPrice = await makeAwaitable(this.dialog, NumberPopup, {
            title: _t("Set unit price in USD"),
            startingValue: "",
            formatDisplayedValue: (x) => `$ ${x}`,
        });
        if (usdPrice !== undefined && usdPrice !== null && usdPrice !== "") {
            const price = parseFloat(usdPrice ?? "");
            if (price && !isNaN(price)) {
                const basePrice = price / usd.rate;
                // Odoo 19 uses camelCase: setUnitPrice instead of set_unit_price
                if (line.setUnitPrice) {
                    line.setUnitPrice(basePrice);
                } else if (line.set_unit_price) {
                    // Fallback for older versions
                    line.set_unit_price(basePrice);
                } else {
                    // Direct assignment as last resort
                    line.price_unit = basePrice;
                }
                line.price_type = "manual";
            }
        }
    },
});

