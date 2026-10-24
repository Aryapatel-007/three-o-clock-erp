# Report Spec

This file defines every report Caffeza gets, column by column.
Reports are the client's main requirement, and the rule is that they cannot be wrong.

How the three report docs fit together:
`docs/GLOSSARY.md` says what each word means.
This file says which numbers each report shows and where each number comes from.
`docs/RECONCILIATION-RULES.md` says which balance checks each report must pass.

The exact endpoints, request shapes and response shapes are written into `docs/API-CONTRACT.md` by prompt P13, from this file.
If this file and the contract ever disagree, stop and fix one of them before writing code.

Module: M19 Reports v2, built on M6's engine, plus M8 for the activity log.

---

## 1. Rules every report follows

**One source.**
Reports only add up numbers that were frozen onto records when the event happened.
Sales come from `bills`.
Money comes from `bills.payments` and M16's collection and cash records.
Cancellations come from `orders`.
A report never recomputes tax, never reads a live menu price, and never reads today's category for last month's sale.

**One engine.**
Every report runs through one shared service.
That service applies the tenant scope, the business date range, and the "leave out voided" rule in its first step.
A report's own code only groups and sorts.

**The filter sentence.**
Every report, on screen, in print and in every export, starts with one plain line saying exactly what it covers.
Example: "26 Sep 2026 to 27 Sep 2026. Business day starts 5:00 AM. All order types. All captains. Voided bills left out."

**Open days.**
If the range includes a business date that has not been closed, a banner says:
"26 Sep is still open. These numbers will change until Day Close."

**Totals and averages.**
A totals row is the exact sum of the rows above it, in paise.
An average is a sum divided by a sum, and is labelled "average".
A report never rounds totals to whole rupees while showing ".00".

**Drill down.**
Every number that is a count or a money value is clickable.
It opens the Bill List, R19, filtered to exactly the bills behind that number.
If a number cannot be drilled, it does not go on a report.

**Checks.**
Every report runs the checks listed for it in `docs/RECONCILIATION-RULES.md` before it renders.
A thin strip at the top shows the result.
Green: "All 6 checks passed."
Red: the failed check's message, and a link to the bills that caused it.
A failed check never hides the report.

**Export.**
Every report exports to Excel, and prints to A4 or saves as PDF through the browser.
The export is built from the same response the screen shows, so the numbers cannot differ.
An Excel file has four sheets: the report, the filter sentence, the definitions of every column used, and the check results.

**Format.**
Money is shown as ₹ with Indian grouping and two decimals: ₹2,07,179.00.
Dashboard tiles may drop the decimals, and then they say so.
Times are India time, 12-hour: 9:05 PM.
Dates are shown as 26 Sep 2026.
Negative money is shown with a minus sign and in the `mirch` colour.

**Who sees what.**
OWNER sees every report.
MANAGER sees every report except where a report below says otherwise.
No other role sees reports.

---

## 2. The report list

| ID | Report | The question it answers |
|---|---|---|
| R1 | Today | How is today going, right now? |
| R2 | Day Close | Did the day add up, and where is the money? |
| R3 | Sales by Day | How did each day do across a range? |
| R4 | Hours and Weekdays | When are we busy? |
| R5 | Payments | How was each day paid? |
| R6 | Platform Money | What do Zomato, Swiggy and the dining apps owe us, and did they pay? |
| R7 | Cash Till | Did the cash drawer match? |
| R8 | GST | What GST do we owe, and what goes in the returns? |
| R9 | Tally Export | The file the accountant imports |
| R10 | Invoice Register | Every invoice number, in order, with no gaps |
| R11 | Menu Performance | Which categories and items earn the money? |
| R12 | Captains | How did each captain's tables do? |
| R13 | Tables and Table Time | Which tables earn, and how fast do they turn? |
| R14 | Discounts | Who gave what discount, and why? |
| R15 | Cancellations and Voids | What was cancelled or voided, by whom, and what was wasted? |
| R16 | No Charge | What was given away free, and who approved it? |
| R17 | On Hold Accounts | Who owes us, and since when? |
| R18 | Activity Log | Who did something sensitive? |
| R19 | Bill List | The bills behind any number |
| R20 | CA Pack | Everything the CA needs for the month, in one file (P65) |

---

## 3. The reports

### R1 Today

A live screen, not a printed report.
Refreshes every 60 seconds.
It covers the current business date only.

**Tiles**

