from odoo import api, fields, models, _
from odoo.exceptions import UserError, AccessError
from odoo.tools import float_is_zero, float_compare
from odoo.osv.expression import AND
import json
import logging

_logger = logging.getLogger(__name__)


class PosSession(models.Model):
    _inherit = "pos.session"

    # Store closing balances for all currencies (JSON format: {currency_id: amount})
    currency_closing_balances = fields.Text("Currency Closing Balances",
                                            help="JSON dict of {currency_id: closing_amount} for all currencies")

    # Computed field: Total ending balance in base currency (converts all currencies to base)
    total_ending_balance_base = fields.Float(
        "Total Ending Balance (Base Currency)",
        compute="_compute_total_ending_balance_base",
        store=False,
        help="Total ending balance converted to base currency (sum of all currency ending balances converted to base)"
    )

    # Legacy fields for compatibility
    oc_opening_bal_ids = fields.One2many("other.currency.opening.balance", "session_id",
                                         string="Other Currencies Opening Balance")
    oc_opening_cash_details = fields.Text("Other Currency Opening Details")

    @api.model
    def get_opening_balances_by_currency(self, session_id):
        """
        RPC helper for POS frontend.
        Returns a dict {currency_id: opening_total} for the given session.
        This is used by the closing popup to always show starting balances and create currency sections
        even when the pos.load model cache is incomplete.
        """
        session = self.browse(session_id).exists()
        if not session:
            return {}
        lines = self.env['other.currency.opening.balance'].sudo().search([('session_id', '=', session.id)])
        return {l.currency_id.id: l.opening_total for l in lines}

    def _compute_cash_balance(self):
        """
        Override to handle multi-currency cash balances correctly.
        Odoo's core only looks at ONE cash payment method, but we have multiple (TZS, USD, EUR).
        We need to include ALL cash payments converted to base currency.
        """
        for session in self:
            # IMPORTANT:
            # In this customization, bank-type payment methods are considered part of the "cash" total
            # for opening/closing control to avoid generating "Cash difference observed" moves when the
            # user counts cash+bank together.
            payment_methods_to_include = session.payment_method_ids.filtered(
                lambda pm: pm.is_cash_count or pm.type == 'bank'
            )
            if payment_methods_to_include:
                total_cash_payment = 0.0

                # Process each included payment method
                for cash_pm in payment_methods_to_include:
                    captured_cash_payments_domain = AND([
                        session._get_captured_payments_domain(),
                        [('payment_method_id', '=', cash_pm.id)]
                    ])
                    result = self.env['pos.payment']._read_group(
                        captured_cash_payments_domain,
                        aggregates=['amount:sum']
                    )
                    pm_total = result[0][0] or 0.0

                    # All amounts are already in base currency (TZS)
                    total_cash_payment += pm_total
                    _logger.info(f"Cash balance calculation - Payment method: {cash_pm.name}, Total: {pm_total}")

                # Add cash movements (statement lines)
                if session.state == 'closed':
                    total_cash = session.cash_real_transaction + total_cash_payment
                else:
                    total_cash = sum(session.statement_line_ids.mapped('amount')) + total_cash_payment

                session.cash_register_balance_end = session.cash_register_balance_start + total_cash
                session.cash_register_difference = session.cash_register_balance_end_real - session.cash_register_balance_end

                _logger.info(f"Session {session.name} cash balance - Start: {session.cash_register_balance_start}, "
                             f"Payments: {total_cash_payment}, Cash movements: {total_cash - total_cash_payment}, "
                             f"Expected end: {session.cash_register_balance_end}, "
                             f"Actual end (counted): {session.cash_register_balance_end_real}, "
                             f"Difference: {session.cash_register_difference}")
            else:
                session.cash_register_balance_end = 0.0
                session.cash_register_difference = 0.0

    @api.depends('currency_closing_balances')
    def _compute_total_ending_balance_base(self):
        """
        Compute total ending balance in base currency by converting all currency ending balances.
        This shows the total cash value in base currency for all currencies.
        """
        for session in self:
            total = 0.0
            base_currency = session.company_id.currency_id

            # Process all currencies from currency_closing_balances JSON
            if session.currency_closing_balances:
                try:
                    currency_closing = json.loads(session.currency_closing_balances)
                    for currency_id_str, amount in currency_closing.items():
                        try:
                            currency_id = int(currency_id_str)
                            amount_float = float(amount) or 0.0
                            currency = self.env['res.currency'].sudo().browse(currency_id)
                            if not currency.exists() or amount_float == 0:
                                continue
                            if currency.id == base_currency.id:
                                total += amount_float
                                continue
                                try:
                                    total += currency._convert(
                                        amount_float,
                                        base_currency,
                                        session.company_id,
                                        session.stop_at or fields.Datetime.now()
                                    )
                                except Exception as e:
                                    _logger.warning(f"Failed to convert currency {currency_id} ending balance: {e}")
                                    if hasattr(currency, 'inverse_rate') and currency.inverse_rate:
                                        total += amount_float * currency.inverse_rate
                        except (ValueError, TypeError):
                            continue
                except (json.JSONDecodeError, TypeError):
                    pass

            session.total_ending_balance_base = total

    def action_pos_session_open(self):
        """
        Override to load previous session's ending balances for all currencies.
        This allows the opening balance to be pre-filled with the previous session's ending balance.
        """
        result = super().action_pos_session_open()

        for session in self.filtered(lambda s: s.state == 'opening_control'):
            if session.config_id.cash_control and not session.rescue:
                # Find the last closed session for this POS config
                last_session = self.search([
                    ('config_id', '=', session.config_id.id),
                    ('id', '!=', session.id),
                    ('state', '=', 'closed')
                ], order='stop_at desc', limit=1)

                if last_session:
                    # Load ending balances from previous session as opening balances
                    # This allows the opening control popup to show the previous session's ending balance

                    # First, try to load from currency_closing_balances (JSON format with all currencies)
                    currency_closing = {}
                    if last_session.currency_closing_balances:
                        try:
                            currency_closing = json.loads(last_session.currency_closing_balances)
                        except (json.JSONDecodeError, TypeError):
                            currency_closing = {}

                    base_currency_id = session.company_id.currency_id.id
                    base_opening = currency_closing.get(
                        base_currency_id) or last_session.cash_register_balance_end_real or 0.0

                    # Base currency opening is the session cash register start.
                    session.cash_register_balance_start = float(base_opening) or 0.0

                    # Store opening balances dynamically in other.currency.opening.balance (including base currency)
                    # so the POS opening popup can read them from `oc_opening_bal_ids`.
                    OpeningBal = self.env['other.currency.opening.balance'].sudo()
                    # Clear any pre-existing opening lines (safety).
                    session.oc_opening_bal_ids.unlink()
                    for currency_id_str, amount in (currency_closing or {}).items():
                        try:
                            currency_id = int(currency_id_str)
                            OpeningBal.create({
                                'session_id': session.id,
                                'currency_id': currency_id,
                                'opening_total': float(amount) or 0.0,
                            })
                        except (ValueError, TypeError):
                            continue
                    # Ensure base currency exists in oc_opening_bal_ids too (for UI consistency)
                    if not session.oc_opening_bal_ids.filtered(lambda l: l.currency_id.id == base_currency_id):
                        OpeningBal.create({
                            'session_id': session.id,
                            'currency_id': base_currency_id,
                            'opening_total': float(base_opening) or 0.0,
                        })

        return result

    def update_closing_control_state_session(self, notes):
        """
        Override to store ending balances per currency when closing session.
        This allows the next session to load these as opening balances.
        """
        # Get currency counts from the closing popup
        # The notes parameter might contain currency information, but we need to get it from the frontend
        # For now, we'll store the ending balances after the session is closed
        return super().update_closing_control_state_session(notes)

    def post_closing_cash_details(self, counted_cash, currency_counts=None):
        """
        Override to store ending balances per currency.
        The counted_cash is the base currency amount (actual counted amount from user).
        currency_counts is a dict of {currency_id: counted_amount} for all currencies including base.
        """

        def _safe_float(val):
            """Coerce numbers or formatted strings like '50,000.00' to float safely."""
            if val is None:
                return 0.0
            if isinstance(val, (int, float)):
                return float(val)
            if isinstance(val, str):
                cleaned = val.strip()
                # remove thousands separators and any currency symbols/letters
                cleaned = cleaned.replace(",", "")
                cleaned = "".join(ch for ch in cleaned if ch.isdigit() or ch in ".-")
                try:
                    return float(cleaned) if cleaned not in ("", "-", ".", "-.", ".-") else 0.0
                except ValueError:
                    return 0.0
            try:
                return float(val) or 0.0
            except (TypeError, ValueError):
                return 0.0

        counted_cash = _safe_float(counted_cash)
        result = super().post_closing_cash_details(counted_cash)

        # Store ending balances - these will be loaded as opening balances for the next session
        currency_counts = currency_counts or {}

        # Get base currency ID
        base_currency = self.company_id.currency_id
        base_currency_id = base_currency.id

        # SECURITY/CONSISTENCY: Only accept currencies that are relevant for THIS session.
        # This prevents stale/ghost currencies (e.g. EUR) from being stored if the frontend
        # accidentally sends them.
        allowed_currency_ids = {base_currency_id}
        try:
            # Currencies configured on payment methods for cash control.
            allowed_currency_ids |= set(self.payment_method_ids.mapped("currency_of_cash_control").ids)
        except Exception:
            pass
        try:
            # Currencies that exist in opening balances for this session (so closing can include them).
            opening_lines = self.env["other.currency.opening.balance"].sudo().search([("session_id", "=", self.id)])
            allowed_currency_ids |= set(opening_lines.mapped("currency_id").ids)
        except Exception:
            pass

        # Extract closing balances for all currencies
        # Calculate expected ending balance for base currency
        # Expected ending = Opening + Payments Collected (excluding change) + Cash Movements
        orders = self._get_closed_orders()
        base_opening = self.cash_register_balance_start or 0.0

        # Get base currency payments (excluding change)
        default_cash_pm = self.payment_method_ids.filtered(lambda pm: pm.type == 'cash')[:1]
        base_payments = 0.0
        if default_cash_pm:
            base_payments = sum(orders.payment_ids.filtered(
                lambda p: p.payment_method_id == default_cash_pm and not p.is_change
            ).mapped('amount')) or 0.0

        # Get cash movements for base currency
        # Cash movements are statement lines with payment_ref (cash in/out)
        base_cash_movements = 0.0
        if default_cash_pm and default_cash_pm.journal_id:
            # Get cash movements from base currency journal
            base_cash_movements = sum(self.sudo().statement_line_ids.filtered(
                lambda l: l.payment_ref and l.journal_id.id == default_cash_pm.journal_id.id
            ).mapped('amount')) or 0.0

        # Calculate expected ending balance
        base_expected_ending = base_opening + base_payments + base_cash_movements

        # Ending cash in base currency should reflect what was actually counted by the user.
        # Fall back to computed expected ending only if nothing meaningful was received.
        base_ending = counted_cash if counted_cash is not None else base_expected_ending

        # Build a dict of all currency closing balances
        all_currency_closing = {}

        # Log received data for debugging
        _logger.info(
            f"post_closing_cash_details called - Session ID: {self.id}, State: {self.state}, counted_cash: {counted_cash}, currency_counts: {currency_counts}")
        _logger.info(
            f"Base currency calculation - Opening: {base_opening}, Payments: {base_payments}, Cash Movements: {base_cash_movements}, Expected: {base_expected_ending}")

        # Process all currencies from currency_counts
        for currency_id_str, amount in currency_counts.items():
            try:
                # Handle both string and integer currency IDs
                currency_id = int(currency_id_str) if isinstance(currency_id_str, str) else currency_id_str
                if int(currency_id) not in allowed_currency_ids:
                    _logger.warning(
                        f"Ignoring closing currency_id={currency_id} not allowed for this session. "
                        f"Allowed currency_ids={sorted(list(allowed_currency_ids))}"
                    )
                    continue
                amount_float = _safe_float(amount)

                _logger.info(f"Processing currency {currency_id}: amount={amount_float}")

                # Store in the all_currency_closing dict
                all_currency_closing[currency_id] = amount_float
                if currency_id == base_currency_id:
                    # Base currency closing balance - prefer the actual counted amount.
                    base_ending = amount_float
                    _logger.info(f"Base currency in currency_counts with counted amount: {amount_float}")
            except (ValueError, TypeError) as e:
                # Skip invalid entries
                _logger.warning(f"Failed to process currency entry {currency_id_str}: {amount}, error: {e}")
                continue

        # If base currency is not in currency_counts, use counted_cash or calculated expected
        if base_currency_id not in all_currency_closing:
            all_currency_closing[base_currency_id] = base_ending
            _logger.info(f"Base currency not in currency_counts, using: {base_ending}")

        # Store ending balances - store even if state is not exactly 'closing_control' 
        # (might be transitioning or already closed but we still want to store the values)
        # Only skip if session is already fully closed
        if self.state in ('closing_control', 'opening_control', 'opened'):
            currency_closing_json = json.dumps(all_currency_closing) if all_currency_closing else '{}'
            # Compute the overall total in base currency for standard Odoo fields.
            total_ending_in_base = 0.0
            for currency_id, amount_float in all_currency_closing.items():
                if not amount_float:
                    continue
                currency = self.env['res.currency'].sudo().browse(int(currency_id))
                if not currency.exists():
                    continue
                if currency.id == base_currency_id:
                    total_ending_in_base += amount_float
                else:
                    total_ending_in_base += currency._convert(
                        amount_float,
                        base_currency,
                        self.company_id,
                        self.stop_at or fields.Datetime.now()
                    )

            _logger.info(
                f"Writing closing balances (dynamic) - Base={base_ending}, Total(Base Currency)={total_ending_in_base}, All={currency_closing_json}"
            )

            self.write({
                'currency_closing_balances': currency_closing_json,
                'cash_register_balance_end_real': total_ending_in_base,
            })

            # Verify the write was successful
            self.invalidate_recordset(
                ['currency_closing_balances', 'cash_register_balance_end_real']
            )
        else:
            _logger.warning(
                f"Skipping storage of closing balances - Session state is '{self.state}', expected 'closing_control', 'opening_control', or 'opened'")

        return result

    def _post_cash_details_message(self, state, expected, difference, notes):
        """
        Post a multi-currency message in the chatter.
        
        Dynamic behavior:
        - Opening: read amounts from `oc_opening_cash_details` (written by opening popup)
        - Closing: read amounts from `currency_closing_balances` (written by closing popup)
        """
        from markupsafe import Markup
        is_opening = 'opening' in (state or '').lower()
        base_currency = self.company_id.currency_id

        message_lines = []
        title = "Opening cash Balance (Multi-Currency)" if is_opening else "Closing Balance (Multi-Currency)"
        message_lines.append(f"<strong>{title}</strong>")

        # Build amounts map:
        # - opening: {"USD": 100, "EUR": 50, ...} from oc_opening_cash_details keys like "Total USD"
        # - closing: {currency_id: amount} from currency_closing_balances
        amounts_by_currency = []
        total_in_base = 0.0

        if is_opening and self.oc_opening_cash_details:
            try:
                details = json.loads(self.oc_opening_cash_details) if isinstance(self.oc_opening_cash_details,
                                                                                 str) else {}
                if isinstance(details, dict):
                    for k, v in details.items():
                        name = str(k).replace('Total', '').strip()
                        if not name:
                            continue
                        currency = self.env['res.currency'].sudo().search([('name', '=ilike', name)], limit=1)
                        if not currency:
                            continue
                        amount = float(v) if v not in (None, False, '') else 0.0
                        if not amount:
                            continue
                        amounts_by_currency.append((currency, amount))
            except Exception:
                pass
        elif (not is_opening) and self.currency_closing_balances:
            try:
                closing = json.loads(self.currency_closing_balances) if isinstance(self.currency_closing_balances,
                                                                                   str) else {}
                if isinstance(closing, dict):
                    for currency_id_str, amount in closing.items():
                        try:
                            currency_id = int(currency_id_str)
                            currency = self.env['res.currency'].sudo().browse(currency_id)
                            if not currency.exists():
                                continue
                            amount_f = float(amount) if amount not in (None, False, '') else 0.0
                            if not amount_f:
                                continue
                            amounts_by_currency.append((currency, amount_f))
                        except Exception:
                            continue
            except Exception:
                pass

        # Use consistent conversion date for all calculations
        conversion_date = self.stop_at or fields.Datetime.now()
        
        if amounts_by_currency:
            message_lines.append("")
            for currency, amount in amounts_by_currency:
                try:
                    if currency.id == base_currency.id:
                        total_in_base += amount
                        message_lines.append(f"<u>{currency.name}:</u> {currency.format(amount)}")
                    else:
                        # Convert to base currency using the same date as when storing
                        converted = currency._convert(
                            amount, base_currency, self.company_id, conversion_date
                        )
                        total_in_base += converted
                        message_lines.append(
                            f"<u>{currency.name}:</u> {currency.format(amount)} (= {base_currency.format(converted)})"
                        )
                except Exception as e:
                    _logger.warning(f"Failed to convert {currency.name} amount {amount}: {e}")
                    message_lines.append(f"<u>{currency.name}:</u> {currency.format(amount)}")

        # FIX: Use the calculated total from actual currency amounts instead of overriding
        # The calculated total is more accurate because it uses the same conversion method
        # as the POS frontend. Only use cash_register_balance_end_real as a fallback if
        # we couldn't calculate from currency amounts.
        if total_in_base == 0.0 and (not is_opening) and self.cash_register_balance_end_real:
            # Fallback: use stored total only if we couldn't calculate from currency amounts
            total_in_base = self.cash_register_balance_end_real
            _logger.info(f"Using cash_register_balance_end_real as fallback: {total_in_base}")
        else:
            # Log the calculated total for debugging
            _logger.info(
                f"Closing balance total calculated from currency amounts: {total_in_base} {base_currency.name}, "
                f"stored cash_register_balance_end_real: {self.cash_register_balance_end_real or 0.0}"
            )

        message_lines.append("")
        message_lines.append(f"<strong>Total ({base_currency.name}):</strong> {base_currency.format(total_in_base)}")

        if notes:
            message_lines.append("")
            message_lines.append(f"<em>{state} control message:</em>")
            message_lines.append(notes)

        message_body = Markup("<br/>".join(message_lines))
        self.message_post(body=message_body, email_from=self.env.user.email or "admin@example.com")

    def _create_account_move(self, balancing_account=False, amount_to_balance=0, bank_payment_method_diffs=None):
        """
        Override to handle multi-currency cash control.
        Keep move in base currency for proper balancing.
        After creating the move, reconcile cash-in/out movements with company receivable accounts.
        
        CRITICAL FIX: Ensure balancing_account is always POS receivable account (1559), not cash account (1000.0).
        """
        # CRITICAL: Force balancing_account to be POS receivable account (1559) instead of cash account
        # This ensures cash difference entries use account 1559, not account 1000.0
        if balancing_account:
            pos_receivable_account = self.company_id.account_default_pos_receivable_account_id
            if balancing_account.id != pos_receivable_account.id:
                _logger.warning(
                    f"CRITICAL: Balancing account mismatch! Got {balancing_account.code} ({balancing_account.name}), forcing to {pos_receivable_account.code} (1559)")
                balancing_account = pos_receivable_account

        # Use standard Odoo method - keep move in base currency
        # The move currency should remain in base currency (TZS) for proper balancing
        result = super()._create_account_move(balancing_account, amount_to_balance, bank_payment_method_diffs)

        # Reconcile cash-in/out movements with company receivable accounts
        self._reconcile_cash_movements_with_company_accounts()

        return result

    # -------------------------------------------------------------------------
    # Bank payment original currency support
    # -------------------------------------------------------------------------
    def _get_bank_payment_amount_currency(self, payment_method, amounts):
        """
        Compute the foreign/original currency amount for a bank payment method.

        We rely on `pos.payment.payment_currency_id` + `pos.payment.currency_amount_total` filled by the POS frontend.
        This allows account.payment / receivable lines to show the original currency (e.g. EUR) while keeping
        debit/credit in company currency.
        """
        self.ensure_one()
        if not payment_method or payment_method.type != 'bank':
            return (False, 0.0)

        payment_currency = payment_method.currency_of_cash_control or False
        if not payment_currency:
            return (False, 0.0)

        company_currency = self.company_id.currency_id
        if payment_currency.id == company_currency.id:
            return (False, 0.0)

        # Collect all payments for this payment method in this session.
        payments = self._get_closed_orders().payment_ids.filtered(
            lambda p: p.payment_method_id.id == payment_method.id and not p.is_change
        )
        total_amount_currency = 0.0
        for p in payments:
            # Prefer stored foreign amount
            if p.payment_currency_id and p.payment_currency_id.id == payment_currency.id and p.currency_amount_total:
                total_amount_currency += p.currency_amount_total
            else:
                # Fallback: convert company-currency amount (amounts['amount']) proportionally.
                # This fallback is best-effort and should be avoided by ensuring the frontend sets fields.
                try:
                    total_amount_currency = company_currency._convert(
                        abs(amounts.get('amount') or 0.0),
                        payment_currency,
                        self.company_id,
                        self.stop_at or fields.Datetime.now(),
                    )
                except Exception:
                    total_amount_currency = 0.0
                break

        return (payment_currency, total_amount_currency)

    def _apply_move_line_currency(self, move_lines, currency, amount_currency_total):
        """Apply currency_id/amount_currency on move lines, keeping debit/credit intact."""
        if not move_lines or not currency or not amount_currency_total:
            return
        for line in move_lines:
            # Sign follows the move line balance: credit lines get negative amount_currency.
            sign = -1.0 if (line.balance or 0.0) < 0 else 1.0
            line.with_context(check_move_validity=False).write({
                'currency_id': currency.id,
                'amount_currency': sign * abs(amount_currency_total),
            })

    def _create_combine_account_payment(self, payment_method, amounts, diff_amount):
        """
        Override to ensure bank account.payment move lines show the original currency (e.g. EUR)
        when payment method uses `currency_of_cash_control`.
        """
        payment_receivable_line = super()._create_combine_account_payment(payment_method, amounts, diff_amount)

        try:
            if payment_method and payment_method.type == 'bank':
                currency, amt_cur = self._get_bank_payment_amount_currency(payment_method, amounts)
                if currency and amt_cur:
                    # Apply on BOTH sides of the account.payment move:
                    # - Outstanding Receipts
                    # - POS Receivable
                    move = payment_receivable_line.move_id
                    if move:
                        accounts = (payment_method.outstanding_account_id | self._get_receivable_account(payment_method))
                        self._apply_move_line_currency(
                            move.line_ids.filtered(lambda l: l.account_id in accounts),
                            currency,
                            amt_cur
                        )
        except Exception as e:
            _logger.warning(f"Failed to set original currency on combine bank payment move lines: {e}")

        return payment_receivable_line

    def _create_split_account_payment(self, payment, amounts):
        """
        Override to ensure split bank account.payment move lines show the original currency (e.g. EUR)
        when the payment has `payment_currency_id` + `currency_amount_total`.
        """
        payment_receivable_line = super()._create_split_account_payment(payment, amounts)

        try:
            if payment and payment.payment_method_id and payment.payment_method_id.type == 'bank':
                payment_currency = payment.payment_currency_id or payment.payment_method_id.currency_of_cash_control
                if payment_currency and payment_currency.id != self.company_id.currency_id.id:
                    amt_cur = payment.currency_amount_total
                    if not amt_cur:
                        # fallback: convert company currency amount
                        amt_cur = self.company_id.currency_id._convert(
                            abs(amounts.get('amount') or 0.0),
                            payment_currency,
                            self.company_id,
                            self.stop_at or fields.Datetime.now(),
                        )
                    if amt_cur:
                        move = payment_receivable_line.move_id
                        if move:
                            accounts = (
                                payment.payment_method_id.outstanding_account_id
                                | self._get_receivable_account(payment.payment_method_id)
                            )
                            self._apply_move_line_currency(
                                move.line_ids.filtered(lambda l: l.account_id in accounts),
                                payment_currency,
                                amt_cur
                            )
        except Exception as e:
            _logger.warning(f"Failed to set original currency on split bank payment move lines: {e}")

        return payment_receivable_line

    def _prepare_balancing_line_vals(self, imbalance_amount, move, balancing_account):
        """
        Override to ensure cash difference balancing lines ALWAYS use account 1559 (POS Receivable),
        never the cash account (1000.0).
        
        CRITICAL FIX: Cash difference entries must use account 1559, not account 1000.0.
        
        FIX: Handle accounts with secondary currency - if account has a secondary currency,
        the line's currency_id must match it to avoid validation errors.
        """
        # CRITICAL: Force balancing_account to be POS receivable account (1559) instead of cash account
        pos_receivable_account = self.company_id.account_default_pos_receivable_account_id
        if balancing_account.id != pos_receivable_account.id:
            _logger.warning(
                f"CRITICAL: Balancing line account mismatch! Got {balancing_account.code} ({balancing_account.name}), forcing to {pos_receivable_account.code} (1559)")
            balancing_account = pos_receivable_account

        # Call parent method with corrected balancing_account
        line_vals = super()._prepare_balancing_line_vals(imbalance_amount, move, balancing_account)
        
        # FIX: If the balancing account has a secondary currency, ensure the line's currency_id matches it
        # This prevents the error: "The account selected on your journal entry forces to provide a secondary currency"
        account_currency = balancing_account.currency_id
        company_currency = self.company_id.currency_id
        
        if account_currency and account_currency != company_currency:
            # Account has a secondary currency - line must use it
            # Check if the line already has a currency_id that doesn't match the account currency
            current_line_currency_id = line_vals.get('currency_id')
            if current_line_currency_id != account_currency.id:
                # Set the correct currency_id
                line_vals['currency_id'] = account_currency.id
                # Recalculate amount_currency in the account's currency
                # The imbalance_amount is in company currency, convert it to account currency
                amount_currency = company_currency._convert(
                    abs(imbalance_amount),
                    account_currency,
                    self.company_id,
                    self.stop_at or fields.Date.today()
                )
                # Apply the sign based on whether it's debit or credit
                if line_vals.get('debit', 0) > 0:
                    line_vals['amount_currency'] = amount_currency
                else:
                    line_vals['amount_currency'] = -amount_currency
                _logger.info(
                    f"Balancing line: Account {balancing_account.code} has secondary currency {account_currency.name}, "
                    f"setting line currency_id to {account_currency.id}, amount_currency={line_vals.get('amount_currency')}"
                )
        
        return line_vals

    def _get_balancing_account(self):
        """
        Override to ensure balancing account is ALWAYS POS receivable account (1559),
        never the cash account (1000.0).
        
        CRITICAL FIX: Cash difference entries must use account 1559.
        """
        # CRITICAL: Always return POS receivable account (1559) for balancing
        pos_receivable_account = self.company_id.account_default_pos_receivable_account_id
        if pos_receivable_account:
            _logger.info(f"Using POS receivable account {pos_receivable_account.code} (1559) for balancing")
            return pos_receivable_account

        # Fallback to parent method if account not found
        return super()._get_balancing_account()

    def _reconcile_account_move_lines(self, data):
        """
        Override to ensure ONLY cash payment method lines are reconciled together.
        Bank payment methods (like mobile money) must NOT be included in cash reconciliation.
        
        CRITICAL FIX: Filter out all bank payment method lines before reconciliation to prevent
        "Entries are not from the same account" error when mixing cash (account 1559) and bank (account 103020).
        
        The issue: Bank payments create lines in MULTIPLE accounts (e.g., 1559 and 103020), and when
        the parent method tries to reconcile them together, it fails because reconciliation requires
        all lines to use the same account.
        
        The solution: Remove ALL bank payment methods from the reconciliation dictionaries, letting
        Odoo's standard bank payment flow handle them separately.
        
        BANK PAYMENT ACCOUNTING FLOW (Odoo Standard):
        - All payments (cash and bank) first post to account 1559 (POS Receivable) via _get_receivable_account()
        - Bank payments then create account.payment records that move from 1559 to Outstanding Receipts
        - Bank payments are NOT auto-reconciled here (manual reconciliation required when money arrives)
        - Cash payments are auto-reconciled here (money is immediately available)
        """
        # Get all the line collections
        split_cash_statement_lines = data.get('split_cash_statement_lines', self.env['account.move.line'])
        combine_cash_statement_lines = data.get('combine_cash_statement_lines', self.env['account.move.line'])
        split_cash_receivable_lines = data.get('split_cash_receivable_lines', self.env['account.move.line'])
        combine_cash_receivable_lines = data.get('combine_cash_receivable_lines', self.env['account.move.line'])

        # Get bank payment line collections - these are the problem!
        payment_method_to_receivable_lines = data.get('payment_method_to_receivable_lines', {})
        payment_to_receivable_lines = data.get('payment_to_receivable_lines', {})

        # Get POS receivable account (should be 1559)
        pos_receivable_account = self.company_id.account_default_pos_receivable_account_id

        # CRITICAL FIX 1: Filter cash line collections to ensure ONLY lines using POS receivable account
        def is_correct_cash_line(line):
            """Check if a line uses the correct POS receivable account."""
            if line.account_id != pos_receivable_account:
                _logger.warning(
                    f"Filtering out line {line.id} from cash collections - wrong account: {line.account_id.code} ({line.account_id.name}), expected {pos_receivable_account.code}")
                return False
            return True

        split_cash_statement_lines = split_cash_statement_lines.filtered(is_correct_cash_line)
        combine_cash_statement_lines = combine_cash_statement_lines.filtered(is_correct_cash_line)
        split_cash_receivable_lines = split_cash_receivable_lines.filtered(is_correct_cash_line)
        combine_cash_receivable_lines = combine_cash_receivable_lines.filtered(is_correct_cash_line)

        # CRITICAL FIX 2: Remove ALL bank payment methods from payment_method_to_receivable_lines
        # These create lines in multiple accounts and cause the reconciliation error
        filtered_payment_method_to_receivable_lines = {}
        for payment_method, lines in payment_method_to_receivable_lines.items():
            if payment_method.type == 'bank':
                _logger.info(
                    f"REMOVING bank payment method '{payment_method.name}' (type={payment_method.type}) from reconciliation - has {len(lines)} lines in accounts: {[f'{l.account_id.code} ({l.account_id.name})' for l in lines]}")
                # Don't add to filtered dict - effectively removing it from reconciliation
                continue
            else:
                # Keep cash payment methods, but verify all lines use the same account
                unique_accounts = lines.mapped('account_id')
                if len(unique_accounts) > 1:
                    _logger.error(
                        f"ERROR: Payment method '{payment_method.name}' has lines in multiple accounts: {[f'{acc.code} ({acc.name})' for acc in unique_accounts]}")
                    # Filter to only POS receivable account
                    filtered_lines = lines.filtered(lambda l: l.account_id == pos_receivable_account)
                    if filtered_lines:
                        filtered_payment_method_to_receivable_lines[payment_method] = filtered_lines
                else:
                    filtered_payment_method_to_receivable_lines[payment_method] = lines

        # CRITICAL FIX 3: Remove ALL bank payments from payment_to_receivable_lines
        filtered_payment_to_receivable_lines = {}
        for payment, lines in payment_to_receivable_lines.items():
            if payment.payment_method_id.type == 'bank':
                _logger.info(
                    f"REMOVING bank payment {payment.id} (method='{payment.payment_method_id.name}', type={payment.payment_method_id.type}) from reconciliation - has {len(lines)} lines in accounts: {[f'{l.account_id.code} ({l.account_id.name})' for l in lines]}")
                # Don't add to filtered dict - effectively removing it from reconciliation
                continue
            else:
                # Keep cash payments, but verify all lines use the same account
                unique_accounts = lines.mapped('account_id')
                if len(unique_accounts) > 1:
                    _logger.error(
                        f"ERROR: Payment {payment.id} has lines in multiple accounts: {[f'{acc.code} ({acc.name})' for acc in unique_accounts]}")
                    # Filter to only POS receivable account
                    filtered_lines = lines.filtered(lambda l: l.account_id == pos_receivable_account)
                    if filtered_lines:
                        filtered_payment_to_receivable_lines[payment] = filtered_lines
                else:
                    filtered_payment_to_receivable_lines[payment] = lines

        # Update data with all filtered collections
        data.update({
            'split_cash_statement_lines': split_cash_statement_lines,
            'combine_cash_statement_lines': combine_cash_statement_lines,
            'split_cash_receivable_lines': split_cash_receivable_lines,
            'combine_cash_receivable_lines': combine_cash_receivable_lines,
            'payment_method_to_receivable_lines': filtered_payment_method_to_receivable_lines,
            'payment_to_receivable_lines': filtered_payment_to_receivable_lines,
        })

        # Log what we're reconciling
        _logger.info(f"=== RECONCILIATION SUMMARY ===")
        _logger.info(
            f"Cash lines: split_statement={len(split_cash_statement_lines)}, combine_statement={len(combine_cash_statement_lines)}, split_receivable={len(split_cash_receivable_lines)}, combine_receivable={len(combine_cash_receivable_lines)}")
        _logger.info(
            f"Payment method lines (cash only): {len(filtered_payment_method_to_receivable_lines)} payment methods")
        _logger.info(f"Payment lines (cash only): {len(filtered_payment_to_receivable_lines)} payments")
        _logger.info(f"Bank payments EXCLUDED from reconciliation (will be handled by Odoo's standard bank flow)")

        # Call parent method with filtered data
        # Bank payments are now completely removed, so they won't cause reconciliation errors
        return super()._reconcile_account_move_lines(data)

    def _reconcile_cash_movements_with_company_accounts(self):
        """
        Reconcile all cash-in/out movements with company receivable cash accounts.
        This is called after session closing to move cash from PoS accounts to company accounts.
        """
        try:
            # Get all cash movement statement lines for this session
            cash_movements = self.statement_line_ids.filtered(lambda l: l.payment_ref and l.foreign_currency_id)

            for movement in cash_movements:
                if movement.foreign_currency_id and movement.amount_currency:
                    currency_id = movement.foreign_currency_id.id
                    amount_currency = abs(movement.amount_currency)
                    sign = 1 if movement.amount > 0 else -1  # Cash in = positive, Cash out = negative

                    # Reconcile this movement
                    self._reconcile_cash_movement_with_company_account(movement, currency_id, amount_currency, sign)
        except Exception as e:
            _logger.warning(f"Failed to reconcile cash movements with company accounts: {e}")

    @api.model
    def _load_pos_data_fields(self, config_id):
        # Ensure the POS frontend receives our multi-currency opening totals.
        res = super()._load_pos_data_fields(config_id)
        res += ["oc_opening_bal_ids", "oc_opening_cash_details", "currency_closing_balances"]
        return list(dict.fromkeys(res))

    @api.model
    def _load_pos_data_models(self, config_id):
        res = super()._load_pos_data_models(config_id)
        if "other.currency.opening.balance" not in res:
            res.append("other.currency.opening.balance")
        return res

    # NOTE: We do not use `set_opening_multi_cash` (USD/EUR hardcoded) in the dynamic module.
    # The POS opening popup stores ALL currencies via `set_other_currency_opening_bal`.

    def set_other_currency_opening_bal(self, oc_details):
        """Store opening balances for all currencies (dynamic support)."""
        if oc_details:
            self.ensure_one()
            # Store JSON details
            self.oc_opening_cash_details = json.dumps(oc_details) if isinstance(oc_details, dict) else oc_details

            # Delete existing opening balance records for this session
            self.oc_opening_bal_ids.unlink()

            # Calculate total opening balance in base currency
            total_opening_base = 0.0
            company_currency = self.company_id.currency_id

            # Create new opening balance records
            vals = []
            for k, v in oc_details.items():
                # Extract currency name from key (e.g., "Total USD" -> "USD")
                key = k.replace('Total', '').strip()
                if key:
                    # Search for currency by name (case-insensitive)
                    currency = self.env['res.currency'].sudo().search([
                        ('name', '=ilike', key)
                    ], limit=1)
                    if currency:
                        amount = float(v) if v else 0.0
                        if amount > 0:  # Only create record if amount > 0
                            vals.append({
                                'session_id': self.id,
                                'currency_id': currency.id,
                                'opening_total': amount,
                            })

                            # Convert to base currency and add to total
                            if currency.id == company_currency.id:
                                total_opening_base += amount
                            else:
                                converted_amount = currency._convert(
                                    amount,
                                    company_currency,
                                    self.company_id,
                                    fields.Datetime.now()
                                )
                                total_opening_base += converted_amount

            # Create all records at once
            if vals:
                self.env['other.currency.opening.balance'].create(vals)

            # Update cash_register_balance_start with total (all currencies converted to base)
            # This ensures the starting balance shows the total of all currencies
            if total_opening_base > 0:
                self.cash_register_balance_start = total_opening_base

    def try_cash_in_out_multi(self, payment_method_id, _type, amount, reason, extras, foreign_currency_id=False,
                              amount_currency=False, **kwargs):
        """Cash in/out for a specific cash drawer/payment method.

        - `amount` is expressed in the selected journal currency (same as payment method journal currency).
        - Optionally, you can also pass a `foreign_currency_id` + `amount_currency` for multi-currency statement lines.
        - Can also receive foreign_currency_id and amount_currency from kwargs (for RPC compatibility).
        - If foreign_currency_id is provided, will find the payment method with matching currency_of_cash_control and use its journal.
        """
        self.ensure_one()
        payment_method = self.env["pos.payment.method"].browse(payment_method_id)
        if payment_method.type != "cash" or not payment_method.journal_id:
            raise UserError(_("Selected payment method must be a Cash method with a journal."))

        # Support kwargs for RPC calls from JS
        # IMPORTANT: Extract from kwargs FIRST, before any processing
        # RPC calls pass kwargs as a separate dictionary, so we need to check kwargs first
        _logger.info(
            f"Cash move: Initial params - foreign_currency_id={foreign_currency_id}, amount_currency={amount_currency}, amount={amount}, kwargs={kwargs}")

        # Extract from kwargs if not provided in function params
        if not foreign_currency_id:
            foreign_currency_id = kwargs.get("foreign_currency_id") or False
        if amount_currency in (False, None, 0, ''):
            amount_currency = kwargs.get("amount_currency") or False

        _logger.info(
            f"Cash move: After kwargs extraction - foreign_currency_id={foreign_currency_id}, amount_currency={amount_currency}, amount={amount}")

        # If foreign currency is specified, find the payment method with matching currency_of_cash_control
        target_payment_method = payment_method
        if foreign_currency_id:
            # Handle currency_id: can be int, string (name), or string (id)
            currency_id = foreign_currency_id
            if isinstance(currency_id, str):
                # If it's a string, try to find currency by name first, then by ID
                currency = self.env["res.currency"].sudo().search([
                    ("name", "=", currency_id)
                ], limit=1)
                if currency:
                    currency_id = currency.id
                else:
                    # Try to parse as integer ID
                    try:
                        currency_id = int(currency_id)
                    except (ValueError, TypeError):
                        raise UserError(_("Invalid currency: %s") % currency_id)
            elif not isinstance(currency_id, int):
                try:
                    currency_id = int(currency_id)
                except (ValueError, TypeError):
                    raise UserError(_("Invalid currency ID: %s") % currency_id)

            # Find payment method with matching currency_of_cash_control
            # Get all cash payment methods
            all_cash_pms = self.config_id.payment_method_ids.filtered(lambda pm: pm.type == "cash" and pm.journal_id)

            # Find payment method with matching currency_of_cash_control
            matching_pm = all_cash_pms.filtered(
                lambda pm: pm.currency_of_cash_control
                           and pm.currency_of_cash_control.id == currency_id
            )

            if matching_pm:
                # Use the first matching payment method's journal
                target_payment_method = matching_pm[0]
            else:
                # If no matching payment method found, check if current payment method's currency matches
                if payment_method.currency_of_cash_control and payment_method.currency_of_cash_control.id == currency_id:
                    target_payment_method = payment_method
                else:
                    # Use current payment method as fallback
                    target_payment_method = payment_method

        sign = 1 if _type == "in" else -1
        vals = self._prepare_account_bank_statement_line_vals(self, sign, amount, reason, False, extras)
        vals["journal_id"] = target_payment_method.journal_id.id

        # Process foreign currency if provided
        if foreign_currency_id:
            # currency_id was already processed above in the payment method matching section
            # If it wasn't processed (no foreign_currency_id in kwargs), process it now
            if 'currency_id' not in locals():
                currency_id = foreign_currency_id
                if isinstance(currency_id, str):
                    currency = self.env["res.currency"].sudo().search([
                        ("name", "=", currency_id)
                    ], limit=1)
                    if currency:
                        currency_id = currency.id
                    else:
                        try:
                            currency_id = int(currency_id)
                        except (ValueError, TypeError):
                            raise UserError(_("Invalid currency: %s") % currency_id)
                elif not isinstance(currency_id, int):
                    try:
                        currency_id = int(currency_id)
                    except (ValueError, TypeError):
                        raise UserError(_("Invalid currency ID: %s") % currency_id)

            # CRITICAL: Check if journal currency matches foreign currency
            # If they match, we CANNOT set foreign_currency_id (Odoo constraint)
            # Also, we CANNOT set amount_currency without foreign_currency_id (another Odoo constraint)
            # Solution: When journal currency = foreign currency, use amount_currency as the amount value
            journal_currency = target_payment_method.journal_id.currency_id
            company_currency = self.company_id.currency_id
            journal_currency_id = journal_currency.id if journal_currency else company_currency.id

            if currency_id == journal_currency_id:
                # Journal currency matches foreign currency
                # Odoo constraint: Can't set foreign_currency_id when it matches journal currency
                # Odoo constraint: Can't set amount_currency without foreign_currency_id
                # Solution: Use amount_currency as the amount value (since journal is already in that currency)
                # The amount field will be in the journal currency (EUR), not base currency (TZS)
                if amount_currency not in (False, None, 0, ''):
                    try:
                        amount_currency_float = float(amount_currency)
                        # Use amount_currency as the amount (journal is already in foreign currency)
                        # This means amount will be in EUR, not TZS
                        vals["amount"] = sign * amount_currency_float
                        _logger.info(
                            f"Cash move: Journal currency ({journal_currency_id}) matches foreign currency ({currency_id})")
                        _logger.info(
                            f"Cash move: Using amount_currency={amount_currency} as amount (journal is in foreign currency)")
                        # Don't set foreign_currency_id or amount_currency (Odoo constraints)
                        # The currency will be identified from the journal
                        # Store the original base amount for reference (we'll use it to identify currency in get_closing_control_data)
                        # Actually, we can't store it in the statement line, but we can identify from journal
                    except (ValueError, TypeError) as e:
                        _logger.warning(f"Cash move: Could not convert amount_currency={amount_currency} to float: {e}")
                else:
                    _logger.warning(
                        f"Cash move: Journal currency matches foreign currency but amount_currency not provided")
            else:
                # Journal currency is different - safe to set foreign_currency_id
                vals["foreign_currency_id"] = currency_id
                _logger.info(
                    f"Cash move: Set foreign_currency_id={currency_id} in vals (journal currency={journal_currency_id})")

                # Set amount_currency if provided, otherwise calculate from amount using rate
                if amount_currency not in (False, None, 0, ''):
                    try:
                        amount_currency_float = float(amount_currency)
                        vals["amount_currency"] = sign * amount_currency_float
                        _logger.info(
                            f"Cash move: Set amount_currency={vals['amount_currency']} (from provided value {amount_currency}) for currency_id={currency_id}, amount={amount}")
                    except (ValueError, TypeError) as e:
                        _logger.warning(f"Cash move: Could not convert amount_currency={amount_currency} to float: {e}")
                        # Fall through to conversion
                else:
                    # If amount_currency not provided, convert base amount to foreign currency
                    currency = self.env["res.currency"].browse(currency_id)
                    if currency.exists():
                        # Convert base amount (in base currency) to foreign currency
                        # amount is in base currency, we need to convert it to foreign currency
                        company_currency = self.company_id.currency_id
                        if currency.id != company_currency.id:
                            # Convert: foreign_amount = base_amount / rate (if rate = how many base = 1 foreign)
                            # Or use inverse_rate: foreign_amount = base_amount * inverse_rate
                            converted_amount = company_currency._convert(
                                abs(amount),
                                currency,
                                self.company_id,
                                fields.Datetime.now()
                            )
                            vals["amount_currency"] = sign * converted_amount
                            _logger.info(
                                f"Cash move: Converted amount={amount} to amount_currency={vals['amount_currency']} for currency_id={currency_id}")
                        else:
                            # Same currency, use amount directly
                            vals["amount_currency"] = sign * float(amount)
                            _logger.info(f"Cash move: Same currency, using amount={amount} as amount_currency")
                    else:
                        _logger.warning(f"Cash move: Currency {currency_id} not found, cannot set amount_currency")

            _logger.info(
                f"Cash move: Created with foreign_currency_id={currency_id}, amount_currency={vals.get('amount_currency')}, amount={amount}")
            _logger.info(f"Cash move: vals dict before create: {vals}")

        statement_line = self.env["account.bank.statement.line"].create([vals])

        # CRITICAL: After creation, verify and re-set the fields if they were lost
        # This can happen if Odoo's standard code overwrites them
        # BUT: Only set foreign_currency_id if journal currency is different
        if foreign_currency_id:
            if 'currency_id' not in locals():
                currency_id = foreign_currency_id
                if not isinstance(currency_id, int):
                    try:
                        currency_id = int(currency_id)
                    except (ValueError, TypeError):
                        currency_id = None

            if currency_id:
                journal_currency = target_payment_method.journal_id.currency_id
                company_currency = self.company_id.currency_id
                journal_currency_id = journal_currency.id if journal_currency else company_currency.id

                # Only set foreign_currency_id if journal currency is different
                if currency_id != journal_currency_id:
                    # Check if fields were lost during creation
                    if not statement_line.foreign_currency_id or statement_line.foreign_currency_id.id != currency_id:
                        _logger.warning(
                            f"Cash move: foreign_currency_id was lost during create! Re-setting to {currency_id}")
                        try:
                            statement_line.write({'foreign_currency_id': currency_id})
                        except Exception as e:
                            _logger.warning(f"Cash move: Could not set foreign_currency_id: {e}")

                # Only set amount_currency if journal currency is different (Odoo constraint)
                if currency_id != journal_currency_id:
                    # Journal currency is different, so we can set amount_currency
                    if amount_currency not in (False, None, 0, ''):
                        try:
                            expected_amount_currency = sign * float(amount_currency)
                            if abs(statement_line.amount_currency or 0) != abs(expected_amount_currency):
                                _logger.warning(
                                    f"Cash move: amount_currency was lost during create! Re-setting to {expected_amount_currency}")
                                statement_line.write({'amount_currency': expected_amount_currency})
                        except (ValueError, TypeError) as e:
                            _logger.warning(f"Cash move: Could not re-set amount_currency: {e}")
                else:
                    # Journal currency matches - amount_currency is already set as amount, don't try to set it again
                    _logger.info(f"Cash move: Journal currency matches, amount_currency is stored as amount field")

        # Verify the statement line after potential fixes
        _logger.info(
            f"Cash move: Statement line {statement_line.id} after fixes - foreign_currency_id={statement_line.foreign_currency_id.id if statement_line.foreign_currency_id else None}, amount_currency={statement_line.amount_currency}")

        return statement_line

    def _get_receivable_account(self, payment_method):
        """
        For bank payments, respect the payment method's Intermediate Account (receivable_account_id) if set.
        Fallback to the company default POS receivable account when not set.

        IMPORTANT: Do not fallback to the journal default account (cash account 1000.*).
        """
        # For bank payments, prefer payment method intermediate account; otherwise use POS default.
        if payment_method.type == 'bank':
            account = payment_method.receivable_account_id or self.company_id.account_default_pos_receivable_account_id
            _logger.info(
                f"Bank payment method {payment_method.name}: Using receivable account {account.code} ({account.name})"
            )
            return account

        # For cash payments, use standard behavior
        return super()._get_receivable_account(payment_method)

    def _get_company_receivable_cash_account(self, currency_id):
        """
        Get the company receivable cash account for a specific currency.
        Returns the first payment method/journal marked as 'use_as_default_receivable_cash_from_pos'
        for the given currency.
        """
        # Find payment methods with matching currency and marked as receivable
        payment_methods = self.env['pos.payment.method'].search([
            ('use_as_default_receivable_cash_from_pos', '=', True),
            ('currency_of_cash_control', '=', currency_id),
            ('journal_id', '!=', False),
        ], limit=1)

        if payment_methods and payment_methods[0].journal_id:
            return payment_methods[0].journal_id.default_account_id

        return False

    def _reconcile_cash_movement_with_company_account(self, statement_line, currency_id, amount_currency, sign):
        """
        Reconcile cash-in/out movement with company receivable cash account.
        Creates a journal entry: PoS cash account (Credit) -> Company receivable cash account (Debit)
        """
        try:
            # Get company receivable cash account for this currency
            company_account = self._get_company_receivable_cash_account(currency_id)
            if not company_account:
                # No company receivable account configured for this currency
                return

            # Get the PoS cash account (from statement line's journal)
            pos_account = statement_line.journal_id.default_account_id
            if not pos_account:
                return

            # Get currency
            currency = self.env['res.currency'].browse(currency_id)
            company_currency = self.company_id.currency_id

            # Calculate base currency amount
            if currency.id != company_currency.id:
                base_amount = currency._convert(
                    abs(amount_currency),
                    company_currency,
                    self.company_id,
                    statement_line.date
                )
            else:
                base_amount = abs(amount_currency)

            # Create journal entry for reconciliation
            # PoS cash account: Credit (cash out) or Debit (cash in)
            # Company receivable account: Debit (cash out) or Credit (cash in)
            move_vals = {
                'date': statement_line.date,
                'journal_id': statement_line.journal_id.id,
                'ref': f'Cash {statement_line.payment_ref or "Movement"} - {currency.name}',
                'line_ids': [
                    # PoS cash account line
                    (0, 0, {
                        'account_id': pos_account.id,
                        'debit': base_amount if sign > 0 else 0.0,  # Cash in = debit
                        'credit': base_amount if sign < 0 else 0.0,  # Cash out = credit
                        'currency_id': currency.id if currency.id != company_currency.id else False,
                        'amount_currency': amount_currency if currency.id != company_currency.id else False,
                        'name': f'Cash {statement_line.payment_ref or "Movement"} - {currency.name}',
                    }),
                    # Company receivable cash account line
                    (0, 0, {
                        'account_id': company_account.id,
                        'debit': base_amount if sign < 0 else 0.0,  # Cash out = debit (money going to company)
                        'credit': base_amount if sign > 0 else 0.0,  # Cash in = credit (money coming from company)
                        'currency_id': currency.id if currency.id != company_currency.id else False,
                        'amount_currency': -amount_currency if currency.id != company_currency.id else False,
                        'name': f'Cash {statement_line.payment_ref or "Movement"} - {currency.name}',
                    }),
                ],
            }

            # Create the move
            move = self.env['account.move'].create(move_vals)
            move.action_post()

            # Reconcile the lines
            # Get the receivable line from the move
            receivable_line = move.line_ids.filtered(lambda l: l.account_id.id == company_account.id)
            if receivable_line:
                # Reconcile with statement line's receivable line
                statement_receivable_line = statement_line.move_id.line_ids.filtered(
                    lambda l: l.account_id.account_type == 'asset_receivable'
                )
                if statement_receivable_line:
                    (receivable_line | statement_receivable_line).reconcile()
        except Exception as e:
            # Log error but don't break the cash movement
            _logger.warning(f"Failed to reconcile cash movement with company account: {e}")

    @api.model
    def get_cash_movements_with_currency(self, session_id):
        """Get cash movements with currency information for closing popup display."""
        try:
            session = self.env['pos.session'].browse(session_id)
            if not session.exists():
                return {}

            result = {}
            # Get all statement lines for this session
            journal_ids = session.config_id.payment_method_ids.mapped('journal_id').ids
            if not journal_ids:
                journal_ids = session.statement_ids.mapped('journal_id').ids

            if not journal_ids:
                return {}

            # Filter for cash movements
            domain = [("journal_id", "in", journal_ids)]

            if session.start_at:
                domain.append(("date", ">=", session.start_at))

            if session.stop_at:
                domain.append(("date", "<=", session.stop_at))
            else:
                domain.append(("date", "<=", fields.Datetime.now()))

            statement_lines = self.env["account.bank.statement.line"].search(domain)
            cash_movement_lines = statement_lines.filtered(lambda l: l.payment_ref)

            # Create a mapping of journal_id to payment method currency
            journal_to_currency = {}
            for pm in session.config_id.payment_method_ids:
                if pm.journal_id and pm.currency_of_cash_control:
                    journal_to_currency[pm.journal_id.id] = pm.currency_of_cash_control.id

            for line in cash_movement_lines:
                keys = []
                if line.payment_ref:
                    keys.append(line.payment_ref)
                    keys.append(line.payment_ref.strip())
                if line.name:
                    keys.append(line.name)
                    keys.append(line.name.strip())
                if line.name and '-' in line.name:
                    parts = line.name.split('-')
                    if len(parts) >= 2:
                        keys.append('-'.join(parts[-2:]))
                        keys.append(parts[-1])
                keys.append(f"statement_line_{line.id}")
                keys.append(str(line.id))

                # Determine currency: first from foreign_currency_id, then from journal's payment method
                currency_id = None
                if line.foreign_currency_id:
                    currency_id = line.foreign_currency_id.id
                elif line.journal_id and line.journal_id.id in journal_to_currency:
                    currency_id = journal_to_currency[line.journal_id.id]

                # If we have a currency (foreign or from payment method), create currency info
                if currency_id:
                    currency = self.env["res.currency"].browse(currency_id)
                    currency_info = {
                        "foreign_currency_id": currency_id,
                        "amount_currency": abs(line.amount_currency) if line.amount_currency else abs(line.amount),
                        "currency_symbol": currency.symbol,
                        "currency_name": currency.name,
                        "line_id": line.id,
                        "base_amount": abs(line.amount),
                        "payment_ref": line.payment_ref,
                        "journal_id": line.journal_id.id if line.journal_id else None,
                    }
                    for key in keys:
                        if key:
                            result[key] = currency_info
                    if line.amount:
                        base_amount_key = f"base_amount_{abs(line.amount)}"
                        result[base_amount_key] = currency_info
                        base_amount_rounded = round(abs(line.amount), 2)
                        result[f"base_amount_{base_amount_rounded}"] = currency_info
                    if line.date:
                        try:
                            fuzzy_key = f"amount_{abs(line.amount_currency or line.amount)}_{line.date.strftime('%Y-%m-%d')}"
                            result[fuzzy_key] = currency_info
                        except Exception:
                            pass
                    # Add journal_id as a direct key for easy matching
                    if line.journal_id:
                        journal_key = f"journal_{line.journal_id.id}"
                        result[journal_key] = currency_info

            return result
        except Exception as e:
            pass
            return {}

    def get_closing_control_data(self):
        if not self.env.user.has_group('point_of_sale.group_pos_user'):
            raise AccessError(_("You don't have the access rights to get the point of sale closing control data."))
        self.ensure_one()
        orders = self._get_closed_orders()
        payments = orders.payment_ids.filtered(lambda p: p.payment_method_id.type != "pay_later")
        cash_payment_method_ids = self.payment_method_ids.filtered(lambda pm: pm.type == 'cash')
        default_cash_payment_method_id = cash_payment_method_ids[0] if cash_payment_method_ids else None

        # IMPORTANT: Filter out change payments (is_change=True) from payment_amount calculation
        # Change payments should be shown separately, not included in payments collected
        default_cash_payments = payments.filtered(lambda
                                                      p: p.payment_method_id == default_cash_payment_method_id and not p.is_change) if default_cash_payment_method_id else []
        total_default_cash_payment_amount = sum(
            default_cash_payments.mapped('amount')) if default_cash_payment_method_id else 0

        # IMPORTANT: Bank payments must NEVER be included in cash drawer expected totals.
        # If we add bank payments to cash totals, Odoo will create a CST "Cash difference" move (gain/loss)
        # because it thinks the bank money is physically in the cash box.
        # We still compute bank totals for DISPLAY ONLY in the closing dialog.
        bank_payments = payments.filtered(lambda p: p.payment_method_id.type == 'bank' and not p.is_change)
        total_bank_payment_amount = sum(bank_payments.mapped('amount')) if bank_payments else 0.0

        # Get change payments separately
        change_payments = payments.filtered(lambda
                                                p: p.payment_method_id == default_cash_payment_method_id and p.is_change) if default_cash_payment_method_id else []
        total_change_amount = sum(change_payments.mapped('amount')) if default_cash_payment_method_id else 0

        # Keep standard behavior: bank methods remain in non_cash_payment_methods section
        non_cash_payment_method_ids = self.payment_method_ids - default_cash_payment_method_id if default_cash_payment_method_id else self.payment_method_ids
        # Also filter out change payments from non-cash payment methods
        non_cash_payments_grouped_by_method_id = {
            pm: orders.payment_ids.filtered(lambda p: p.payment_method_id == pm and not p.is_change) for pm in
            non_cash_payment_method_ids}

        cash_in_count = 0
        cash_out_count = 0
        cash_in_out_list = []
        for cash_move in self.sudo().statement_line_ids.sorted('create_date'):
            if cash_move.amount > 0:
                cash_in_count += 1
                name = f'Cash in {cash_in_count}'
            else:
                cash_out_count += 1
                name = f'Cash out {cash_out_count}'
            # Determine currency: first from foreign_currency_id, then from journal's payment method
            move_currency_id = None
            move_amount_currency = None
            base_amount = cash_move.amount  # Default: assume amount is in base currency

            if cash_move.foreign_currency_id:
                # Foreign currency is explicitly set
                move_currency_id = cash_move.foreign_currency_id.id
                move_amount_currency = cash_move.amount_currency if cash_move.amount_currency else None
                # If amount_currency is set, then amount is in base currency
                # If amount_currency is not set, amount might be in foreign currency
                if not move_amount_currency:
                    # Check if journal currency matches foreign currency
                    if cash_move.journal_id and cash_move.journal_id.currency_id and cash_move.journal_id.currency_id.id == move_currency_id:
                        # Journal currency = foreign currency, so amount is in foreign currency
                        move_amount_currency = abs(cash_move.amount)
                        # Convert to base currency
                        foreign_currency = cash_move.foreign_currency_id
                        company_currency = self.company_id.currency_id
                        if foreign_currency.id != company_currency.id:
                            base_amount = foreign_currency._convert(
                                abs(cash_move.amount),
                                company_currency,
                                self.company_id,
                                cash_move.date or fields.Datetime.now()
                            )
                            # Preserve sign
                            base_amount = base_amount if cash_move.amount >= 0 else -base_amount
                    else:
                        # Amount is in base currency, convert to foreign
                        foreign_currency = cash_move.foreign_currency_id
                        company_currency = self.company_id.currency_id
                        if foreign_currency.id != company_currency.id:
                            move_amount_currency = company_currency._convert(
                                abs(cash_move.amount),
                                foreign_currency,
                                self.company_id,
                                cash_move.date or fields.Datetime.now()
                            )
                else:
                    # amount_currency is set, so amount is in base currency (already correct)
                    pass
            elif cash_move.journal_id:
                # Check if journal currency matches a payment method currency
                for pm in self.payment_method_ids:
                    if pm.journal_id and pm.journal_id.id == cash_move.journal_id.id and pm.currency_of_cash_control:
                        move_currency_id = pm.currency_of_cash_control.id
                        journal_currency = cash_move.journal_id.currency_id or self.company_id.currency_id

                        # When journal currency matches foreign currency, amount_currency is not set
                        # The amount field itself is in the foreign currency
                        if journal_currency.id == move_currency_id and move_currency_id != self.company_id.currency_id.id:
                            # Amount is in foreign currency (journal currency)
                            move_amount_currency = abs(cash_move.amount)
                            # Convert to base currency
                            foreign_currency = self.env['res.currency'].browse(move_currency_id)
                            company_currency = self.company_id.currency_id
                            base_amount = foreign_currency._convert(
                                abs(cash_move.amount),
                                company_currency,
                                self.company_id,
                                cash_move.date or fields.Datetime.now()
                            )
                            # Preserve sign
                            base_amount = base_amount if cash_move.amount >= 0 else -base_amount
                        elif cash_move.amount_currency:
                            # amount_currency is set, amount is in base currency
                            move_amount_currency = abs(cash_move.amount_currency)
                        else:
                            # No foreign currency info, amount is in base currency
                            pass
                        break

            cash_in_out_list.append({
                'name': cash_move.payment_ref if cash_move.payment_ref else name,
                'amount': base_amount,  # Always in base currency (TSH)
                'other_curr': cash_move.foreign_currency_id.name if cash_move.foreign_currency_id else (
                    self.env['res.currency'].browse(move_currency_id).name if move_currency_id else ''),
                'other_curr_amt': move_amount_currency if move_amount_currency is not None else None,
                # Foreign currency amount
                'other_curr_symbol': cash_move.foreign_currency_id.symbol if cash_move.foreign_currency_id else (
                    self.env['res.currency'].browse(move_currency_id).symbol if move_currency_id else ''),
                'foreign_currency_id': move_currency_id if move_currency_id else (
                    cash_move.foreign_currency_id.id if cash_move.foreign_currency_id else None),
                'journal_id': cash_move.journal_id.id if cash_move.journal_id else None,
                'statement_line_id': cash_move.id,  # Add statement line ID for direct matching
            })
        oc_details = []
        company_currency = self.company_id.currency_id
        today = fields.Datetime.now()

        for oc in self.oc_opening_bal_ids:
            currency = oc.currency_id
            rate = 0.0

            # If this is the company currency, rate should be 1.0
            if currency.id == company_currency.id:
                rate = 1.0
            else:
                # Compute rate using ORM calls
                try:
                    # Method 1: Use _convert to compute rate
                    converted_amount = currency._convert(
                        1.0,  # 1 unit of foreign currency
                        company_currency,  # to company currency
                        self.company_id,  # company
                        today,  # date
                        round=False,
                    )
                    if converted_amount and converted_amount > 0:
                        # Use readable display:
                        # - for normal currencies: show base per 1 foreign (e.g. 1 EUR = 0.78 USD)
                        # - for very small currencies (e.g. IQD): show foreign per 1 base (e.g. 1 USD = 1432 IQD)
                        rate = converted_amount if converted_amount >= 0.01 else (1.0 / converted_amount)
                except Exception:
                    pass

                # Method 2: If _convert failed, try reading from currency rate records directly
                if not rate or rate == 0:
                    try:
                        rate_obj = self.env['res.currency.rate'].search([
                            ('currency_id', '=', currency.id),
                            ('name', '<=', today.date())
                        ], order='name desc', limit=1)
                        if rate_obj and rate_obj.rate > 0:
                            rate = rate_obj.rate
                    except Exception:
                        pass

                # Method 3: Fallback - try reading the computed field directly
                if not rate or rate == 0:
                    try:
                        currency._read(['rate'])
                        rate = currency.rate or 0.0
                    except Exception:
                        rate = 0.0

            oc_details.append([
                oc.name,
                rate,  # Use computed rate instead of oc.currency_id.rate
                oc.opening_total,
                oc.symbol])

        # Calculate total opening balance in base currency (includes all currencies converted to base)
        total_opening_balance_base = self.cash_register_balance_start or 0.0

        # Add all foreign currency opening balances converted to base currency
        company_currency = self.company_id.currency_id
        for oc in self.oc_opening_bal_ids:
            if oc.currency_id and oc.currency_id.id != company_currency.id and oc.opening_total:
                # Convert foreign currency amount to base currency
                converted_amount = oc.currency_id._convert(
                    oc.opening_total,
                    company_currency,
                    self.company_id,
                    fields.Datetime.now()
                )
                total_opening_balance_base += converted_amount

        return {
            'orders_details': {
                'quantity': len(orders),
                'amount': sum(orders.mapped('amount_total'))
            },
            'opening_notes': self.opening_notes,
            'default_cash_details': {
                'name': default_cash_payment_method_id.name,
                'amount': total_opening_balance_base
                          + total_default_cash_payment_amount
                          + sum(self.sudo().statement_line_ids.mapped('amount')),
                'opening': total_opening_balance_base,
                'payment_amount': total_default_cash_payment_amount,
                # DISPLAY ONLY: bank payments collected (in base currency). Do not include in cash expected totals.
                'bank_payment_amount': total_bank_payment_amount,
                'bank_payment_number': len(bank_payments),
                'change_amount': total_change_amount,  # Add change amount separately
                'moves': cash_in_out_list,
                'id': default_cash_payment_method_id.id
            } if default_cash_payment_method_id else {},
            'non_cash_payment_methods': [{
                'name': pm.name,
                'amount': sum(non_cash_payments_grouped_by_method_id[pm].mapped('amount')),
                'number': len(non_cash_payments_grouped_by_method_id[pm]),
                'id': pm.id,
                'type': pm.type,
            } for pm in non_cash_payment_method_ids],
            'is_manager': self.env.user.has_group("point_of_sale.group_pos_manager"),
            'amount_authorized_diff': self.config_id.amount_authorized_diff if self.config_id.set_maximum_difference else None,
            'oc_details': oc_details
        }

    def _create_cash_statement_lines_and_cash_move_lines(self, data):
        """
        Override to create separate receivable lines per currency payment.
        Each currency payment should have its own receivable line in account 1559 (or receivable account).
        CRITICAL: Only process CASH payment methods - bank payments should not reach this method.
        
        BANK PAYMENT FLOW (handled by Odoo standard, NOT this method):
        - Bank payments are processed by _create_bank_payment_moves() (NOT overridden by us)
        - All payments (cash and bank) first post to account 1559 (POS Receivable) via _get_receivable_account()
        - Bank payments then move from 1559 to Outstanding Receipts via account.payment records
        - Cash payments (handled here) move from 1559 to cash accounts via statement lines
        - This separation ensures bank payments are NOT auto-reconciled (manual reconciliation required)
        """
        # Create the split and combine cash statement lines and account move lines.
        MoveLine = data.get('MoveLine')
        split_receivables_cash_orig = data.get('split_receivables_cash', {})
        combine_receivables_cash_orig = data.get('combine_receivables_cash', {})

        # CRITICAL: Filter out any bank payment methods that might have been included
        # Only process cash payment methods - bank payments use different methods
        split_receivables_cash = {}
        for payment, amounts in split_receivables_cash_orig.items():
            if payment.payment_method_id.type == 'cash':
                split_receivables_cash[payment] = amounts
            else:
                _logger.warning(
                    f"Filtering out non-cash payment {payment.id} (method={payment.payment_method_id.name}, type={payment.payment_method_id.type}) from split_receivables_cash")

        combine_receivables_cash = {}
        for payment_method, amounts in combine_receivables_cash_orig.items():
            if payment_method.type == 'cash':
                combine_receivables_cash[payment_method] = amounts
            else:
                _logger.warning(
                    f"Filtering out non-cash payment method {payment_method.name} (type={payment_method.type}) from combine_receivables_cash")

        # handle split cash payments - GROUP BY CURRENCY for split payments too
        split_cash_statement_line_vals = []
        split_cash_receivable_vals = []

        # Group split payments by payment method type AND currency
        # CRITICAL: Must group by payment method type to ensure cash and bank payments use different accounts
        from collections import defaultdict
        split_currency_receivables = defaultdict(
            lambda: {'amount': 0.0, 'amount_converted': 0.0, 'payments': [], 'payment_method': None, 'currency': None})

        for payment, amounts in split_receivables_cash.items():
            payment_method = payment.payment_method_id
            # CRITICAL: Only process cash payment methods (split_receivables_cash should only contain cash, but verify)
            if payment_method.type != 'cash':
                _logger.warning(
                    f"Skipping non-cash payment method {payment_method.name} (type={payment_method.type}) from split_receivables_cash")
                continue

            payment_record = self.env['pos.payment'].browse(payment.id)

            # Determine currency: use payment currency if available, otherwise payment method currency
            payment_currency = None

            # CRITICAL: Change payments should ALWAYS use base currency (TZS)
            # Even if they have foreign currency fields set, force to TZS
            if payment_record.is_change:
                payment_currency = self.company_id.currency_id
                _logger.info(f"Split change payment {payment.id}: forcing TZS (base currency), amount={payment.amount}")
            elif payment_record.payment_currency_id:
                payment_currency = payment_record.payment_currency_id
            elif payment_method.currency_of_cash_control:
                payment_currency = payment_method.currency_of_cash_control
            else:
                payment_currency = self.company_id.currency_id

            # CRITICAL: Group by (payment_method_type, currency_id) to keep cash and bank separate
            # This ensures cash payments use receivable accounts and bank payments use bank accounts
            # Change payments are included normally (they have negative amounts which reduce the total)
            currency_key = (payment_method.type, payment_currency.id)
            split_currency_receivables[currency_key]['amount'] += amounts['amount']
            split_currency_receivables[currency_key]['amount_converted'] += amounts['amount_converted']
            split_currency_receivables[currency_key]['payments'].append(payment)
            split_currency_receivables[currency_key]['payment_method'] = payment_method
            split_currency_receivables[currency_key]['currency'] = payment_currency

        # Create separate receivable lines for each (payment_method_type, currency) group in split payments
        for currency_key, currency_data in split_currency_receivables.items():
            # currency_key is now (payment_method_type, currency_id)
            currency_id = currency_key[1] if isinstance(currency_key, tuple) else currency_key
            payment_method = currency_data['payment_method']
            currency = currency_data['currency']
            amount = currency_data['amount']

            # For split payments, we still create statement lines per payment, but group receivables by currency
            # Create statement lines for each payment in this currency group
            for payment in currency_data['payments']:
                journal_id = payment.payment_method_id.journal_id
                payment_amount = payment.amount
                split_cash_statement_line_vals.append(
                    self._get_split_statement_line_vals(
                        journal_id,
                        payment_amount,
                        payment
                    )
                )

            # Create ONE receivable line per currency for split payments
            split_cash_receivable_vals.append(
                self._get_split_receivable_vals_by_currency(
                    payment_method,
                    amount,
                    currency_data['amount_converted'],
                    currency,
                    currency_data['payments']
                )
            )

        # handle combine cash payments - GROUP BY CURRENCY instead of payment method
        # This creates separate receivable lines for each currency (USD, EUR, TZS, etc.)
        combine_cash_statement_line_vals = []
        combine_cash_receivable_vals = []

        # Group payments by payment method type AND currency
        # CRITICAL: Must group by payment method type to ensure cash and bank payments use different accounts
        # Group by (payment_method_type, currency_id) tuple to keep cash and bank separate
        currency_receivables = defaultdict(
            lambda: {'amount': 0.0, 'amount_converted': 0.0, 'order_amount': 0.0, 'payments': [],
                     'payment_method': None, 'currency': None})

        # Get all payments and group by payment method type AND currency
        closed_orders = self._get_closed_orders()
        for payment_method, amounts in combine_receivables_cash.items():
            # CRITICAL: Only process cash payment methods (combine_receivables_cash should only contain cash, but verify)
            if payment_method.type != 'cash':
                _logger.warning(
                    f"Skipping non-cash payment method {payment_method.name} (type={payment_method.type}) from combine_receivables_cash")
                continue

            if not float_is_zero(amounts['amount'], precision_rounding=self.currency_id.rounding):
                # Get all payments for this payment method
                for order in closed_orders:
                    for payment in order.payment_ids:
                        if payment.payment_method_id.id == payment_method.id and not payment.payment_method_id.split_transactions:
                            payment_record = self.env['pos.payment'].browse(payment.id)

                            # Determine currency: use payment currency if available, otherwise payment method currency
                            payment_currency = None

                            # CRITICAL: Change payments should ALWAYS use base currency (TZS)
                            if payment_record.is_change:
                                payment_currency = self.company_id.currency_id
                                _logger.info(
                                    f"Change payment {payment.id}: forcing TZS (base currency), amount={payment.amount}")
                            elif payment_record.payment_currency_id:
                                payment_currency = payment_record.payment_currency_id
                            elif payment_method.currency_of_cash_control:
                                payment_currency = payment_method.currency_of_cash_control
                            else:
                                # Fallback to company currency
                                payment_currency = self.company_id.currency_id

                            # CRITICAL: Group by (payment_method_type, currency_id) to keep cash and bank separate
                            # This ensures cash payments use receivable accounts and bank payments use bank accounts
                            currency_key = (payment_method.type, payment_currency.id)
                            currency_receivables[currency_key]['amount'] += payment.amount  # Payment amount (gross)
                            currency_receivables[currency_key]['amount_converted'] += payment.amount
                            # CRITICAL: Track order amount for receivable (net, after change)
                            # The receivable should match the order amount, not payment amount
                            currency_receivables[currency_key]['order_amount'] += order.amount_total  # Order total
                            currency_receivables[currency_key]['payments'].append(payment)
                            # Store the payment method for this group (needed for account selection)
                            if currency_receivables[currency_key]['payment_method'] is None:
                                currency_receivables[currency_key]['payment_method'] = payment_method
                            currency_receivables[currency_key]['currency'] = payment_currency

                            # Log for debugging
                            _logger.info(
                                f"Payment {payment.id}: amount={payment.amount}, order_total={order.amount_total}, currency={payment_currency.name}, payment_method={payment_method.name}, type={payment_method.type}")

        # Create separate receivable lines for each (payment_method_type, currency) group
        for currency_key, currency_data in currency_receivables.items():
            # currency_key is now (payment_method_type, currency_id)
            currency_id = currency_key[1] if isinstance(currency_key, tuple) else currency_key
            payment_method = currency_data['payment_method']
            currency = currency_data['currency']
            payment_amount = currency_data['amount']  # Gross payment amount
            order_amount = currency_data.get('order_amount', payment_amount)  # Order total (net, what customer owes)

            if not float_is_zero(payment_amount, precision_rounding=self.currency_id.rounding):
                # Log for debugging
                _logger.info(
                    f"Creating receivable line for currency {currency.name}: payment_amount={payment_amount}, order_amount={order_amount}, payments={len(currency_data['payments'])}")

                # Create statement line for this currency (gross payment amount - actual cash received)
                # Statement line will create a receivable credit automatically via counterpart_account_id
                combine_cash_statement_line_vals.append(
                    self._get_combine_statement_line_vals(
                        payment_method.journal_id,
                        payment_amount,  # Statement shows actual payment received (gross)
                        payment_method
                    )
                )
                # CRITICAL: Create receivable line for PAYMENT amount (not order amount) to match statement line
                # The statement line creates a receivable credit for payment_amount
                # Our receivable debit must match payment_amount to balance correctly
                # The order amount vs payment amount difference (change) is already handled by the order's receivable
                combine_cash_receivable_vals.append(
                    self._get_combine_receivable_vals_by_currency(
                        payment_method,
                        payment_amount,  # Use PAYMENT amount to match statement line credit
                        payment_amount,  # amount_converted also uses payment amount
                        currency,
                        currency_data['payments']
                    )
                )

        # Log summary
        _logger.info(
            f"Total currency groups: {len(currency_receivables)}, Receivable lines to create: {len(combine_cash_receivable_vals)}")

        # create the statement lines and account move lines
        BankStatementLine = self.env['account.bank.statement.line'].with_context(no_retrieve_partner=True)

        # Create statement lines - these create moves with cash account lines
        split_cash_statement_lines_created = BankStatementLine.create(split_cash_statement_line_vals)
        combine_cash_statement_lines_created = BankStatementLine.create(combine_cash_statement_line_vals)

        # IMPORTANT: We create our own receivable lines in account 1559
        # Don't use the receivable lines from statement lines (they go to cash accounts)
        # Create receivable lines directly in the session's move
        split_cash_receivable_lines = MoveLine.create(split_cash_receivable_vals)
        combine_cash_receivable_lines = MoveLine.create(combine_cash_receivable_vals)

        # For compatibility, we still need to return statement lines (but they're not the receivable lines)
        # The receivable lines are the ones we created above
        # CRITICAL: Only include receivable lines from the POS receivable account (1559) to avoid mixing with bank accounts
        # Also ensure we only include lines from cash payment methods' statement lines
        pos_receivable_account = self.company_id.account_default_pos_receivable_account_id

        # Filter statement lines to only include receivable lines from POS receivable account (1559)
        # This ensures we don't mix cash and bank account receivable lines
        split_cash_statement_lines = self.env['account.move.line']
        for stmt_line in split_cash_statement_lines_created:
            # Only include receivable lines from the POS receivable account
            receivable_lines = stmt_line.move_id.line_ids.filtered(
                lambda line: line.account_id == pos_receivable_account and line.account_id.reconcile
            )
            split_cash_statement_lines |= receivable_lines

        combine_cash_statement_lines = self.env['account.move.line']
        for stmt_line in combine_cash_statement_lines_created:
            # Only include receivable lines from the POS receivable account
            receivable_lines = stmt_line.move_id.line_ids.filtered(
                lambda line: line.account_id == pos_receivable_account and line.account_id.reconcile
            )
            combine_cash_statement_lines |= receivable_lines

        data.update(
            {'split_cash_statement_lines': split_cash_statement_lines,
             'combine_cash_statement_lines': combine_cash_statement_lines,
             'split_cash_receivable_lines': split_cash_receivable_lines,
             'combine_cash_receivable_lines': combine_cash_receivable_lines
             })
        return data

    def _prepare_statement_line_amount_values_multi_currency(self, journal, amount, payment=None):
        """
        Override to use payment currency for multi-currency payments.
        When payment has payment_currency_id, use that currency instead of session currency.
        """
        journal_currency = journal.currency_id or self.company_id.currency_id

        # Get payment currency if available - read from database to ensure we have the field
        payment_currency = None
        payment_amount_currency = None

        if payment:
            payment_record = self.env['pos.payment'].browse(payment.id)

            # CRITICAL: Change payments should NEVER use foreign currency
            # Even if old data has payment_currency_id set, ignore it for change
            if payment_record.is_change:
                # Change is always in base currency (TZS) - ignore any foreign currency settings
                _logger.info(f"Change payment {payment.id}: forcing TZS (base currency), ignoring payment_currency_id")
                payment_currency = None
                payment_amount_currency = None
            elif payment_record.payment_currency_id:
                payment_currency = payment_record.payment_currency_id
                # IMPORTANT: Use the ACTUAL foreign currency amount (e.g., 3 USD) from currency_amount_total
                # This is what the client wants to see in the journal entries
                # CRITICAL: Preserve sign for change payments (negative = money out, positive = money in)
                if payment_record.currency_amount_total and payment_record.currency_amount_total != 0:
                    payment_amount_currency = payment_record.currency_amount_total  # Keep sign (positive or negative)
                else:
                    # Fallback: if currency_amount_total is not set, calculate from base amount
                    company_currency = self.company_id.currency_id
                    if payment_currency.id != company_currency.id:
                        payment_amount_currency = company_currency._convert(
                            amount,  # Keep sign (positive or negative)
                            payment_currency,  # Convert to USD
                            self.company_id,
                            self.stop_at
                        )
                    else:
                        payment_amount_currency = amount  # Keep sign

        # If payment currency matches journal currency, use payment currency amount directly
        if payment_currency and payment_currency.id == journal_currency.id and payment_amount_currency:
            # Payment is in same currency as journal - use payment amount directly
            # CRITICAL: Keep sign (negative for change/refund, positive for payment)
            return {
                'amount': payment_amount_currency,  # Keep sign for proper debit/credit
            }

        # If payment currency is different from journal currency
        if payment_currency and payment_currency.id != journal_currency.id and payment_amount_currency:
            # Convert payment amount (in base currency) to journal currency
            # amount is in base currency (TNS), payment_amount_currency is in payment currency (USD)
            # We need to convert base amount to journal currency
            # CRITICAL: Keep sign for change payments (negative = money out)
            converted_amount = self.currency_id._convert(
                amount,
                journal_currency,
                self.company_id,
                self.stop_at
            )
            return {
                'amount': converted_amount,  # Keep sign
                'amount_currency': payment_amount_currency,  # Keep sign (negative for change)
                'foreign_currency_id': payment_currency.id,
            }

        # Standard Odoo behavior - no payment currency info
        # But if journal currency is different from company currency, use journal currency
        company_currency = self.company_id.currency_id
        if journal_currency.id == company_currency.id:
            return {'amount': amount}
        else:
            # Journal has foreign currency - convert and set foreign currency correctly
            converted_amount = company_currency._convert(amount, journal_currency, self.company_id, self.stop_at)
            return {
                'amount': converted_amount,  # Amount in journal currency
                'amount_currency': amount,  # Amount in base currency
                'foreign_currency_id': company_currency.id,  # Base currency as foreign
            }

    def _get_split_statement_line_vals(self, journal, amount, payment):
        """
        Override to use payment currency for multi-currency payments.
        CRITICAL: Ensure only cash payment methods use this method and ALWAYS use POS receivable account (1559).
        """
        # CRITICAL: Verify payment method is cash type
        payment_method = payment.payment_method_id
        if payment_method.type != 'cash':
            _logger.error(
                f"ERROR: _get_split_statement_line_vals called with non-cash payment method {payment_method.name} (type={payment_method.type}). This should not happen!")
            raise ValueError(f"Only cash payment methods should use this method, but got {payment_method.type}")

        accounting_partner = self.env["res.partner"]._find_accounting_partner(payment.partner_id)
        amount_values = self._prepare_statement_line_amount_values_multi_currency(journal, amount, payment)

        # CRITICAL: For cash payments, ALWAYS use the POS receivable account (1559), NOT the partner's receivable account
        # This ensures all cash statement lines reconcile to the same account
        pos_receivable_account = self._get_receivable_account(payment_method)

        return {
            'date': fields.Date.context_today(self, timestamp=payment.payment_date),
            'payment_ref': payment.name,
            'pos_session_id': self.id,
            'journal_id': journal.id,
            'counterpart_account_id': pos_receivable_account.id,  # ALWAYS use POS receivable account (1559)
            'partner_id': accounting_partner.id,
            **amount_values
        }

    def _get_combine_statement_line_vals(self, journal, amount, payment_method):
        """
        Override to handle multi-currency for combined payments.
        For combined payments, calculate total in payment method currency.
        CRITICAL: Ensure only cash payment methods use this method.
        """
        # CRITICAL: Verify payment method is cash type
        if payment_method.type != 'cash':
            _logger.error(
                f"ERROR: _get_combine_statement_line_vals called with non-cash payment method {payment_method.name} (type={payment_method.type}). This should not happen!")
            raise ValueError(f"Only cash payment methods should use this method, but got {payment_method.type}")

        # For combined payments, get currency from payment method's currency_of_cash_control.
        # IMPORTANT:
        # - If `currency_of_cash_control` is set to the COMPANY currency (e.g., TZS), we MUST treat it
        #   like "no special currency". Otherwise our "foreign-currency" path will exclude change
        #   and post the GROSS cash received (50,000) instead of NET (45,000).
        payment_currency = payment_method.currency_of_cash_control or None
        company_currency = self.company_id.currency_id
        journal_currency = journal.currency_id or company_currency
        if payment_currency and payment_currency.id == company_currency.id:
            payment_currency = None

        # Calculate total in payment currency for all payments of this method.
        # CRITICAL: Exclude change payments ONLY for real foreign-currency cash methods.
        # For base currency (TZS) cash methods, change MUST be included in the net cash movement.
        total_payment_currency_amount = 0
        if payment_currency and payment_currency.id == journal_currency.id:
            # Get all payments for this payment method and sum their currency amounts
            closed_orders = self._get_closed_orders()
            for order in closed_orders:
                for payment in order.payment_ids:
                    if payment.payment_method_id.id == payment_method.id:
                        payment_record = self.env['pos.payment'].browse(payment.id)

                        # CRITICAL: Exclude change payments
                        if payment_record.is_change:
                            continue

                        # Use currency_amount_total if available (actual foreign currency amount)
                        if payment_record.currency_amount_total and payment_record.currency_amount_total != 0:
                            total_payment_currency_amount += payment_record.currency_amount_total
                        elif payment_currency.id == self.currency_id.id:
                            total_payment_currency_amount += payment.amount

        # If payment method has currency and journal matches, use that currency
        if payment_currency and payment_currency.id == journal_currency.id:
            # Calculate USD amount from base if total_currency_amount is 0
            if total_payment_currency_amount == 0:
                company_currency = self.company_id.currency_id
                if payment_currency.id != company_currency.id:
                    # Convert base amount to payment currency
                    total_payment_currency_amount = company_currency._convert(
                        amount,
                        payment_currency,
                        self.company_id,
                        self.stop_at
                    )

            if total_payment_currency_amount > 0:
                # Convert USD to journal currency for amount field
                # Journal currency is USD, so amount should be USD amount
                return {
                    'date': fields.Date.context_today(self),
                    'payment_ref': self.name,
                    'pos_session_id': self.id,
                    'journal_id': journal.id,
                    'counterpart_account_id': self._get_receivable_account(payment_method).id,
                    'amount': abs(total_payment_currency_amount),  # USD amount
                }

        # Use standard method - but ensure currency is set correctly for USD journal
        company_currency = self.company_id.currency_id
        if journal_currency.id != company_currency.id:
            # Journal is in foreign currency (USD) - convert base amount to USD
            # For statement lines: amount is in journal currency, amount_currency is in base currency
            # CRITICAL: Keep sign (negative for change = money out, positive for payment = money in)
            usd_amount = company_currency._convert(
                amount,
                journal_currency,
                self.company_id,
                self.stop_at
            )
            amount_values = {
                'amount': usd_amount,  # Keep sign (negative for change)
                'amount_currency': amount,  # Keep sign (negative for change)
                'foreign_currency_id': company_currency.id,  # Base currency (TZS) as foreign
            }
        else:
            # Journal is in base currency - use standard method
            amount_values = self._prepare_statement_line_amount_values_multi_currency(journal, amount, None)

        return {
            'date': fields.Date.context_today(self),
            'payment_ref': self.name,
            'pos_session_id': self.id,
            'journal_id': journal.id,
            'counterpart_account_id': self._get_receivable_account(payment_method).id,
            **amount_values
        }

    def _get_split_receivable_vals_by_currency(self, payment_method, amount, amount_converted, currency, payments):
        """
        Create receivable line for split payments grouped by currency.
        Similar to _get_combine_receivable_vals_by_currency but for split payments.
        """
        # CRITICAL: For cash payment methods, always use the POS receivable account (1559)
        # Bank payment methods should NOT reach this method - they use different accounts
        # Verify payment method is cash type
        if payment_method.type != 'cash':
            _logger.error(
                f"ERROR: _get_split_receivable_vals_by_currency called with non-cash payment method {payment_method.name} (type={payment_method.type}). This should not happen!")
            raise ValueError(f"Only cash payment methods should use this method, but got {payment_method.type}")

        # Get receivable account (never fallback to journal default account; that would be the cash account).
        account = self._get_receivable_account(payment_method)

        # Calculate total currency amount for this currency group
        # CRITICAL: Use actual payment currency amount, not converted amount
        # CRITICAL: INCLUDE change payments (they have negative amounts which reduce the total)
        total_currency_amount = 0.0
        for payment in payments:
            payment_record = self.env['pos.payment'].browse(payment.id)

            # IMPORTANT: Include change payments - they have negative amounts
            # Change reduces the total receivable amount
            # Example: Payment $20 + Change -6000 TZS = Net payment

            # Priority 1: Use currency_amount_total if available (actual foreign currency amount)
            if payment_record.currency_amount_total and payment_record.currency_amount_total != 0:
                # Use actual currency amount from payment (e.g., 20 USD or -6000 TZS for change)
                total_currency_amount += payment_record.currency_amount_total
                _logger.debug(
                    f"Split payment {payment.id}: Using currency_amount_total={payment_record.currency_amount_total}, is_change={payment_record.is_change}")
            elif currency.id == self.company_id.currency_id.id:
                # Base currency payment - use amount directly
                total_currency_amount += payment.amount
                _logger.debug(f"Split payment {payment.id}: Base currency payment, amount={payment.amount}")
            else:
                # Fallback: Convert base amount to currency (should not happen if currency_amount_total is set)
                company_currency = self.company_id.currency_id
                converted = company_currency._convert(
                    payment.amount,
                    currency,
                    self.company_id,
                    payment.payment_date or self.stop_at
                )
                total_currency_amount += converted
                _logger.warning(
                    f"Split payment {payment.id}: No currency_amount_total, converted {payment.amount} to {converted} {currency.name}")

        if total_currency_amount == 0:
            company_currency = self.company_id.currency_id
            if currency.id != company_currency.id:
                total_currency_amount = company_currency._convert(
                    amount,
                    currency,
                    self.company_id,
                    self.stop_at
                )
            else:
                total_currency_amount = amount

        # Get partner from first payment (for split payments, they might have different partners)
        first_payment = self.env['pos.payment'].browse(payments[0].id) if payments else None
        accounting_partner = self.env["res.partner"]._find_accounting_partner(
            first_payment.partner_id) if first_payment else False

        partial_vals = {
            'account_id': account.id,
            'move_id': self.move_id.id,
            'name': '%s - %s' % (self.name, currency.name),
            'partner_id': accounting_partner.id if accounting_partner else False,
        }

        # IMPORTANT:
        # Use the already computed base amounts coming from the POS payments (`amount` / `amount_converted`)
        # for debit/credit. Do NOT re-convert `total_currency_amount` here, otherwise rate drift can
        # UNBALANCE the session move and trigger the "Force Close Session" wizard.
        company_currency = self.company_id.currency_id
        if currency.id == company_currency.id:
            return self._debit_amounts(partial_vals, amount, amount_converted)

        debit_credit_amount = amount_converted if amount_converted not in (None, False) else amount

        return {
            **partial_vals,
            'debit': debit_credit_amount if debit_credit_amount > 0 else 0.0,
            'credit': -debit_credit_amount if debit_credit_amount < 0 else 0.0,
            'currency_id': currency.id,
            'amount_currency': total_currency_amount,
        }

    def _get_split_receivable_vals(self, payment, amount, amount_converted):
        """
        Override to use payment currency for journal entry lines.
        For multi-currency payments, the receivable line should show payment currency.
        NOTE: This method is kept for backward compatibility but may not be used
        if _get_split_receivable_vals_by_currency is used instead.
        """
        accounting_partner = self.env["res.partner"]._find_accounting_partner(payment.partner_id)
        if not accounting_partner:
            raise UserError(_("You have enabled the \"Identify Customer\" option for %(payment_method)s payment method,"
                              "but the order %(order)s does not contain a customer.",
                              payment_method=payment.payment_method_id.name,
                              order=payment.pos_order_id.name))

        # Get payment currency - read from database to ensure we have the field
        payment_currency = None
        payment_amount_currency = None
        payment_record = self.env['pos.payment'].browse(payment.id)

        if payment_record.payment_currency_id:
            payment_currency = payment_record.payment_currency_id
            # Use the actual foreign currency amount (e.g., 3 USD), not converted amount
            # If currency_amount_total is not set, calculate it from the payment amount
            if payment_record.currency_amount_total and payment_record.currency_amount_total > 0:
                payment_amount_currency = payment_record.currency_amount_total
            else:
                # Fallback: calculate from base amount if currency_amount_total is not set
                company_currency = self.company_id.currency_id
                if payment_currency.id != company_currency.id:
                    # Convert base amount to foreign currency
                    payment_amount_currency = company_currency._convert(
                        amount,
                        payment_currency,
                        self.company_id,
                        self.stop_at
                    )
                else:
                    payment_amount_currency = amount

        # Get journal currency
        journal = payment.payment_method_id.journal_id
        journal_currency = journal.currency_id or self.company_id.currency_id

        # Get receivable account (never fallback to journal default account; that would be the cash account).
        receivable_account = self._get_receivable_account(payment.payment_method_id)
        journal = payment.payment_method_id.journal_id

        # IMPORTANT: Do not fallback to journal.default_account_id here.
        # It is the cash/bank journal default account (e.g. 1000.*) and would break POS receivable postings.

        account_currency = receivable_account.currency_id or self.company_id.currency_id

        partial_vals = {
            'account_id': receivable_account.id,
            'move_id': self.move_id.id,
            'partner_id': accounting_partner.id,
            'name': '%s - %s' % (self.name, payment.payment_method_id.name),
        }

        # If payment has foreign currency, use it for the journal entry line
        if payment_currency and payment_amount_currency:
            # IMPORTANT: Use company-currency amount coming from POS (`amount_converted`) to avoid rate drift.
            debit_credit_amount = amount_converted if amount_converted not in (None, False) else amount

            # Check if account currency matches payment currency
            if account_currency.id == payment_currency.id:
                # Use account currency ID (USD) for Currency column display
                currency_id_to_use = account_currency.id

                return {
                    **partial_vals,
                    'debit': debit_credit_amount if debit_credit_amount > 0 else 0.0,
                    # Base currency (TZS) for balancing
                    'credit': -debit_credit_amount if debit_credit_amount < 0 else 0.0,
                    # Base currency (TZS) for balancing
                    'currency_id': currency_id_to_use,  # USD currency ID (for Currency column)
                    'amount_currency': payment_amount_currency,  # USD amount (for Amount Currency column)
                }
            else:
                return {
                    **partial_vals,
                    'debit': debit_credit_amount if debit_credit_amount > 0 else 0.0,
                    'credit': -debit_credit_amount if debit_credit_amount < 0 else 0.0,
                    'currency_id': payment_currency.id,
                    'amount_currency': payment_amount_currency,
                }
        else:
            # Standard behavior - use session currency
            return self._debit_amounts(partial_vals, amount, amount_converted)

    def _get_combine_receivable_vals_by_currency(self, payment_method, amount, amount_converted, currency, payments):
        """
        Create receivable line for a specific currency.
        This creates separate receivable lines for each currency (USD, EUR, TZS, etc.)
        as required by the client - each currency gets its own line in account 1559.
        """
        journal = payment_method.journal_id
        journal_currency = journal.currency_id or self.company_id.currency_id

        # Get receivable account (account 1559 or payment method's receivable account)
        # CRITICAL: For cash payment methods, always use the POS receivable account (1559)
        # Bank payment methods should NOT reach this method - they use different accounts
        # Verify payment method is cash type
        if payment_method.type != 'cash':
            _logger.error(
                f"ERROR: _get_combine_receivable_vals_by_currency called with non-cash payment method {payment_method.name} (type={payment_method.type}). This should not happen!")
            raise ValueError(f"Only cash payment methods should use this method, but got {payment_method.type}")

        account = self._get_receivable_account(payment_method)
        # DO NOT use journal's default account - that's the cash account
        # We want account 1559 (receivable account)

        # Verify we're using the correct account (should be 1559 or company's default POS receivable)
        if account.code != '1559' and account != self.company_id.account_default_pos_receivable_account_id:
            _logger.warning(
                f"Receivable account is {account.code} ({account.name}), expected 1559 or default POS receivable for cash payment method {payment_method.name}")

        account_currency = account.currency_id or self.company_id.currency_id

        # Calculate total currency amount for this currency group
        # CRITICAL: Use actual payment currency amount, not converted amount
        # CRITICAL: INCLUDE change payments (they have negative amounts which reduce the total)
        total_currency_amount = 0.0
        for payment in payments:
            payment_record = self.env['pos.payment'].browse(payment.id)

            # IMPORTANT: Include change payments - they have negative amounts
            # Change reduces the total receivable amount
            # Example: Payment $20 + Change -6000 TZS = Net payment

            # Priority 1: Use currency_amount_total if available (actual foreign currency amount)
            if payment_record.currency_amount_total and payment_record.currency_amount_total != 0:
                # Use actual currency amount from payment (e.g., 20 USD or -6000 TZS for change)
                total_currency_amount += payment_record.currency_amount_total
                _logger.debug(
                    f"Payment {payment.id}: Using currency_amount_total={payment_record.currency_amount_total}, is_change={payment_record.is_change}")
            elif currency.id == self.company_id.currency_id.id:
                # Base currency payment - use amount directly
                total_currency_amount += payment.amount
                _logger.debug(f"Payment {payment.id}: Base currency payment, amount={payment.amount}")
            else:
                # Fallback: Convert base amount to currency (should not happen if currency_amount_total is set)
                company_currency = self.company_id.currency_id
                converted = company_currency._convert(
                    payment.amount,
                    currency,
                    self.company_id,
                    payment.payment_date or self.stop_at
                )
                total_currency_amount += converted
                _logger.warning(
                    f"Payment {payment.id}: No currency_amount_total, converted {payment.amount} to {converted} {currency.name}")

        # If total_currency_amount is 0, calculate from base amount
        if total_currency_amount == 0:
            company_currency = self.company_id.currency_id
            if currency.id != company_currency.id:
                total_currency_amount = company_currency._convert(
                    amount,
                    currency,
                    self.company_id,
                    self.stop_at
                )
            else:
                total_currency_amount = amount

        # Log the account being used
        _logger.info(
            f"Creating receivable line for currency {currency.name} in account {account.code} ({account.name}), move_id={self.move_id.id}")

        partial_vals = {
            'account_id': account.id,
            'move_id': self.move_id.id,
            'name': '%s - %s' % (self.name, currency.name),
            'display_type': 'payment_term',
        }

        # IMPORTANT:
        # Use the already computed base amounts coming from the POS payments (`amount` / `amount_converted`)
        # for debit/credit. Do NOT re-convert `total_currency_amount` here, otherwise rate drift can
        # UNBALANCE the session move and trigger the "Force Close Session" wizard.
        company_currency = self.company_id.currency_id
        if currency.id == company_currency.id:
            return self._debit_amounts(partial_vals, amount, amount_converted)

        debit_credit_amount = amount_converted if amount_converted not in (None, False) else amount

        # Create receivable line with currency information
        # Debit/Credit in base currency (TZS) for balancing
        # Currency column shows foreign currency (USD/EUR)
        # Amount Currency column shows foreign amount
        return {
            **partial_vals,
            'debit': debit_credit_amount if debit_credit_amount > 0 else 0.0,  # Base currency (TZS) for balancing
            'credit': -debit_credit_amount if debit_credit_amount < 0 else 0.0,  # Base currency (TZS) for balancing
            'currency_id': currency.id,  # Foreign currency ID (for Currency column)
            'amount_currency': total_currency_amount,  # Foreign currency amount (for Amount Currency column)
        }

    def _get_combine_receivable_vals(self, payment_method, amount, amount_converted):
        """
        Override to use payment method currency for journal entry lines.
        For combined payments, sum all payment currency amounts.
        NOTE: This method is kept for backward compatibility but may not be used
        if _get_combine_receivable_vals_by_currency is used instead.
        """
        # Get payment method currency
        payment_currency = None
        if payment_method.currency_of_cash_control:
            payment_currency = payment_method.currency_of_cash_control
        else:
            # Fallback: use journal currency if it's different from company currency
            journal = payment_method.journal_id
            if journal.currency_id and journal.currency_id.id != self.company_id.currency_id.id:
                payment_currency = journal.currency_id

        journal = payment_method.journal_id
        journal_currency = journal.currency_id or self.company_id.currency_id

        # Get receivable account (never fallback to journal default account; that would be the cash account).
        account = self._get_receivable_account(payment_method)

        # IMPORTANT: Do not fallback to journal.default_account_id here.
        # It is the cash/bank journal default account (e.g. 1000.*) and would break POS receivable postings.

        account_currency = account.currency_id or self.company_id.currency_id

        partial_vals = {
            'account_id': account.id,
            'move_id': self.move_id.id,
            'name': '%s - %s' % (self.name, payment_method.name),
            'display_type': 'payment_term',
        }

        # If payment method currency matches journal currency, calculate total in that currency
        if payment_currency and payment_currency.id == journal_currency.id:
            # Get all payments for this payment method and sum their currency amounts
            closed_orders = self._get_closed_orders()
            total_currency_amount = 0
            for order in closed_orders:
                for payment in order.payment_ids:
                    if payment.payment_method_id.id == payment_method.id:
                        payment_record = self.env['pos.payment'].browse(payment.id)
                        if payment_record.currency_amount_total:
                            total_currency_amount += payment_record.currency_amount_total
                        elif payment_currency.id == self.currency_id.id:
                            total_currency_amount += payment.amount

            # Check if account currency matches payment currency
            if account_currency.id == payment_currency.id:
                # Account currency matches payment currency
                # If total_currency_amount is 0, calculate it from base amount
                if total_currency_amount == 0:
                    # Convert base amount to payment currency
                    company_currency = self.company_id.currency_id
                    if payment_currency.id != company_currency.id:
                        # Convert from base currency (TZS) to payment currency (USD)
                        total_currency_amount = company_currency._convert(
                            amount,  # amount is in base currency (TZS)
                            payment_currency,  # Convert to USD
                            self.company_id,
                            self.stop_at
                        )
                    else:
                        total_currency_amount = amount

                # Account currency matches payment currency (both USD)
                # For the move to balance, debit/credit MUST be in base currency (TZS)
                # The move currency is base currency (TZS), so all lines must balance in TZS
                company_currency = self.company_id.currency_id

                # Convert USD amount to base currency for move balancing
                if payment_currency.id != company_currency.id:
                    debit_credit_amount = payment_currency._convert(
                        total_currency_amount,
                        company_currency,
                        self.company_id,
                        self.stop_at
                    )
                else:
                    debit_credit_amount = total_currency_amount

                # Use account currency ID (USD) for Currency column display
                currency_id_to_use = account_currency.id

                return {
                    **partial_vals,
                    'debit': debit_credit_amount if debit_credit_amount > 0 else 0.0,
                    # Base currency (TZS) for balancing
                    'credit': -debit_credit_amount if debit_credit_amount < 0 else 0.0,
                    # Base currency (TZS) for balancing
                    'currency_id': currency_id_to_use,  # USD currency ID (for Currency column)
                    'amount_currency': total_currency_amount,  # USD amount (for Amount Currency column)
                }
            elif total_currency_amount > 0:
                # Account currency doesn't match but we have currency amount - use standard conversion
                # IMPORTANT: Use company-currency amount coming from POS (`amount_converted`) to avoid rate drift.
                converted_amount = amount_converted if amount_converted not in (None, False) else amount

                return {
                    **partial_vals,
                    'debit': converted_amount if converted_amount > 0 else 0.0,
                    'credit': -converted_amount if converted_amount < 0 else 0.0,
                    'currency_id': payment_currency.id,
                    'amount_currency': total_currency_amount,
                }

        # Standard behavior - use session currency
        return self._debit_amounts(partial_vals, amount, amount_converted)

    # IMPORTANT:
    # We DO NOT override `_create_bank_payment_moves` / account.payment creation anymore.
    # Bank payments must create an `account.payment` move that transfers:
    #   - from POS receivable (1559) -> to Outstanding Receipts (1033)
    # so that accountants can later reconcile the bank statement.
    # Our earlier override forced BOTH sides to 1559, producing a wrong "1559 -> 1559" move (no real transfer).
