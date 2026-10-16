# Restaurant ERP

MERN stack. REST API. Multi-tenant SaaS for restaurants in Ahmedabad.
Two developers: Arya and Rishi. One person owns one module fully.
The live client is Three O'Clock Cafe, a Vietnamese coffee cafe on PDPU Road, Gandhinagar. Its setup is in `docs/clients/threeoclock/PROFILE.md`.
This repository was copied from the Z Chaat repository on 16 October 2026; Z Chaat's files are archived in `docs/archive/zchaat/` and `setup/archive/zchaat/`.
The first client, Cafezza, is archived in `docs/archive/caffeza/`.

## Loaded every session

@docs/PROJECT-STATE.md
@docs/CAFFEZA-BUILD-PLAN.md
@docs/CONVENTIONS.md
@docs/GLOSSARY.md

## Read these when the task needs them

These are long. Read the section your task touches, not the whole file.

| File | Read it when |
|---|---|
| `docs/API-CONTRACT.md` | Before writing or changing any endpoint. Read your module's section. |
| `docs/DB-SCHEMA.md` | Before writing or changing any model. Read your module's section. |
| `docs/REPORT-SPEC.md` | Before any report work |
| `docs/RECONCILIATION-RULES.md` | Before any report, billing, payment or Day Close work |
| `docs/TEST-DATA.md` | Before writing any report or money test |
| `docs/clients/threeoclock/PROFILE.md` | Before building anything for the live client, Three O'Clock |
| `docs/DESIGN-SYSTEM.md` | Before any screen work |
| `docs/BUILD-PLAN.md` | Section 13 before calling a module done. Sections 11 and 12 for security and common mistakes. |
| `docs/DEPLOYMENT.md` | Before touching startup, environment variables or deployment |
| `docs/CURRENT-STATE-AUDIT.md` | When you need to know what already exists and where |
| `docs/INTEGRATIONS.md` | Before any Swiggy, Zomato, Pine Labs or Tally work, or setting up a restaurant's integrations |

API-CONTRACT.md and DB-SCHEMA.md are the specification. Do not invent their contents.
If a task needs a field or endpoint that is not in them yet, stop and say so instead of adding it.
A module's spec section is committed before its first line of code.

## Non-negotiable rules

Every database record has a `restaurantId`. Every query filters by it. No exceptions.
Store all money as whole paise integers. Never as a decimal or float.
Copy price, item name, and tax rate into the order when it is created. Never read them live from the menu at bill time.
Check permissions on the server for every endpoint. Hiding a button in React is not security.
Never hard delete a bill, order, or stock entry. Mark it cancelled or voided and keep it.
Bill numbers are generated on the server, are sequential, and are never reused.
Secrets live in `.env`. `.env` is in `.gitignore`. Never commit a real secret.
Store timestamps in UTC. Convert to India time only for display.
GST rates are settings, never hardcoded.

## Rules for money and reports

Money arithmetic lives in `server/utils/money.js`. Tax arithmetic lives in `server/utils/tax.js`. Nowhere else.
Which business day a moment belongs to is decided only by `businessDateFor` in `server/utils/time.js`.
Reports only add up values frozen onto records when the event happened. A report never recomputes tax, never reads a live menu price, and never reads today's category for an old sale.
Every report goes through the one shared report engine. It applies tenant scope, the business date range and "leave out voided" in its first step.
Every label on a screen or an export comes from `docs/GLOSSARY.md`.
A totals row is the exact sum of its rows. An average is a sum divided by a sum.
Every report runs its checks from `docs/RECONCILIATION-RULES.md`. A new check gets a test that breaks it on purpose.
The golden day in `docs/TEST-DATA.md` must still produce every expected number after your change.

## Rules for a live restaurant

The server runs in the cloud, next to a separate Atlas cluster. Do not add anything that assumes a machine inside the restaurant.
Printing happens from the browser on a device in the restaurant. The server never talks to a printer.
Never create a bill in production to test something. Every production bill uses a real GST invoice number.
Schema changes are additive: new fields with defaults, nothing renamed or removed. If a change cannot be additive, say so and write its rollback steps.

## Scope discipline

Work comes from the prompts in `docs/prompts/`, in the order in `docs/CAFFEZA-BUILD-PLAN.md` section 3.
If asked for something that fits none of them, say so instead of building it.

## End of every session

Update `docs/PROJECT-STATE.md` with what changed.
This file is how the other developer and other chats find out what happened here.
Do not skip this.