| Tile | Calculation |
|---|---|
| Bill total so far | Sum of bill totals issued today, not voided |
| Net sales so far | Sum of net sales, same bills |
| Bills | Count, same bills |
| Covers | Sum of covers on dine-in bills |
| Average per cover | Dine-in net sales ÷ dine-in covers |
| Open tables | Orders with status OPEN or READY_TO_BILL, and their running item total |
| Unpaid bills | Count and bill total of UNPAID bills |
| Same weekday last week | Bill total at the same time of day, one week ago, and the difference as a percent |

**Panels**
Money so far, by method, with On Hold and unpaid.
Top 5 items by quantity.
Alerts: every void, every No Charge, every discount over 20%, every item cancelled after preparation. Each alert opens the record.

The owner can choose which tiles show and in what order. That arrives with M20.

---

### R2 Day Close

The most important report.
One business date.
It is also the record printed and stored when the day is closed by M16.
Computed in one place, `computeDayFigures` in `server/services/dayFiguresService.js`, used by both Day Close and this report. A closed day returns the stored snapshot. See `docs/API-CONTRACT.md`, M16 section 4.

**Section A. Sales**

| Line | Calculation |
|---|---|
| Bills | Count of bills with this business date, not voided |
| Covers | Sum of covers, dine-in bills |
| Item total | Sum of `subtotalInPaise` |
| Discount | Sum of `discount.amountInPaise` |
| Net sales | Item total − discount |
| CGST | Sum of `taxBreakdown[].cgstInPaise` |
| SGST | Sum of `taxBreakdown[].sgstInPaise` |
| GST | CGST + SGST |
| Round-off | Sum of `roundOffInPaise` |
| Bill total | Sum of `grandTotalInPaise` |
| Average bill | Net sales ÷ bills |
| Average per cover | Dine-in net sales ÷ dine-in covers |

**Section B. Where the day's bill total went**

| Line | Calculation |
|---|---|
| Cash, Card, UPI | Payments on today's bills, by method, grouped as money in hand |
| Zomato Gold, Dineout, EazyDiner, Zomato, Swiggy | Payments on today's bills, by method, grouped as platform money |
| On Hold | Bill totals of today's bills charged to accounts, listed by account |
| Unpaid | Bill totals of today's unpaid bills. Must be zero before the day can close. |
| Total | Must equal Section A bill total. Check C3. |

**Section C. Collections received today for older On Hold bills**
By account and method.
Not sales. Shown so the cash drawer makes sense.

**Section D. Cash drawer**

| Line | Calculation |
|---|---|
| Opening float | Entered at the start of the day |
| Cash from bills | Cash payments with this business date |
| Cash collections | Cash collections with this business date |
| Paid in | Sum of paid-in entries, each with its reason |
| Paid out | Sum of paid-out entries, each with its reason |
| Expected cash | Opening + cash from bills + cash collections + paid in − paid out |
| Counted cash | Entered at Day Close |
| Cash difference | Counted − expected |

The count is blind.
The manager enters the counted cash without seeing the expected figure.
The owner sees the expected figure and the difference.
Whether a manager may see the difference after entering the count is a setting, off by default. `TO CONFIRM` with the owner.

**Section E. By order type**
Dine-in, Takeaway, and Delivery split by platform.
Bills, net sales, bill total for each.

**Section F. GST by rate**
One row per rate: net sales, CGST, SGST, GST.
Platform-paid delivery orders appear as their own 0% row, labelled "GST paid by platform, section 9(5)".

**Section G. Controls**

| Line | Calculation |
|---|---|
| Discounts | Count and total, and the three largest |
| No Charge | Count and No Charge value |
| Items cancelled | Count and value, and wasted value |
| Orders cancelled | Count and value |
| Voided bills | Count and value, each with its reason |

**Section H. Invoices**
First number, last number, number issued, number voided, gaps.
Gaps must be zero. Check C6.

**Section I. Checks**
Every check result.

**Outputs**
Screen.
80 mm and 58 mm thermal print, from the cashier's browser.
A4 print and PDF.
Excel.

**Sources**
`bills` by `businessDate`.
Payments and collections by their own business date.
Cash entries from M16.
Cancellations from `orders`, by the business date of the cancel time.

---

### R3 Sales by Day

A range of business dates. One row per date.

