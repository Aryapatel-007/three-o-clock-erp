# Glossary

One word, one meaning, everywhere.
This file decides what every number on every report is called and how it is calculated.
Report screens, exports, printed bills, API field names and help text all follow it.

Why this exists:
Caffeza's current system uses "Order Amount" for two different numbers, and "Sales" for a number that includes tax.
An owner who meets the same word meaning two things stops trusting all of it.

If a new report needs a word that is not here, add it here first, in the same pull request.

---

## 1. Rules for words

1. A label on screen always comes from this file.
2. A total is always the exact sum of the rows above it.
3. An average is always a sum divided by a sum, never an average of averages. It is always labelled "average".
4. Every money value is shown in rupees with the Indian grouping, like ₹2,07,179.00.
5. Every time is shown in India time, 12-hour, like 9:05 PM.
6. Every date filter uses business dates, never calendar dates.

**Words we never use on their own, because they are ambiguous:**

| Banned word | Why | Use instead |
|---|---|---|
| Amount | Means anything | The exact term below |
| Sales | Their old system meant "including tax". Most owners mean "before tax". | Bill total, or Net sales |
| Gross sales | Accountants mean "before discount". Our old API field `grossSalesInPaise` means "including tax". | Item total, or Bill total |
| Wallet | Mixes money already in the bank with money a platform still owes | Money in hand, or Platform money |
| Occupancy | Unclear | Covers |
| APC | An abbreviation | Average per cover |

---

## 2. The numbers on a bill

These follow the order in which a bill is built.

| Term | Meaning | Calculation | Stored in |
|---|---|---|---|
| **Line total** | The price of one line: quantity times unit price, plus its add-ons | `quantity × unitPriceInPaise`, plus add-ons | `bills.lines[].lineTotalInPaise` |
| **Item total** | All line totals added together, before discount and before GST | Sum of line totals | `bills.subtotalInPaise` |
| **Discount** | Money taken off the item total, before GST is worked out | Flat, or a percent of the item total | `bills.discount.amountInPaise` |
| **Net sales** | What the cafe actually earns from the bill. This is the taxable value. | Item total minus discount | Sum of `bills.taxBreakdown[].taxableInPaise` |
| **CGST** | Central GST, half of the GST | Worked out once per tax rate | `bills.taxBreakdown[].cgstInPaise` |
| **SGST** | State GST, the other half | Worked out once per tax rate | `bills.taxBreakdown[].sgstInPaise` |
| **GST** | CGST plus SGST | CGST + SGST | `bills.totalTaxInPaise` |
| **Round-off** | The paise added or removed so the bill lands on a whole rupee | Between minus 49 and plus 50 paise | `bills.roundOffInPaise` |
| **Bill total** | What the guest is asked to pay | Net sales + GST + round-off | `bills.grandTotalInPaise` |

Every bill obeys this, to the paisa:
Item total minus discount equals net sales.
Net sales plus GST plus round-off equals bill total.

Mapping from Caffeza's old labels:

| Their word | Our word |
|---|---|
| Sub Total | Item total |
| Amount, or Taxable | Net sales |
| Tax | GST |
| Sales, or Final, or NetTotal | Bill total |

---

## 3. Shares down to each line

A discount and GST are worked out for the whole bill, per tax rate.
Category and item reports need each line's part of them.
So every bill line also stores its share.

| Term | Meaning | Stored in |
|---|---|---|
| **Line discount share** | This line's part of the bill discount | `bills.lines[].discountShareInPaise` |
| **Line net sales** | Line total minus its discount share | `bills.lines[].taxableInPaise` |
| **Line GST share** | This line's part of the GST for its tax rate | `bills.lines[].taxInPaise` |

The rule for splitting, applied separately inside each tax rate on a bill:

1. Split the rate's discount across its lines in proportion to line total.
2. Give each line the whole paise it is due, rounded down.
3. Give any paise left over one at a time, to the lines with the biggest leftover fractions. A tie goes to the earlier line on the bill.
4. Split the rate's GST across the same lines in proportion to line net sales, the same way.

This is called the largest remainder method.
It guarantees that line shares add up exactly to the bill's figures.
It reproduces Caffeza's own split on real bill C22276: ₹22.68, ₹20.16, ₹14.11 and ₹4.03 four times.
Prompt P03 builds it, in `server/utils/tax.js` and nowhere else.

---

## 4. Days and time

| Term | Meaning |
|---|---|
| **Business day** | The trading day. It starts at `settings.businessDayStartsAtMinutes`, 5:00 AM by default, and runs until 4:59 AM the next morning. |
| **Business date** | The label of a business day, stored as `"YYYY-MM-DD"`. A bill paid at 12:30 AM on 27 September has business date 26 September. |
| **Bill's business date** | Decided when the bill is issued, from `billedAt`, and never changed. Sales count on this date. |
| **Payment's business date** | Decided when the money is received, from `receivedAt`. Cash in the drawer counts on this date. |
| **Open day** | A business date that has not been closed yet. Its numbers can still change. |
| **Closed day** | A business date locked by Day Close. Its numbers never change unless a manager reopens it, which is logged. |

Most bills are issued and paid on the same business date.
The two dates differ only for On Hold bills, which are issued on one day and collected on a later one.

---

## 5. The kinds of bill and order

| Term | Meaning | Counted in sales |
|---|---|---|
| **Bill** | A tax invoice with a number from the invoice series | Yes |
| **Unpaid bill** | A bill issued but not yet settled. Only possible on an open day. | Yes |
| **Paid bill** | A bill whose payments add up to its bill total | Yes |
| **On Hold bill** | A bill charged to a named account, to be collected later. Status `ON_ACCOUNT`. | Yes, on the day it was issued |
| **Voided bill** | A bill cancelled after it was issued. It keeps its number and is shown in the invoice register. | No |
| **No Charge order** | Food given free, with a reason and an approver. Order status `NO_CHARGE`. It gets no invoice number and no bill. | No |
| **Cancelled item** | A line cancelled before the bill was issued | No |
| **Cancelled order** | A whole order cancelled before billing | No |

