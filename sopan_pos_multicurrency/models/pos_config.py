from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


class PosConfig(models.Model):
    _inherit = "pos.config"

    @api.model
    def _load_pos_data_fields(self, config_id):
        """
        Odoo 19 uses `_load_pos_data_fields()` to decide which `pos.config` fields are sent to the POS UI.

        In our codebase, some environments call `pos.config._load_pos_data()` on an empty recordset,
        passing `config_id=False`. If we rely solely on `super()` (pos.load.mixin default), it returns `[]`
        and POS crashes (e.g. KeyError: 'use_pricelist', 'advanced_employee_ids', ...).

        So:
        - Start from `super()` if it provides a base list.
        - Otherwise, fall back to *all* fields defined on `pos.config` in this DB (including fields added by other installed addons like `pos_hr`).
        """
        fields = super()._load_pos_data_fields(config_id)
        if not fields:
            # NOTE: `id` is always present but not necessarily part of `_fields`.
            # Using `_fields` ensures compatibility with extra addons that expect additional keys in `pos.config` data.
            fields = list(self._fields.keys())

        return list(dict.fromkeys(fields))
    
    @api.constrains('pricelist_id', 'use_pricelist', 'available_pricelist_ids', 'journal_id', 'invoice_journal_id', 'payment_method_ids')
    def _check_currencies(self):
        """
        Override to allow payment methods with foreign currency journals when currency_of_cash_control is set.
        This enables multi-currency payment methods (e.g., Cash USD with USD journal when base is TNS).
        IMPORTANT: Method name must be EXACTLY _check_currencies to override Odoo's constraint.
        """
        for config in self:
            if config.use_pricelist and config.pricelist_id and config.pricelist_id not in config.available_pricelist_ids:
                raise ValidationError(_("The default pricelist must be included in the available pricelists."))

            # Check if the config's payment methods are compatible with its currency
            # ALLOW foreign currency journals when currency_of_cash_control is set
            for pm in config.payment_method_ids:
                if pm.journal_id and pm.journal_id.currency_id:
                    # If payment method has currency_of_cash_control set, allow foreign currency journal
                    if pm.currency_of_cash_control:
                        # Allow foreign currency journal - this is the multi-currency feature
                        # Just ensure journal currency matches payment method currency
                        if pm.journal_id.currency_id.id != pm.currency_of_cash_control.id:
                            raise ValidationError(_(
                                "Payment method '%s': Journal currency (%s) must match Currency Of Cash Control (%s)."
                            ) % (
                                pm.name,
                                pm.journal_id.currency_id.name,
                                pm.currency_of_cash_control.name
                            ))
                        # If journal currency matches currency_of_cash_control, allow it even if different from config currency
                        # This is the key: we skip the base currency check when currency_of_cash_control is set
                    else:
                        # No currency_of_cash_control set - apply standard Odoo constraint
                        if pm.journal_id.currency_id != config.currency_id:
                            raise ValidationError(_(
                                "Payment method '%s' must be in the same currency as the Sales Journal or the company currency if that is not set. "
                                "To use a foreign currency journal, set the 'Currency Of Cash Control' field on the payment method."
                            ) % pm.name)

            if config.use_pricelist and any(config.available_pricelist_ids.mapped(lambda pricelist: pricelist.currency_id != config.currency_id)):
                raise ValidationError(_("All available pricelists must be in the same currency as the company or"
                                        " as the Sales Journal set on this point of sale if you use"
                                        " the Accounting application."))
            if config.invoice_journal_id.currency_id and config.invoice_journal_id.currency_id != config.currency_id:
                raise ValidationError(_("The invoice journal must be in the same currency as the Sales Journal or the company currency if that is not set."))