| Column | Calculation |
|---|---|
| Business date | Shown with the weekday: Sat 26 Sep |
| Bills | Count, not voided |
| Covers | Dine-in covers |
| Item total | |
| Discount | |
| Net sales | |
| GST | |
| Round-off | |
| Bill total | |
| Average bill | Net sales ÷ bills |
| Average per cover | Dine-in net sales ÷ dine-in covers |

A date with no bills still gets a row, filled with zeros.
A toggle compares with the previous range of the same length.
A line chart shows net sales per day.
Served at `GET /reports/v2/sales-by-day`. The M6 endpoint stays until P18 replaces its screen.

---

### R4 Hours and Weekdays

Two views of the same range.

**By hour:** net sales and bills in each hour of the day, by the hour of `bills.billedAt` in India time.
**Weekday by hour:** a grid of weekday against hour, each cell showing net sales. Busy cells are darker.

Uses `DISPLAY_TIMEZONE`, never a hardcoded zone.
Served at `GET /reports/v2/hours`. The M6 endpoint stays until P18 replaces its screen.

---

### R5 Payments

A range. One row per business date, one column per payment method.

| Column group | Contents |
|---|---|
| Money in hand | Cash, Card, UPI, and their subtotal |
| Platform money | Zomato Gold, Dineout, EazyDiner, Zomato, Swiggy, and their subtotal |
| On Hold | Charged to accounts that day |
| Unpaid | Only on an open day |
| Bill total | Must equal the four groups added. Check C3. |
| Collections | Received that day against On Hold accounts, shown separately |

Every method always appears, with zeros where unused.
A missing column reads as "no data", and zero means "none taken", which is a different answer.
Methods come from the configured list, not a hardcoded one.
OWNER only, matching the existing rule on `GET /reports/payment-methods`.

---

### R6 Platform Money

A range. One row per payout batch, from `platformpayouts`, with expected, received and difference, as `docs/API-CONTRACT.md` M17 section 6.4 works it out.
Below it, a list of platform payments no live payout covers yet.
The table below is what each batch row and its drill down show.

| Column | Calculation |
|---|---|
| Platform | Zomato, Swiggy, Zomato Gold, Dineout, EazyDiner |
| Bills | Count of bills paid through it |
| Bill total | Sum paid through it |
| Discount funded by us | Discounts on those bills where the restaurant paid |
| Discount funded by platform | Where the platform paid |
| Commission | Bill total × commission rate, rate frozen on each bill |
| Expected payout | Bill total − commission |
| Received payout | Entered when the money lands |
| Difference | Received − expected |

Drill down to one row per bill: bill number, date, platform order ID, bill total, commission, expected, received, date received.
Commission rates are `TO CONFIRM`.
Until they are confirmed, commission shows as "rate not set", and no expected payout is invented.

---

### R7 Cash Till

A range. One row per business date.
The same lines as R2 Section D, plus who closed the day and when.
Owner only, because it shows expected cash.

---

### R8 GST

A range, usually a month.

**Section A. By rate**
One row per rate: net sales, CGST, SGST, GST.

**Section B. Supplies where the platform pays GST**
By platform: net sales on delivery orders taxed under section 9(5).

**Section C. Not sales**
No Charge value.
Voided bill total.
Both listed so the accountant can see them, and both kept out of Section A.

**Section D. Documents issued**
Per invoice series: first number, last number, total issued, total voided.
This is what GSTR-1 asks for.

**Section E. Round-off**
The total, so the accountant can post it to the round-off ledger.

The exact GSTR-1 table each section maps to is `TO CONFIRM` with their CA.

---

### R9 Tally Export

A file, not a screen.
The first version reproduces the shape their accountant already imports from the old system's "Tally Data":

| Block | Rows |
|---|---|
| Sales by rate | One row per tax rate: taxable value, CGST, SGST, final amount, round-off |
| Sales by payment method | One row per method, using their Tally codes from `docs/archive/caffeza/CAFFEZA-PROFILE.md` section 10 |

Round-off is its own row, as in their old file.
Unlike their old file, the by-method block uses each bill's own stored net sales and GST, never a value worked backwards from the rounded amount.
Their old file shows two different taxable totals for the same day because of that.
Tally XML vouchers can come later. `TO CONFIRM` with their accountant.

---

### R10 Invoice Register

A range. One row per invoice number, in number order.

| Column | Contents |
|---|---|
| Invoice number | |
| Business date | |
| Issued at | Time, India time |
| Order type and table | |
| Bill total | |
| Status | Paid, On Hold, Unpaid or Voided |
| Void reason | If voided |

