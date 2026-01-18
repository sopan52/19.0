from odoo import api, fields, models, _
import logging

_logger = logging.getLogger(__name__)


class ResCurrency(models.Model):
    _inherit = "res.currency"

    @api.model
    def _load_pos_data_fields(self, config_id):
        # inverse_rate and rate are needed in POS for currency conversion and display.
        # Both fields are required for proper currency conversion calculations.
        return list(dict.fromkeys(super()._load_pos_data_fields(config_id) + ["inverse_rate", "rate"]))

    @api.model
    def _load_pos_data_domain(self, data, config):
        # Start from core currencies (company + pos currency), then add currencies needed for cash control/payment.
        base_domain = super()._load_pos_data_domain(data, config)
        base_ids = set(self.search(base_domain).ids)

        # config is a recordset, not a dict - access fields directly
        pm_currency_ids = set(
            config.payment_method_ids.mapped("currency_of_cash_control").ids
        )
        bill_currency_ids = set(config.default_bill_ids.mapped("currency_id").ids)
        # Dynamic module: no hardcoded currency names. Load only what POS needs.
        currency_ids = {cid for cid in (base_ids | pm_currency_ids | bill_currency_ids) if cid}
        return [("id", "in", list(currency_ids))]

    @api.model
    def _load_pos_data(self, config, data):
        """
        Ensure POS receives consistent `rate` / `inverse_rate` values.

        IMPORTANT (match Odoo UI semantics):
        - `rate`         = "Unit per USD" (foreign per 1 base/company currency)
                           computed as: company_currency._convert(1.0, currency, ...)
        - `inverse_rate` = "USD per Unit" (base per 1 foreign currency unit)
                           computed as: currency._convert(1.0, company_currency, ...)

        We compute both directions using `_convert(..., round=False)` to avoid rounding-to-zero issues
        for tiny currencies like IQD.
        
        NOTE: Rates are computed using today's date. For session-specific rates, the backend
        accounting code uses the session date (stop_at) when creating journal entries to ensure
        consistency with the actual transaction date.
        """
        # Call parent to get base data
        result = super()._load_pos_data(config, data)

        # Get company currency for rate computation
        company = config.company_id
        company_currency = company.currency_id

        # Get current date for rate computation
        # NOTE: We use today() here because _load_pos_data is called when loading POS config,
        # not when opening a session. The backend accounting code uses session.stop_at for
        # actual conversions to ensure consistency with transaction dates.
        today = fields.Date.today()

        # Process each currency in the result to ensure rate is computed
        if 'res.currency' in result:
            currencies_data = result['res.currency']

            # Get all currency IDs that need rates
            currency_ids = [c.get('id') for c in currencies_data if c.get('id')]

            if currency_ids:
                # Now process each currency and set the rate
                for currency_data in currencies_data:
                    currency_id = currency_data.get('id')
                    if not currency_id:
                        continue

                    # If this is the company currency, rate should be 1.0
                    if currency_id == company_currency.id:
                        currency_data['rate'] = 1.0
                        currency_data['inverse_rate'] = 1.0
                    else:
                        rate = 0.0
                        inverse_rate = 0.0
                        try:
                            currency = self.browse(currency_id)
                            if currency.exists():
                                # Compute: 1 foreign -> company currency (base per foreign)
                                base_per_foreign = currency._convert(
                                    1.0,
                                    company_currency,
                                    company,
                                    today,
                                    round=False,
                                )
                                # Compute: 1 company currency -> foreign (foreign per base)
                                foreign_per_base = company_currency._convert(
                                    1.0,
                                    currency,
                                    company,
                                    today,
                                    round=False,
                                )

                                if foreign_per_base and foreign_per_base > 0:
                                    rate = float(foreign_per_base)
                                if base_per_foreign and base_per_foreign > 0:
                                    inverse_rate = float(base_per_foreign)
                                
                                # Log the computed rates for debugging
                                _logger.debug(
                                    "Currency ID %s (%s): rate=%.6f (foreign per 1 base), inverse_rate=%.6f (base per 1 foreign), date=%s",
                                    currency_id, currency.name if currency.exists() else 'unknown',
                                    rate, inverse_rate, today
                                )
                        except Exception as e:
                            _logger.warning("Currency ID %s _convert rate fetch failed: %s", currency_id, str(e))
                            rate = 0.0
                            inverse_rate = 0.0

                        if (not rate or rate <= 0) and (not inverse_rate or inverse_rate <= 0):
                            _logger.warning(
                                "Currency ID %s has no usable rate/inverse_rate for date %s. "
                                "Please ensure a currency rate exists for this date.",
                                currency_id, today
                            )

                        # Set the computed values
                        currency_data['rate'] = float(rate) if rate else 0.0
                        currency_data['inverse_rate'] = float(inverse_rate) if inverse_rate else 0.0

        return result
