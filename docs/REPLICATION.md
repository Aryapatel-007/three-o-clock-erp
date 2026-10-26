# REPLICATION: the cafe box, the cloud mirror, intake and backup

P62. The specification for running the restaurant on a box inside the cafe,
with Atlas as a read-only mirror, a backup and the intake for the internet.
The prompt is `docs/prompts/P62-local-first.md`. Operations are in
`docs/RUNBOOK.md`; installation in `docs/DEPLOYMENT.md` sections 17 and 18;
the staff guide in `docs/STAFF-SETUP.md`.

**State flows up, requests flow down.** The box never receives a changed bill,
order or stock level from the cloud. It receives "a customer asked for this",
and decides through the same services every till uses.

---

## 1. Roles

One codebase, three ways to run it, chosen by `DEPLOYMENT_ROLE`
(`server/config/deployment.js`):

| Role | Where | Writes | Runs |
|---|---|---|---|
| `CLOUD` (default) | Render, as P12 to P61 | everything | as before P62: nothing in this document is active |
| `BOX` | the mini PC in the cafe | everything, while it holds the current epoch and its clock is right | changelog writer, shipper, intake puller, reconciliation, clock check |
| `MIRROR` | a small cloud app on Atlas | only `intake`, sessions and its own bookkeeping, until promoted | the replication routes, the public page, the owner's read-only dashboard |

A `CLOUD` deployment that sets nothing behaves exactly as before. The writer
gate, the writer guard and the job-loop check all answer "may write" there.

---

## 2. What lives where

### 2.1 The classification

`server/config/replication.js` names every Mongoose model once with `sync`
(`MIRROR` or `LOCAL_ONLY`), `owner` (`BOX`, `CLOUD` or `EACH`) and a reason.
`tests/replicationClassification.test.js` fails if a model is missing or a
name does not exist.

| Sync | Models |
|---|---|
| MIRROR, owner BOX | Account, AccountEntry, AttendanceEntry, AuditLog, Bill, Branch, CashMovement, Category, Conversation, **Counter**, Customer, DayClosure, Ingredient, IntakeApplication, IntegrationConnection, IntegrationEvent, IntegrationJob, Kot, MenuItem, MenuPhoto, MessageTemplate, OnlineOrder, OnlinePayment, Order, PaymentMethod, PlatformItemMapping, PlatformOrder, PlatformPayout, Recipe, Refund, Reservation, Restaurant, Station, StockMovement, Table, TallyBridge, TallyExport, TerminalTransaction, User |
| LOCAL_ONLY, owner BOX | ChangelogEntry, ChangelogCounter |
| LOCAL_ONLY, owner CLOUD | IntakeItem, ReplicaCursor, ReplicationQuarantine |
| LOCAL_ONLY, owner EACH | RefreshToken, ServerStart, BackupRun, BackupState, ReplicationState |

`Counter` ships so that a promoted mirror continues the bill series and never
restarts it. `IntegrationJob` ships so that a promoted mirror finds the refunds
and acknowledgements still owed. `owner` is `BOX` for every operational
collection today; section 14 of the prompt (multi-branch) moves restaurant-wide
configuration to `CLOUD` here without moving anything else.

### 2.2 Decisions in the classification

- **Users ship with their password and PIN hashes.** A restore that loses every
  login is not a restore.
- **Refresh tokens never ship.** After a promotion everyone signs in again.
- **Logo bytes ship.** `brandLogos` is `select: false` so the ordering screen
  never carries image bytes, not because it is secret. The mirror's public
  page and dashboard draw the logo, and a restore without it is not whole.
- **Partner credentials ship sealed.** They are encrypted under
  `INTEGRATION_SECRETS_KEY` and `PAYMENT_SECRETS_KEY`; the mirror needs the same
  keys to verify webhooks (section 6.1), and the copy is unreadable without them.
- **`intake` lives only on the mirror**, and the box's outcome for each item
  (`intakeapplications`) ships up like any other state.

---

## 3. The changelog

### 3.1 Shape (`changelog`, `server/models/ChangelogEntry.js`)