---

## 6. Money received

| Term | Meaning |
|---|---|
| **Payment method** | How a bill was settled. Cafezza, the first client, had eight; see `docs/archive/caffeza/CAFFEZA-PROFILE.md` section 10. |
| **Payment method kind** | `IN_HAND` or `PLATFORM`, set on each payment method and frozen onto each payment |
| **Money in hand** | Methods of kind `IN_HAND`, where the money is already the cafe's: Cash, Card, UPI |
| **Platform money** | Methods of kind `PLATFORM`, where a platform collected the money and pays the cafe later, minus commission: Zomato Gold, Dineout, EazyDiner, Zomato, Swiggy |
| **Money received** | Money in hand plus platform money |
| **On Hold** | Bill totals charged to accounts and not yet collected |
| **Collection** | Money received later against an On Hold account. It is not a sale. It counts in the drawer on the day it arrives. |
| **Split payment** | One bill settled with more than one method |

Every day obeys this, to the paisa:
Money received for the day's bills, plus On Hold, plus unpaid, equals the day's bill total.
On 26 September at Caffeza: ₹2,06,628 received plus ₹551 On Hold equals ₹2,07,179.

---

## 7. Platform terms

| Term | Meaning |
|---|---|
| **Platform** | Zomato, Swiggy, Zomato Gold, Dineout or EazyDiner |
| **Platform order** | A delivery order placed on Zomato or Swiggy. Entered by hand for now. |
| **Platform order ID** | The platform's own number for the order, like `249377796192385` |
| **Platform-paid GST** | On a platform delivery order, the platform pays the GST under section 9(5). Our bill shows 0% GST. Stored as `taxTreatment: PLATFORM_COLLECTS` on the order and the bill, frozen when the order is created. |
| **Discount funded by** | Who paid for a discount: the restaurant, or the platform |
| **Commission** | The platform's cut, as a percent of the bill total. `TO CONFIRM` per platform. |
| **Payout** | One batch of money from a platform, covering a range of business dates. Stored in `platformpayouts`. |
| **Expected payout** | For one payout: the sum over its payments of payment amount minus commission, each at the payment's own frozen commission rate. Payments with no rate are listed as "rate not set" and left out. |
| **Received payout** | What the platform actually paid, entered when it lands in the bank |
| **Payout difference** | Received payout minus expected payout |

---

## 8. People, tables and time

| Term | Meaning | Calculation |
|---|---|---|
| **Captain** | The staff member who opened the order | `orders.openedBy`, frozen onto the bill as `captainId` and `captainName` |
| **Covers** | Guests at a dine-in table | `orders.guestCount`, frozen onto the bill as `guestCount` |
| **Average per cover** | Dine-in net sales per guest | Dine-in net sales ÷ dine-in covers |
| **Average bill** | Net sales per bill | Net sales ÷ bills |
| **Table time** | How long a dine-in table was in use | Minutes from order opened to bill paid |
| **Average table time** | Mean table time | Total table time ÷ dine-in paid bills |
| **Kitchen time** | How long an item took in the kitchen | Minutes from KOT fired to marked ready |
| **Station** | A place a KOT goes, like Live Kitchen or Beverages | M18 |

Why average per cover will not match Caffeza's old APC:
Their APC divides all net sales, delivery included, by all guests.
Ours uses dine-in only, because a delivery order has no guests at a table.
On 26 September theirs was ₹417.33.

---

## 9. Controls

| Term | Meaning |
|---|---|
| **Discount reason** | Chosen from a fixed list, plus an optional note |
| **Approved by** | The owner or manager who allowed a discount, a No Charge, a void or a reopened day |
| **Cancelled before preparation** | The item never reached the kitchen, or the kitchen had not started it. `wasPrepared: false`. |
| **Cancelled after preparation** | The kitchen had made it. `wasPrepared: true`. |
| **Cancel reason** | Chosen from a fixed list in `server/config/cancelReasons.js`, with an optional note. A note is required for Other. |
| **Wasted value** | Line total of items cancelled after preparation, at menu price, before GST |
| **No Charge value** | Line total of a No Charge order at menu price, before GST |
| **Void** | Cancelling an issued bill. The number stays in the register, marked voided, with a reason. |

---

## 10. Cash drawer

| Term | Meaning |
|---|---|
| **Opening float** | Cash put in the drawer at the start of the day |
| **Cash from bills** | Cash payments received on the business date |
| **Cash collections** | Cash received against On Hold accounts on the business date |
| **Paid in** | Cash added to the drawer that is not a sale, with a reason |
| **Paid out** | Cash taken out for an expense, like buying milk, with a reason |
| **Expected cash** | Opening float + cash from bills + cash collections + paid in − paid out |
| **Counted cash** | What the manager counts at Day Close |
| **Cash difference** | Counted cash − expected cash. Negative means cash is missing. |

---

## 11. Invoice numbers

| Term | Meaning |
|---|---|
| **Invoice series** | The prefix and the running number, like `CFA/C/22442` |
| **Invoice register** | Every number issued in a range, in order, including voided ones |
| **Gap** | A missing number in the series. There must never be one. |

---

## 12. Report words

