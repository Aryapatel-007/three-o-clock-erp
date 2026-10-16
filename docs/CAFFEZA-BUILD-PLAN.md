# Caffeza Build Plan

Written for Cafezza, the first client, and kept as the history of P00 to P24.
The live client is now Z Chaat: see `docs/archive/zchaat/PROFILE.md`.

This file is the plan for taking the existing ERP live at Caffeza, our first paying client.
It sits next to `docs/BUILD-PLAN.md`, it does not replace it.
`docs/BUILD-PLAN.md` still describes the whole product.
This file says what Caffeza needs from it, in what order, and who builds each part.

Read `docs/archive/caffeza/CAFFEZA-PROFILE.md` for who the client was.
Read `docs/CURRENT-STATE-AUDIT.md` for what already exists.

---

## 1. The goal

Replace Caffeza's current POS with ours.
Keep it as simple to use as theirs.
Make the reports impossible to get wrong.

Go-live means:
Captains take orders on their phones or tablets.
Kitchen stations get their tickets.
The cashier bills, takes every payment method they use today, handles No Charge and On Hold.
The manager closes the day with a cash count.
The owner reads reports that always balance, and exports them for the accountant.

---

## 2. Module numbers

The repo's numbers stay as they are.
`docs/BUILD-PLAN.md` section 5 already defines M7 to M15.
So Caffeza work reuses M8 and M10, where they already cover what Caffeza needs, and new modules start at M16.

| ID | Module | Status | What Caffeza needs from it |
|---|---|---|---|
| M0 | Foundation | Done | Trust the host's proxy |
| M1 | Menu Management | Done | Bulk import of their menu |
| M2 | Order Taking and KOT | Done | Fixed cancel reasons, the variant availability check |
| M3 | Billing with GST | Done, CA review pending | Invoice prefix and starting number, frozen captain, covers and category, line shares |
| M4 | Inventory | Built | Switched off for go-live |
| M5 | Attendance | Done | Switched off for go-live |
| M6 | Reports and Dashboard | Built | The base that M19 extends |
| M7 | Restaurant Settings | Done | Feature switches and new setting groups |
| M8 | Audit Trail | Specified, not built | Pulled forward. Built exactly as specified, plus the new actions in section 6. |
| M10 | Payments | Not started | Pulled forward with an adjusted scope: configurable payment methods including platforms. No UPI QR for go-live. |
| M16 | Settlement and Day Close | New | No Charge, On Hold accounts, cash drawer, Day Close |
| M17 | Delivery and Platform Orders | New | Delivery order type, platform fields, 0% tax on platform orders, entered by hand |
| M18 | Kitchen Stations | New | Stations, category routing, one KOT per station |
| M19 | Reports v2 | New | Every report in `docs/REPORT-SPEC.md` |
| M20 | Floor Plan and Look | New | Areas, a visual table layout, themes, the visual refresh |
| M21 | Integrations | New in P25 | A product module, not a client module: Swiggy and Zomato orders, Pine Labs card machines and Tally, for any restaurant |

Deferred until after Caffeza is live, exactly as `docs/BUILD-PLAN.md` describes them:
M9 Purchase Orders, M11 Payroll, M12 Employee Self-Service, M13 Company Finance Dashboard, M14 Online Ordering, M15 AI Service.

Phase 2 work from `docs/BUILD-PLAN.md` section 7 is also required before go-live.
For Caffeza it becomes prompts P01, P05, P11 and P12, plus the checklist in `docs/GO-LIVE.md`.

---

## 3. The prompts, in order

Every prompt lives in `docs/prompts/`.
Paste one into Claude Code, or into Antigravity, per session.
Each prompt names its model at the top.