| Field | |
|---|---|
| `restaurantId` | the tenant; for a `restaurants` change, the document's own `_id` |
| `seq` | per-restaurant, gap-free, reserved in the same transaction as the insert (`changelogcounters`) |
| `epoch` | the writer's epoch when it was captured (section 7) |
| `coll`, `documentId`, `op` | `insert`, `update`, `replace`, `delete`, or `baseline` |
| `doc` | the whole document after the change (`fullDocument: updateLookup`); null for a delete |
| `capturedAt` | the box's clock; shown, never used for ordering |
| `eventId` | the change event's resume token, unique, so an event read twice is one entry |

Unique index `{ restaurantId, seq }`. Append-only by construction
(`appendOnlyGuardPlugin`); a test fails if an update or delete path appears in
`services`, `controllers`, `scripts` or `routes`. Never pruned.

### 3.2 The writer (`server/services/replication/changelogWriter.js`)

Tails the local change stream for the MIRROR collections only. No service in
M0 to M21 writes an outbox entry; none can forget to. Outside the request path:
a till's write commits and returns before its change reaches the stream.

The resume token is saved after each batch. On the first start, or when the
oplog no longer holds the token, it takes a **baseline**: one entry per
existing document, read after the stream was opened so nothing written
meanwhile is missed. Re-capturing is harmless: the mirror's apply is an upsert.

### 3.3 Which restaurant

From the document's `restaurantId`; for `restaurants`, its `_id`; for a delete,
from the last entry for that document.

### 3.4 Size

A busy restaurant: about 600 bills a day, each touching its order a dozen
times, its KOTs, payments, stock movements and audit lines, about 60 changes a
bill, about 36,000 entries a day at about 3 KB: **about 110 MB a day before
compression, about 40 MB on disk with WiredTiger's compression, about 15 GB a
year.** The box's 512 GB NVMe holds decades. The oplog is set to 20 GB
(`box/mongo/mongod.conf`), more than seven days of that load, so a week of
dead 4G loses nothing and the change stream still resumes.

---

## 4. Shipping up

### 4.1 The shipper (`server/services/replication/shipper.js`)

Every second, per restaurant: read up to 200 entries above the acknowledged
mark, oldest first, POST them to the mirror, and move the mark only to the
mirror's `appliedThrough`. On failure it waits 1, 2, 5, 15, 30, 60, then 120
seconds between tries. No connectivity detection: an outage is a long wait.

Lag is measured, never guessed: `entriesWaiting` and `secondsBehind` (the age
of the oldest unshipped entry), on `/network/self` and `/network/status`.

### 4.2 The receiver (`server/services/replication/receiver.js`)

In one transaction with the cursor (`replicacursors`):

- an entry at or below `appliedSeq` is skipped, so a batch sent three times
  changes the copy once;
- the first new entry must be `appliedSeq + 1`; anything else is a **gap**, and
  the copy stops there (`409 REPLICATION_GAP` with `expectedSeq`). It never skips.
- each change is a `replaceOne` with upsert by `_id`, or a `deleteOne`, through
  the driver, after checking the collection ships and the document belongs to
  the restaurant named in the signed batch.

When the mirror expects an **earlier** seq (it was wiped or restored), the
shipper rewinds and sends from there: a wiped copy rebuilds itself from seq 1.
When it expects a **later** one, an entry is missing on the box: the shipper
stops and says so (`docs/RUNBOOK.md` section 7).

### 4.3 Data-loss window