| Term | Meaning |
|---|---|
| **Share of net sales** | This row's net sales ÷ the report's total net sales. The rows add up to 100%. |
| **Rank** | Position when sorted by net sales, highest first |
| **Filter sentence** | The line at the top of every report saying exactly what it covers, like "26 Sep 2026, business day starts 5:00 AM, all order types, all captains" |
| **Check** | A balance rule from `docs/RECONCILIATION-RULES.md` that the report must pass |
| **Drill down** | Clicking any number to see the bills behind it |

Caffeza's old category report shows a "%" column where the top category is always 100% and the rest are measured against it.
Ours is a true share, and the column is labelled "Share of net sales".

---

## 13. Column labels

Added by P13 for the M19 report columns, so every label on a report comes from this file.
The labels already defined above keep their meaning.

| Term | Meaning |
|---|---|
| **Bills** | A count of bills, voided bills left out |
| **Order type** | Dine-in, Takeaway or Delivery, frozen on the bill |
| **Table** | The table name frozen on the bill |
| **Category** | The category name frozen on the bill line when the item was ordered |
| **Item** | The item name frozen on the bill line |
| **Quantity sold** | Sum of line quantities on live bills |
| **Cancelled quantity** | Sum of quantities on cancelled order lines of that item |
| **Items cancelled** | Count and line total of cancelled order lines |
| **Quantity** | The quantity on one line |
| **Invoice number** | The bill number, like `CFA/C/22442` |
| **Status** | Paid, On Hold, Unpaid, Voided, or "Missing number" in the invoice register |
| **Void reason** | The fixed void reason's label, and its note |
| **Cancel reason** | The fixed cancel reason's label, and its note |
| **Stage** | Cancelled before preparation, or Cancelled after preparation |
| **Time issued** | When the bill was issued, `billedAt`, in India time |
| **Time paid** | When the bill was fully paid, `paidAt`, in India time |
| **Time** | When the event on that row happened, in India time |
| **Paid with** | The payment methods of a bill, by their frozen names |
| **Tax rate** | A GST rate, like 5% |
| **Tally code** | The payment method's Tally ledger code, frozen on the payment |
| **Hour** | An hour of the day in India time, from when bills were issued |
| **Weekday** | Monday to Sunday, from the business date |
| **Period** | The business dates a payout covers |
| **Open tables** | Tables with an order that is open or waiting for the cashier |
| **Same weekday last week** | The bill total one week earlier, up to the same time of day |
| **Turns per day** | Bills on a table ÷ business dates in the range |
| **Percent off** | Discount ÷ item total, on one bill or a group of bills |
| **Applied by** | The person who applied a discount |
| **Cancelled by** | The person who cancelled a line or an order |
| **Voided by** | The person who voided a bill |
| **Requested by** | The captain who opened a No Charge order |
| **Closed by** | The person who closed a business day |
| **Account** | An On Hold account, like "W-330 Office" |
| **Opening balance** | What an account owed when it was set up in this system |
| **Charged** | Bill totals put on an account |
| **Collected** | Collections received against an account |
| **Outstanding** | Opening balance + charged − collected, ± adjustments |
| **Oldest unpaid bill** | The business date of the oldest charge not yet covered by collections, and its age in days |
| **Line total** | Defined in section 2; on a cancelled line it is the value at menu price, before GST |
| **Figure** | One named number on a day's report, like Net sales or Paid out. The first column of R2's sections. |
| **Count** | How many, on a line of R2: bills, covers, cancelled items |
| **Value** | A figure's money, on a line of R2, in rupees |
| **Discounted bills** | A count of bills with a discount above zero |
| **Cancelled value** | Line total of cancelled items at menu price, before GST, whether or not they were prepared |
| **Items made** | Quantity on kitchen ticket lines marked ready |
| **Item total before discount** | Item total, named in full where a discount sits beside it (R14) |
| **Bill total after discount** | Bill total, named in full where a discount sits beside it (R14) |
| **No Charge value, before GST** | No Charge value, with its basis in the header (R16) |
| **No Charge reason** | The fixed No Charge reason's label, and its note |
| **Age in days** | Days from the oldest unpaid bill's business date to the date the accounts are read as of |

---

## 14. Appearance words

Added by P22 for the Appearance page, the activity log and the sign-in screen.

| Term | Meaning |
|---|---|
| **Logo** | The restaurant's logo image. Shown only on the sign-in screen, the top bar, the rail and the browser tab. |
| **Logo for light screens** | The `LIGHT_GROUND` slot: dark artwork on a transparent background, shown by day |
| **Logo for dark screens** | The `DARK_GROUND` slot: light artwork, shown by night and on the sign-in screen |
| **Upload** | Choose an image file and save it as a logo |
| **Remove** | Clear a logo slot. The activity log keeps what was removed. |
| **No logo** | A slot with no image |
| **Brand colours** | The logo's own background colour and the colour of text on it |
| **Brand colour** | The logo's own background colour, `brandHex` |
| **Text on the brand colour** | The colour of text on the brand colour, `onBrandHex` |
| **Neutral tone** | Which set of page, card and text colours the restaurant uses |
| **Cool** | The default neutral tone: green-grey |
| **Warm** | The linen and espresso neutral tone |
| **Logo set** | The activity log line `BRAND_LOGO_SET` |
| **Logo removed** | The activity log line `BRAND_LOGO_REMOVED` |

---

## 15. Online words

Added by P23 for the public page, the staff inbox and the alert.

