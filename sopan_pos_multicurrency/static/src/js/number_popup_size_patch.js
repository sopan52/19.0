/** @odoo-module */

import { NumberPopup } from "@point_of_sale/app/components/popups/number_popup/number_popup";

// Allow passing a dialog size to NumberPopup without changing the default behavior.
// Default remains 'sm' (as defined in the core template), but we can pass e.g. 'md'/'lg' for our custom use-cases.
NumberPopup.props = {
    ...NumberPopup.props,
    size: { type: String, optional: true },
};

