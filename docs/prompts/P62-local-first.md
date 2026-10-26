# P62 — Local-first: MongoDB Community on the cafe box, Atlas as mirror, backup and intake

> **Renumbered.** This prompt arrived as "P51". P51 is already Arya's WhatsApp
> assistant (`P51-whatsapp-assistant.md`) and the last prompt on `main` is P61,
> so it is P62 everywhere in the code and the docs. See the decision log,
> 2026-10-21. The network additions asked for alongside it (the WiFi the system
> runs on, changing it, every device's connection strength, the staff setup
> guide) are part of P62 and are recorded the same way.

> Paste this whole file as the opening message of a fresh Claude Code session,
> or save it to `docs/prompts/P51-LOCAL-FIRST.md` and point a session at it.

---

## 0. Read before you write anything

In this order, and do not skip:

1. `docs/PROJECT-STATE.md` — current stage, module status, the full decision log.
2. `CLAUDE.md` — the non-negotiable rules.
3. `docs/CONVENTIONS.md` — sections 1, 2, 3, 9.
4. `docs/BUILD-PLAN.md` — section 6 (rules that are not negotiable), section 13
   (done conditions).
5. `docs/DEPLOYMENT.md` — the current hosting decision, in full.
6. `docs/INTEGRATIONS.md` — every inbound webhook and outbound call M21 makes.
7. The M14 sections of `docs/API-CONTRACT.md` — the public page `/r/:slug`,
   Razorpay advances, refunds.
8. `models/Counter.js` — read the comment, not just the code.
9. Every file in `server/models/` — you will classify each one (§3).
10. `docs/GO-LIVE.md` and `docs/GO-LIVE-READINESS.md`.

Then report, **before writing code**, what you found that contradicts this
prompt. There is more than one thing. If you do not name them, you did not read.

---

## 1. The architecture

```
 Tills · captain tablets · kitchen screens · printers       (cafe WiFi / LAN)
                         │  1–3 ms
                         ▼
 ┌──────────────────── Cafe box (the only writer) ────────────────────┐
 │ Node + Express: every business rule, unchanged                      │
 │ MongoDB Community Server: single-node replica set, local disk       │
 │ Changelog writer ─► Shipper ───────────── up: state, continuous ────┼─┐
 │ Intake puller   ◄─────────────────────── down: requests only ───────┼─┤
 │ Outbound jobs (M21): refunds, platform acks, Tally — retried        │ │
 │ Snapshot job: mongodump --oplog, local + off-site                   │ │
 └─────────────────────────────────────────────────────────────────────┘ │
                                                     4G / broadband      │
 ┌──────────────────── MongoDB Atlas + small cloud app ────────────────┐ │
 │ Mirror of operational data: READ-ONLY, enforced                     │◄┘
 │ Owner dashboard and M19 reports read the mirror                     │
 │ `intake`: the one writable surface — online orders, webhooks        │
 │ Snapshot storage and point-in-time restore                          │
 └─────────────────────────────────────────────────────────────────────┘
```

**All live operation runs on the cafe box.** Atlas holds a continuously updated
copy for the owner dashboard and off-site backup. Atlas also receives the things
only the internet can deliver — online orders and partner webhooks. It holds
them as requests for the box to act on, never as orders in their own right.
Compass is a read-only window into the local database (§2.2).

The rule that makes this simple: **state flows up, requests flow down.** The box
never receives a changed bill, order or stock level from the cloud. It receives
"a customer asked for this" and decides, through the same services every till
uses.

### 1a. This reverses three logged decisions

Write all three into the decision log in `docs/PROJECT-STATE.md`, with reasons,
before building. Never delete an old line.

- **2026-09-30** — "Hosting: a cloud server in the same region as a separate
  Atlas cluster... A box inside the cafe was considered and rejected."
- **Undated** — "Web app is online only. A web app cannot work offline." That was
  true of a cloud-hosted app. A web app served from a box in the same room does
  not stop when the internet does. Internet-offline and LAN-offline are
  different failures, and only the first has to be survived.
- **2026-08-29 (M2)** — the kitchen display polls every ten seconds "one less
  thing to debug on bad kitchen wifi". The stated reason was distance to the
  server. On a LAN that reason is gone.

