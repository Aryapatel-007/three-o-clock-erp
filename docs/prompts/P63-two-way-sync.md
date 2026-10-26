# P63. Two-way sync: the cafe PC and the website both take bills

Asked for by Rishi, 2026-10-21, in the Cafezza-Offline repository:

> the vercel website should work as it is, the local should work, when there is
> internet ... the local will update instantly to atlas, so both local and vercel
> website have same database atlas, plus local database ... these 3 should be in
> total sync, instantly; when there is no internet the local should work and
> store data locally and when the internet comes it should sync to atlas; for
> example 3 devices working together, 2 running locally on wifi and 1 on atlas,
> this should also be handled.

Asked which rule holds while the cafe's internet is down, Rishi chose **both keep
billing** over "the website waits", knowing it needs two invoice series and that
conflicts are flagged for staff rather than prevented. Built here first, then on
the test site; the live Caffeza repository is changed only after that.

Depends on P62 (the box, the changelog, the shipper and the receiver).

## 1. What changes

P62 has one writer at a time: the box, with the cloud as a read-only mirror.
P63 adds `SYNC_MODE=TWO_WAY`, set on both the box (`DEPLOYMENT_ROLE=BOX`) and the
cloud (`DEPLOYMENT_ROLE=CLOUD`, the Render server the website uses). Then:

1. Both write. Devices on the cafe WiFi use the box; the website uses the cloud.
2. Both keep a changelog of their own changes (the P62 change-stream writer).
3. The box, every second while it can reach the cloud, **pulls** the cloud's new
   changes and applies them, then **pushes** its own. The cloud never calls the
   box. Offline, each side keeps its changes; the first round after the line
   comes back exchanges them in order.
4. A change applied from the other side is never sent back (no echo).

`SYNC_MODE=ONE_WAY`, the default, is P62 exactly.

## 2. Numbers that can never clash

While `TWO_WAY`, the cloud draws every number from its own series; the box keeps
the existing ones.

| Number | Box (unchanged) | Cloud |
|---|---|---|
| Bill, financial-year mode | `2026-27/000176` | `2026-27/W00001`; series `2026-27/W` |
| Bill, prefix mode | `ZC/22442` | `ZC/W1`; series `ZC/W` |
| Order, KOT, online order, booking | 1, 2, 3 ... | 900001, 900002 ... |

A website bill's `billSequence` is 900,000,000 plus its number, so the existing
unique index on `{ restaurantId, branchId, financialYear, billSequence }` holds
with no index change. The invoice register and check C6 already work per
`invoiceSeries`, so each series is checked for gaps on its own. GST allows a
supplier more than one series; **the CA confirms the W series before it is used
for real.**

Day Close happens only on the cafe PC: the cloud answers
`422 CLOSE_ON_CAFE_PC` while `TWO_WAY`. Integration jobs (WhatsApp, platforms,
Razorpay refunds) run only on the cloud, which has the internet and the
partners; the box does not run the job loop while `TWO_WAY`.

## 3. Applying a change from the other side

Each side keeps, per document, the last version both sides agreed on (the
*base*) in `syncdocs`, local to each side. For an incoming change to a document:

1. Identical to what is here: nothing to do; the base becomes it.
2. Nothing here changed since the base: take the incoming version.
3. Both changed since the base: a **three-way merge**. Field by field, a field
   only one side changed takes that side; a field both changed takes the newer
   document's value (by `updatedAt`; a tie goes to the box). Arrays of
   sub-documents with an `_id` (order lines, payments, rounds) are merged item
   by item the same way, so dishes added on both sides are all kept. When the
   same field was changed both ways, a **sync conflict** is recorded for staff.
   Bookkeeping fields (`updatedAt`, `lastLoginAt`, `version`) never count as a
   conflict.
4. A delete from the other side deletes here, unless this side changed the
   document since the base: then this side's version is kept and a conflict is
   recorded.

The merged result, when it differs from what came in, is a change on this side
and goes back the other way, so both sides end with the same document.

## 4. The same table, bill or name taken on both sides

A unique rule broken by an incoming document (a different `_id`) is a *clash*.
The cafe PC's document always keeps its place, on both sides, so both end the
same:

| Clash | The website's document becomes |
|---|---|
| One open order per table | the order stays open but stops holding the table (`occupiesTable: false`) |
| One live bill per order | voided, reason Other, note "Voided by sync: this order was also billed on the cafe PC." |
| One opening float a day | voided, the same note |
| One open shift per person | voided |
| A name (dish, category, table, station, account, ingredient) | renamed "<name> (website)" |
| A guest's mobile | kept, mobile marked `<mobile>-website` |
| A staff phone or email | switched off, phone or email marked `-website` |
| A counter | the higher value kept on the PC's counter; the website's removed |
| A dish photo, a recipe | removed (both are configuration, P24, M4) |
| Anything else | not applied here; a conflict is recorded so a person decides |

Every clash records a sync conflict.

## 5. Sync conflicts

`syncconflicts` ships both ways, so both sides list them. Owners and managers
see a count in the top bar and a list (`/sync`): what, which number or table,
what each side had, what was kept, and **Mark as seen**. Fixing anything uses
the ordinary screens (move the table, refund, void); each conflict links to its
order or bill.

## 6. Routes

- `POST /replication/pull` (cloud, `TWO_WAY`, signed like `/batches`): body
  `{ restaurantId, afterSeq, limit }`; `data { entries, newestSeq }`.
- `POST /replication/batches` also answers on the cloud while `TWO_WAY`, taking
  `seenPeerSeq` (how far the box has pulled), and applies by section 3.
- `GET /sync/status` (OWNER, MANAGER): mode, node, pushed and pulled position,
  last error, unseen conflicts.
- `GET /sync/conflicts?seen=false&page=` (OWNER, MANAGER).
- `POST /sync/conflicts/:conflictId/seen` (OWNER, MANAGER).

## 7. Setting it up

Box `.env`: `SYNC_MODE=TWO_WAY`, `MIRROR_URL=<the cloud's address>`,
`REPLICATION_SECRET=<same on both>`. Cloud (Render): `SYNC_MODE=TWO_WAY`,
`REPLICATION_SECRET=<same>`. Both start from the same data (P62's exact copy),
then each takes its changelog baseline; identical documents cost nothing.

## 8. Done when

1. A dish added on the website appears on the PC, and one added on the PC on
   the website, within a few seconds.
2. With the PC cut off, both bill; the PC's bills continue `2026-27/000176`, the
   website's are `2026-27/W00001`; after reconnecting both sides hold every bill
   and C6 passes per series.
3. Dishes added to one order on both sides while cut off are all on it after.
4. A table opened on both sides while cut off: the PC's order holds it, the
   website's is still open, flagged.
5. Nothing applied from one side is sent back to it.
6. `SYNC_MODE=ONE_WAY` behaves exactly as P62; its tests pass unchanged.
