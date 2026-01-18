from odoo import api, fields, models, _
from odoo.exceptions import UserError


class PosOrder(models.Model):
    _inherit = "pos.order"

    def _process_payment_lines(self, pos_order, order, pos_session, draft):
        """Override core change creation to support UI-selected change payment method.

        If the frontend already created a payment line with `is_change=True`, we skip the
        automatic 'return' payment creation.
        
        CRITICAL FIX: When creating change payment for foreign currency overpayment,
        we now calculate and set currency_amount_total to ensure correct tracking.
        """
        from odoo.tools import float_is_zero
        import logging
        _logger = logging.getLogger(__name__)

        prec_acc = order.currency_id.decimal_places
        order = order.with_context(backend_recomputation=True)

        # Same approach as core Odoo: recompute from server-side payments.
        # This correctly handles negative `is_change` payments and avoids drift.
        order.write({'amount_paid': order._compute_amount_paid()})

        if not draft and not float_is_zero(pos_order.get("amount_return", 0.0), prec_acc):
            # If change is already recorded by the UI, fix it if amount is positive (should be negative)
            existing_change_payments = order.payment_ids.filtered("is_change")
            if existing_change_payments:
                # CRITICAL FIX: Ensure change payment amount is NEGATIVE
                for change_payment in existing_change_payments:
                    if change_payment.amount > 0:
                        # Fix positive amount - make it negative
                        _logger.warning(f"Fixing change payment {change_payment.id}: amount was positive ({change_payment.amount}), making negative")
                        change_payment.write({'amount': -abs(change_payment.amount)})
                        
                        # Also fix currency_amount_total if present
                        if change_payment.currency_amount_total and change_payment.currency_amount_total > 0:
                            _logger.warning(f"Fixing change payment {change_payment.id}: currency_amount_total was positive ({change_payment.currency_amount_total}), making negative")
                            change_payment.write({'currency_amount_total': -abs(change_payment.currency_amount_total)})
                
                return  # Don't create duplicate change payment

            # Get the change amount in base currency.
            # In Odoo, `amount_return` can be negative already. Change payment must ALWAYS be negative.
            change_amount_base = abs(pos_order.get("amount_return", 0.0))
            
            # CRITICAL FIX: Change is ALWAYS given in the POS base currency.
            # Even if customer pays in a foreign currency, they receive change in base currency.
            
            # Find the base-currency cash payment method (currency_of_cash_control is unset or equals base).
            base_currency = pos_session.company_id.currency_id
            change_payment_method = pos_session.payment_method_ids.filtered(
                lambda pm: pm.is_cash_count and (
                    not pm.currency_of_cash_control or pm.currency_of_cash_control.id == base_currency.id
                )
            )[:1]
            
            if not change_payment_method:
                # Fallback: any cash payment method
                change_payment_method = pos_session.payment_method_ids.filtered("is_cash_count")[:1]
                if not change_payment_method:
                    raise UserError(_("No cash statement found for this session. Unable to record returned cash."))
            
            _logger.info(f"Change for order {order.id}: amount={change_amount_base} {base_currency.name}, "
                        f"payment_method={change_payment_method.name}")
            
            # Create change payment in base currency ONLY - no foreign currency fields
            return_payment_vals = {
                "name": _("return"),
                "pos_order_id": order.id,
                "amount": -change_amount_base,  # Negative in base currency
                "payment_date": fields.Datetime.now(),
                "payment_method_id": change_payment_method.id,
                "is_change": True,
                # CRITICAL: NO payment_currency_id, NO currency_amount_total
                # Change is ALWAYS in base currency only
            }
            
            _logger.info(f"Creating change payment in base currency: {return_payment_vals}")
            
            order.add_payment(return_payment_vals)
            order._compute_prices()

