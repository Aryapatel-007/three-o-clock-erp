# P65 The CA's month: one pack, shared, signed off

Model: Opus, high. Owner: Rishi (M19, M21, M7). Depends on: P64, and P29's
closed days.

Asked for by Rishi on 2026-10-24: "reports can be shared to the CA, and the
work for the restaurant and the CA gets easy."

Read before starting: `docs/REPORT-SPEC.md` R8, R9 and R10,
`docs/RECONCILIATION-RULES.md`, `server/services/reports/engine.js`,
`server/services/integrations/tally/exportService.js`,
`server/services/emailService.js`, `docs/REPLICATION.md` section 2.

## 1. What already exists

More than it looks. The accountant's path is half built:

1. R8 GST gives the rate-wise figures. R9 Tally Export builds balanced vouchers
   as XML, from closed days only, refuses to build while any ERROR check fails,
   and refuses to export a date twice until the owner says the old vouchers
   were deleted from Tally. R10 Invoice Register proves there is no gap in the
   series. Every report already exports as a workbook from the same envelope
   the screen drew, so a file can never disagree with a screen.
2. `emailService.js` sends through Resend, used by P44's day-end message.
3. Every report runs the checks in `docs/RECONCILIATION-RULES.md` and shows a
   red strip rather than hiding itself.

## 2. What is missing

1. **One pack.** A CA wants a month, not nineteen downloads. Today the owner
   has to know which reports matter and pick the dates on each.
2. **A way in.** The CA has no account, and should not need the owner's phone
   and password. Everything today is behind a staff sign-in.
3. **Filing shape.** R8 answers "what GST do we owe". A GSTR-1 return also wants
   a rate-wise B2C summary, an HSN or SAC summary, and the document series with
   its voided numbers. P64 adds the HSN field this needs.
4. **A signature.** Nothing records that the CA looked, which is also the gate
   M3's decision D1 has been waiting on since 2026-08-30: a CA confirming the
   GST output on a real printed bill. This prompt is how that finally closes.

## 3. What to build

A. **Spec first**: `docs/REPORT-SPEC.md` gains R20, the CA Pack;
   `docs/API-CONTRACT.md` a P65 section; `docs/DB-SCHEMA.md` the `cashares`
   collection; `docs/GLOSSARY.md` section 49 for the CA's words;
   `docs/RECONCILIATION-RULES.md` any check the pack adds; and the rows in the
   prompts README and the build plan. Classify the new model in
   `server/config/replication.js` or the tripwire test fails (P62).

B. **R20, the CA Pack**, a sectioned report like R9, through the one engine,
   with `requiresPassingChecks` and closed days only. Sections:
   1. **Cover** — restaurant, legal name, GSTIN, FSSAI, the period, which of
      its days are closed, and when the pack was generated.
   2. **Outward supplies, rate-wise** — taxable value, CGST, SGST per slab, and
      the platform-collected 0% supplies on their own line with section 9(5)
      named, because that is the line a CA will ask about first.
   3. **HSN and SAC summary** — from the codes P64 freezes on each bill line.
      Lines with no code are their own "not recorded" row, never guessed. Same
      rule as R11's treatment of bills from before P03.
   4. **Document series** — R10's numbers in order, voided ones included and
      marked, so the CA can see the series is unbroken.
   5. **Money received** — by payment method, with On Hold and unpaid, matching
      R5 and R2 to the paisa.
   6. **On Hold movement** — opening, charged, collected, adjusted, closing.
   7. **Cash and expenses** — the month's expenses by category from the cash
      book, bank deposits as contra, cash to the owner as drawings, exactly as
      P29 already maps them for Tally.
   8. **Checks** — every reconciliation check for the period, each named, with
      what it compared.
   The workbook writes one sheet per section, which the engine already supports
   as `sheetPerSection` for R9. The Tally XML for the same period is offered
   beside it, from the existing export service, not a second builder.

