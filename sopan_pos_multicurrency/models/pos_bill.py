from odoo import api, fields, models, _


class PosBill(models.Model):
    _inherit = "pos.bill"

    currency_id = fields.Many2one(
        "res.currency",
        string="Currency",
        default=lambda self: self.env.company.currency_id.id,
        help="Currency of this denomination set. For multi-currency cash count, define separate denominations per currency.",
    )

    @api.model
    def _load_pos_data_fields(self, config_id):
        fields_list = super()._load_pos_data_fields(config_id)
        fields_list = list(dict.fromkeys(fields_list + ["currency_id"]))
        return fields_list
    
    @api.model
    def _load_pos_data_domain(self, data, config):
        """Load bills with currency information"""
        return [('id', '!=', False)]

    # Dynamic module: no legacy `use_for_usd` flag. Use `currency_id` directly.
 