### 1b. Sequencing — raise this before agreeing to build

Stage 9 is taking the product live at Z Chaat. Changing where the application
runs during a go-live is how go-lives fail. When something breaks on day one,
nobody can tell whether the cause is the ERP or the hosting.

State your recommendation and **wait for an answer**. The default is that Z
Chaat goes live on the existing cloud deployment and this becomes Stage 10. If it
must happen before go-live, the cloud deployment stays a tested fallback,
reachable by changing one address on each device.

---

## 2. Six facts about this stack the build must handle

These are not opinions. Get one wrong and either the till stops or the data is
wrong.

### 2.1 A standalone `mongod` cannot run transactions, and bill creation requires one

`models/Counter.js` reserves a gap-free bill number inside the transaction that
inserts the bill, and the project deliberately gave it **no degraded mode**. On a
plain standalone Community server, **every bill fails at the till.**

So the local database runs as a **single-node replica set**. Community Edition
supports this at no cost: add `replSetName` to the config and run one
`rs.initiate()`. It is also what makes change streams and `mongodump --oplog`
work. The application **refuses to start** if the database is not a replica set,
checked with `db.hello().setName`. That gives a clear error at boot instead of a
mystery 500 on the first bill of the day.

### 2.2 Compass is a GUI, not the server, and it must not be a writer

Compass writes go straight to collections. They bypass `tenantGuardPlugin`,
`scoped(req)`, `server/utils/money.js`, the invoice counter and `auditlogs`.
Every rule this project enforces lives in the application, not the database.

- The credential for day-to-day Compass access on the production box is
  **read-only**.
- A separate write credential exists for deliberate repairs. It is not saved in
  Compass, and every use goes in the session log with what changed and why.
- Document both in `docs/RUNBOOK.md`.

### 2.3 "Periodic backup" is a statement of how much data you are willing to lose

With an hourly job, if the box is stolen, burns or loses its disk at 9:40pm,
every bill since 9:00 never existed. Those are real sales, real cash, and real
GST invoice numbers in a series that is supposed to be unbroken. So §4 requires
a continuous path as well. The acceptable loss window is a question in §15 for a
person to answer, not for you to assume.

### 2.4 `mongodump` on a live database is not consistent without `--oplog`

Without `--oplog`, collections are read at different moments. A dump can then
hold a bill whose payment is missing. Every snapshot uses `--oplog`, and every
restore uses `--oplogReplay`.

### 2.5 Atlas cannot be a secondary of a self-managed replica set

There is no way to point the replica set at Atlas. The copy is made by the
application shipping its own changes and by restoring snapshots. Do not spend a
session trying to make native replication span the two.

### 2.6 An offline box's clock decides which day a sale belongs to

`businessDateFor`, `assertDayOpen`, bill timestamps and GST invoice dates all
read the server clock through `nowUtc()`. A box running for days without
internet relies on its own hardware clock. A box whose clock battery has died
comes back from a power cut dated in the past.

- The box syncs time over NTP whenever it is online, and has a working clock
  battery checked at install.
- At boot, and periodically after, the server compares its clock with the newest
  changelog capture time and the newest bill. **If the clock has gone
  backwards, it refuses writes.** The till shows the reason in plain words, and
  `docs/RUNBOOK.md` gives the fix. It never silently bills on the wrong day.
- The changelog's ordering is its `seq`, never a timestamp, so clock trouble can
  never reorder replication.

---

## 3. What lives where: every collection is classified

The design document said to synchronise "selected records". In this codebase
that becomes a rule enforced by a test, not a list someone remembers to update.

Create one file, `server/config/replication.js`, that classifies **every
Mongoose model** with:

- `sync` — `MIRROR` (shipped to Atlas), or `LOCAL_ONLY` (never leaves the box).
- `owner` — `BOX` for every collection today. A collection with no `owner`
  column has nowhere to put the answer when multi-branch arrives (§15), so the
  column exists from day one.
- `reason` — one line, especially for every `LOCAL_ONLY` entry.

Starting expectations, to be confirmed against the real models:

- **`MIRROR`:** orders, KOTs, bills, payments, menu, categories, tables, stations,
  stock movements, ingredients, recipes, attendance, account entries, payouts,
  day closes, audit logs, settings, users (password and PIN hashes included,
  because a restore that loses every login is not a restore).