If a number is missing between the first and last, a red row appears in its place saying "Missing number".
There must never be one. Check C6.

---

### R11 Menu Performance

A range. Opens at category level. Clicking a category shows its items.

| Column | Calculation |
|---|---|
| Category, or item | Frozen name from the bill line, `bills.lines[].categoryName` or `itemName` |
| Quantity sold | Sum of line quantities |
| Item total | Sum of line totals |
| Discount | Sum of line discount shares |
| Net sales | Sum of line net sales |
| Share of net sales | Row net sales ÷ total net sales. Rows add to 100%. |
| Rank | By net sales |
| Cancelled quantity | From `orders`, cancelled lines of this item |
| Wasted value | Cancelled after preparation, at line total |

Totals row: item total, discount and net sales must equal R3 for the same range. Check C5.
A toggle shows items on the menu that sold nothing, for menu clean-up.
Everything comes from the category and name frozen on the bill line, so moving an item to a new category never rewrites old reports.

---

### R12 Captains

A range. One row per captain.

| Column | Calculation |
|---|---|
| Captain | Frozen name on the bill, `bills.captainName`, grouped by `captainId` |
| Bills | Count |
| Covers | Dine-in covers |
| Net sales | |
| Bill total | |
| Average per cover | Their dine-in net sales ÷ their dine-in covers |
| Average table time | Their table minutes ÷ their dine-in paid bills |
| Discounts on their bills | Count and total |
| Items they cancelled | Count and value, by `cancelledBy` |

Totals row: bills, net sales and bill total must equal R3. Check C5.
Delivery and takeaway orders opened at the counter appear under the counter login, so the total still balances.
Caffeza's old captain report was ₹16,392 short of its own day total. This one cannot be.

---

### R13 Tables and Table Time

A range. One row per table, grouped by area.

| Column | Calculation |
|---|---|
| Table | Frozen name on the bill |
| Bills | Count |
| Covers | |
| Net sales | |
| Turns per day | Bills ÷ number of business dates in the range |
| Average table time | Minutes from order opened to bill paid |

A second panel shows kitchen time per station: average minutes from KOT fired to ready, and the five slowest items.

---

### R14 Discounts

A range.

**Summary by reason:** count, total discount, average percent off.
**Summary by who applied it:** count and total, highest first.
**Bill list:**

| Column | Contents |
|---|---|
| Bill number and time | |
| Table and captain | |
| Item total before discount | Named in full, never "order amount" |
| Discount | |
| Percent off | Discount ÷ item total |
| Bill total after discount | Named in full |
| Reason and note | |
| Applied by | |

Clicking a bill shows how the discount was shared across its lines.
Served at `GET /reports/v2/discounts`. The M6 endpoint stays until P18 replaces its screen.

---

### R15 Cancellations and Voids

A range. Three tables, one screen.

**Items cancelled**

| Column | Contents |
|---|---|
| Time | Cancel time, India time |
| Table and captain | |
| Item and quantity | |
| Value | Line total at menu price, before GST |
| Stage | Before preparation, or after preparation |
| Reason and note | |
| Cancelled by | A person, never a station name alone |

A line cancelled as part of a whole-order cancel takes the order's `cancelReasonCode`, as P04 noted.

**Whole orders cancelled:** time, table, value, reason, cancelled by.
**Bills voided:** invoice number, value, reason, voided by, time.

Summaries by reason, by person and by item.
Wasted value is shown as its own headline number.
Caffeza's old system split this across three reports, and one of them said "No Data Found". This is one report.

---

### R16 No Charge

A range. One row per No Charge order: `orders` with status `NO_CHARGE`, by `noCharge.businessDate`.

| Column | Contents |
|---|---|
| Time and table | |
| Items | |
| No Charge value | At menu price, before GST |
| Reason and note | |
| Requested by | |
| Approved by | |

The value is always before GST, and the column header says so.
Their old reports showed the same order as ₹230 in one place and ₹242 in another.

---

### R17 On Hold Accounts

Two views.

Reads `accounts` and `accountentries`.

**Accounts, as of a date:**

| Column | Calculation |
|---|---|
| Account | Like "W-330 Office" |
| Opening balance | Carried over on cutover day |
| Charged | Bill totals put on the account |
| Collected | Money received against it |
| Outstanding | Opening + charged − collected |
| Oldest unpaid bill | Its date, and its age in days |

