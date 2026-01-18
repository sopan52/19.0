/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosPayment } from "@point_of_sale/app/models/pos_payment";

patch(PosPayment.prototype, {
    export_for_printing() {
        const receipt = super.export_for_printing(...arguments);
        const cur = this.payment_currency_id;
        receipt.payment_currency_name = cur?.name || null;
        receipt.payment_currency_symbol = cur?.symbol || null;
        receipt.payment_currency_rate = this.payment_currency_rate || (cur?.rate || 0);
        receipt.currency_amount_total = this.currency_amount_total || 0;
        return receipt;
    },
});