- **`LOCAL_ONLY`:** refresh tokens (session state; after a promotion everyone
  signs in again, and that is acceptable — say so in the runbook), the changelog
  itself, the shipper's own state.
- **Logo bytes on `restaurants.brandLogos`** are `select: false` for a reason.
  Decide whether they ship, and write the decision down.

**The tripwire:** a test loads the model registry and fails if any model is
missing from `replication.js`, or if `replication.js` names a model that does
not exist. A new model cannot be quietly left out of the backup. This is the
same shape as the `skipTenantGuard` counter and the report-definitions import
test.

---

## 4. Up: state flows to Atlas by two paths

A continuous stream can silently drift. A periodic snapshot alone loses
everything since the last one. Build both. Each is the check on the other.

### 4.1 Continuous: the changelog and the shipper

Do not hand-edit an outbox write into every service across M0 to M21. There are
twenty modules, and a service that forgets is a silent hole.

A worker on the box tails the local **change stream** for `MIRROR` collections
and appends each change to a new collection, `changelog`:

- `restaurantId`, and a **per-restaurant monotonic `seq`** reserved in the same
  write that persists the entry, so a gap is a detectable fault.
- `epoch` (§8), `collection`, `documentId`, `operation`, the full post-image,
  and the server clock at capture.
- A unique index on `{ restaurantId, seq }`.
- Append-only by construction: no update path, no delete path, and a test that
  fails if one appears.
- The change stream resume token is persisted after each batch, so a restart
  resumes rather than replaying from zero or skipping.

Document IDs are generated on the box and never reassigned. Those stable IDs
are what make every apply in Atlas an idempotent upsert.

A **shipper** process, outside the request path and never blocking a write:

- pushes batches to Atlas oldest-first, with backoff;
- relies on the receiver applying them idempotently against
  `{ restaurantId, seq }`, so a replayed batch is a no-op rather than an error
  (the discipline `stockmovements` already uses with its `eventKey`);
- advances its high-water mark only on an acknowledged apply;
- exposes lag, as entries behind and seconds behind, to the health endpoint and
  the status indicators (§7).

Do not build connectivity detection. The shipper just keeps trying with
backoff, and an outage is simply a long backoff.

Size local changelog retention for at least seven days of a busy restaurant's
writes, so a week of dead 4G loses nothing. State the figure in the spec.

### 4.2 Periodic: the full snapshot

On a schedule, take a `mongodump --oplog` of the whole database. Write it to
local disk **and** upload it off-site, independently of the shipper.

- Keep a rolling set: hourly for a day, daily for a month, monthly for a year.
- State in the spec what that costs in storage.
- Atlas's own backups and point-in-time restore are a third layer, not a
  substitute.

### 4.3 Reconciliation: the point of having both

On a schedule, compare Atlas with the local database:

- document counts per `MIRROR` collection;
- a checksum over the day's bills, payments and invoice numbers.

**A mismatch is an alert the owner sees**, not a log line nobody reads.
"Synchronisation is not a backup" is the design document's rule. Reconciliation
is what proves both the sync and the backup are true today.

---

## 5. Down: requests flow to the box through `intake`

The design document deferred two-way sync. This codebase cannot defer it. M14
and M21 already receive things from the internet, and the box sits behind the
cafe's router where nothing can reach it:

- online takeaway orders and table bookings from `/r/:slug`;
- Razorpay payment confirmations and refund results;
- Swiggy and Zomato order webhooks, behind the sandbox platform today;
- Pine Labs card machine callbacks.

Done narrowly, it keeps the single writer intact.

### 5.1 The cloud accepts, but only into `intake`

- The cloud app exposes exactly the public and webhook routes these flows need.
  They verify signatures exactly as M21 does today, and write **only** to a new
  `intake` collection.
- Each intake item carries:
  - the source;
  - the external ID (Razorpay payment ID, platform order number) under a unique
    index, so a webhook delivered three times is one item;
  - the raw verified payload;
  - a status: `RECEIVED`, `CLAIMED`, `APPLIED` or `REJECTED`, with a reason.