| Term | Meaning |
|---|---|
| **Online order** | A takeaway request a guest placed on the restaurant's own page. It is not an order until a staff member accepts it. Reference like `W-42`. |
| **Booking** | A table reservation, from the page or from a phone call. Reference like `R-17`. Use this word on screens. "Reservation" is the field and API name. |
| **Waiting** | An online order or booking request nobody has answered yet |
| **Accept** | Turn an online order into a takeaway order, and by default send it to the kitchen |
| **Confirm** | Agree to a booking, optionally on a table |
| **Decline** | Refuse a request, with a reason the guest sees |
| **Expired** | Nobody answered in time. The guest is asked to call. |
| **Seat** | Open the booking's table, which starts a dine-in order |
| **No-show** | A confirmed booking whose guests did not come |
| **Pickup time** | When the guest will collect a takeaway |
| **As soon as possible** | Pickup at the earliest time the cafe allows: now plus the lead time |
| **Answer within** | How long staff have to accept or decline before a request expires |
| **Paused** | The page is not taking takeaway orders for a while. Bookings still come in. |
| **Reserved** | On a floor tile: the table has a confirmed booking soon |
| **Party size** | How many people a booking is for. Becomes the order's covers when seated. |
| **Quote** | The prices and estimated bill total the guest saw before placing. The bill is worked out again when the order is accepted. |
| **Estimated bill total** | The quote's bill total, item total plus GST, rounded. The words on the page are "Estimated bill total". |
| **Page address** | The link to the restaurant's public page, like `/r/cafezza` |
| **Online alerts** | The chime, the spoken line and the banner for waiting requests, per device |
| **Offers consent** | The guest ticked the box agreeing to offers and news by SMS or WhatsApp |
| **Pay online** | Pay in advance on the cafe's page, through the cafe's own Razorpay account |
| **Paid online** | The payment method an advance becomes on the bill |
| **Advance** | Money paid online before the bill exists: a takeaway in full, or a booking deposit |
| **Deposit** | A booking's advance: people × the deposit per person |
| **Apply advance** | Put the advance on the bill as a payment |
| **Refunded** | Paid online and returned to the guest in full, or in part |
| **Forfeited** | A deposit kept, because the guest cancelled too late or did not come |
| **Waiting for payment** | Placed on the page and not yet paid. Staff do not see it. |

---

## 16. Cashier and integration words

Added by P25.

| Term | Meaning |
|---|---|
| **Cash count** | How many of each note and coin were counted. The server adds them up; a total typed beside it must agree. |
| **Tendered** | The cash a guest handed over for a bill, counted by notes or typed |
| **Change** | Tendered minus the amount applied to the bill, handed back. Never recorded as a payment. |
| **Refund owed** | Card, UPI or platform money to return to a guest after an item was cancelled on a paid bill. Recorded as done by a manager, with a reference. It moves no money in this system. |
| **Print request** | A captain asking for a bill to print on the counter's printer |
| **Bill printer** | This device's printer setting: Thermal 80 mm, Thermal 58 mm, A4 or A5 |
| **Duplicate** | Printed at the top of a bill from its second print on |
| **Tax invoice** | The words at the top of every printed bill, thermal or full page |
| **Rate** | On a full-page invoice, the price of one of an item, add-ons included, before GST |
| **Platform order** | An order a delivery platform sends through an integration, before and after it becomes our delivery order. Not an online order, which comes from the restaurant's own page. |
| **Order channel** | A delivery platform connected to receive orders: Swiggy, Zomato, or the sandbox platform |
| **Sandbox platform** | A practice order channel that behaves like a platform, for testing and training. Never in production. |
| **Item mapping** | Which of our dishes, size and extras a platform's item is |
| **Payment terminal** | A card machine connected to the bill screen, like a Pine Labs machine |
| **Terminal payment** | One attempt to take a payment on the card machine, from sending the amount to approved, declined, cancelled or expired |
| **PTRID** | Pine Labs' reference for an amount sent to the machine. The cashier picks or types it on the machine. |
| **Tally voucher** | One entry sent to Tally: a sales, receipt or payment voucher, with debits equal to credits |
| **Ledger mapping** | Which Tally ledger each figure goes to: sales by rate, GST, round-off, each payment method, On Hold, paid in and out |
| **Tally bridge** | A small program on the computer that runs Tally. It fetches vouchers from our server and posts them into Tally. |
| **Integration user** | The restaurant's automatic user, like "Swiggy (automatic)", that integrations act as. It cannot sign in. |
| **Add items** | On a bill: void it so the table can order more. The money already paid carries to the next bill. (P26) |
| **Add more dishes** | On a served table's order: take new dishes, which go to the kitchen as usual (P26) |

---

## 17. Customer words

Added by P27.

| Term | Meaning |
|---|---|
| **Customer** | One guest at this restaurant, known by their mobile number |
| **Visit** | One order opened with the customer's mobile number |
| **Last visit** | When their latest order was opened |
| **Total spent** | Bill totals of their orders' live bills |
| **Agreed to offers** | The guest said yes to offers and news by SMS or WhatsApp. Shown with when, how and the wording they agreed to. |
| **Withdrawn** | The guest asked not to get offers any more |


---

## 18. Approval words

Added by P28.

| Term | Meaning |
|---|---|
| **PIN** | A 4 to 6 digit number an owner or manager types to approve something on someone else's screen. It never signs anyone in. |
| **A manager approves** | The step where an owner or manager picks their name and types their PIN |
| **Set PIN** | Give a person a new PIN, on the Staff screen |
| **Approvals** | The settings that decide what needs a manager's PIN |
| **Approved by** | Defined in section 9. From P28 it is also stored on a cancelled line, a cancelled order, a voided bill and a cash entry. |

---

## 19. Words on the printed thermal bill

Added 2026-10-09. The thermal bill keeps the words Z Chaat's guests and staff
already know from their old bill. They are printed words only; screens and
reports keep the terms above.

| Printed word | Our term |
|---|---|
| **Sub Total** | Item total |
| **Grand Total** | Bill total |
| **Total Qty** | Sum of the quantities on the bill |
| **Price** | Rate, section 16: one of the item, add-ons included, before GST |
| **Amount** | Line total |
| **Cashier** | The person who made the bill |
| **Bill No.** | Invoice number |

