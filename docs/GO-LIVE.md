# Go-Live

How Caffeza moves from their current POS to ours, without a bad Saturday.
Start this after prompt P21 passes.

---

## 1. Gates before the first real bill

Every gate must be true. None of them can be closed by code alone.

| # | Gate | How to prove it | Who |
|---|---|---|---|
| 1 | The golden day passes end to end | P21 is green on the release being deployed | Arya |
| 2 | Their CA has signed off on GST | A printed sample bill covering 5%, a discount, an MRP item and a platform delivery order at 0%, plus written answers to the CA questions in `docs/clients/zchaat/PROFILE.md` section 15 | Arya, with the owner |
| 3 | The bill prints properly on their printer | Printed on their actual model, at their paper width, with the longest item name on the menu, "Grilled Tofu Cream Cheese Avocado Focaccia Bagel", wrapping without pushing the amounts out of line | Rishi |
| 4 | Stations get their tickets | A test order on staging reaches Live Kitchen and Beverages on their own tablets, and prints if they chose paper | Arya |
| 5 | Staff have practised on staging | Every captain, cashier and station has done the training in section 2 | Both |
| 6 | The restore drill has been done | `docs/DEPLOYMENT.md` section 8, with the date recorded | Arya |
| 7 | The backup internet works | Main line unplugged during a test bill, and the bill still completed | Rishi |
| 8 | The owner has checked the menu | Every item and price on staging, signed off in writing | Owner |
| 9 | Every staff login works | Each person has signed in once, on their own device | Both |
| 10 | On Hold opening balances are agreed | A written list from the owner of what each account owes | Owner |
| 11 | Monitoring is on | The uptime alert has been tested by stopping staging once | Arya |
| 12 | Support is arranged | The support card is at the counter | Both |

---

## 2. Training

All training happens on staging, never on production.
Each role gets a one-page cheat sheet, printed and laminated, in the language that role prefers.

| Role | Length | What they practise |
|---|---|---|
| Captain | 30 minutes | Open a table and enter the covers. Add items, variants and notes. Send the KOT. Cancel an item with a reason. Move a table. |
| Station | 15 minutes | Their station screen. Mark an item or a ticket ready. Reprint a ticket if they use paper. |
| Cashier | 45 minutes | Bill a table. Split a payment. Take a Zomato Gold, Dineout or EazyDiner payment. Enter a delivery order. Charge a bill to an On Hold account. Reprint a bill. |
| Manager | 45 minutes | Apply a discount. Approve No Charge and voids. Record a cash paid out. Do Day Close with the blind cash count. Read R2 Day Close. |
| Owner | 30 minutes | Read every report. Click any number through to its bills. Export to Excel. Read the activity log. Change a setting. Choose the accent colour and Today tiles on the Appearance page. Check the logo, brand colours and warm look on the Appearance page. |

---

## 3. The parallel run, done the light way

Running both systems in full means every order is entered twice.
At 180 bills a day, staff will not do that for two weeks, and they should not have to.

So the comparison is done in three stages instead.

**Stage 1. Shadow check, on staging.**
On one or two weekday afternoons, a developer takes about 30 real bills from their current system and enters the same orders into staging.
Compare each bill total.
Final totals must match.
Tax may differ by one paisa on a discounted bill, depending on the CA's answer about rounding.
Run `npm run e2e` on the release candidate before each pilot day.

**Stage 2. Pilot days.**
Pick a slow weekday, like a Tuesday.
Use our system for the whole day. Keep the old one open and ready, but unused.
At the end of the day, compare our Day Close with the real money, not with their old reports, which have known errors:

| Our figure | Compare with |
|---|---|
| Counted cash against expected cash | The cash in the drawer |
| Card | The card machine's settlement report |
| UPI | The bank statement |
| Zomato Gold, Dineout, EazyDiner | Each platform's own app or dashboard |
| Zomato and Swiggy delivery | The platform partner apps |

Do two pilot days.
If both balance, or every difference has a known reason, move on.

**Stage 3. Full use, with the old system on standby.**
Switch over for good.
Keep the old system installed and ready for 14 days, as a fallback.

A comparison sheet for every pilot and standby day:

| Date | Bill total | Cash expected | Cash counted | Card, ours | Card, machine | UPI, ours | UPI, bank | Platform, ours | Platform, apps | Differences explained |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

---

## 4. Cutover day

Do these in this order.

1. Before cutover, run the menu import again with Caffeza's final menu, as a dry run, and read the summary.
2. After the last bill on the old system, write down its invoice number, and take a photo of the screen showing it.
3. In our settings, set the invoice prefix, and set the starting number to that number plus one.
4. Enter the On Hold opening balances from gate 10.
5. Count the opening float, and enter it.
6. Every captain signs in on their own device.
7. Print the first real bill, and check it: invoice number, GSTIN, FSSAI number, tax lines, total.
8. A developer stays on site for the whole first day, and again for the first Friday, Saturday and Sunday.

---

## 5. The first two weeks

Every day:
Day Close is done.
Every check is green, or explained.
Any cash difference has a written reason.

Every morning:
A ten-minute call with the manager about the day before.

Every problem, however small, goes into the known problems table in `docs/PROJECT-STATE.md` the same day.

---

## 6. Going back, if we must

Switch back to the old system, or to the paper fallback in `docs/DEPLOYMENT.md` section 11, if any of these happens:

1. Billing is impossible for more than 15 minutes during service.
2. A printed bill shows a wrong total.
3. Any data is lost.

Bills already created in our system stay there. Nothing is deleted.
Decide the next step the following morning, with the owner.

---

## 7. Sign-off

After 14 days of full use, the owner signs a short note confirming:

1. The Day Close figures matched the real money on every day, or every difference was explained.
2. The list of open issues, with an agreed date for each.
3. The support arrangement from here on.

Keep the signed note with the project records.