**Statement for one account:** every charge and collection in date order, with a running balance.

---

### R18 Activity Log

Built by M8, exactly as specified in `docs/API-CONTRACT.md` under "M8 Audit Trail".
The summary view ranks people by the value they voided, highest first.
M16 and M17 add their own actions, listed in `docs/CAFFEZA-BUILD-PLAN.md`.

---

### R19 Bill List

The page every drill down opens.

**Filters:** business date range, bill number, table, captain, order type, platform, payment method, status, has discount, has cancellations.
**Columns:** bill number, business date, time issued, time paid, table or type, captain, covers, item total, discount, net sales, GST, round-off, bill total, how it was paid, status.
**One bill:** every line with its shares, every payment, the discount with who applied it, and a timeline of every event on the order from opening to payment.

---

### R20 CA Pack

A calendar month of closed days, for the restaurant's chartered accountant.
Built by P65 and emailed on the 1st of the next month. One sheet per section:

| Section | Contents |
|---|---|
| Cover | Restaurant, legal name, GSTIN, FSSAI, the period, its closed days, when it was built, and what the pack does not cover |
| Outward supplies, rate-wise | R8 A and B: net sales, CGST, SGST per rate; the platform's section 9(5) supplies on their own rows |
| HSN and SAC summary | By the code frozen on each bill line and its rate: quantity, net sales, CGST, SGST. No code: "Not recorded" |
| Document series | R10, every number in order, voided and missing ones included |
| Money received | R5's totals by payment method, then On Hold, Unpaid and Collections |
| On Hold movement | Per account: opening, charged, collected, adjusted, closing |
| Cash and expenses | Expenses by category, bank deposits (contra), cash to the owner (drawings) |
| Checks run | Every check run, with what it compared |

Refuses with a day open or an ERROR check failing, as R9. Contains no guest's
name or number. Checks: C1, C3, C4, C5.7, C5.8, C6, C13.

---

## 4. What happens to the existing M6 reports

| Existing endpoint | Becomes |
|---|---|
| `GET /reports/dashboard` | Replaced by R1 |
| `GET /reports/sales-summary` | Kept. Its figures feed R2 Section A. |
| `GET /reports/sales-by-day` | Replaced by R3, `GET /reports/v2/sales-by-day` |
| `GET /reports/hourly` | Replaced by R4, `GET /reports/v2/hours` |
| `GET /reports/top-items` | Kept for R1. R11 replaces it on report screens. |
| `GET /reports/tax-summary` | Replaced by R8 |
| `GET /reports/discounts` | Replaced by R14, `GET /reports/v2/discounts` |
| `GET /reports/payment-methods` | Replaced by R5 |
| `GET /reports/labour-hours` | Kept, hidden while attendance is switched off |
| `GET /reports/stock-consumption` | Kept, hidden while inventory is switched off |

Nothing is removed until the new screen that replaces it is live.

---

## 5. How Caffeza's old reports map to ours

| Their report | Ours |
|---|---|
| Sales Summary Details, Sales Summary Overview, Invoice Overview | R2 Day Close |
| Sales Summary by Date, by Shift or Date | R3 Sales by Day |
| Sales Summary by Order Type | R2 Section E, R3 |
| Wallet Summary, Payment Overview | R5 Payments |
| Taxes, Tally Data, Daily Sales Summary (FAS) | R8 GST, R9 Tally Export |
| by Category, by Category and Subcategory, by Subcategory and Item, by Item, by Item List | R11 Menu Performance |
| by Captain | R12 Captains |
| by Table Group, Detail by Table Group, Passing Desk | R13 Tables and Table Time |
| Discount Overview, Discount Detail | R14 Discounts |
| Cancelled Order Items, Cancelled Orders, Cancellation Detail by Item, Sales Return by Item | R15 Cancellations and Voids |
| No Charge Orders | R16 No Charge |
| On Hold Orders, On Hold Payment Received | R17 On Hold Accounts |
| Shift Till | R7 Cash Till |
| Service Charge Report | R19 Bill List. Caffeza charges no service charge. |
| Item Specials, Item Group | Not built. Both are "To-Do" in their own system. |

---

## 6. Fields the reports depend on

Every field the reports read now exists. The exact stored field behind every
column, each report's endpoint, filters, totals, checks and drill downs are in
`docs/API-CONTRACT.md`, section "M19 Reports v2", written by P13.
Fields that are still not stored, and what that means for a label, are listed
in its section 11.
