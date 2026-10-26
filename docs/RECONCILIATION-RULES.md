# Reconciliation Rules

These are the balance checks that prove a report is right.
Each one is an equation that must hold to the paisa.
If one fails, it is a bug, never a rounding quirk.

Words follow `docs/GLOSSARY.md`.
Which report runs which check is listed in section 3.

---

## 1. How checks run

**Where they run**

1. In the report engine, before any report renders. The result is the strip at the top of the report.
2. At Day Close. An ERROR check blocks the close. A WARNING check needs a written note to continue.
3. In the test suite. Every check has a test that passes on good data and a test that deliberately breaks the rule and watches the check fail.

**Severity**

| Severity | Meaning | On screen |
|---|---|---|
| ERROR | The numbers are wrong or incomplete. Something in the code or the data is broken. | Red strip. Report still shows. |
| WARNING | The numbers are right, but a person needs to look at something, like a cash difference. | Amber strip |

**What a failure shows**

The check's ID and message, exactly as written below, with the real values filled in.
The expected value, the actual value, and the difference.
A link to the bills or records that caused it.

**Rules for the checks themselves**

A check never changes data. It only reads.
A check never rounds before comparing. It compares whole paise.
Checks live in one server file, `server/services/reconciliationService.js`, started in P10 with the one-day checks Day Close needs, and completed in P14.
Built in P10 for one business date: C1, C3, C4, C6, C8 and C9. Completed in P14: every check, C1 to C12, is built in `reconciliationService.js`, with range versions in `runRangeChecks` that return one result per check listing every failing day or bill. Day Close runs every check that applies to one day. For C6 and C8 the day's bills include any bill whose `billedAt` falls in the day's hours, so a bill stored on the wrong date fails C8 alone instead of also opening a gap in C6.

---

## 2. The checks

### C1 Bill arithmetic

Scope: every bill in the range, not voided.
Severity: ERROR.

For each bill:

1. Sum of line totals equals item total.
2. Item total minus discount equals the sum of slab net sales.
3. For each slab, CGST plus SGST equals slab GST.
4. Sum of slab GST equals the bill's GST.
5. Net sales plus GST plus round-off equals bill total.
6. Round-off is between minus 49 and plus 50 paise.

Message: "C1 Bill arithmetic: bill {billNumber} does not add up. {rule} expected {expected}, found {actual}."

### C2 Line shares

Scope: every bill in the range, not voided.
Severity: ERROR.

For each bill:

1. Sum of line discount shares equals the bill discount.
2. For each tax rate, sum of line net sales equals that slab's net sales.
3. For each tax rate, sum of line GST shares equals that slab's GST.

Message: "C2 Line shares: bill {billNumber}, the line shares do not add up to the bill. {rule} expected {expected}, found {actual}."

### C3 Where the money went

Scope: each business date in the range.
Severity: ERROR.

Payments received on the day's bills
plus `chargedToAccountInPaise` of the day's bills charged to an account
plus the unpaid remainder of the day's `UNPAID` bills
equals the day's bill total.

A charge counts wherever it is recorded, so a bill wrongly marked `PAID` fails C4
and not C3.

On 26 September at Caffeza: ₹2,06,628 + ₹551 + ₹0 = ₹2,07,179.

Message: "C3 Money: on {date}, bills total {billTotal} but received plus On Hold plus unpaid is {accounted}. {difference} is unaccounted for."

### C4 Paid means paid

Scope: every bill with status PAID.
Severity: ERROR.

Sum of the bill's payments equals its bill total.
A bill with status UNPAID has payments below its bill total.
A bill with status ON_ACCOUNT has payments plus `chargedToAccountInPaise` equal to its bill total (P09).

Message: "C4 Payment: bill {billNumber} is marked {status} but its payments total {paid} against a bill total of {billTotal}."

### C5 Groups add up to the whole

Scope: the report's range.
Severity: ERROR.

Each of these grouped totals equals the ungrouped total for the same range:

1. Categories: sum of category net sales equals net sales.
2. Items: sum of item net sales equals net sales.
3. Captains: sum of captain bill totals equals bill total.
4. Order types: sum of order type bill totals equals bill total.
5. Hours: sum of hourly net sales equals net sales.
6. Days: sum of daily bill totals equals the range bill total.
7. Tax rates: sum of slab net sales equals net sales.
8. HSN or SAC codes: sum of net sales by code and rate equals net sales (R20, P65). Lines with no code count under "Not recorded"; a line with no share (before P03) counts as zero, which fails the check on purpose.

Message: "C5 Totals: the {grouping} totals add up to {sum}, but the whole is {total}. {difference} is missing from one of the groups."

This is the check Caffeza's old captain report would have failed, by ₹16,392.

### C6 Invoice numbers

Scope: each invoice series in the range.
Severity: ERROR.

1. No number between the first and the last is missing.
2. No number appears twice.
3. Every voided bill is still present in the register.

Message: "C6 Invoices: number {number} is missing from series {series}." Or: "number {number} appears {count} times."

### C7 Cancelled never sold

Scope: the range.
Severity: ERROR.

No order line with status CANCELLED appears as a line on any bill.
No No Charge order has a bill with an invoice number.

Message: "C7 Cancelled: item {itemName} on order {orderNumber} was cancelled but appears on bill {billNumber}."

### C8 Business date matches the clock

Scope: every bill in the range.
Severity: ERROR.

Each bill's stored `businessDate` equals the business date worked out from its `billedAt` with the restaurant's business day start.
A failure means a clock or time zone problem, which is the exact bug Caffeza's old system has.