---

## 20. Bill revision and cash book words

Added by P29.

| Term | Meaning |
|---|---|
| **Bill revision** | A change to the items on a bill that nothing has been paid on, under the same invoice number: an item removed or added. It is not a void, and it uses no number. |
| **Revised bill** | A bill with at least one revision. Printed "Revised bill" under its invoice number. |
| **Remove** | On an unpaid bill: take an item off it, which revises the bill |
| **Add to this bill** | On an unpaid bill: add dishes, which go to the kitchen and revise the bill |
| **Bills changed before payment** | The revisions in a range: R15's section and R2's controls line |
| **Removed from the bill before payment** | The stage of an item taken off an unpaid bill, in R15 |
| **Bills paid before printing** | Bills whose payment was taken before they were printed |
| **Waiting for the kitchen** | A bill whose order has items not yet ready. It takes no payment until they are. |
| **Undo** | On the kitchen screen: take back a ready tick made by mistake |
| **Just done** | The kitchen screen's row of tickets finished in the last 10 minutes |
| **Cash book** | The one screen for the day's cash: brought forward, top-ups, cash sales, expenses, cash taken out, and the cash in the drawer |
| **Brought forward** | The cash kept in the drawer when the last day closed, proposed as today's opening float |
| **Opening difference** | A brought-forward float counted again in the morning: counted minus kept |
| **Top-up** | Cash added to the drawer that is not a sale: from the owner, from the bank, or change. The record type is paid in. |
| **Source** | Where a top-up came from: Owner, Bank, Change or Other |
| **Cash sales** | Cash from bills, in the cash book's words, with any On Hold cash collected beside it |
| **Expense** | Cash spent from the drawer, like buying milk. The record type is paid out. |
| **Expense category** | What an expense was for, from the restaurant's list, like Milk and dairy |
| **Cash taken out** | Cash removed from the drawer that is not an expense: a bank deposit, or cash given to the owner |
| **Bank deposit** | Cash taken out to the bank. In Tally it is a contra entry, never an expense. |
| **Given to the owner** | Cash taken out to the owner. In Tally it is the owner's drawings. |
| **Cash check** | A count of the drawer during the day, without closing it. It moves no money. |
| **Cash in drawer** | What should be in the drawer now: brought forward or opening float, plus top-ups, cash sales and cash collections, minus expenses and cash taken out. Called expected cash at Day Close. |
| **Kept for tomorrow** | The cash left in the drawer at Day Close, for the next day's float |
| **Taken out at close** | Counted cash minus kept for tomorrow, at Day Close |
| **Usual float** | The amount the cash book proposes to keep for tomorrow |

Report column labels added by P29, for R7, R10 and R15:

| Term | Meaning |
|---|---|
| **Change** | On a bill revision: Removed or Added |
| **Items** | The items a revision removed or added, by their frozen names |
| **Bill total before** | A revised bill's total before that revision |
| **Bill total after** | A revised bill's total after that revision |
| **Changed by** | The person who revised a bill |
| **After printing** | Whether a bill had been printed when it was revised |
| **Revised** | In the invoice register: the bill was revised, and how many times |
| **Top-ups** | The day's top-ups added together |
| **Expenses** | The day's expenses added together |

---

## 21. Server words

Added by P30.

| Term | Meaning |
|---|---|
| **Server** | The program in the cloud every screen talks to. On Render's free plan it sleeps after 15 minutes with no one using it. |
| **Starting the server** | The minute it takes to wake after a sleep. A bar at the top of the screen says so, and the screen loads by itself. |
| **Started** | One time the server began running: after a deploy, or a wake from sleep. Counted on the Server card in Settings. |
| **Went to sleep during working hours** | A business date with more than 2 wakes, not deploys, inside working hours: the pingers did not keep it awake. |
| **Pinger** | An outside service that calls the server's wake address every few minutes, so it never sleeps in working hours |
| **Reload this screen** | After a write the server may not have received while it woke: read the screen's data again, without sending the write twice |

---

## 22. Password words

Added by P34.

| Term | Meaning |
|---|---|
| **Forgot password?** | The link on the sign-in screen to set a new password with a manager's approval |
| **Set password** | Save the new password, once a manager has approved it |
| **New password** | The password the person will sign in with from now on, at least 8 characters |
| **Manager's phone** | On the sign-in screen, the phone number of the owner or manager approving. They cannot approve their own. |
| **Back to sign in** | Leave the form without changing anything |

---

## 23. Kitchen ticket words

Added by P36.

| Term | Meaning |
|---|---|
| **Round** | One Send to the kitchen on an order. The first dishes are round 1; dishes added later are round 2, 3 and so on, on the same ticket |
| **One kitchen ticket per table** | The setting `kitchen.oneTicketPerOrder`: an order keeps one ticket, under one KOT number, for every round and station |
| **Added** | On the kitchen screen, the caption over a later round: "Added 7:20 pm" |
| **Cooking** | A dish's switch on the kitchen screen, off: not ready yet (P38) |
| **Ready** | The same switch, on: the dish is ready. Switching it off again is the undo (P38) |

---

## 25. Public page words

Added by P38, for the restaurant's public page. Section 15 still holds its main words.

