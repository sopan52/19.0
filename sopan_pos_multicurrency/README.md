# POS Dynamic Multi-Currency Cash Control

## Overview

**POS Dynamic Multi-Currency Cash Control** is a comprehensive solution for managing multi-currency cash operations in Odoo Point of Sale (POS). This module provides complete cash control functionality with support for unlimited currencies, dynamic configuration, and real-time currency conversion.

### Key Highlights

- ✅ **Unlimited Currencies** - Support for any currency worldwide
- ✅ **100% Dynamic** - No hardcoding, fully configurable
- ✅ **Odoo 19 Native** - Built specifically for Odoo 19 Enterprise Edition
- ✅ **24/7 Support** - Professional support from Sopan Digital

---

## Table of Contents

1. [Features](#features)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Usage](#usage)
5. [Screenshots](#screenshots)
6. [Troubleshooting](#troubleshooting)
7. [Support](#support)
8. [License](#license)

---

## Features

### 💱 Dynamic Multi-Currency Support

- **Unlimited Currencies**: Support for any currency worldwide without restrictions
- **Dynamic Configuration**: Assign currencies to payment methods on-the-fly without code changes
- **Zero Hardcoding**: Fully flexible system that adapts to your business needs automatically
- **Real-Time Conversion**: Automatic currency conversion using latest exchange rates from Odoo
- **Smart Assignment**: Intelligent currency detection and assignment based on payment methods

### 💰 Opening & Closing Balance

- Multi-currency opening balance setup per POS session
- Currency-wise closing balance calculation & display
- Automatic expected vs. actual balance comparison
- Detailed closing notes with currency breakdown
- Money details popup with coin/denomination support

### 📊 Cash In / Cash Out

- Multi-currency cash in/out operations
- Dynamic coin/denomination adding
- Currency-wise movement tracking
- Reason tracking for all movements

### 💳 Multi-Currency Payments

- Accept payments in any configured currency
- Store payment currency and amount separately
- Payment line shows currency amounts clearly
- Receipt displays comprehensive currency information

### 🏦 Bank Payment Support

- Bank payments displayed per currency
- Original currency preserved in entries
- Proper journal entries with tracking
- Multi-currency reconciliation support

### 📝 Accurate Accounting

- Proper `currency_id` on all accounting lines
- Correct receivable entries per currency
- IFRS/GAAP compliant accounting
- Currency-wise cash difference tracking

---

## Installation

### Prerequisites

- Odoo 19.0 Enterprise Edition
- Point of Sale module installed
- Accounting module installed

### Installation Steps

1. **Copy Module**
   - Copy the `sopan_pos_multicurrency` folder to your Odoo addons directory
   - Ensure the module is in a custom addons path (e.g., `/custom/v19_pos_dynamic_multicurrency/`)

2. **Update Apps List**
   - Go to **Apps** menu in Odoo
   - Click **Update Apps List**

3. **Install Module**
   - Search for "POS Dynamic Multi-Currency Cash Control"
   - Click **Install** button
   - Wait for installation to complete

4. **Configure POS**
   - Follow the [Configuration](#configuration) steps below

---

## Configuration

### Step 1: Setup Multi-Currency

1. Navigate to **Accounting → Configuration → Currencies**
2. Activate the currencies you want to use in POS
3. Ensure exchange rates are configured for each currency
4. Verify that rates are up-to-date for your POS session dates

### Step 2: Configure Payment Methods

1. Navigate to **Point of Sale → Configuration → Payment Methods**
2. For each payment method that uses a currency:
   - Select the payment method
   - Set the **Currency** field to the appropriate currency
   - Configure the **Journal** properly for each payment method
   - Save the configuration

**Note**: The module dynamically detects currencies from payment method configurations. No additional currency mapping is required.

### Step 3: Configure Denominations (Optional)

1. Navigate to **Point of Sale → Configuration → Bills**
2. Create denomination entries for each currency:
   - Set the **Currency** field
   - Define coin/bill values (e.g., 1, 5, 10, 20, 50, 100)
   - These denominations will appear in Money Details popup during cash operations

---

## Usage

### Opening Balance

1. Start a new POS session
2. The **Opening Control** popup will appear automatically
3. Enter opening balance for base currency (default)
4. Click **Add Currency** to add opening balance for other currencies
5. Enter amounts for each currency as needed
6. Click **Validate** to start the session

### Cash In / Cash Out

1. During POS session, click **Cash In** or **Cash Out** button
2. Select the currency from the dropdown
3. Enter the amount
4. Optionally add detailed denominations using **Money Details**
5. Enter a reason for the movement
6. Click **Validate** to record the movement

### Multi-Currency Payment

1. Add products to the order
2. Click **Payment**
3. Select the payment method (currency will be automatically detected)
4. Enter the amount in the payment method's currency
5. The system will automatically convert and display the amount in base currency
6. Complete the payment

### Closing Balance

1. When closing POS session, the **Closing Control** popup appears
2. View expected balance per currency
3. Count actual cash per currency
4. Enter denominations using **Money Details** if needed
5. Review differences per currency
6. Add closing notes if required
7. Click **Validate** to close the session

---

## Screenshots

The module includes comprehensive screenshots demonstrating:

1. **Multi-Currency Setup** - Configuration in Accounting module
2. **Payment Method Configuration** - Currency assignment to payment methods
3. **Opening Balance** - Multi-currency opening balance interface
4. **Cash In/Out** - Cash movement operations
5. **Multi-Currency Payment** - Payment processing with real-time conversion
6. **POS Receipt** - Multi-currency receipt display
7. **Session Backend** - Complete currency-wise tracking

View all screenshots in the module's App Store page or in `static/description/` folder.

---

## Troubleshooting

### Currency Not Appearing

- Ensure currency is activated in **Accounting → Configuration → Currencies**
- Verify exchange rates exist for the session date
- Check that payment method has currency assigned

### Opening Balance Not Saving

- Check user access rights
- Ensure POS session is not already started
- Verify currency is properly configured

### Payment Currency Mismatch

- Verify payment method has correct currency assigned
- Check journal configuration matches currency
- Ensure POS config uses correct journals

### Accounting Entries Issues

- Verify journal accounts are configured correctly
- Check currency rate exists for transaction date
- Ensure proper account mapping in chart of accounts

---

## Support

### Contact Information

- **Email**: office.sopandigital@gmail.com
- **Module**: POS Dynamic Multi-Currency Cash Control
- **Version**: 19.0.1.0.0

### Getting Help

For technical support, feature requests, or bug reports, please contact us at the email above. Include:

- Odoo version
- Module version
- Detailed description of the issue
- Screenshots or error messages (if applicable)

---

## License

This module is licensed under **OPL-1 (Odoo Proprietary License v1.0)**.

**Copyright (c) 2024 Sopan Digital**

See [LICENSE](LICENSE) file for full license details.

---

## Changelog

### Version 19.0.1.0.0

- Initial release for Odoo 19
- Dynamic multi-currency support
- Opening and closing balance management
- Cash in/out operations
- Multi-currency payment processing
- Bank payment support
- Comprehensive accounting integration

---

## Author

**Sopan Digital**

Professional Odoo development and customization services.

---

**Thank you for using POS Dynamic Multi-Currency Cash Control!**
