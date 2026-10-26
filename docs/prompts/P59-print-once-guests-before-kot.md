# P59 A captain's bill prints once, and the guest count moves to the first Send

Model: Opus, high. Owner: Rishi (M3, M2). Depends on: P25 Part D, P56, P57.

Asked for by Rishi on 2026-10-21: "when the captain clicks Print at counter the
bill prints twice", and "shift the number of guests to the guest name and
number screen, before the captain sends the KOT".

## 1. What is wrong today

Read from Z Chaat's live bills on 2026-10-21: of 88 bills a captain sent to the
counter, 37 were printed two or more times, the second print recorded 1 to 4
seconds after the first. The lock of 2026-10-19 keeps two tabs of one Chrome
profile from both printing; it cannot see a second profile (the silent-printing
launcher keeps its own) or a second device with "Print bills sent by captains"
on. A captain tapping Print at counter again while the first request waited
also stamped a new request time, which the counter took as a new request.

Seating a table asks for the guests before the order opens; the guest's name and
mobile are asked on the first Send (P56). Captains want both on one screen, at
the Send.

## 2. What to build

A. Spec first: API-CONTRACT "P59", GLOSSARY section 43, this file in the
   prompts README and the build plan.

B. Server. `requestPrint` keeps a waiting request's time. `markPrinted` takes
   `forRequestAt` and records the print only when that request is still the
   one waiting, else 409 `DUPLICATE`.

C. Counter (`CaptainBillPrinter`, `printBill`): read the invoice data, claim
   the request, print only when the claim answers 200.

D. Captain's bill screen: "Sent to the counter" in place of Print at counter
   while their request waits.

E. Guests. `PATCH /orders/:orderId/customer` takes `guestCount` on a dine-in
   order. `requireGuestCount` is checked on the first Send, not on opening.
   Tapping a free table opens the order at once (a booking soon still offers
   to seat it). The Guest details sheet asks "How many guests?" first.

## 3. Tests

Server: two devices claiming one request, one wins and the other gets 409 with
the count unchanged; a second print request while one waits keeps its time;
a print request after a print is a new request; `guestCount` set through the
customer endpoint, refused on a takeaway; with `requireGuestCount` on, opening
without guests works and the first Send without guests is refused, the second
is not. Browser: the captain billing spec, with two counter devices, prints
once; the guest count is chosen on the Guest details sheet.
