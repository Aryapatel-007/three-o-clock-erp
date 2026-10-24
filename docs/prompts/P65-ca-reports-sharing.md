# P65 The CA's month, sent by itself

Model: Opus, high. Owner: Rishi (M19, M7). Depends on: P64, for the HSN codes
section 4C.3 adds up.

Asked for by Rishi on 2026-10-24: "reports can be shared to the CA, and the
work for the restaurant and the CA gets easy." From MyBillBook's CA Reports
Sharing screen, seen in his own account on 2026-10-24 (app version 9.25.1,
Pro plan).

Read before starting: `docs/REPORT-SPEC.md` R8, R9 and R10,
`docs/RECONCILIATION-RULES.md`, `server/services/reports/engine.js`,
`server/services/emailService.js`, `server/services/backup/backupService.js`
(for how a recurring job is scheduled here), `docs/REPLICATION.md` section 2.

## 1. What the screen Rishi pointed at actually does

Four fields and a switch: CA name, CA WhatsApp number, CA email (optional),
Enable Sharing. One line of behaviour: GSTR reports go to the CA on the 1st of
every month. There is no portal, no login and no link. The "1 CA" in their
plans is this, not a seat.

**An earlier draft of this prompt got that wrong** and designed a tokenised
share link, a public route, expiry and revocation, with a seventh
`ACCOUNTANT` role behind it. All of that is dropped. It is written down here
so nobody reads the old idea somewhere and rebuilds it. If a CA ever asks to
filter and drill for themselves, that is a new prompt with a real CA asking.

## 2. What already exists

Most of the hard part:

1. R8 GST gives the rate-wise figures. R9 Tally Export builds balanced
   vouchers from closed days only, refuses while any ERROR check fails, and
   refuses to export a date twice. R10 Invoice Register proves the series has
   no gap. Every report exports as a workbook built from the envelope the
   screen drew, so a file can never disagree with a screen.
2. `emailService.js` sends through Resend, used by P44's day-end message.
3. P54's `startBackups` is the pattern for a recurring job: one ticker started
   with the server, which decides on each tick whether anything is due.

## 3. What is missing

A single pack instead of nineteen downloads, a monthly send, and the GSTR-1
shape: a rate-wise B2C summary, an HSN or SAC summary (P64 adds the codes) and
the document series with its voided numbers.

## 4. What to build

### A. Spec first

`docs/REPORT-SPEC.md` gains R20; `docs/API-CONTRACT.md` a P65 section;
`docs/DB-SCHEMA.md` the `careportsends` collection and the `settings.reports.ca`
group; `docs/GLOSSARY.md` section 49; the rows in the prompts README and
`docs/CAFFEZA-BUILD-PLAN.md` sections 3 and 6. Classify the new model in
`server/config/replication.js` or the tripwire test fails (P62).

### B. The CA's details, without their number in the audit trail

`settings.reports.ca`: `{ enabled, name, email, whatsapp }`, beside P44's
`dayEndEmails`, owner only, every field defaulted so no restaurant needs a
migration.

**There is a trap here, and it must be handled in the same commit.**
`settingsService.js` writes a `SETTINGS_CHANGED` audit line per changed field
carrying `previousValue` and `newValue` as strings, under a comment promising
no personal data goes in there. Saving the CA's number through it would write
a phone number into the audit trail, which CONVENTIONS section 12 and P27 both
forbid. So the three CA contact fields are marked in `settingsService` as
recorded without their values: the audit line says the CA's contact changed and
who changed it, and never the number, the address or the name. A test asserts
that saving a CA number leaves no audit line containing it.

The CA's details are the restaurant's configuration, not a guest's record. They
never reach `/auth/me`, never reach a report, and never appear in a log line.

### C. R20, the CA Pack

One sectioned report, through the one engine, closed days only, with
`requiresPassingChecks` exactly as R9 has it. Sections:

1. **Cover** — restaurant, legal name, GSTIN, FSSAI, the period, which of its
   days are closed, when the pack was built, and the plain sentence from
   section 5 about what the pack does not cover.
2. **Outward supplies, rate-wise** — taxable value, CGST and SGST per slab,
   with the platform-collected 0% supplies on their own line naming section
   9(5), because that is the first line a CA will ask about.
3. **HSN and SAC summary** — from the codes P64 freezes on each bill line.
   Lines with no code are their own "not recorded" row, never guessed, the
   same rule R11 already uses for bills from before P03.
4. **Document series** — R10's numbers in order, voided ones included and
   marked, so the CA can see the series is unbroken.
5. **Money received** — by payment method, with On Hold and unpaid, matching
   R5 and R2 to the paisa.