| Prompt | Title | Module | Depends on | Suggested owner | Model |
|---|---|---|---|---|---|
| P00 | Adopt the Caffeza docs | Docs only | Nothing | Arya | Sonnet, medium |
| P01 | Production safety | Phase 2 | P00 | Rishi | Opus, high |
| P02 | Settings: feature switches and invoice series | M7 | P01 | Rishi | Sonnet, medium |
| P03 | Bill snapshots and line shares | M3 | P02 | Rishi | Opus, high |
| P04 | Cancel reasons and variant check | M2 | P01 | Rishi | Sonnet, medium |
| P05 | Kitchen stations and printing | M18, Phase 2 printing | P01 | Arya | Opus, high |
| P06 | Delivery and platform orders | M17 | P03 | Arya | Opus, high |
| P07 | Settlement spec | M10, M16 | P03, P06 | Rishi | Opus, high |
| P08 | Payment methods, discount reasons and No Charge | M10, M16 | P07 | Rishi | Opus, high |
| P09 | On Hold accounts and platform payouts | M16 | P08 | Rishi | Opus, high |
| P10 | Cash drawer and Day Close | M16 | P09 | Rishi | Opus, high |
| P11 | Caffeza setup and menu import | Phase 2 onboarding | P05, P08 | Arya | Sonnet, medium |
| P12 | Cloud deployment | Phase 2 hosting | P01, P11 | Arya | Opus, high |
| P13 | Reports spec | M19 | P10 | Arya | Opus, high |
| P14 | Report engine: checks, drill down, export | M19 | P13 | Arya | Opus, high |
| P15 | Daily, money and GST reports | M19 | P14 | Arya | Opus, high |
| P16 | Menu, captain and table reports | M19 | P14 | Arya | Opus, high |
| P17 | Audit trail and control reports | M8, M19 | P14 | Part A Rishi, Part B Arya | Opus, high |
| P18 | Report screens and Today | M19 | P15, P16, P17 | Arya | Opus, high |
| P19 | Floor plan | M20 | P05 | Arya | Opus, high |
| P20A | New look, part 1: foundation and service screens | M20 | P19, and `docs/DESIGN-SYSTEM.md` | Arya | Opus, high |
| P20B | New look, part 2: back office and customisation | M20 | P20A | Arya | Opus, high |
| P21 | Golden day, end to end | M19 proof | Everything | Arya | Opus, high |
| P22 | Cafezza brand and professional finish | M20 | P20B, P21 | Arya | Opus, high |
| P23 | Online takeaway orders and table reservations | M14 | P22 | Rishi | Opus, high |
| P24 | Advance payment, dish photos and the new public page | M14, M1 | P23 | Rishi | Opus, high |
| P25 | Z Chaat, the cashier, and integrations | Onboarding, M3, M10, M16, M21 | P23 | Arya, for M21 | Opus, high |
| P26 | Adding items after serving and after billing | M2, M3 | P25 | Rishi | Opus, high |
| P27 | Customers: guest details at the table, for CRM | M22 | P26 | Rishi | Opus, high |
| P28 | A manager's PIN for cancels, voids and cash | M2, M3, M16 | P26 | Rishi | Opus, high |
| P29 | Bill edits without voids, ready means served, print before payment, undo in the kitchen, and a clear cash book | M2, M3, M16, M18, M19, M21 | P28 | Arya | Opus, high |
| P30 | Performance baseline and hosting | Phase 2 hosting | P29 | Rishi | Sonnet, medium |
| P31 | Compression and request latency | Phase 2 | P30 | Rishi | Sonnet, medium |
| P32 | The client's weight | M20 | P30 | Rishi | Opus, high |
| P33 | The live channel | M2, M14, M18 | P30, P31 | Rishi | Opus, high |
| P30 (keep awake) | Keep the free server awake | Hosting | The Render and Vercel deploy | Arya | Sonnet, high |
| P34 | Set a new password from the sign-in screen | M0 | P28 | Rishi | Opus, high |
| P35 | The same dish once on the bill, and each drink its own dish | M3, M1 | P29 | Arya | Opus, high |
| P36 | One kitchen ticket per table | M2, M18, M19 | P35 | Arya | Opus, high |
| P37 | WhatsApp: the connection, templates, and the receipt | M21, M22 | P29 | Arya | Opus, high |
| P38 | The public page as a street-food signboard | M14 | P24 | Rishi | Opus, high |
| P39 | A captain cannot change a printed bill | M3, M2 | P29 | Rishi | Opus, high |
| P40 | A manager's PIN to add to a printed bill | M3, M2 | P39 | Rishi | Opus, high |
| P41 | Kitchen text on one line, Recall, Undo after Send, the floor as tiles | M18, M2, M20 | P36, P38 | Rishi | Opus, high |
| P42 | Changing a dish after it is sent; the kitchen login sees only tickets | M2, M18, M20 | P41 | Rishi | Opus, high |
| P43 | Other, with the mode of payment | M10, M3 | P08 | Rishi | Sonnet, medium |
| P44 | The Day End summary, and the day-end message by email | M16, M7, M19 | P43 | Rishi | Opus, high |
| P45 | A loud bell on the kitchen screen for a new KOT | M18 | P42 | Rishi | Sonnet, medium |
| P46 | Open item: a dish whose name and price are typed when ordering | M1, M2, M3, M19 | P42 | Rishi | Opus, high |
| P47 | Other modes: Swiggy, Zomato and EazyDiner one tap away, kept in Settings | M10, M7 | P43 | Rishi | Sonnet, medium |
| P48 | PetPooja's way: the floor, Recall, change, typed extras, the counter screen, a test site | M2, M3, M10, M18, M20 | P46 | Rishi | Opus, high |
| P49 | Before a dish is sent, the captain changes it freely | M2 | P48 | Rishi | Sonnet, medium |
| P50 | Close a table opened by mistake | M2 | P49 | Rishi | Sonnet, medium |
| P51 | The WhatsApp assistant: questions, table bookings, and stop | M21, M14, M22 | P37 | Arya | Opus, high |
| P54 | Constant backups | Phase 2 operations | P43 | Arya | Opus, high |
| P55 | The owner's dashboard, beside the ERP | M19, M20 | P18, P44 | Rishi | Opus, high |
| P56 | A note for every dish, the guest's details before the first KOT, and only whole voids in the void lists | M2, M3, M18, M19, M22 | P27, P36, P50 | Rishi | Opus, high |

