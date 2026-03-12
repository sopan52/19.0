{
    'name': 'Odoo POS Multi Currency | Point of Sale Multi-Currency | POS Cash Control Multi-Currency | POS Multi-Currency Payments & Cash In/Out | Multi Currency Cash Drawer | POS Currency Exchange | Restaurant Multi-Currency Management | Odoo 19 POS Multi-Currency Support | Dynamic POS Currency Converter',
    'summary': 'Universal multi-currency solution for Odoo POS: cash control, opening/closing balances, cash in/out, and payments with live exchange rates for retail and restaurants.',
    'description': """
        POS Dynamic Multi-Currency Cash Control is a comprehensive solution for managing multi-currency cash operations in Odoo Point of Sale (POS).
        
        Key Features:
        - Dynamic multi-currency opening and closing balance per session.
        - Multi-currency cash in and cash out operations with reason tracking.
        - Support for any currency configured on POS payment methods.
        - Real-time currency conversion using Odoo's live exchange rates.
        - Detailed multi-currency breakdown on POS receipts and session reports.
        - Dynamic coin/denomination adding for precise cash management.
    """,
    'version': '19.0.1.0.0',
    'category': 'Point Of Sale',
    'author': 'Sopan Digital',
    'license': 'OPL-1',
    'price': 120,
    'currency': 'USD',
    "depends": ["base","point_of_sale","account"],
    "data": [
        'security/ir.model.access.csv',
        "views/views.xml",
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'sopan_pos_multicurrency/static/src/css/pos.css',
            'sopan_pos_multicurrency/static/src/js/models.js',
            'sopan_pos_multicurrency/static/src/js/ProductCard.js',
            'sopan_pos_multicurrency/static/src/js/number_popup_size_patch.js',
            'sopan_pos_multicurrency/static/src/js/number_buffer_patch.js',
            'sopan_pos_multicurrency/static/src/js/multi_currency_payment.js',
            'sopan_pos_multicurrency/static/src/js/payment_line_display.js',
            'sopan_pos_multicurrency/static/src/js/price_display_edit.js',
            'sopan_pos_multicurrency/static/src/js/receipt_payment_currency.js',
            'sopan_pos_multicurrency/static/src/js/MoneyDetailsPopup.js',
            'sopan_pos_multicurrency/static/src/js/OpeningControlPopup.js',
            'sopan_pos_multicurrency/static/src/js/CashMovePopup.js',
            'sopan_pos_multicurrency/static/src/js/ClosePosPopup.js',
            'sopan_pos_multicurrency/static/src/xml/number_popup_size_patch.xml',
            'sopan_pos_multicurrency/static/src/xml/opening_control_popup.xml',
            'sopan_pos_multicurrency/static/src/xml/pos_money_control.xml',
            'sopan_pos_multicurrency/static/src/xml/pos.xml',
            'sopan_pos_multicurrency/static/src/xml/payment_lines_currency.xml',
            'sopan_pos_multicurrency/static/src/xml/payment_method_buttons.xml',
            'sopan_pos_multicurrency/static/src/xml/receipt_payment_currency.xml',
        ],
    },
    'demo': [],
    "images": ['static/description/banner.png'],
    'installable': True,
    'auto_install': False,
    'application': True,
}
