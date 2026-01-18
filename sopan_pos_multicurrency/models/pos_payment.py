from odoo import api, fields, models, _


class PosPayment(models.Model):
    _inherit = "pos.payment"

    payment_currency_id = fields.Many2one(
        "res.currency",
        string="Payment Currency",
        help="Currency in which the cashier entered the payment (e.g. USD/EUR).",
    )
    currency_amount_total = fields.Monetary(
        string="Amount in Payment Currency",
        currency_field="payment_currency_id",
        help="Amount entered in the payment currency (e.g. 50 USD).",
    )
    payment_currency_rate = fields.Float(
        string="Payment Currency Rate",
        help="Rate used in the POS to convert between base currency and the payment currency at the time of payment.",
    )

    @api.model
    def _load_pos_data_fields(self, config_id):
        # IMPORTANT (Odoo 19):
        # If we return only our custom fields here, POS will load a restricted field set and
        # the frontend model definition will miss core relations like `pos_order_id`,
        # causing crashes when adding a payment line (e.g. `set_amount()` -> `pos_order_id.assert_editable()`).
        core_fields = [
            "id",
            "name",
            "pos_order_id",
            "amount",
            "payment_method_id",
            "payment_date",
            "payment_status",
            "ticket",
            "is_change",
            "uuid",
        ]
        extra_fields = ["payment_currency_id", "currency_amount_total", "payment_currency_rate"]
        return list(dict.fromkeys(core_fields + extra_fields))