P04, P05 and P19 do not depend on the billing chain, so they can run in parallel with it.
The owners follow the rule "one module, one owner". Change any of them, and record the change in the decision log.

---

## 4. Milestones

| Milestone | Prompts | What you can show the client |
|---|---|---|
| A. Safe foundations | P00 to P04 | Nothing new on screen. Bills now store everything the reports need. |
| B. Their way of working | P05 to P10 | Stations, delivery orders, all eight payment methods, No Charge, On Hold, Day Close |
| C. Live on staging | P11, P12 | Their real menu and tables on a real web address |
| D. The reports | P13 to P18 | Every report, balancing, drillable and exportable |
| E. The look | P19, P20A, P20B, P22 | Their floor plan, the new design, and Cafezza's own brand |
| F. Proof | P21 | The golden day replays end to end with every check green. Done 2026-10-02: `npm run e2e`, and `docs/GO-LIVE-READINESS.md`. |

After milestone F, follow `docs/GO-LIVE.md`.

---

## 5. Reviews

`docs/BUILD-PLAN.md` section 13 says a module is not done until the other developer has read it.
`docs/PROJECT-STATE.md` records that Arya has not yet read M1, M4, M5, M6 or M7.

For Caffeza, two of those reads come first, because the reports build directly on them:

1. Arya reads M3 before P06 starts.
2. Arya reads M6 before P13 starts.

Every new Caffeza module gets its second read before the next milestone begins.

---

## 6. New audit actions

M8 already lists the actions it adds.
Caffeza work adds these, each written by the module that creates the event.
M8 reads them all.

| Action | Entity | Written by | Why |
|---|---|---|---|
| `LINE_CANCELLED_AFTER_PREP` | `ORDER` | M2, from P04 | Food was made and thrown away |
| `NO_CHARGE_GIVEN` | `ORDER` | M16, from P08 | Food given away free |
| `PAYMENT_METHOD_CORRECTED` | `BILL` | M10, from P08 | A way to move money between cash and UPI after the fact |
| `BILL_CHARGED_TO_ACCOUNT` | `BILL` | M16, from P09 | Money that will only arrive later |
| `ACCOUNT_BALANCE_ADJUSTED` | `ACCOUNT` | M16, from P09 | Writing off what someone owes |
| `CASH_PAID_OUT` | `CASH` | M16, from P10 | Cash leaving the drawer |
| `DAY_CLOSED` | `DAY` | M16, from P10 | The day is locked |
| `DAY_REOPENED` | `DAY` | M16, from P10 | A locked day was changed |
| `PLATFORM_PAYOUT_RECORDED` | `PAYOUT` | M17, from P09 | Platform money arriving |
| `BRAND_LOGO_SET` | `SETTINGS` | M20, from P22 | The restaurant's logo changed |
| `BRAND_LOGO_REMOVED` | `SETTINGS` | M20, from P22 | The restaurant's logo was removed |

---

## 7. What "done" means for Caffeza work

Everything in `docs/BUILD-PLAN.md` section 13, plus:

1. The module's spec section is committed to `docs/API-CONTRACT.md` and `docs/DB-SCHEMA.md` before its code.
2. The golden day in `docs/TEST-DATA.md` still produces every expected number.
3. Every check in `docs/RECONCILIATION-RULES.md` that touches the module passes, and has a test that breaks it on purpose.
4. Every new number on screen uses a word from `docs/GLOSSARY.md`.
5. Every new screen works on a phone held in one hand, and on the cashier's computer with a keyboard.
6. `docs/PROJECT-STATE.md` is updated before the session ends.

---

## 8. Out of scope for go-live

| Thing | Why |
|---|---|
| Live Zomato and Swiggy order import | Needs partner API approval. Orders are entered by hand for now. |
| UPI QR on the bill | Caffeza already has its own QR standee |
| Recipe costing | Needs M9 purchase prices. Inventory itself is built and, from 2026-10-08, switched on in the setup file. |
| Attendance | Built, switched off. Same. |
| Payroll | M11, needs a CA and its own build |
| Offline mode | The server is in the cloud. The cafe gets a backup internet line instead. |
| Loyalty, WhatsApp | Later modules. They build on the customers and the offers consent P23 collects. |
| Online ordering and bookings | P23, added 2026-10-08. It does not block go-live, and Caffeza goes live without it. |
| More than one outlet | `branchId` is ready on every record. The screens come later. |

If a request fits none of the prompts above, say so plainly, and do not build it.

---

## 9. How to work

`CLAUDE.md` loads only the short docs automatically.
The long specs are read in part, when a task needs them.
That keeps each Claude Code session's memory free for the code itself.

Before a session: pull, read the prompt, and check its "Depends on" prompts are merged.
During a session: one prompt, committed directly to `main`.
After a session: update `docs/PROJECT-STATE.md`, push, and ask the other developer to read it.