| Term | Meaning |
|---|---|
| **On the menu** | The strip of dishes on the home page, those with photos first |
| **Menu sections** | The restaurant's menu categories, as tiles on the home page and a list beside the menu |
| **Search the menu** | Find a dish by its name or description |
| **Visit us** | The address, today's hours, the phone and a link to the map |
| **Open in Maps** | Opens the address in Google Maps |
| **Pay at the counter** | No online payment: the guest pays when they collect, by the QR code at the counter, card or cash |
| **No advance payment** | A booking takes no deposit |
| **Takeaway token** | The order's reference, shown large on the status page, to show at the counter |
| **Order chit** | The order's lines and estimated bill total, on the details step |
| **Note to the kitchen** | The one-tap requests and the note on a dish |
| **Celebrating something?** | The optional occasion on a booking, sent in its note |
| **Booking advance** | The deposit on the public page, in the words guests know: the deposit per person × the party, paid online when booking |

---

## 26. Recall and undo words

Added by P41.

| Term | Meaning |
|---|---|
| **Recall** | On the kitchen screen: bring a finished ticket back to the board, its dishes back to Cooking |
| **Finished** | A ticket whose dishes are all ready, listed under Recall for 60 minutes |
| **Undo** | On the order screen, for 60 seconds after Send to kitchen: take that Send back. The dishes leave the kitchen and are on the order again, not sent. |
| **Sent to the kitchen by mistake** | The cancel reason an Undo writes on the dishes it took back |

---

## 27. Changing a sent dish

Added by P42.

| Term | Meaning |
|---|---|
| **Change** | On a sent dish: lower its quantity, change its note, remove it or swap it |
| **Remove dish** | Take a sent dish off the order and the kitchen ticket |
| **Swap for another dish** | Remove a sent dish and pick its replacement, which goes to the kitchen |
| **Changed** | On a kitchen ticket: the dish's quantity or note changed after it was sent |
| **Already made** | A dish the kitchen has marked ready. Changing it needs a reason, and a manager's PIN for a cashier or captain. |

---

## 28. Other payment words

Added by P43.

| Term | Meaning |
|---|---|
| **Other** | The built-in payment method for a way of paying the restaurant has no method for. Switched off until the owner switches it on. |
| **Mode of payment** | On an Other payment, how it was paid: Cheque, Bank transfer, Wallet, Coupon, or what the cashier types. Stored as the payment's reference. |

---

## 29. Words in the day-end message

Added by P44. The message keeps the words Z Chaat's manager already sends each
night, as the thermal bill keeps its old words (section 19). Screens and
reports keep the terms above.

| Message word | Our term |
|---|---|
| **Gross Sale** | Bill total |
| **Tax** | GST |
| **Net Sale** | Net sales |
| **Due payment** | On Hold plus unpaid |
| **Total exp** | Expenses |
| **Today APC** | Average per cover |
| **Today Pax** | Covers |
| **Grand Total Cash in hand** | Counted cash once closed, else cash in drawer |
| **Total Petty Cash** | Kept for tomorrow once closed, else cash in drawer |
| **Occupancy** | Covers against the seats of active tables |
| **Monthly Till Date sale** | Bill total from the 1st of the month to the date |
| **Daily Average** | Monthly Till Date over the days from the 1st to the date |

Screen words added by P44:

| Term | Meaning |
|---|---|
| **Day End** | The page that walks through the day: Overview, Cash, Close |
| **Day-end message** | The day's figures as text, to copy or email |
| **Email this report** | Send the day-end message to the addresses in Settings |
| **Day-end email addresses** | Who gets the day-end message, set by the owner |

---

## 30. Kitchen bell words

Added by P45.

| Term | Meaning |
|---|---|
| **Sound on / Sound off** | On the kitchen screen: whether this device rings for a new ticket |
| **Tap anywhere to turn on the sound** | Shown until the first tap, which browsers need before any sound |

---

## 31. Open item words

Added by P46.

| Term | Meaning |
|---|---|
| **Open item** | A dish on the menu whose name and price staff type when ordering, for anything not on the menu |
| **Type name and price** | An open item's card on the order screen |

---

## 32. Other modes

Added by P47.

| Term | Meaning |
|---|---|
| **Other modes** | The ways of paying the payment screen offers one tap each under Other, kept by the owner in Settings |
| **Swiggy Dineout, Zomato Dineout, EazyDiner** | Dine-in bills paid through those apps; recorded as Other with that mode |

---

## 33. PetPooja's words on the floor and at the counter

Added by P48.

| Term | Meaning |
|---|---|
| **Blank table** | Free |
| **Running KOT table** | A table whose food is with the kitchen |
| **Running table** | A table whose food is served |
| **Printed table** | A table whose bill is printed |
| **Bill No** | The box in the top bar that opens a bill by its number |
| **History** | The 👁 on a table: what it has had today, read-only |
| **Guest gave** | On a cash payment: the notes the guest handed over |
| **Give back** | The change to return, and the notes to return it in |
| **Extra** | A typed add-on with its own price, on one dish |
| **KOT & Print** | Send to the kitchen and print the KOT |
| **Save & Print** | Make the bill and print it |

---

## 34. Closing a table opened by mistake

Added by P50.

| Term | Meaning |
|---|---|
| **Close table** | On an order nothing has been sent from: close it because it was opened by mistake. No reason, no PIN, and it counts nowhere. **Close order** for a takeaway or delivery. |
| **Opened by mistake** | The code a closed order keeps, so the order is never deleted |


---

## 35. Messaging words

Added by P37.