- **A test asserts that intake handlers import no operational model.** Their
  only possible write is to `intake`. This is the same shape as the
  report-definitions test.
- The read-only middleware of §6.3 allowlists exactly these routes, and the
  route-table test asserts the allowlist is exact. One extra route is a failure.

### 5.2 The box pulls and decides

- The box claims items from `intake`, oldest first.
- It applies each one **through the normal services**: `orderService` for an
  online order, the M10 payment path for a confirmation. The online order
  therefore gets its number, its stock deduction, its audit line and its KOT the
  same way a till order does.
- The result travels back up the normal changelog: `APPLIED` with the created
  order's ID, or `REJECTED` with a reason code.
- Applying is idempotent on the intake item's ID. An item claimed, applied, and
  then claimed again after a crash creates one order, never two.

### 5.3 This is all that is left of conflict handling

With one writer, simultaneous edits to operational data cannot happen. The
design document's conflict rules collapse to one case: **the cloud accepted a
request on stale information.**

- The public page reads menu and availability from the mirror, which is seconds
  behind. A customer can order a dish the kitchen switched off ten seconds ago.
- The box rejects with `ITEM_UNAVAILABLE`, and if money was taken, an automatic
  refund goes into the outbound queue (§5.4).
- Write each rejection reason into the spec with what the customer sees.
- No other kind of conflict resolution is built.

### 5.4 Outbound calls are jobs on the box, and they survive restarts

Refunds, platform accept and reject acknowledgements, and Tally pushes go out
through M21's existing jobs and event log. Confirm that M21 already persists
jobs and retries them. Extend it if not, but **do not build a second queue**
beside it. A job must survive the box being unplugged mid-retry.

**WhatsApp is not in this codebase.** The decision log of 2026-10-01 left it out
on purpose. Do not build it here. The outbound queue is generic, so a later
prompt can add it.

### 5.5 When the box is unreachable, intake waits

If the cafe's internet is down, intake items pile up in the cloud. Nothing
pretends they were accepted. What the customer is told while their order waits
is a question in §15, because Razorpay has already taken the money and platforms
impose their own acceptance deadlines.

---

## 6. What works where

| Feature | Internet down (LAN up) | Internet up |
|---|---|---|
| POS, order taking, KOT | Yes, unchanged | Yes |
| KOT and bill printing (browser iframe to local printer) | Yes | Yes |
| Billing, GST, invoice numbers | Yes, unchanged | Yes |
| Payments recorded at the till (cash, UPI, card) | Yes — the method is recorded, as designed since M3 | Yes |
| Inventory, attendance, Day Close | Yes | Yes |
| Owner dashboard **inside** the cafe | Yes, from the box over the LAN | Yes |
| Owner dashboard from outside | Shows the last synced figures with their age | Yes, seconds behind |
| Online orders and bookings (M14) | Accepted into intake, wait until the box reconnects (§5.5) | Yes, via intake |
| Swiggy / Zomato / Pine Labs (M21) | Wait in intake or the outbound queue | Yes |
| Razorpay refunds | Queued as jobs, sent on reconnect | Yes |
| Tally push | Queued | Yes |
| Cross-branch reports | n/a — single branch today (§15) | n/a |

If the **LAN** or the **box** is down, nothing works locally. That is what the UPS,
the mirrored disk and the promotion ritual (§8) exist for.

---

## 7. Status: two kinds of offline, shown differently

Staff must never confuse "the cloud is unreachable", which is harmless to
service, with "my tablet cannot reach the box", which stops service. Build both
into the existing `AppShell` top bar, using `StateChip`. Each state gets a word
and an icon as well as a colour, per `docs/DESIGN-SYSTEM-V2.md`.

- **Device ↔ box.** Driven by the device's own requests and the SSE stream.
  - `Connected` — quiet.
  - `Reconnecting` — after one failed request.
  - `Cannot reach server` — alert state. Writes are held in the short request
    queue (§12) and the screen says so.
- **Box ↔ cloud.** Driven by the shipper's real lag.
  - `Synced` — quiet.
  - `12 waiting to upload` — calm, not an alert. Service is fine.
  - `Not synced for 3 hours` — visible to OWNER and MANAGER only, as an alert,
    because that is a backup problem, not a service problem.