Message: "C8 Date: bill {billNumber} was issued at {billedAt} India time, which is business date {computed}, but it is stored as {stored}."

### C9 Cash drawer

Scope: each business date with a cash record.
Severity: WARNING.

Expected cash equals opening float + cash from bills + cash collections + paid in − paid out − cash taken out.
Cash collections are `accountentries` of type `COLLECTION` whose frozen method is `CASH`, on that business date.
P29: paid in is shown as top-ups and paid out as expenses; cash taken out is the `CASH_TAKEN_OUT` movements of the date, a bank deposit or cash given to the owner, never an expense. A day with none gives the figure it gave before P29.
Cash taken out at close, after the count, is not part of expected cash, and never changes the difference.
That equation itself is ERROR if it fails, because it means the arithmetic is broken.
The difference between counted and expected cash is a WARNING whenever it is not zero.

Message: "C9 Cash: counted {counted}, expected {expected}. {difference} {short or over}."

### C10 Account balances

Scope: every On Hold account.
Severity: ERROR for the arithmetic, WARNING for a negative balance.

Outstanding equals opening balance + charges − collections, read from `accountentries`: `OPENING`, `CHARGE` and `ADJUSTMENT` up add, `CHARGE_REVERSED`, `COLLECTION` and `ADJUSTMENT` down subtract.
An outstanding balance below zero is a WARNING: the account has paid more than it owes.

Message: "C10 Account: {accountName} shows {outstanding} outstanding, but its entries add up to {computed}."

### C11 Platform payouts

Scope: every live payout batch in the range.
Severity: WARNING.

Expected payout is worked out per batch, as `docs/API-CONTRACT.md` M17 section 6.4 says: each payment's amount minus its own frozen commission, summed.
Any difference between received and expected payout is shown for review.
A bill whose platform has no commission rate set is listed, and no expected payout is invented for it.

Message: "C11 Platform: {platform} paid {received} for {count} bills against {expected} expected. Difference {difference}." When payments in the batch have no commission rate, the message adds "{n} payments with no commission rate set."

### C12 Closed days do not change

Scope: every closed business date in the range.
Severity: ERROR.

Recomputing the Day Close figures from the stored records, with `computeDayFigures`, gives exactly `dayclosures.snapshot` stored when the day was closed.
A failure means a record on a closed day was changed after the close.

P29: the comparison is on the keys the stored snapshot holds. A figure a later prompt adds to `computeDayFigures` (like `cashTakenOutInPaise` or `controls.billRevisions`) is compared only for days closed after it existed, so adding a figure never reads as every earlier closed day having changed.

### C13 Revision trail

Added by P29.
Scope: every live bill in the range whose `revision` is above 0.
Severity: ERROR.

The bill holds exactly `revision` entries in `revisions`, numbered 1 to `revision`, and the last one's `newGrandTotalInPaise` equals the bill's `grandTotalInPaise`.
A failure means a bill's figures moved without a revision recording it.
C1 and C2 still hold on a revised bill, because its totals and shares are rebuilt by the same code as bill creation. C6 is unaffected, because a revision uses no number. C7 holds, because a removed line is cancelled on the order and absent from the bill.

Message: "C13 Revision: bill {billNumber} is {grandTotal} but its last revision says {newGrandTotal}."

### C14 Brought forward

Added by P29.
Scope: each business date in the range whose opening float was brought forward.
Severity: WARNING.

The confirmed opening float equals `keptForTomorrowInPaise` of the closed day it was brought forward from.
A difference is not an error, because the drawer can change overnight, but it is shown with its note for the owner to read.

Message: "C14 Brought forward: {date} opened with {float}, but {fromDate} kept {kept}. Note: {note}."

Message: "C12 Closed day: {date} was closed at {closedAt} with bill total {stored}. The records now add up to {now}."

---

## 3. Which report runs which checks

| Report | Checks |
|---|---|
| R1 Today | C1, C3, C4 for today |
| R2 Day Close | C1, C3, C4, C6, C8, C9, and C12 when closed. P14 adds C2, C5.4, C5.7, C7, C10 and C11 for the day. P29 adds C13 and C14. |
| R3 Sales by Day | C1, C5.6, C8 |
| R4 Hours and Weekdays | C5.5 |
| R5 Payments | C3, C4 |
| R6 Platform Money | C11 |
| R7 Cash Till | C9 and C14 for each date |
| R8 GST | C1, C5.7, C6 |
| R9 Tally Export | C1, C5.7, and the export refuses to build if any ERROR check fails |
| R10 Invoice Register | C6, C13 |
| R11 Menu Performance | C2, C5.1, C5.2, C7 |
| R12 Captains | C5.3 |
| R13 Tables and Table Time | C5.4 |
| R14 Discounts | C1, C2 |
| R15 Cancellations and Voids | C6, C7, C13 |
| R16 No Charge | C7 |
| R17 On Hold Accounts | C10 |
| R18 Activity Log | None. It is M8's read. |
| R19 Bill List | C1, C2, C4 for each bill shown |
| R20 CA Pack | C1, C3, C4, C5.7, C5.8, C6, C13, and the pack refuses to build if any ERROR check fails |

---

## 4. Tests every check needs

For each check, the test suite has:

1. The golden day from `docs/TEST-DATA.md`, where every check passes.
2. A copy of the golden day with one number deliberately broken, where exactly that check fails and every other check still passes.

The second test is the one that matters.
A green suite proves the code passes the tests.
Breaking the rule on purpose proves the check would have caught a real mistake.
The M6 build used the same discipline, and it should stay.