Provisional (prompt section 15 question 2, the owner's to confirm): with the
internet up, the copy is **seconds** behind. With it down, nothing leaves the
box, and what protects the data is the box itself (mirrored NVMe, UPS) and the
hourly local snapshot. P54's encrypted diary to Backblaze runs as well, every
5 minutes.

---

## 5. Transport and trust

Every replication request is canonical EJSON (types survive: an Int32 stays an
Int32 in the copy) with `X-Replication-Signature: sha256=<hex>`, an HMAC of the
exact bytes under `REPLICATION_SECRET`, the same value on both sides. Nothing
else authenticates these routes. No timestamp is signed: the box's clock may be
wrong, and every replication write is idempotent, so a replay changes nothing.
The routes answer only on a `MIRROR` (404 elsewhere), mounted before the JSON
parser with a 16 MB limit:

| Route | |
|---|---|
| `POST /api/v1/replication/batches` | apply a batch (section 4.2) |
| `POST /api/v1/replication/intake/claim` | hand the box the oldest waiting intake; also records that the box checked in |
| `POST /api/v1/replication/intake/result` | the box's outcome for one item |
| `POST /api/v1/replication/reconcile` | counts and digests for the box to compare (section 8) |

The box only ever makes outbound connections. Nothing is opened on the cafe's
router.

---

## 6. Intake: requests flow down

### 6.1 The mirror accepts, only into `intake`

On a read-only mirror these routes stop at `services/intake/intakeRoute.js`
and become an intake item; everywhere else they run exactly as before:

| Route | Source | External id (unique per restaurant) |
|---|---|---|
| `POST /public/:slug/orders` | `ONLINE_ORDER` | the guest's `idempotencyKey` |
| `POST /public/:slug/reservations` | `RESERVATION` | the guest's `idempotencyKey` |
| `POST /public/:slug/orders/:id/cancel`, `/reservations/:id/cancel` | `*_CANCEL` | sha256 of id and body |
| `POST /public/:slug/orders/:id/payment-return`, `/reservations/:id/payment-return` | `*_PAYMENT_RETURN` | sha256 of id and body |
| `POST /public/:slug/payments/webhook` | `RAZORPAY_WEBHOOK` | sha256 of the raw body |
| `POST /hooks/:provider/:webhookKey` | `PARTNER_WEBHOOK` | sha256 of provider and raw body |

Webhooks are verified before they are kept, exactly as today: Razorpay with the
cafe's sealed webhook secret (`webhookSignatureMatches`), partners by their own
adapter (`verifyWebhookSignatureOnly`, which is `receiveWebhook`'s check without
its writes). A forged one is refused and nothing is stored.

`services/intake/cloudIntake.js` imports no model but `IntakeItem`;
`tests/intake.test.js` fails if it does.

A guest's new order or booking gets `202` with an intake id and a one-time
secret. The public page polls `GET /public/:slug/intake/:id?secret=` every two
seconds for up to three minutes, then shows the order exactly as before. The
status token the box made is handed over once, to the holder of the secret,
then cleared.

**While the box has not checked in for 5 minutes, the page takes no new order
or booking** (`ONLINE_CLOSED`, "The cafe can't take online requests right
now"), before any money moves. Provisional answer to prompt section 15
question 3; `BOX_SILENT_CLOSES_PAGE_AFTER_MS` in `cloudIntake.js`. Webhooks and
a guest's cancel or payment return are always taken.

### 6.2 The box pulls and decides (`services/intake/boxIntake.js`)

Every 3 seconds: claim up to 20 items, oldest first (a claim is held two
minutes; a box that crashes mid-apply has its items claimed again), apply each
through the normal services after validating the body again with the route's
own schema, then report.

| Source | Applied through |
|---|---|
| `ONLINE_ORDER` | `onlineOrderService.place`: its reference, the staff alert, and once accepted, its order, KOT and stock deduction, as for a till |
| `RESERVATION` | `reservationService.request` |
| cancels, payment returns | `guestCancel`, `guestPaymentReturn` |
| `RAZORPAY_WEBHOOK` | `onlinePaymentService.handleWebhook` |
| `PARTNER_WEBHOOK` | `webhookService.receiveWebhook`, which queues the M21 job |

`intakeapplications` records `STARTED` before and the outcome after. Applying
again after a crash is safe because each service is idempotent on the
request's own key: one item, one order. (Edge: a re-applied order's status
token was lost with the first try; the guest is told their reference and that
live tracking is unavailable.)

### 6.3 Rejection reasons, and what the guest sees

A refusal any till would get is final: `REJECTED` with its code, never retried.

| Code | When | The guest sees |
|---|---|---|
| `VALIDATION_FAILED` | an item no longer exists, a pickup time no longer offered | "Some of the information sent was not valid." with the field |
| `ONLINE_CLOSED` | takeaway was switched off, or the cafe paused it, after the mirror last heard | the cafe's own closed message |
| `TOO_MANY_OPEN_REQUESTS` | the phone already has orders waiting | "You already have orders waiting for the cafe." |
| `ITEM_UNAVAILABLE` | the kitchen switched a dish off, or took it off the menu, after the mirror last heard | "Cold Shake is not available right now." |
| `BAD_SIGNATURE` | a webhook the box could not verify | (no guest) |

**No refund is needed for a rejected online order:** the advance is taken only
after the box has made the order (`startPayment` runs inside `place`), so a
refused order never took money. A payment that arrives for an order the cafe
then declines is refunded by P24's existing path, through the outbound jobs.

### 6.4 Outbound calls

Refunds, platform acknowledgements and Tally pushes are M21's `integrationjobs`:
persisted, claimed with a lock, retried 30 s to 2 h, `dedupeKey` unique. They
survive the box being unplugged. P62 adds no second queue; it stops the loop on
any machine that is not the writer (a read-only mirror, a fenced box), so a
refund is never sent twice.

---

## 7. One writer, and the epoch

Exactly one machine writes a restaurant's operational data at any moment.

- Each machine holds an integer **epoch** (`replicationstate.writer`), starting
  at 1. Every changelog entry and batch carries it.
- The mirror refuses a batch stamped below its epoch (`409 STALE_EPOCH`) and
  keeps it in `replicationquarantine` for a person to read; it is never applied.
- A box that receives `STALE_EPOCH` **stands down**: `fenced`, every write
  refused with `WRITER_FENCED`, by the HTTP gate and again by the model guard.
  Signing in still works, so staff can read why.
- **Promotion is a command a person runs**, never a timeout:
  `npm run replication -- promote --confirm PROMOTE` on the mirror shows each
  restaurant's last applied seq and its time, adds one to the epoch, and clears
  the read-only flag. The mirror then processes intake itself through the same
  services. `docs/RUNBOOK.md` section 6.

### 7.1 Enforcement, twice

1. `middleware/writerGate.js`, before every route: the mirror lets through only
   `MIRROR_WRITE_ALLOWLIST` (sign-in, quote, the intake routes, the replication
   routes); `tests/writerGate.test.js` walks the whole route table and fails if
   the set of writing routes it lets through is not exactly that list.
2. `models/plugins/writerGuard.js`, applied through the tenant guard to every
   tenant model and to `Restaurant`: any write to a MIRROR model throws before
   it reaches the database when this machine may not write. LOCAL_ONLY models
   (sessions, intake) are untouched.

The guest's status read on the mirror skips the two writes it makes on a box
(expiry, Razorpay read-back): those are the box's.

---

## 8. Reconciliation (`server/services/replication/reconcile.js`)

Every 30 minutes on the box, when nothing is waiting to ship: for every MIRROR
collection, the count and a SHA-256 over every document of the restaurant in
canonical EJSON sorted by `_id`, computed on each side, plus the same for the
day's bills on their own. A mismatch is stored in
`replicationstate.reconcile:<rid>` and shown to the owner and manager in the
top bar ("Cloud copy differs"), on the dashboard and on Network and devices.
Proven by changing one document directly in the copy.

---

## 9. Snapshots

- **Local, hourly:** `mongodump --oplog --gzip --archive` of the whole box by
  the `cafe-snapshot.timer`, as the backup login, into
  `BOX_DATA_DIR/snapshots/{hourly,daily,monthly}`. Kept: 24 hourly, 31 daily,
  12 monthly. Restored only with `--oplogReplay`. At about 300 MB compressed
  for a year-old restaurant: **about 20 GB at most**, on the box's disk.
- **Off-site:** P54's encrypted full copies and five-minute diary to Backblaze
  B2, run by the box, unchanged and independent of the shipper.
- **Atlas's own backups** of the mirror are a third layer, not a substitute.

`tests/replication.test.js` dumps the live test database with `--oplog`,
restores it into a fresh server with `--oplogReplay`, and compares every
collection.

---

## 10. The box on the LAN

- MongoDB Community, single-node replica set `rs0`, authentication on, bound
  to the box and the LAN only. The server refuses to start against a
  standalone (`assertReplicaSet`, from `hello().setName`).
- The server listens on port 80 and serves the screens from the same address.
- **Plain http on the LAN.** A browser drops a `Secure` cookie set by an
  `http://192.168.x.x` page, so on a `BOX`, over http only, the refresh cookie
  is not `Secure` (still httpOnly, SameSite=Lax, path-scoped, and behind the
  `X-Requested-With` check), and helmet leaves out `upgrade-insecure-requests`,
  which would otherwise send every script to an https that does not exist.
  To put the box on https instead: a certificate for a name the router's DNS
  answers locally, and a reverse proxy; the cookie is then `Secure` again by
  itself (`req.secure`).
- The clock: NTP whenever online; at boot and every minute the server compares
  its clock with its newest changelog capture and newest bill, and refuses
  every write (`CLOCK_BEHIND`) while it is more than two minutes behind.

---

## 11. Speed budget (P62 section 9)

Measured on the box, not yet on the cafe's tablets: those numbers are owed and
go into `docs/PERFORMANCE-BASELINE.md` when the box is in the cafe. The
changelog writer and shipper are outside the request path by construction
(change stream after commit; separate timers).

---

## 12. What is not built yet

- The device-side short request queue for WiFi blips of seconds (prompt
  section 12). A tap during "Cannot reach server" is not saved, and the banner
  says so.
- SSE for the kitchen screen: the kitchen already has P33's live channel
  (Socket.IO) with the poll as fallback, so P62's "replace the 10-second poll"
  is already true in a different form. Not changed.
- The in-process read cache and the PWA shell (section 9.4, 9.5): measure on
  the real tablets first.
- The physical acceptance tests (pull the plug, cut the WAN for an hour) and the
  speed budget on real hardware: they need the box in the cafe.

## 13. Two-way sync (P63)

`SYNC_MODE=TWO_WAY` on the box and on the cloud (`DEPLOYMENT_ROLE=CLOUD`): both
write, both keep a changelog (section 3, the same writer), and the box exchanges
them: every `SYNC_EVERY_SECONDS` (60) inside `SYNC_HOURS` (08:30 to 02:30 India
time), and outside them only with changes waiting, at most every 15 minutes
(`sync/pacing.js`), so Render's free server sleeps at night. Each round it pulls
the cloud's entries after `peerpull:<rid>.pulledSeq`
(`POST /replication/pull`) and applies them, then ships its own (section 4) with
`seenPeerSeq`. The cloud never calls the box. The prompt is
`docs/prompts/P63-two-way-sync.md`; the code is `server/services/sync/`.

**Applying** (`sync/applyPeer.js`) is not P62's blind replace. Per document,
`syncdocs` holds the base, the last version both sides agreed on: set when a
change from the other side is applied, and when this side's own entry is known
to have reached the other side (the box: on the cloud's acknowledgement; the
cloud: when the box's `seenPeerSeq` passes it). Then: identical is a no-op;
unchanged here since the base takes the incoming; changed on both is a
three-way merge (`sync/merge.js`), newer `updatedAt` winning a field changed both
ways, arrays of sub-documents merged by `_id`; a broken unique rule is a clash,
where the PC's document keeps its place (`sync/clashes.js`). Every merge with a
field changed both ways, every clash, and a delete of something changed here,
records a `syncconflicts` document.

**No echo.** A document written from the other side records its hash in
`syncdocs.appliedHashes`; the changelog writer leaves out a change whose
document has one of those hashes. A merged result is not recorded, so it goes
back and both sides converge.

**Superseded entries.** After time apart a side can hold a change it recorded,
then take the other side's later version of the same document before its own
change went over. Sending that older change would put the old version back. So
an entry whose document here now holds a version that came from the other side
(its hash is in `appliedHashes`) is sent with `superseded: true`: its seq still
goes over, keeping the cursor gap-free, and the receiver skips it
(`flagSuperseded` in `sync/exchange.js`, on push and on pull).

**A baseline taken again** (Render waking and unable to resume its change
stream) leaves out every document whose current version is its `syncdocs` base,
so it records only what really changed and Atlas does not grow by every
document each time.

**One record per conflict.** A conflict still open (not marked seen) for the same
document and kind is brought up to date, not recorded again.

**Before applying**, the side pumps its own change stream, so a change made a
moment before is in the changelog and in the base comparison.

**Numbers.** One series (2026-10-22): the website numbers bills, orders, KOTs,
online orders and bookings from the same counters as the PC. A counter changed on
both keeps the higher value; two records with one number keep the PC's, and the
website's is renumbered with the next free number, its copies with it
(`sync/numberClashes.js`, API-CONTRACT "P63" section 2).

**What runs where while `TWO_WAY`.** Box: changelog writer, pusher, puller, no
intake puller, no integration job loop, no reconciliation (two writers diverge
for seconds by design). Cloud: changelog writer, the replication routes, the
integration job loop, P54 backups. Day Close only on the box.

**Rollback.** `SYNC_MODE=ONE_WAY` on both, then P62's section 17.5 decides who
writes.