6. **On Hold movement** — opening, charged, collected, adjusted, closing.
7. **Cash and expenses** — the month's expenses by category, bank deposits as
   contra and cash to the owner as drawings, exactly as P29 already maps them
   for Tally.
8. **Checks** — every reconciliation check for the period, each named, with
   what it compared.

The workbook writes one sheet per section, which the engine already supports as
`sheetPerSection` for R9. The same period's Tally XML comes from the existing
export service, never a second builder.

### D. The monthly send

A ticker started with the server, in P54's shape. On each tick: for each
restaurant with `ca.enabled`, if the previous month has no `careportsends` row,
every one of its business dates is closed, and the machine holds the whole month
(section 4F), build the pack and email it.

`careportsends`: `restaurantId`, `period` (`"2026-10"`), `status`
(`SENT`, `FAILED`, `REFUSED`), `refusedReason`, `sentAt`, `to`, the file names,
and the checks summary. A unique index on `{ restaurantId, period }` is what
makes a restart, a second machine or a retry unable to send twice — a unique
index rather than a service check, for the same reason `stockmovements` uses
one: a check has a race in its middle.

`sendEmail` gains an optional `attachments` argument, in Resend's shape, and
nothing else about it changes. The email carries the workbook and the Tally XML
and says in its first line what period it covers.

With a day still open the send does not go. It records `REFUSED` with the open
dates and tells the owner on their dashboard. **That refusal is the feature**:
a CA who receives half a month and files from it is worse off than a CA who
receives nothing.

WhatsApp is not built here. P37 sends to guests through approved templates and
reads `customers` and offers consent; a CA is neither a guest nor a customer
record, and bending that path around one accountant would put a third party
into the collection that exists for guests. A CA on WhatsApp is its own small
prompt: one utility template and a send path of its own.

### E. The screen

Settings, CA reports (owner only): the four fields, what will be sent and when,
the last twelve sends with their status, **Send now** for a month the owner
picks, and Download for the workbook and the XML. A refused month says why in
words: which dates are open, or which check failed.

New audit action `CA_PACK_SENT`, OWNER only on the activity log, in build plan
section 6. Changing the CA's details is already `SETTINGS_CHANGED`, under 4B's
rule.

### F. Where it runs

The pack is a read, but it must be a read of a complete month. Under P63 the
cafe PC is the writer and the cloud has its own copy, and under P62 the mirror
is read-only and can lag. So the send refuses unless every business date in the
period is closed **and** the machine running it holds the period's last change:
`ReplicationState` and `ReplicaCursor` already carry what is needed to answer
that. It runs wherever the job loop runs, and the internet is what Resend needs,
not the cafe.

## 5. What the pack does not carry, and what it cannot claim

Say each of these on the cover, not in a comment. A CA who discovers them
later trusts nothing else in the pack.

1. **No purchases, so no input GST.** M9 is deferred, so nothing in this system
   records a purchase bill. The pack is outward supplies only: there is no
   purchase register, no input tax credit and no GSTR-2B reconciliation, and
   the CA assembles that side as they do today. This is the single largest gap
   between this pack and what a general billing app hands a CA.
2. **Everything is B2C.** `accounts` carries no GSTIN field, so a corporate On
   Hold account cannot be told from a walk-in. If Z Chaat starts invoicing a
   registered company that wants input credit, that is a schema addition and a
   decision of its own, not something to infer from an account's name.
3. **No credit notes.** A bill voided before the return is filed is a cancelled
   number in the series, which the pack shows. A refund after filing needs a
   credit note under section 34, and this system has no such document.
4. **No e-invoicing.** No IRN and no signed QR. It is turnover-gated and is its
   own prompt, with its own decision about the threshold Z Chaat has reached.
5. **No guest personal data.** Not a name, not a number, not a masked number. A
   CA needs invoice numbers and amounts, not a customer list, and the consent
   P27 records is for offers, not for handing contacts to a third party. A test
   asserts no customer field reaches R20.

## 6. Tests

Server: the golden day's month produces a pack whose every section reconciles
with R2, R5, R8 and R10 to the paisa; an open day refuses the build and names
the date; a failing ERROR check refuses it, as R9 does; the unique index means
a second send for one period writes nothing and sends nothing, proved by
running the tick twice; a Resend failure records `FAILED` and is tried again on
the next tick, never twice in one; saving a CA number writes no audit line
containing it (it fails when the field is left out of 4B's list, tried on
purpose); the pack contains no customer field; a lagging mirror refuses, and
the same request succeeds once the cursor passes.

Browser: the owner sets the CA's details, sends a month by hand, sees it in the
history, and downloads the workbook. The e2e server's fake Resend (P44) receives
it with both attachments.

## 7. Effort

Two sessions: the spec and R20; the send, the settings and the screen. P64 comes
first, because without its HSN codes section 4C.3 has nothing to add up.