- **Owner dashboard on the mirror:** a "figures as of 14:32" stamp from measured
  lag, never a guess, and a warning past a threshold.
- **Reconciliation mismatch (§4.3)** and **clock refusal (§2.6)** get their own
  messages in plain words, with the runbook step.

Error and status copy go in the existing per-feature `errorCopy.js` pattern. A
user never sees a code.

---

## 8. One writer, and the fence that keeps it that way

**Exactly one machine may write operational data for a restaurant at any
moment.** Orders carry a `version` and are written only through
`applyVersionedUpdate`. One open order per table is a partial unique index. Bill
numbers are gap-free per restaurant, branch and financial year. None of that
survives two writers. The way it fails is two bills with the same GST invoice
number, which is a legal problem, not a bug to patch later.

The box is the writer. Atlas is read-only except for `intake` (§5.1).

If the box dies mid-service, authority can move to the cloud **when a person runs
a command**, never on a heartbeat timeout. Automatic failover across a consumer
internet link is the fastest route to two writers.

- Each writer holds an integer **`epoch`** that increments every time authority
  moves.
- Every changelog entry carries the epoch, and Atlas refuses a batch stamped
  below the current one.
- When the cloud is promoted, it clears its read-only flag and processes
  `intake` itself, through the same services.
- A box that comes back from the dead:
  1. sees a higher epoch;
  2. refuses to write;
  3. ships whatever it still has queued;
  4. stands down.
- Sessions do not carry across a promotion (§3). Staff sign in again on the
  cloud address.

Write promotion and demotion into `docs/RUNBOOK.md` as numbered steps a tired
manager can follow at 9pm. The operator must be shown the last applied `seq` and
its time, so they know exactly what may be missing. If the steps exist only in a
developer's head, they do not exist.

---

## 9. The speed budget

**p95 under 80ms, tap to painted**, on the cafe's real tablets over its real WiFi,
for:

- add an item;
- fire a KOT;
- create a bill;
- load the floor;
- load the ordering screen.

1. **The link is the whole win.** Gandhinagar to Singapore is roughly 80–140ms
   round trip; LAN is 1–3ms. Move the server into the room, then
   **re-measure before optimising anything else**, so you can tell what the code
   actually costs.
2. Serve the client from the same box; Express already does this in production
   (logged 2026-10-01). Fonts stay self-hosted via `@fontsource`.
3. **Kitchen display:** replace the 10-second poll with SSE. Keep the poll as a
   fallback that engages if the stream drops twice. P29's ready/served
   semantics and the undo window must behave identically either way.
4. **In-process read cache** for menu, settings, tables, stations and payment
   methods, invalidated on write. It is **safe only because there is a single
   writer.** Write that reason in a comment where the cache lives, because if
   the single-writer rule is ever broken, this breaks silently.
5. **PWA shell cached**, so a reload during a rush does not refetch the app.
6. **Query counts.** The floor read is already five queries whatever the floor
   size, with a test counting them. Do not regress it. Add the same shape of
   test for the ordering and billing screens.
7. **The changelog writer and shipper must not slow a write.** Measure p95 with
   them on and off. They run outside the request path, and the numbers prove it.

Record before and after numbers in the session log. "Faster" with no measurement
is not a result.

---

## 10. The box, the network, the peripherals, the clock

Specify in `docs/DEPLOYMENT.md`:

- **The box:** mini PC, N100-class or better, 16GB RAM, NVMe, plus a second NVMe
  mirrored.
- **A UPS powering the box, the router and the KOT and bill printers.** A box on
  battery behind a dead router is a box no tablet can reach. Size it for a clean
  shutdown plus 15 minutes of service. This is non-negotiable here: more
  restaurant systems die to power cuts than to code.
- **MongoDB Community:**
  - installed as a service that starts on boot, with journaling on;
  - bound to the LAN interface only, with authentication enabled;
  - **never** exposed to the internet.
  - The box makes outbound connections only; nothing inbound is opened on the
    cafe's router.
- **The network:**
  - dual-band router, with tills and kitchen screens on 5GHz;
  - the server on a fixed IP, reachable by hostname **without depending on the
    cafe's internet for DNS**, because the day that matters is the day the
    internet is down;
  - a 4G line for the shipper, intake pulls and owner access, never in the
    till's path.