| Term | Meaning |
|---|---|
| **WhatsApp** | The restaurant's own WhatsApp Business number, connected in Integrations |
| **Template** | A message Meta has to approve before it can be sent to a guest who has not just written to the restaurant. Each has our name for it, like Bill receipt |
| **Utility** | A template about something the guest did, like their bill. About ₹0.145 a message. Never needs offers consent |
| **Marketing** | A template that promotes something, like an offer. About ₹1.09 a message. Only to guests who agreed to offers |
| **Approval state** | Where Meta's review of a template stands: Draft, Waiting for Meta, Approved, Rejected, Paused or Switched off |
| **Approved as** | The category Meta approved a template in, which can differ from the one asked for. Costs follow it |
| **Opt-out** | The guest replied STOP: offers stop at once; bills continue |
| **Delivery receipt** | Meta telling us a message was sent, delivered, read, or failed |
| **Service window** | The 24 hours after a guest writes to the restaurant, when a plain reply needs no template |
| **Send the bill on WhatsApp** | The setting that sends a guest their bill when it is paid |

---

## 36. Assistant words

Added by P51.

| Term | Meaning |
|---|---|
| **Assistant** | The automated WhatsApp assistant that answers guests from the restaurant's own data |
| **Chat** | One guest's WhatsApp conversation with the restaurant |
| **Chats** | The screen where staff read and answer chats |
| **Needs a person** | A chat the assistant handed over, waiting for staff |
| **With staff** | A chat a person has replied to; the assistant stays quiet until it is handed back |
| **Hand back** | Give a chat back to the assistant |
| **Stop offers** | The guest wants no promotions. Bills and booking messages still go |
| **Stop all messages** | The guest wants nothing from the restaurant on WhatsApp, bills included |
| **Fixed menu** | The three buttons a guest gets when no AI key is on or the assistant is out of its daily limit. With the assistant off, nothing is sent |
| **AI key** | The key to Anthropic, Groq or Gemini the assistant uses |
| **Window open** | The guest wrote in the last 24 hours, so staff can reply freely |
| **Window closed** | The guest last wrote more than 24 hours ago; WhatsApp allows no free reply, so staff call instead |

---

## 37. Backup words

Added by P54.

| Term | Meaning |
|---|---|
| **Backup** | A copy of the whole database kept outside it, in Backblaze B2, encrypted |
| **Full copy** | The whole database at one moment: every 6 hours, or once a day when the database is large |
| **Change diary** | Every change to the database, saved every 5 minutes, kept forever |
| **Restore** | Rebuild the database as it was at a chosen minute, from a full copy and the change diary, into a new empty database |
| **Practice restore** | A restore every Sunday on GitHub into a throwaway database, to prove the backups work |
| **Backed up** | How long ago the last change was saved, like "Backed up 3 minutes ago" |
---

## 38. The owner's dashboard

Added by P55. Words on the owner's dashboard; every figure on it keeps its word above.

| Term | Meaning |
|---|---|
| **Where the sales came from** | The day's bill total by order type, and delivery by platform |
| **Where the money went** | How the day's bills were settled: each payment method, On Hold and Unpaid |
| **By hour** | Net sales in each hour of the day, India time |
| **Busiest** | The hour with the most net sales |
| **Watch list** | The day's controls: discounts, voided bills, No Charge, orders cancelled. P56 took items cancelled and wasted value off it |
| **Figures to** | The time the figures were read, while the day is open |
| **Dashboard** | The owner's page of the day's important figures, outside the ERP |
| **Open the ERP** | From the dashboard into everything else: floor, bills, reports, settings |
| **% of total** | On the dashboard, a row's bill total against the day's, in whole percents adding up to 100 |
| **Cancelled after preparation** | On the watch list, the wasted value: items the kitchen had made, at menu price, before GST |

---

## 39. Order note and guest details

Added by P56.

| Term | Meaning |
|---|---|
| **Note for all dishes** | One instruction for every dish on the order, like "Less spicy". Printed at the top of every KOT as "FOR ALL ITEMS". |
| **FOR ALL ITEMS** | The printed KOT's word for the note for all dishes |
| **Guest details** | The guest's name, mobile and their yes to offers, asked on a table's first Send to the kitchen |
| **Save and send** | Keep the guest's details and send the dishes to the kitchen |
| **Skip, send without details** | Send the dishes without the guest's details |
| **Voided to change items** | A bill voided only so its items could change after billing, and billed again. Not a voided bill on any list; its numbers stay in the invoice register. |

---

## 40. The bill in one place

Added by P57.

