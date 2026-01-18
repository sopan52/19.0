/** @odoo-module */

import { ProductCard } from "@point_of_sale/app/components/product_card/product_card";
import { patch } from "@web/core/utils/patch";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";

patch(ProductCard.prototype, {
    setup() {
        super.setup();
        this.pos = usePos();
    },

    /**
     * Calculate and return tax-included price for the product
     * This method is called from the XML template
     */
    getTaxIncludedPrice() {
        return this.props.product?.getTaxDetails()?.total_included
    }
});

