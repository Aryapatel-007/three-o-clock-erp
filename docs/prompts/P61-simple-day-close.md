# P61 A simple Day Close

Model: Opus, high. Owner: Rishi (M16). Depends on: P29, P44, P50, P59.

Asked for by Rishi on 2026-10-21: "make Day Close simple for the manager, the
owner and the cashier. When they close the day, the orders they have not
punched are open. Keep Day Close very simple and easy, not such a complex
process."

## 1. What is wrong today

1. Read from live Z Chaat on 2026-10-21 (read only): order 188 on Table 4,
   opened at 2:04 PM, no dishes, nothing sent, was the only open order, and it
   alone refused Day Close. P59 opens a free table on one tap, so a stray tap
   leaves an empty open order. Orders with dishes never sent block the same way.
2. Day End is three tabs (Overview, Cash, Close), then a sheet with three more
   steps (count, keep for tomorrow, where the rest goes). The cashier cannot
   close at all.

## 2. What to build

A. Spec first: API-CONTRACT "P61", GLOSSARY section 45, this file in the
   prompts README and the build plan.

B. Server: orders nothing was sent from are listed as `closesOnClose`, not
   blockers, and closed as opened by mistake inside the Day Close transaction.
   The cashier may close, always blind.

C. Screen: one Day End page, as API-CONTRACT P61 section 3. A table left with
   no dishes is also closed when the person leaves its order screen.

## 3. Tests

Server: an empty order and an order with a dish not sent do not block; closing
cancels both as opened by mistake and leaves R15 and the day's figures as they
were; an order with a dish sent still blocks; a cashier closes, blind (no
expected cash or difference in the answer). Browser: the cashier closes a day
with a stray empty table in one screen.
