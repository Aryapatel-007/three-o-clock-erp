# P57 The bill in one place: review, discount, then Save or Save & Print

**Asked for by:** Rishi, 2026-10-17, with a photo of PetPooja's billing screen: "after all the food is served and when we are doing the bill this order it prints the bill but what if we have to do the discount and remove or review the order then do the bill ... in this everything is in the one place so according to this make the process simple and easy".
**Modules:** M3, M2.
**Depends on:** P29 (print before payment), P42 (changing a sent dish), P48 (the counter screen).

## Why

Today a served table is billed with one button, **Bill this order**. It makes the bill straight away, and on a counter with "Print the bill as soon as it is made" switched on it prints straight away too. A discount, a removed dish or a second look all come after, on a bill that already has its number and is often already in the guest's hand, so changing it needs the manager's PIN and a second print.

PetPooja keeps everything on one screen until the cashier says so: the dishes with their quantities, the discount, the total, and then **Save** or **Save & Print**. Nothing is made or printed before that.

## A. One request makes the bill with its discount, and a preview shows its numbers

1. `POST /bills` takes an optional `discount`, the same body as `POST /bills/:billId/discount` (`kind`, `valueInPaise` or `rateBps`, `reasonCode`, `note`, `fundedBy`), and applies it to the new bill inside the same transaction. The same people may give it as on the bill (`assertCanDiscount`): the owner and a manager, and a cashier only a platform discount when the owner allows it. A flat discount larger than the item total is refused, as on the bill. The audit line is the same `DISCOUNT_APPLIED`, written once the bill is saved.
2. An order reopened from a bill (P26) already carries that bill's discount and payments, so `discount` on it is 422: change the discount on the new bill.
3. `preview: true` runs the whole bill inside its transaction and rolls it back. Nothing is written: no bill, no number used, no audit line, no announcement to other screens. The answer is the bill as it would be, with `preview: true` and `billNumber: null`. The till uses it to show the guest's total, GST and round-off before anything is saved, so no money or tax arithmetic happens on the device.

## B. The order screen, once every dish is served

1. **Bill this order** in the header goes. In its place, under the order's dishes, the **Bill** box:
   - **Discount**: Add discount opens the same discount sheet as the bill. Once chosen it reads "10% · Regular guest" with Change and Remove. Nothing is saved yet. Shown only to those who may discount.
   - The totals, from the preview: Item total, Discount, CGST and SGST by rate, Round-off, **Bill total**. They follow every change to the dishes or the discount.
   - **Save**: make the bill, print nothing, open it.
   - **Save & Print**: make the bill and print it on this device, then open it, where the payment is asked next (P29). A captain's Save & Print sends it to the counter's printer instead (P25 Part D).
2. The dishes above stay changeable until Save: lower a quantity, remove a dish or swap it through Change (P42), and add more through Add more dishes (P26). The PIN rules for a dish the kitchen made are unchanged.
3. Once the bill exists the order screen shows **Open bill**, as before, and the bill screen keeps its own Discount, Remove and Add to this bill for anything later.
4. This device's "Print the bill as soon as it is made" goes: Save and Save & Print say which, every time.

## Tests

Server, `server/tests/billInOnePlace.test.js`:
1. A preview of a served order answers the bill's totals with `billNumber: null`; afterwards there is no bill, the order has no `billId`, its version is unchanged, the counter is unchanged (the next real bill is `000001`), and no audit line was written.
2. A preview with a 10% discount answers the same totals as creating the bill and then discounting it.
3. Creating with a discount saves the bill with the discount, `appliedBy` the person, and one `DISCOUNT_APPLIED` line; its totals equal create then discount.
4. Refusals: a cashier giving a restaurant discount (403), a captain giving any (403), a flat discount above the item total (422), a discount on a reopened order (422), a preview on a stale version (409), another restaurant's order (404).

Browser, `e2e/billInOnePlace.spec.js`: a manager on the counter computer opens a served table, sees the Bill box with its total, adds a 10% discount and sees the total fall before saving, then Save & Print: one print, the bill shows the discount and asks for the payment.