| Term | Meaning |
|---|---|
| **Bill** | On a served order, the box under the dishes: the discount, the totals and Save, before the bill is made |
| **Add discount** | Choose a discount before the bill is made. Nothing is saved until Save. |
| **Save** | Make the bill, print nothing |
| **Save & Print** | Make the bill and print it (P48's word, now on every served order) |

---

## 41. Kitchen tickets without stations

Added by P58.

| Term | Meaning |
|---|---|
| **A separate ticket for each station** | The setting `kitchen.splitTicketsByStation`. Off: each Send to the kitchen is one ticket with every dish on it, headed KITCHEN; the next Send from the same table is a new ticket with a new KOT number |

---

## 42. Signing in and out

Added 2026-10-19, for the livelier sign-in screen and the account menu.

| Term | Meaning |
|---|---|
| **Good morning, Good afternoon, Good evening, Working late** | The sign-in greeting, by the hour in India: from 5 AM, noon, 5 PM and 11 PM |
| **Show password, Hide** | Shows the password as typed, or hides it again |
| **Caps Lock is on** | The keyboard's Caps Lock is on while the password is typed |
| **Account** | The person's initials in the top bar; it opens their name, role, This device and Sign out |
| **Hold to sign out** | Sign out is pressed and held, so a stray tap on a shared device never signs anyone out. From the keyboard it asks "Sign out now?" instead |
| **Signed out** | Shown once on the sign-in screen after someone signs out on this device: "Abhay, you are signed out. See you next shift." |

---

## 43. Printing at the counter and guests at the Send

Added by P59.

| Term | Meaning |
|---|---|
| **Sent to the counter** | On a captain's bill: the request is waiting for the counter's printer. Tapping again sends nothing more |
| **How many guests?** | On the Guest details sheet, at a table's first Send. The count becomes the order's covers |
| **Small tiles, Big tiles** | On the kitchen screen: small, narrower tickets so more fit in a rush, or the full size. Kept on each device |

---

## 44. Bill without KOT

Added by P60.

| Term | Meaning |
|---|---|
| **Bill without KOT** | On the order screen, for the counter: make the bill for dishes not yet sent, without a KOT. The dishes count as served; nothing goes to the kitchen |

---

## 45. A simple Day Close

Added by P61.

| Term | Meaning |
|---|---|
| **Before you close** | On Day End: what stops the day closing, each with Open |
| **Closes by itself** | An order nothing was sent from: Day Close closes it, opened by mistake, and it counts nowhere |
| **Cash in the drawer** | On Day End: the cash counted at close (counted cash) |
| **Taking cash out of the drawer?** | Optional at close: keep some for tomorrow and say where the rest went. Without it, everything counted stays as tomorrow's float |
| **Day's details** | The day's full figures, the cash flow and the day-end message, under the close |

---

## 46. Two-way sync

Added by P63.

| Term | Meaning |
|---|---|
| **Two-way sync** | The cafe PC and the website both take orders and bills, and each gets the other's within seconds while the internet is up |
| **Website series** | The bill numbers the website uses while two-way sync is on: `2026-27/W00001` |
| **Sync conflict** | The same thing changed on the cafe PC and on the website before they could tell each other, or the same table, bill or name taken on both. Listed for the owner and manager |
| **Kept from** | Which side's version a sync conflict kept: the cafe PC or the website |
| **Mark as seen** | A person has read a sync conflict and dealt with it |
| **Close the day on the cafe PC** | While two-way sync is on, only the PC closes the day |

---

## 48. Invoice themes and printed fields

Added by P64. Printed words on the full-page invoice and the screens that set it up.

| Term | Meaning |
|---|---|
| **Invoice theme** | How the full-page tax invoice is laid out: Classic, GST detailed, Modern or Compact. Every figure is the same on all four |
| **Classic** | The full-page invoice as it printed before P64 |
| **GST detailed** | The theme with an HSN or SAC column, a rate summary, the amount in words, the declaration and a signature line |
| **Modern** | Classic with a band in the restaurant's accent and lighter rules |
| **Compact** | A tighter layout for A5 paper, with the same content |
| **HSN/SAC** | The code a line is classified under for GST. A dish with no code of its own prints the restaurant's default SAC, 996331, restaurant service |
| **Default SAC code** | The code printed for any dish without one of its own |
| **Amount in words** | The bill total spelled in rupees and paise, in lakh and crore |
| **Declaration** | The printed line that the invoice shows the actual price and the particulars are true and correct |
| **Authorised signatory** | The words under the signature line, beside the restaurant's legal name |
| **Signature image** | The owner's signature, uploaded once and printed above the signature line |
| **Terms and conditions** | The restaurant's own text printed at the foot of the full-page invoice |
| **PAN** | The restaurant's Permanent Account Number |
| **Udyam number** | The restaurant's MSME registration number |
| **Account balance** | On an On Hold bill: what the account owes in all, now (its outstanding) |
| **Original for recipient** | The copy marking on the guest's copy of a full-page invoice (CGST Rule 48(2)) |
| **Duplicate for supplier** | The copy marking on the restaurant's own copy |
| **Use the accent colour** | Draw the full-page invoice's band and rules in the accent chosen on Appearance |
| **Invoice settings** | The tab for the full-page invoice: the theme and what it shows |
| **Print settings** | The tab that previews the invoice on A4 or A5 and chooses the copy |
| **Thermal settings** | The tab for what the thermal roll shows |
| **Invoice layout** | The settings screen for the three tabs above |
| **Invoice date** | The date the bill was issued, printed when Time issued is off |
| **Guest** | On the full page: the guest's name, when its switch is on |
| **Mobile** | On the full page: the last four digits of the guest's mobile, as XXXXXX1234 |
| **Tax summary** | On GST detailed: each rate's net sales, and its CGST and SGST rate and amount |
| **CGST rate, SGST rate** | Half the GST rate each, like 2.5% on a 5% dish |

---

## 49. The CA's month

Added by P65.

| Term | Meaning |
|---|---|
| **CA reports** | The settings screen that sends the month to the restaurant's chartered accountant |
| **CA pack** | One workbook for a month of closed days: rate-wise sales, HSN and SAC summary, the document series, money received, On Hold, cash and the checks |
| **CA's email** | Where the pack is sent on the 1st of every month |
| **Send now** | Send a month's pack straight away, even one already sent |
| **Sent** | The pack reached the email service |
| **Refused** | Not sent, because a day of the month is open, a check failed, or this copy has not received the month yet. Tried again later |
| **Failed** | The email service refused it. Tried again within the hour |
| **Outward supplies** | The month's sales, by tax rate |
| **HSN and SAC summary** | Net sales and tax by the code on each line |
| **Not recorded** | A line from before HSN codes were kept, or before line shares |
| **Document series** | Every invoice number in the month, in order, voided ones included |
| **On Hold movement** | Each account's opening, charged, collected, adjusted and closing balance for the month |
| **Bank deposit** | Cash taken to the bank: a contra entry, not an expense |
| **Drawings** | Cash taken by the owner |
| **Code** | An HSN or SAC code, on the summary |
| **Line** | One line of the pack's cover, money or checks |
| **Detail** | What a line of the cover says |
| **Opening** | An account's balance at the start of the month |
| **Closing** | An account's balance at the end of the month |
| **Adjusted** | Adjustments to an account in the month, up or down |
