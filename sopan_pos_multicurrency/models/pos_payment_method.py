from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


class PosPaymentMethod(models.Model):
    _inherit = "pos.payment.method"

    currency_of_cash_control = fields.Many2one(
        "res.currency",
        string="Currency Of Cash Control",
        help="Currency in which this payment method is expected to be entered in the POS (e.g. Cash USD, Cash EUR). "
             "When set, allows this payment method to use a journal in foreign currency (different from base currency). "
             "The journal's default account will be used for cash, and the journal's loss/profit accounts will be used for cash differences.",
    )
    use_as_default_receivable_cash_from_pos = fields.Boolean(
        string="Use as Default Receivable Cash from PoS",
        default=False,
        help="If checked, this journal/account will be used as the company receivable cash account "
             "for cash-in/out operations from PoS. Only one account per currency should be marked. "
             "The first one found will be used if multiple are marked.",
    )

    @api.model
    def _load_pos_data_fields(self, config_id):
        """
        Ensure POS receives the currency_of_cash_control field.
        Many2one fields are automatically serialized by Odoo, but we need to explicitly
        include the field name in the returned list so it's sent to the frontend.
        Also exclude industrycode field if it's present (it doesn't exist on this model).
        """
        fields_list = super()._load_pos_data_fields(config_id)
        # Exclude industrycode field if present (it doesn't exist on pos.payment.method)
        if "industrycode" in fields_list:
            fields_list = [f for f in fields_list if f != "industrycode"]
        if "currency_of_cash_control" not in fields_list:
            fields_list.append("currency_of_cash_control")
        return fields_list
    
    @api.constrains('journal_id', 'currency_of_cash_control')
    def _check_foreign_currency_journal_allowed(self):
        """
        Allow payment methods to have journals in foreign currencies when currency_of_cash_control is set.
        This enables multi-currency payment methods (e.g., Cash USD with USD journal when base is TNS).
        """
        for pm in self:
            if pm.journal_id and pm.currency_of_cash_control:
                journal_currency = pm.journal_id.currency_id or pm.journal_id.company_id.currency_id
                # When currency_of_cash_control is set, allow foreign currency journals
                # But ensure journal currency matches the payment method currency
                if pm.journal_id.currency_id and pm.journal_id.currency_id.id != pm.currency_of_cash_control.id:
                    raise ValidationError(_(
                        "Journal currency (%s) must match Currency Of Cash Control (%s) for payment method '%s'."
                    ) % (
                        pm.journal_id.currency_id.name,
                        pm.currency_of_cash_control.name,
                        pm.name
                    ))
    
    @api.onchange('journal_id')
    def _onchange_journal_id_multi_currency(self):
        """
        Auto-set currency_of_cash_control from journal currency if not already set.
        This helps with configuration - when user selects a USD journal, auto-set currency to USD.
        """
        for pm in self:
            if pm.journal_id and not pm.currency_of_cash_control:
                # If journal has a currency, use it
                if pm.journal_id.currency_id:
                    pm.currency_of_cash_control = pm.journal_id.currency_id
                # Otherwise, use company base currency
                elif pm.journal_id.company_id:
                    pm.currency_of_cash_control = pm.journal_id.company_id.currency_id
    
    @api.onchange('currency_of_cash_control')
    def _onchange_currency_of_cash_control(self):
        """
        When currency is set, suggest matching journal if available.
        """
        for pm in self:
            if pm.currency_of_cash_control and not pm.journal_id:
                # Try to find a journal with matching currency
                matching_journal = self.env['account.journal'].search([
                    ('type', 'in', ['cash', 'bank']),
                    ('currency_id', '=', pm.currency_of_cash_control.id),
                    ('company_id', '=', pm.company_id.id),
                ], limit=1)
                if matching_journal:
                    pm.journal_id = matching_journal
    
    def get_cash_account(self):
        """Get the cash account to use for this payment method.
        Uses the journal's default account (Odoo standard behavior).
        """
        self.ensure_one()
        if self.journal_id and self.journal_id.default_account_id:
            return self.journal_id.default_account_id
        return False
    
    def get_loss_account(self):
        """Get the loss account for cash short (Odoo standard: journal.loss_account_id)."""
        self.ensure_one()
        if self.journal_id and self.journal_id.loss_account_id:
            return self.journal_id.loss_account_id
        return False
    
    def get_profit_account(self):
        """Get the profit account for cash over (Odoo standard: journal.profit_account_id)."""
        self.ensure_one()
        if self.journal_id and self.journal_id.profit_account_id:
            return self.journal_id.profit_account_id
        return False
    
    def get_payment_currency(self):
        """Get the currency for this payment method."""
        self.ensure_one()
        if self.currency_of_cash_control:
            return self.currency_of_cash_control
        # Fallback to journal currency or company currency
        if self.journal_id and self.journal_id.currency_id:
            return self.journal_id.currency_id
        return self.company_id.currency_id

