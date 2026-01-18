from odoo import fields, models,api

class OtherCurrencyOpeningBalance(models.Model):
    _name = "other.currency.opening.balance"
    _inherit = ['pos.load.mixin']

    opening_total = fields.Float(string="Opening Total")
    session_id = fields.Many2one("pos.session", string="Session")
    currency_id = fields.Many2one("res.currency", string="Other Currency")
    name = fields.Char("Name", related="currency_id.name", store=True)
    symbol = fields.Char("Symbol", related="currency_id.symbol", store=True)

    @api.model
    def _load_pos_data_fields(self, config_id):
        return ['id', 'name', 'currency_id', 'opening_total', 
            'session_id', 'symbol']

    @api.model
    def _load_pos_data_domain(self, data, config):
        return [('session_id', '=', data['pos.session'][0]['id'])]
