# Z Chaat Profile

This file is the real setup of our live client, Z Chaat.
It was read from their printed menu ("Z Chaat Menu May 2026") and two table
cards, on 8 October 2026. Every prompt that builds anything for Z Chaat reads
this file first.

`TO CONFIRM` means we have not seen the answer yet.
Build with the stated default, and make the value a setting so the answer can
change without code. Nothing in the code names Z Chaat: its details live only
here, in `setup/zchaat.json`, `setup/zchaat-menu.csv`, and its own records in
the database.

Section 15 lists every open item in one place.

The first client, Cafezza, is archived in `docs/archive/caffeza/`.

---

## 1. The business

| Field | Value | Where it lives in our system |
|---|---|---|
| Name on the menu | "Z. Chaat" | `settings.appearance.wordmark` |
| Trade name | "Z Chaat". `TO CONFIRM` the exact spelling for the bill. | `restaurants.name` |
| Line under the name | "Indian Street Food" | `settings.receipt.headerLine2` |
| Lines on their cards | "Swaad bhi, Yaad bhi!" and "Ek Baar Try Karoge... Baar Baar Aaoge!" | `settings.receipt.footerText` carries the first |
| Address | E-19/20, Ground Floor, Siddhraj Z Square, Podar International School Road, Kudasan, Gandhinagar 382421 | `restaurants.address` |
| Phones | 76008 58900 and 76008 59800 | `restaurants.phone` carries the first |
| City and state | Gandhinagar, Gujarat | `restaurants.address.city`, `state` |
| Legal name | `TO CONFIRM` | `restaurants.legalName` |
| GSTIN | `TO CONFIRM`. It must print on every bill. | `restaurants.gstin` |
| FSSAI licence number | `TO CONFIRM`. It must print on every bill. | `restaurants.fssaiLicenseNumber` |
| Logo | `TO CONFIRM`: a PNG with a transparent background. SVG is refused by the upload. | `restaurants.brandLogos` |

## 2. Size and hours

| Fact | Value |
|---|---|
| Days open | Seven days a week |
| Hours | `TO CONFIRM` |
| Business day starts | 5:00 AM, the default, until the hours are confirmed. `settings.businessDayStartsAtMinutes` 300. |
| Outlets | One |

## 3. Tax

| Fact | Value |
|---|---|
| Prices | Exclusive of taxes, by their own terms. GST is added on top, which is how the product already works (M3 decision D1). |
| Rate | 5% on every item, split CGST 2.5% and SGST 2.5% |
| Catering | Their catering plans say "+ 5% tax" |
| Platform delivery orders | 0% on our bill, the platform paying GST under section 9(5): `settings.delivery.platformCollectsGst` on. `TO CONFIRM` with their CA. |
| Printed MRP items | Water Bottle ₹50, and Sprite, Diet Coke, Coke and Thums Up ₹70 each. `TO CONFIRM`, section 15 item 7. |

## 4. Invoice numbers

`TO CONFIRM`: their prefix and the starting number. Set by hand on cutover day,
as `docs/GO-LIVE.md` says, through Settings, never by a script.

## 5. Order types

Dine in, takeaway and home delivery. Home delivery comes through platforms,
which they have not named yet (section 15 item 5).

## 6. Floor

From Rishi, 8 October 2026: two round tables for 8, seven for 6, two for 4,
and two or three extra. Made in the app that day, in one section, Main, and
placed on the floor plan:

| Tables | Seats | Shape on the plan |
|---|---|---|
| Table 1, Table 2 | 8 | Round |
| Table 3 to Table 9 | 6 | Long |
| Table 10, Table 11 | 4 | Square |
| Table 12 to Table 14 | not set | Square, the extra tables |

`TO CONFIRM`: the names the staff use, whether the extra tables are two or
three (a table never used can be deleted in Table setup), their seats, and
where each stands in the room (More, Table setup, Arrange tables). Their table
cards ask guests to scan a QR code to leave a review (section 15 item 12).

## 7. People and roles

`TO CONFIRM`: every name, phone number and role. The owner's phone is given at
provisioning.

## 8. Kitchen stations

A starting point to confirm, in `setup/zchaat.json`:

| Station | Categories |
|---|---|
| Chaat Counter | Bhel, Chaat Darbar |
| Tandoor | Kulcha, Breads |
| Beverages | Desi Tadka Sharbat, Beverages, Roll Cut Kulfi |
| Kitchen | Everything else. The default station. |

## 9. Menu

