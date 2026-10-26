# P60 Bill without KOT

Model: Opus, high. Owner: Rishi (M3, M2). Depends on: P57, P59.

Asked for by Rishi on 2026-10-21: the cashier, manager or owner wants to make
the bill without sending the order to the kitchen, because the order is
already known and the guest is to be given the bill first. His answers: the
dishes never go to the kitchen (they count as served at once); offered on
tables and takeaway, for the counter only.

## 1. What is wrong today

A bill can only be made once every dish has been sent to the kitchen and
served (`assertOrderIsBillable` wants `READY_TO_BILL`). For a guest whose order
the kitchen already has, or for items that need no cooking, the counter has to
send a KOT nobody needs and tick it ready before the bill exists.

## 2. What to build

A. Spec first: API-CONTRACT "P60", DB-SCHEMA section 59, GLOSSARY section 44,
   this file in the prompts README and the build plan.

B. Server: `POST /bills` takes `withoutKot`. In the bill's transaction the
   not-sent lines become served with `billedWithoutKot`, the order becomes
   ready to bill, stock is deducted as a Send would, then the bill is made.
   Captains are refused; platform and delivery orders are refused; a dish with
   the kitchen is refused; `requireGuestCount` applies as at the first Send.

C. Order screen: **Bill without KOT** beside Send for the counter roles, which
   opens the Bill box with `withoutKot` (preview, discount, Save, Save & Print).
   A table's first time asks the Guest details sheet first.

## 3. Tests

Server: a cashier bills a table without a KOT (no KOT exists, lines served and
marked, bill lines marked, order ready to bill, totals as a normal bill); a
preview changes nothing; a captain is 403; a delivery order and a dish with the
kitchen are 422; stock deducted once; a stale version 409. Browser: a cashier
on the counter computer adds dishes to a table, taps Bill without KOT, Save &
Print prints the bill, and the kitchen screen shows no ticket.