- **The clock:** NTP when online, a clock battery verified at install, and the
  §2.6 refusal tested.
- **Unattended recovery:** the box runs headless and returns to service on its
  own after a power cut. Verify it by actually pulling the plug during
  acceptance.

---

## 11. Done means these pass

These come on top of `docs/BUILD-PLAN.md` section 13. Many are negative tests. A
green suite proves the code passes the tests; deliberately breaking a rule
proves the tests would have caught it. M6 and the `skipTenantGuard` tripwire
already use this discipline.

**Database and backup**

1. **Standalone is refused.** Point the app at a standalone `mongod`. It fails at
   boot with a clear message, not at the first bill.
2. **Every model is classified.** Add an unclassified model and the
   `replication.js` tripwire fails.
3. **Restore from snapshot.** Dump a live trading database with `--oplog`,
   restore it clean with `--oplogReplay`, and every collection matches.
   Automated.
4. **Rebuild from the log.** Wipe the Atlas copy, replay the changelog from
   `seq` 1, and it matches the box document for document.
5. **Replay is idempotent.** Ship the same batch three times, and the copy is
   unchanged after the first.
6. **Gap detection.** Remove one changelog entry. The copy refuses to advance
   past the gap and reports it.
7. **Reconciliation catches drift.** Change one document directly in Atlas. The
   §4.3 job detects it, and the owner sees the alert.

**Intake and outbound**

8. **Intake is idempotent.** Deliver the same Razorpay webhook three times. One
   intake item results, and one order.
9. **Intake survives a crash mid-apply.** Kill the box after claiming and before
   marking applied. On restart, one order, never two.
10. **Stale availability is rejected cleanly.** Switch a dish off on the box,
    then submit an online order for it via the mirror. The order is
    `REJECTED / ITEM_UNAVAILABLE` and a refund job is queued.
11. **Intake handlers cannot write operational data.** The import test fails if
    one imports an operational model.
12. **Outbound jobs survive the plug.** Unplug the box with a refund job pending.
    It is sent after restart, exactly once.

**Writer and fencing**

13. **Atlas read-only.** Every non-intake write route returns 503 while the flag
    is set, asserted by enumerating the route table, not by spot checks.
14. **Epoch fencing.** Promote the cloud, then let the old box try to write. The
    write is refused. Assert that no second bill number was issued under any
    circumstance.
15. **Clock refusal.** Set the box clock behind the newest bill. Writes are
    refused, and the till shows the reason.

**Physical failures**

16. **Pull the plug** mid-service, with an open order and a KOT in flight. On
    restart there is no corruption and no lost acknowledged write, and service
    resumes with no intervention beyond power.
17. **Cut the WAN for an hour** of simulated trading. The till is unaffected, the
    status shows `waiting to upload`, and the shipper catches up fully with no
    duplicates and no gaps.

**Status and screens**

18. **Status states.** Each §7 state is reached in a Playwright test and shows
    its word and icon. Cloud-down never shows the device-down alert.

**Unchanged money, met speed**

19. **Golden day still golden.** `tests/goldenDay.test.js` passes byte for byte,
    and checks C1 to C12 pass. **If one printed bill total moves by one paisa,
    this work has gone wrong.**
20. **Speed budget met** on real hardware over real WiFi, with the numbers
    recorded.
21. **The full e2e golden day** plays through the real screens against the box,
    each role on its own device size, as it does today.

---

## 12. Do not do these

- **Do not run the local database as a standalone.** (§2.1)
- **Do not make Compass a write path.** (§2.2)
- **Do not rely on the periodic snapshot alone,** or on sync alone. (§4)
- **Do not ship state downward.** Only intake requests flow down, and they are
  applied through the normal services. (§5)
- **Do not touch `server/utils/tax.js`, `server/utils/money.js`,
  `server/utils/units.js` or `models/Counter.js`.** This is an infrastructure
  change. If a bill total moves, stop.
- **No CRDTs, no multi-master, no sync-engine rewrite of the client** (PouchDB,
  RxDB, ElectricSQL). There is no multi-writer problem here. That machinery would
  put the frozen money arithmetic, the per-slab GST rounding and the gap-free
  invoice series back in question for nothing.
