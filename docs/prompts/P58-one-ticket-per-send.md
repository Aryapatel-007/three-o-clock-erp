# P58 One kitchen ticket per Send, not per station

Model: Opus, high. Owner: Arya (M18). Depends on: P36, P41, P48.

Asked for by Arya on 2026-10-17, for Z Chaat: "we don't need sections like
Chaat Counter, Beverages, only table wise", and "when table 9 gave 3 orders,
sent to kitchen, then again after some time 2 new orders from the same table,
both should have different KOTs, not the same".

## 1. What is wrong today

Z Chaat runs with `kitchen.oneTicketPerOrder` off (P48), so every Send makes
new tickets, which is right. But it still makes one ticket per station (P05):
on 17 October Table 2's one Send at 7:46 PM became KOT 204 (Chaat Counter) and
KOT 205 (Kitchen). The kitchen wants one ticket for that Send, with every dish
on it, and the station chips on the kitchen screen gone.

## 2. What to build

A. Spec first: API-CONTRACT "P58", DB-SCHEMA section 58, GLOSSARY section 41,
   this file in the prompts README and the build plan.

B. `settings.kitchen.splitTicketsByStation`, Boolean, default `true`, in the
   kitchen group of `GET` and `PATCH /settings`, OWNER to change, with the usual
   reason and audit line. Default on, so every restaurant fires exactly as
   before until its owner switches it off. `/auth/me` `kitchen` carries it,
   because the kitchen login cannot read `GET /settings`.

C. Firing (`kitchenService.fireOrder`). With the setting off:
   1. With `oneTicketPerOrder` off, a Send makes one new ticket, with a new KOT
      number, holding every pending dish. The next Send makes the next ticket.
   2. With `oneTicketPerOrder` on, P36 is unchanged: the order's one ticket.
   3. Either way the ticket's own `stationId` and `stationName` are null, so the
      printed ticket's heading is KITCHEN and no station name shows.
   4. Every ticket line still freezes the station that makes it (P36), so R13's
      kitchen time by station keeps working.
   With the setting on, nothing changes.

D. The kitchen screen. With the setting off: no station chips; every ticket is
   shown whole, whatever station the device or the signed-in user has saved
   (kept, not erased, so switching the setting back restores it); holding a
   ticket marks every dish on it; Recall lists whole tickets; and auto-print
   prints each new ticket, every dish, without needing a station chosen. Only
   one device in the kitchen should auto-print, or each prints every ticket.
   With the setting on, nothing changes.

E. Settings, Kitchen: a checkbox "A separate ticket for each station", with the
   hint saying what off does.

F. Tests: off, one Send across three stations is one ticket with three lines,
   a station-less heading, and each line's station; a second Send is a second
   ticket with the next number; on, P05's per-station tickets are unchanged;
   `/auth/me` carries the setting; the settings default. Break the rule on
   purpose and watch the test fail. A browser test: the kitchen screen with
   the setting off shows no station chips and one ticket per Send.

G. Not done here: switching Z Chaat's setting. That is a production change for
   Z Chaat's owner, in Settings, Kitchen, once this is deployed.

## 3. How to know it is finished

The tests in F and the whole server suite pass, with counts before and after;
lint and build pass; the kitchen specs and the golden day pass in `npm run
e2e`; PROJECT-STATE has the entry and a decision log row. Nothing is pushed
without Arya's word.