100 dishes in 14 categories, with descriptions, in `setup/zchaat-menu.csv`.
Every price is before GST, at 5%. Dishes with sizes have one row per size, 105
rows in all.

The printed menu's "Aerated Drinks" is four dishes, Sprite, Diet Coke, Coke and
Thums Up, so each is one tap at the table and prints under its own name (P35).

Two spelling mistakes on the printed menu were corrected: "Red Dargon Sizzler"
to "Red Dragon Sizzler", and "Panner Chilly Dry" to "Paneer Chilly Dry".

Jain options are on request. "Jain" is already one of the one-tap notes to the
kitchen.

## 10. Payment methods

Cards and UPI, by their own terms, and cash. `TO CONFIRM`: whether Card and UPI
go through a Pine Labs machine (M21, P25 Part I), and which platforms they use:
Swiggy, Zomato, Zomato Gold, Dineout, EazyDiner or others.

## 11. Discounts they give

`TO CONFIRM`.

## 12. Their terms, and what staff still need

"Orders once placed cannot be cancelled" is printed for guests. Staff still
make mistakes, so cancelling an item after billing (P25 Part E) is built for
them, with a manager's PIN.

## 13. Catering

| Plan | Price per person | Choices |
|---|---|---|
| Plan A | ₹649 + 5% | Desi sharbat any 2, bhel any 1, chaat any 2, mains any 1, biryani any 1, dessert any 1 |
| Plan B | ₹749 + 5% | Desi sharbat any 2, bhel any 2, chaat any 2, mains any 2, biryani any 2, dessert any 2 |

In the menu file each plan is one item per person, with the guest's choices
written in the note. `TO CONFIRM` that this is how they want it billed.

## 14. Look

Measured from their menu file on 8 October 2026:

| Colour | Value | Use |
|---|---|---|
| Brick red | `#A64220` | The brand colour behind the logo, `settings.appearance.brandHex` |
| Cream | `#F6EFD8` | Text on the brand colour, `onBrandHex`. 5.34 to 1 on brick red. |
| Saffron | `#F4A026` | On the menu only |
| Second cream | `#EDE6CE` | On the menu only |

`#A64220` cannot be the accent: the colour rules refuse it as too close to the
Open state's colour, so a button could look like a table's state. The nearest
preset they accept, Espresso `#55473F`, is the accent in `setup/zchaat.json`.
The neutral tone is Warm. The second language is Gujarati.

## 15. Everything still to confirm

1. Legal name, GSTIN and FSSAI number. All three must print on every bill.
2. Tables: made from Rishi's counts (section 6). Still to confirm: their names, two or three extra tables, the extras' seats, and the layout.
3. Kitchen stations, and which categories go to each. Section 8 is only a starting point.
4. Staff: names, phone numbers and roles.
5. Payment methods, including whether Card and UPI go through a Pine Labs machine, and which platforms they use: Swiggy, Zomato, Zomato Gold, Dineout, EazyDiner or others.
6. Business hours, and so the business day start.
7. **Water Bottle ₹50, and Sprite, Diet Coke, Coke and Thums Up ₹70 each.** If these are sold at their printed MRP, GST must not be added on top. Store them before tax so the bill lands on the MRP, as was done for Cafezza's water bottle: for example ₹47.62 for ₹50, and ₹66.67 for ₹70. The menu file carries ₹50.00 and ₹70.00 until they answer.
8. Breads, "Plain/Butter": is butter the same price? The menu file has them the same.
9. Catering: billed as the two plan items per person with the choices in a note, as the menu file does now, or another way.
10. Invoice prefix and starting number, set by hand on cutover day.
11. On Hold accounts, if any.
12. The review link for the QR code on the bill, `settings.receipt.reviewLinkUrl` (P25 Part C5).
13. The logo, as a PNG or SVG with a transparent background, for the Appearance page. An SVG is converted to PNG first: the upload refuses SVG.
14. Tally version, company name and ledger names (P25 Part J).
15. Pine Labs Merchant ID, Security Token, Store ID and terminal Client IDs (P25 Part I).
16. **For their CA (P29 Part B).** Changing the amount of a bill after its invoice number is printed and before it is paid, under the same number, with every change recorded: confirm this is acceptable under GST for their B2C bills. Until then the owner can switch off "Change an unpaid bill instead of voiding it" (`billing.reviseUnpaidBills`) on the Settings screen and get the old void-and-rebill behaviour.
17. Their expense categories, usual float and Tally ledgers for each category, cash to the bank and the owner's drawings (P29 Part F). The ten defaults are in place until they say otherwise.