- **No device-side offline write path** beyond a short request queue that holds a
  request across a WiFi blip of seconds. A tablet never becomes a source of
  truth, never issues numbers, never computes totals.
- **No second outbound queue** beside M21's jobs. (§5.4)
- **No WhatsApp.** (§5.4)
- **No automatic failover.** (§8)
- **Do not widen tenancy.**
  - Every record still carries `restaurantId`.
  - Every query still filters by it via `scoped(req)`.
  - `tenantGuardPlugin` still applies, including on `intake` and `changelog`.
  - The sanctioned `skipTenantGuard` count stays exactly where it is.
- **Nothing is hard deleted.** The changelog least of all.

---

## 13. Order of work — spec before code

Follow the precedent M1 and M5 set and that M2 broke: **the spec section is
committed before the first line of code.**

1. Read §0. Report the contradictions and your §1b recommendation. **Wait.**
2. Write `docs/REPLICATION.md`: the collection classification, changelog shape,
   seq and epoch rules, shipper protocol, intake protocol and rejection reasons,
   snapshot schedule and retention, reconciliation, and the promotion ritual.
   Commit it alone.
3. Add replication, intake and deployment sections to `docs/DB-SCHEMA.md`,
   `docs/API-CONTRACT.md` and `docs/DEPLOYMENT.md`. Commit.
4. Local replica-set setup, the boot refusal, the clock check, Compass
   credentials. Commit.
5. `server/config/replication.js` and its tripwire. Commit.
6. Changelog writer and its tests, including the negative ones. Commit.
7. Shipper, Atlas receiver, read-only enforcement and the route-table test.
   Commit.
8. Intake: cloud routes, import test, box puller, idempotent apply, rejection and
   refund path. Commit.
9. Outbound: confirm or extend M21 jobs for restart survival. Commit.
10. Snapshot job, restore drill, reconciliation job and its alert. Commit.
11. Status indicators in `AppShell`. Commit.
12. Epoch, promotion and demotion commands, and `docs/RUNBOOK.md`. Commit.
13. Speed work: measure first, then SSE, then the read cache, then the PWA shell.
    Record before and after.
14. Full acceptance run (§11) on the real box.
15. Update `docs/PROJECT-STATE.md`: the three reversals, every decision made
    while building, module status, known problems.

Work is committed directly to `main`. The no-feature-branches decision of
2026-09-30 stands.

---

## 14. Later, and named now so it is not retrofitted

**Multi-branch, and full two-way sync.** One box per branch, each the writer for
its own operational data. That is consistent with bill numbers already being
sequential per restaurant, branch and financial year.

Restaurant-wide configuration is the hard part: menu, prices, users, settings.
Some of it will then be owned by the cloud (head office) and flow down to every
branch. When that happens:

- those collections change `owner` to `CLOUD` in `replication.js`;
- a config channel joins intake as a second downward path.

Do not build it now. Make sure nothing built now prevents it.

---

## 15. Ask before you assume

Each answer changes the build. Ask, do not guess, and write the answers into the
decision log:

1. Stage 10 after Z Chaat is live, or before go-live with cloud kept as a tested
   fallback?
2. **What is the acceptable data-loss window if the box is destroyed outright —
   seconds, or an hour?** It sets shipper batching and the snapshot interval. It
   is the owner's decision, not a developer's.
3. **While the box is unreachable, what does an online customer see?**
   - Their order waits in intake, but Razorpay has already taken the money.
   - Should the public page stop taking orders when the box has not checked in
     for N minutes?
   - What is N?
4. Swiggy and Zomato impose acceptance deadlines. If the box is unreachable past
   one, do we let the platform auto-reject, or does the cloud need a narrow
   auto-accept rule? (The default is to let it reject, because the kitchen
   cannot cook an order it never saw.)
5. One cafe or several? Several means §14 comes forward.
6. Who physically restarts the box at 9pm when it will not come up, and what is
   their phone number? It goes in the runbook.
7. Does the owner want live access to the box as well as the mirror, or is the
   mirror enough?
8. Which Atlas tier, and does its storage cover the §4.2 retention?
9. Budget for the box, the second NVMe, the UPS (box, router and printers) and
   Atlas, confirmed before anything is ordered.