C. **How the CA gets it.** Two ways are possible and they are not equal; this
   is the decision to settle before writing code.
   - **A share link, recommended for v1.** A new `cashares` record: one
     restaurant, one period, created by an OWNER, an expiry, revocable, and
     only the hash of its token stored, which is the pattern `TallyBridge`
     already uses for the bridge's token. The CA opens
     `/api/v1/public/ca/:token`, reads the pack and downloads the workbook and
     the XML. It sits outside the general rate limiter with its own, like the
     public page, and the slug lookup is a sanctioned `skipTenantGuard` use,
     which means the tripwire's sanctioned count in
     `tests/skipTenantGuard.test.js` moves from four to five, deliberately and
     in the same commit. Every open is audited.
   - **A seventh role, `ACCOUNTANT`.** `server/config/roles.js` opens with "The
     six roles. This list is closed." Adding one touches every permission
     table, every `requireRole` call site and the Staff screen, and gives the
     CA a phone-number login inside a restaurant's user list. It is the better
     answer in the long run, because the CA could then filter and drill exactly
     as the owner does. It is also a much larger blast radius for something no
     CA has used yet.
   Build the link now. Keep the role as its own prompt, written once a real CA
   has used a pack and said what they still had to ask for.

D. **Monthly, by itself.** On the 1st, for the month just ended, the pack is
   built and emailed to `settings.reports.caEmails`, a mirror of P44's
   `dayEndEmails`, at most five addresses, with the workbook and the Tally XML
   attached. Resend takes base64 attachments; `sendEmail` gains an optional
   `attachments` argument and nothing else changes. If a day in the month is
   still open, the email says so and names the dates rather than sending a
   half month quietly. That refusal is the feature.

E. **The sign-off.** The CA marks a period reviewed, with an optional note. It
   is stored on the share, audited as `CA_PACK_REVIEWED`, and shown on the
   owner's dashboard beside the month. `CA_PACK_SHARED`, `CA_PACK_OPENED`,
   `CA_PACK_REVOKED` are the other three new actions, OWNER-only on the
   activity log, added to `docs/CAFFEZA-BUILD-PLAN.md` section 6.

F. **Screens.** `/reports/ca` for the owner: pick a month, see the pack, copy
   or email the link, see who opened it and when, revoke it. The CA's own view
   is the same envelope rendered by the existing `ReportPage`, read-only, with
   no sidebar and no links into the ERP.

## 4. What the pack must never carry

A guest's mobile number, name or any other personal detail. A CA needs invoice
numbers and amounts, not a customer list, and the DPDP consent P27 records is
for offers, not for handing a contact list to a third party. The thermal bill
already masks a mobile to its last four digits; the pack carries none at all.
No phone number in the link, and no personal data in any URL, which CONVENTIONS
section 3 already forbids. A test asserts no `customer` field reaches R20.

## 5. Where it runs

With two-way sync on (P63) the cafe PC is the writer and the cloud is a
read-only mirror. A CA pack is a read, so it should be served from the cloud
rather than from a PC in a cafe during service. But a mirror can lag, and a
pack built from a half-applied month would be wrong in the most expensive way.
So: the pack refuses to build unless every business date in the period is
closed **and** the mirror's cursor has passed the last changelog entry for that
period. `ReplicationState` and `ReplicaCursor` already carry what is needed to
answer that. Say it plainly on screen when it refuses: the day is not closed,
or the copy is still catching up.

## 6. Tests

Server: the golden day's month produces a pack whose every section reconciles
with R2, R5, R8 and R10 to the paisa; an open day in the period refuses the
build and names the date; a failing ERROR check refuses the build, as R9 does;
a share token is stored only as a hash and a wrong token is a 401; an expired
or revoked share is refused; a second open writes a second audit line; the pack
contains no customer field; a lagging mirror refuses, and the same request
succeeds once the cursor passes.

Browser: the owner shares a month, opens the link in a clean session with no
cookie, downloads the workbook, and marks it reviewed.

## 7. Effort, honestly

Three sessions: the spec and R20; the share, the email and the schedule; the
screens. P64 comes first, because without its HSN field section 3 of the pack
has nothing to add up.
