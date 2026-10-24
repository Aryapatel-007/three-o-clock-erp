# DATABASE SCHEMA

MongoDB via Mongoose. One shared database. Tenancy by `restaurantId` on every record.

Rules that apply to every collection unless stated otherwise, from `docs/CONVENTIONS.md` section 4:

Every record has `restaurantId` and `branchId`.
Every record has `createdAt` and `updatedAt`, stored in UTC.
Every compound index starts with `restaurantId`.
Money is a whole integer of paise. Percentages are integers in basis points.

Last updated: [DATE] by [NAME]

---

# M0 Foundation

Four collections: `restaurants`, `branches`, `users`, `refreshtokens`.

---

## Important: the tenancy root exception

`restaurants` and `branches` are the tenancy roots. They cannot follow the normal rule, and this must be handled deliberately rather than worked around later.

A restaurant document does not belong to a restaurant. It **is** the restaurant. Its `_id` is the value that every other collection stores as `restaurantId`.

A branch document belongs to a restaurant but is not inside a branch. Its `_id` is the value every other collection stores as `branchId`.

Therefore:

| Collection | `baseSchema` plugin | `tenantGuard` plugin | Notes |
|---|---|---|---|
| `restaurants` | No | No | Queried by `_id`. Guard would block every legitimate query. |
| `branches` | Partial | Yes, on `restaurantId` only | Has `restaurantId`, has no `branchId`. |
| `users` | Yes | Yes | Full. |
| `refreshtokens` | Yes | Yes | Full. |

Because `restaurants` is exempt from the guard, every query against it must be reviewed by hand. There are only two legitimate patterns: lookup by `_id` taken from a verified token, and the provisioning script. Any third pattern is a bug.

`branches` needs a plugin variant that adds `restaurantId` but not `branchId`. Build it as `baseSchemaTenantRoot.js` rather than passing an option flag, so the difference is visible in the import line.

---

## 1. `restaurants`

The tenant. One document per customer restaurant.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | This is the `restaurantId` used everywhere else |
| `name` | String | yes | Trading name. Shown on screen. |
| `legalName` | String | no | Registered company name. Appears on a GST invoice. |
| `gstin` | String | no | 15 characters. Optional because a small restaurant may not be registered. |
| `fssaiLicenseNumber` | String | no | 14 digits |
| `address.line1` | String | no | |
| `address.line2` | String | no | |
| `address.city` | String | no | |
| `address.state` | String | no | |
| `address.pincode` | String | no | 6 digits |
| `contactPhone` | String | no | 10 digits |
| `contactEmail` | String | no | |
| `settings.businessDayStartsAtMinutes` | Number | yes | Integer, 0 to 1439. Minutes past midnight IST at which the business day rolls over. Default 300 (05:00 IST). Added by M5, decision log D1. |
| `settings.tax` | Object | yes | `pricingMode`, `defaultTaxRateBps`, `roundOffEnabled`. Added by M7. See section 17. |
| `settings.receipt` | Object | yes | Header lines, footer text, and three print toggles. Added by M7. See section 17. |
| `settings.inventory` | Object | yes | `lowStockAlertsEnabled`. Added by M7. See section 17. |
| `brandLogos.lightGround` | Object | no | P22. The logo for day screens, or null. See below. |
| `brandLogos.darkGround` | Object | no | P22. The logo for night screens and the sign-in brand panel, or null. See below. |
| `isActive` | Boolean | yes | Default true. Platform-controlled, not customer-controlled. |
| `createdAt` | Date | auto | UTC |
| `updatedAt` | Date | auto | UTC |

Indexes: `_id` only. No compound index needed, this collection will have tens of documents, not millions.

The `settings` object:

`settings.businessDayStartsAtMinutes` is here as of M5. See section 7 and decision log entry D1. It is an integer number of minutes past midnight IST, default 300 (05:00), configurable per restaurant through `PATCH /api/v1/restaurant`. Every attendance entry derives and stores its `businessDate` from this value at clock-in, so a shift that runs 18:00 to 01:30 is counted under the day it started.

`settings.tax`, `settings.receipt` and `settings.inventory` were added by M7,
which owns configuration for the whole project. Section 17 has every field, its
type and its default. Nothing reads them directly: `services/settingsService.js`
is the only way any module reads a setting.

M3 was originally expected to add `settings.tax`. It did not, and M7 added it
instead, which is why `tax.pricingMode` and `tax.roundOffEnabled` are stored and
deliberately not yet wired into M3's frozen tax arithmetic. Section 17 says why.

### `brandLogos` (added by P22)

The restaurant's logo, one object per slot, outside `settings` on purpose: an
image never travels with `GET /settings` and never lands in a `SETTINGS_CHANGED`
audit line. API-CONTRACT M20 section P22 has the checks and the endpoints.

| Field | Type | Default | Notes |
|---|---|---|---|
| `contentType` | String | null | `image/png`, `image/webp` or `image/jpeg`, from the file signature, never from the client |
| `data` | Buffer | null | The image bytes, at most 204,800. **`select: false`**, so `authenticate`, which loads the restaurant on every request, never reads them. Read only by `GET /restaurant/logo/:slot`. |
| `sha256` | String | null | Hex SHA-256 of `data`. The ETag, and what `/auth/me` sends so a device knows when to fetch again. |
| `width`, `height` | Number | null | Pixels, from the image header. Each 128 to 1024. |
| `sizeBytes` | Number | null | The length of `data` |
| `setAt` | Date | null | UTC |
| `setBy` | ObjectId | null | The owner who uploaded it |

Each slot is an object with every field defaulted, and a slot is empty when
`sha256` is null, so a restaurant written before P22 reads back two empty slots
without a migration. Removing a logo sets every field of the slot back to its
default; the `BRAND_LOGO_REMOVED` audit line keeps the hash, size and dimensions.

Additive. Rollback: none is needed to run an older server, which ignores the
field. To remove the data, `$unset: { brandLogos: "" }` on every restaurant.

---

## 2. `branches`

One physical outlet. Version 1 creates exactly one per restaurant and never a second.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | This is the `branchId` used everywhere else |
| `restaurantId` | ObjectId | yes | `restaurants._id` | Indexed |
| `name` | String | yes | | Defaults to `"Main"` at provisioning |
| `address.line1` | String | no | | |
| `address.line2` | String | no | | |
| `address.city` | String | no | | |
| `address.state` | String | no | | |
| `address.pincode` | String | no | | |
| `contactPhone` | String | no | | 10 digits |
| `online` | Object | no | | Added by M14 (P23): `publicSlug`, `pausedUntil`, `pausedBy`. See section 28. |
| `isActive` | Boolean | yes | | Default true |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

Indexes: `{ restaurantId: 1 }`.

No `branchId` field. Its own `_id` serves that purpose.

---

## 3. `users`

Every person who logs in. Owners, managers, and floor staff, all in one collection.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | |
| `restaurantId` | ObjectId | yes | `restaurants._id` | |
| `branchId` | ObjectId | yes | `branches._id` | Single branch in version 1 |
| `name` | String | yes | | Trimmed, 1 to 100 characters |
| `phone` | String | yes | | Exactly 10 digits, first digit 6 to 9. **Globally unique.** |
| `email` | String | no | | Optional. Lowercased. **Globally unique when present.** A second login identity: `POST /auth/login` takes it in place of phone. |
| `passwordHash` | String | yes | | bcrypt. Never returned by any endpoint. Excluded by default via `select: false`. |
| `role` | String | yes | | One of `OWNER`, `MANAGER`, `CASHIER`, `WAITER`, `KITCHEN`, `STOREKEEPER` |
| `isActive` | Boolean | yes | | Default true. There is no delete. |
| `lastLoginAt` | Date | no | | UTC. Null until first login. |
| `passwordChangedAt` | Date | no | | UTC. Used to invalidate access tokens issued before a password change. |
| `pinHash` | String | no | | bcrypt hash of a 4 to 6 digit PIN for the M5 shared-tablet clock. `select: false`. Null until set. Never returned, never logged. Added by M0-D. |
| `pinFailedAttempts` | Number | no | | `select: false`. Default 0. Consecutive failed PIN checks. Reset to 0 on a correct PIN or a PIN reset. Added by M0-D. |
| `pinLockedUntil` | Date | no | | UTC. Set when the PIN locks after 5 consecutive failures. Not a timeout: the PIN stays locked until an OWNER or MANAGER sets a new one. The date is kept for the audit line and the staff message. Added by M0-D. |
| `stationId` | ObjectId | no | `stations._id` | Added by P05. Only for `KITCHEN` users: which station their kitchen screen opens on. Null otherwise. Setting it on any other role is refused. |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

Indexes:

`{ phone: 1 }` unique. Note that this one does **not** start with `restaurantId`, and that is correct here, for the reason below.

`{ email: 1 }` unique, **partial on `email` being a string**. Same reasoning as `phone`: a login identity has to be unique across the whole platform, not per restaurant. The partial filter (`{ email: { $type: 'string' } }`) is what lets any number of users have no email while any two that do have one cannot collide. Email is lowercased by the model, so the uniqueness is case-insensitive without a collation index.

`{ restaurantId: 1, branchId: 1, isActive: 1 }` for staff lists.

`{ restaurantId: 1, role: 1 }` for permission and reporting queries.

### Why `phone` and `email` are globally unique, and what it costs

Login is phone plus password, with no restaurant selector on the login screen. If two restaurants both had a user with phone `9876543210`, the server would not know which account to check.

So a phone number identifies exactly one account across the whole platform.

The consequence is real and you should know it before it surprises you. If the same person works at two restaurants that are both your customers, they need two phone numbers. This is uncommon at owner and manager level and more common with floor staff who work two jobs.

The alternative was a restaurant code field on the login screen, which is friction on a screen used forty times a day.

This is the trade we chose. Log it in the decision log.

`email` was added as a **second** login identity, not a replacement: an owner or a manager who would rather sign in with an address they remember can, while floor staff keep using a phone. It is still optional. When it is set it obeys the same global-uniqueness rule as phone, for the same reason — login has no restaurant context, so the identifier alone has to point at one account.

### `passwordChangedAt` and access tokens

A refresh token can be revoked because it lives in the database. An access token cannot, because it is stateless and valid for 15 minutes.

`passwordChangedAt` closes that window. The `authenticate` middleware compares the token's `iat` against this field, and rejects any access token issued before the last password change.

Without this, a stolen access token keeps working for up to 15 minutes after the user changes their password in response to that exact theft.

### The PIN, and why it issues no session

M5's shared-tablet attendance clock (`POST /api/v1/attendance/station/clock`) lets a staff member clock in by tapping their name and typing a PIN, on a tablet that holds one ordinary logged-in session for the whole floor.

`authService.verifyPin({ restaurantId, branchId, userId }, pin)` checks the PIN and returns the user id on success. It issues **no token of any kind**, access or refresh. That is the property that makes a PIN safe on a device forty people touch: the worst a leaked PIN can do is record a clock event for the wrong person, which a manager corrects from the register with an audit line.

Everything that reads or writes `pinHash` lives in `services/authService.js`, the same discipline as `passwordHash`, so `grep -rn "pinHash" server/controllers/` stays empty.

A missing user, a user with no PIN, and a wrong PIN all cost one bcrypt comparison against the dummy hash and fail identically, so timing cannot tell which users exist or which have a PIN. Five consecutive failures lock the PIN until an OWNER or MANAGER resets it through `PATCH /api/v1/users/:userId/pin`. It does not unlock on its own.

There is deliberately no uniqueness constraint on a PIN within a branch. Verification takes the `userId` — the staff member taps their own tile first — so it asks "is this that person's PIN", never "whose PIN is this". A unique index on a salted bcrypt hash is not possible anyway, and an application-level check across the branch buys nothing the tap already provides.

---

## 4. `refreshtokens`

One document per active session. This is what makes logout and revocation real.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | |
| `restaurantId` | ObjectId | yes | `restaurants._id` | |
| `branchId` | ObjectId | yes | `branches._id` | |
| `userId` | ObjectId | yes | `users._id` | Indexed |
| `tokenHash` | String | yes | | SHA-256 of the raw token, hex. Indexed, unique. |
| `expiresAt` | Date | yes | | UTC. `REFRESH_TOKEN_TTL` from issue: 365 days by default (30 before 2026-10-14). |
| `revokedAt` | Date | no | | UTC. Null while active. |
| `revokedReason` | String | no | | `LOGOUT`, `LOGOUT_ALL`, `ROTATED`, `REUSE_DETECTED`, `PASSWORD_CHANGED`, `USER_DEACTIVATED` |
| `replacedByTokenHash` | String | no | | Set on rotation. Builds the chain used for reuse detection. |
| `userAgent` | String | no | | Truncated to 255 characters |
| `ipAddress` | String | no | | Stored for session review. Never written to a log line. |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

Indexes:

`{ tokenHash: 1 }` unique. Like `phone`, this deliberately does not lead with `restaurantId`, because the lookup happens before any tenant context exists. At refresh time the token is the only thing the server has.

`{ restaurantId: 1, userId: 1, revokedAt: 1 }` for listing and bulk-revoking a user's sessions.

`{ expiresAt: 1 }` as a TTL index with `expireAfterSeconds: 0`.

### The TTL index is a deliberate exception to the no-hard-delete rule

CLAUDE.md says never hard delete a bill, order, or stock entry. A refresh token is none of those. It is session state with no audit value once expired, and keeping every session record forever grows without bound for no benefit.

Mongo removes expired documents automatically. Revoked-but-unexpired tokens stay until their natural expiry, which is what makes reuse detection work.

Write this reason as a comment in the model file. Someone will otherwise read the TTL index as a rule violation and remove it.

---

## Provisioning

There is no signup endpoint. Accounts are created by a script that Arya or Rishi runs.

`npm run provision:restaurant`

It creates, in one transaction where possible:

One `restaurants` document.
One `branches` document named `"Main"`, linked to it.
One `users` document with role `OWNER`, linked to both.

It prints the owner's sign-in identity and password to the terminal once, and never stores the plain password anywhere. The password is generated unless `--password` is given; an `--email` may be set as a second login identity.

If any step fails, nothing is created. A restaurant with no owner is unusable and a user with a dangling `restaurantId` is worse.

---

## What M0 deliberately does not contain

No order, bill, or stock collection. Those belong to M2 through M4 and will be defined in this file when those modules are designed. The menu and category collections were defined by M1, and the `attendanceentries` collection by M5; all are below.

No permissions collection. Roles are a fixed enum in code. A database-driven permission system is a version 2 problem.

No audit log collection yet. M3 needs one for voids and discounts. It will be defined then, not guessed now.

---

# M1 Menu Management

Two collections: `categories` and `menuitems`.

Both are ordinary tenant collections. Neither is a tenancy root, so both apply
`baseSchemaPlugin` and then `tenantGuardPlugin` in full, and both therefore get
`restaurantId`, `branchId`, `createdAt`, `updatedAt`, the compound
`{ restaurantId, branchId }` index, and the `toJSON` transform that renames
`_id` to `id` and drops `__v`.

| Collection | `baseSchema` plugin | `tenantGuard` plugin |
|---|---|---|
| `categories` | Yes | Yes |
| `menuitems` | Yes | Yes |

---

## 5. `categories`

A menu section. "Starters", "Main Course", "Beverages".

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | |
| `restaurantId` | ObjectId | yes | From `baseSchema`. From the token, never the body. |
| `branchId` | ObjectId | yes | From `baseSchema`. From the token, never the body. |
| `name` | String | yes | Trimmed, 1 to 60 characters |
| `nameLower` | String | yes | Internal. Derived from `name`. Never in a response. |
| `displayOrder` | Number | yes | Integer, minimum 0, default 0 |
| `isActive` | Boolean | yes | Default true. This is the delete. |
| `stationId` | ObjectId | no | Added by P05. `stations._id`, the station this category's dishes are cooked at. Null routes to the default station. |
| `createdAt` | Date | auto | UTC |
| `updatedAt` | Date | auto | UTC |

Indexes:

`{ restaurantId: 1, branchId: 1, nameLower: 1 }` unique. Two categories in one
branch cannot share a name, compared case-insensitively.

`{ restaurantId: 1, branchId: 1, displayOrder: 1 }` for the ordered list read.

### Why `nameLower` exists

Case-insensitive uniqueness in Mongo otherwise needs a collation-aware index,
and a query written without the matching collation silently misses the index and
returns case-sensitive answers. A derived lowercase field makes the uniqueness
ordinary, visible in the index definition, and impossible to query around by
accident.

It is maintained by the model, not by callers, and is stripped in `toJSON`. It
is an implementation detail of the index and is not part of the API contract.

---

## 6. `menuitems`

One sellable dish. The record M2 copies from and M4 attaches a recipe to.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | M2 stores this on an order line, M4 on a recipe |
| `restaurantId` | ObjectId | yes | `restaurants._id` | From `baseSchema` |
| `branchId` | ObjectId | yes | `branches._id` | From `baseSchema` |
| `categoryId` | ObjectId | yes | `categories._id` | Must exist in the same restaurant and branch |
| `name` | String | yes | | Trimmed, 1 to 100 characters |
| `nameLower` | String | yes | | Internal, as above. Never in a response. |
| `description` | String | no | | Trimmed, maximum 500 characters |
| `priceInPaise` | Number | yes | | Integer, 0 to 100000000. Whole paise. |
| `taxRateBps` | Number | yes | | Integer, 0 to 10000. Basis points. 5% is 500. |
| `displayOrder` | Number | yes | | Integer, minimum 0, default 0 |
| `isAvailable` | Boolean | yes | | Default true. "In stock right now." |
| `isActive` | Boolean | yes | | Default true. "On the menu at all." The delete. |
| `variants` | [Variant] | yes | | Default `[]`, at most 20 |
| `addOns` | [AddOn] | yes | | Default `[]`, at most 30 |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

Indexes:

`{ restaurantId: 1, branchId: 1, nameLower: 1 }` unique.

`{ restaurantId: 1, branchId: 1, categoryId: 1, displayOrder: 1 }` for the menu
tree read.

`{ restaurantId: 1, branchId: 1, isActive: 1, isAvailable: 1 }` for the filtered
list read.

`taxRateBps` lives on the item, not in a global setting, because different
dishes are taxed differently and a zero-rated item is legitimate. CLAUDE.md's
"GST rates are settings, never hardcoded" is satisfied by the rate being data on
the record rather than a constant in code.

### `isAvailable` and `isActive` are different questions

`isAvailable` is "can I sell this right now". The kitchen flips it many times a
day and all six roles may do so.

`isActive` is "is this on the menu at all". It is the soft delete, changed rarely
and only by an owner or manager.

Collapsing them into one field would mean a cook marking paneer out of stock and
a manager removing a dish from the menu were the same event, and reinstating one
would reinstate the other.

### Subdocument: Variant

A size or portion. `_id` is on.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | **Permanent once issued.** See below. |
| `name` | String | yes | Trimmed, 1 to 40 characters. Unique within the item, case-insensitive. |
| `priceInPaise` | Number | yes | Integer, minimum 0. **Absolute price, not a delta.** |
| `isAvailable` | Boolean | yes | Default true |

### Subdocument: AddOn

An extra. `_id` is on.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | Permanent once issued, same rule as Variant |
| `name` | String | yes | Trimmed, 1 to 40 characters. Unique within the item, case-insensitive. |
| `priceInPaise` | Number | yes | Integer, minimum 0 |
| `isAvailable` | Boolean | yes | Default true |

Add-ons are typed per item on purpose. There is no shared add-on library, because
"extra cheese" on a pizza and "extra cheese" on a sandwich are different prices
and would drift apart the moment one was edited.

### Variant and add-on ids are permanent

A subdocument `_id`, once issued, is never regenerated. `PATCH /menu-items/:id`
matches incoming entries to existing subdocuments by id and updates them in
place. See API-CONTRACT.md section 5.4 for the exact rule.

M4 attaches a recipe to a `menuItemId` plus an optional `variantId`, and M2
stores a `variantId` on an open order line. Both are foreign keys into this
array. A naive array replacement that regenerated every `_id` on every edit would
silently detach a recipe from its variant the first time a manager renamed
"Half" to "Half Plate", and nothing would notice until M4 ran a deduction.

### The subdocument `toJSON` trap

`baseSchema`'s `toJSON` transform is set on the parent schema and does not
descend into `variants` or `addOns`. Without the same transform on both
subdocument schemas, a response ships an item with `id` whose variants still
carry `_id` and `__v`.

Both subdocument schemas apply the shared transform from
`models/plugins/jsonTransform.js`. There is a test asserting no response body
anywhere in the suite contains the literal string `_id`.

### Deliberately not here

No price history and no scheduled price changes. Changing a price overwrites the
old value. The 7pm order still bills at the 7pm price because M2 copies price,
name and tax rate onto the order line at creation, which is the rule in
CLAUDE.md, not because this collection keeps a history.

No combos or meal bundles. No item images. No time-based pricing.

---

# M5 Employee Attendance

One collection: `attendanceentries`.

It is an ordinary tenant collection. It is not a tenancy root, so it applies
`baseSchemaPlugin` and then `tenantGuardPlugin` in full, and therefore gets
`restaurantId`, `branchId`, `createdAt`, `updatedAt`, the compound
`{ restaurantId, branchId }` index, and the `toJSON` transform that renames
`_id` to `id` and drops `__v`.

| Collection | `baseSchema` plugin | `tenantGuard` plugin |
|---|---|---|
| `attendanceentries` | Yes | Yes |

M5 hangs off M0 alone. It never reads the menu or the ordering chain. The one
number it produces that a later module wants is minutes worked per person,
exposed as `GET /api/v1/attendance/summary` and consumed by M6 when M6 is built.

---

## 7. `attendanceentries`

One clock-in, and the clock-out that closes it, for one person. The record M6's
hours-worked report reads and any future payroll build sums.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | |
| `restaurantId` | ObjectId | yes | `restaurants._id` | From `baseSchema`. From the token, never the body. |
| `branchId` | ObjectId | yes | `branches._id` | From `baseSchema`. From the token, never the body. |
| `userId` | ObjectId | yes | `users._id` | Whose shift this is. On the self-service and station paths the server sets it; only the two manager endpoints accept it from the body. |
| `clockInAt` | Date | yes | | UTC. The server's clock at clock-in, never a time sent by a client, except on the manager create endpoint. |
| `clockOutAt` | Date | no | | UTC. `null` while the shift is open. The server's clock, or a manager correction. |
| `workedMinutes` | Number | no | | Integer whole minutes. `null` while open. Recomputed from `clockInAt` and `clockOutAt` on every write. Never supplied by a client, never patched directly. |
| `businessDate` | String | yes | | `"YYYY-MM-DD"`. The business day this shift belongs to, derived at clock-in. Never sent by a client. See below. |
| `clockInSource` | String | yes | | Enum `SELF`, `STATION`, `MANAGER`. |
| `clockOutSource` | String | no | | Enum `SELF`, `STATION`, `MANAGER`. `null` while open. |
| `corrections` | [Correction] | yes | | Default `[]`. Append only. Every manager edit, every manual creation, and the station undo write one entry. See the subdocument below. |
| `isVoided` | Boolean | yes | | Default false. The CONVENTIONS section 4 void fields. There is no delete. |
| `voidedAt` | Date | no | | UTC. Set when voided. |
| `voidedBy` | ObjectId | no | `users._id` | Set when voided. |
| `voidReason` | String | no | | Trimmed, 1 to 500 characters. Required when voiding. `MIS_TAP` is the value the station undo writes. |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

### Subdocument: Correction

One recorded change to an entry. Append only: a correction is never edited or
removed once written, because the audit trail is the point.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | |
| `correctedAt` | Date | yes | UTC. The server's clock. |
| `correctedBy` | ObjectId | yes | `users._id`. Who made the change. |
| `field` | String | yes | Enum `clockInAt`, `clockOutAt`, `CREATION`. What changed. `CREATION` marks the seed entry a manual create writes. |
| `previousValue` | String | no | The value before, as an ISO string, or `null`. |
| `newValue` | String | no | The value after, as an ISO string, or `null`. |
| `reason` | String | yes | Trimmed, 1 to 500 characters. A correction with no reason is rejected at validation, never defaulted to `""`. |

The Correction subschema applies the shared `toJSON` transform from
`models/plugins/jsonTransform.js`, the same one the M1 variant and add-on
subdocuments use, so a correction ships as `id`, not `_id`.

### Indexes

Every index starts with `restaurantId`, per CONVENTIONS section 4.

`{ restaurantId: 1, branchId: 1, userId: 1, clockInAt: -1 }` for the register
read and one person's history, both of which list a user's entries newest first.

`{ restaurantId: 1, branchId: 1, businessDate: 1 }` for the summary read, which
groups by user across a range of business days.

`{ restaurantId: 1, branchId: 1, userId: 1 }` **unique, partial on
`{ clockOutAt: null }`**. This is what makes "one open shift per person" a
database constraint rather than a race between two tablets. See below.

### Why the partial unique index, and how it is expressed

Two tablets can call `POST /attendance/clock-in` for the same person in the same
second. A service-layer "do they already have an open shift" check has a window
between its read and its write where both calls pass. The partial unique index
closes it: at most one document per `{ restaurantId, branchId, userId }` may have
`clockOutAt` null, so the second insert fails at the database and the service
turns that into a clean `409 ALREADY_CLOCKED_IN`.

The partial filter is `{ clockOutAt: null }`. MongoDB partial indexes accept
equality expressions, and equality to `null` matches both an explicitly-null
field and a missing one. They do **not** accept `$exists: false`, so an open
shift stores `clockOutAt: null`; a closed shift holds a real date and is not
covered by the index, which is why a person may have many closed entries and
only one open one. Task B verifies this `unique` + partial combination against
`mongodb-memory-server` and a real cluster, the way M1 has a test asserting its
own tenancy tripwire.

### Why `businessDate` is a string, and how it is derived

It is stored as `"YYYY-MM-DD"`, not a `Date` at UTC midnight. A business day is a
label, not an instant: it answers "which day's report does this shift land on",
and it must not change meaning when read in another timezone. A string cannot be
pulled into `Date` arithmetic or shifted by a `getTimezoneOffset()` a later
screen forgot, and it groups cleanly in the summary query.

It is derived once, at clock-in, and never recomputed: take `clockInAt` (UTC),
convert to IST, subtract `restaurants.settings.businessDayStartsAtMinutes`
(default 300), and take the calendar date of the result. A clock-in at
2026-08-29 01:30 IST with the default 05:00 boundary lands on `businessDate`
`"2026-08-28"`, so a shift that ran from 18:00 the previous evening is counted
under the evening it started. A correction to `clockInAt` does **not** move
`businessDate`; to move an entry to another day a manager voids it and recreates
it, so a day that has already been reported on stays stable.

### Why whole minutes

`workedMinutes` is an integer, for the same reason money is whole paise:
fractional hours accumulate rounding error, and two screens that round
differently disagree about someone's pay. Seconds are dropped at computation,
`workedMinutes = floor((clockOutAt - clockInAt) / 60000)`. Task B has real tests
on this arithmetic, including a shift that crosses midnight and one that crosses
the configured business-day boundary, because a quiet bug here is the
money-and-GST equivalent for this module.

### `corrections[]` is embedded, not a shared audit collection

BUILD-PLAN section 7 requires an audit trail on a corrected attendance entry:
who, when, why. There is no shared audit-log collection in the project yet, and
DB-SCHEMA already says M3 will define one for voids and discounts. Rather than
build a general audit collection speculatively, M5 embeds the trail on the entry
as `corrections[]`. When M3 designs the shared collection it decides whether to
pull these in or leave them. This is a deliberate call, decision log D3, not an
oversight.

### Nobody corrects their own entry

A correction, void, or manual create whose actor is the entry's own `userId` is
refused with `422 SELF_CORRECTION_FORBIDDEN`. The audit trail exists because
BUILD-PLAN section 7 calls it the feature that catches a dishonest insider; a
manager who can silently extend their own shift defeats it. This binds an OWNER
too, which is why it is a 422 business rule and not a 403: 403 means not you, 422
means not this by anyone, the M0-C split. A single-owner restaurant therefore
cannot fix its own entries; that cost is accepted, decision log D4. The one
exception is the station undo, described in API-CONTRACT.md section 8.

### An open shift is never auto-closed

A shift left open past 12 hours is almost always a forgotten clock-out. The
server never writes a clock-out time it invented: an auto-close puts a fictional
number into a payroll record. Instead the entry is flagged in the register read
(`requiresAttention: true`) and a manager closes it with a correction and a
reason, decision log D5. The 12-hour threshold is a server constant, not an
environment variable and not client logic.

### Dependency: the staff PIN

`POST /attendance/station/clock` is the shared-tablet path: a staff member taps
their name and types a PIN, and the server records a clock event without issuing
any session. It uses the per-user PIN credential defined in **section 3**
(`users.pinHash`, `pinFailedAttempts`, `pinLockedUntil`), delivered by M0-D.

`attendanceService.stationClock` calls `authService.verifyPin`, which returns
the user id on success and throws `InvalidPinError` / `PinLockedError`
otherwise. It issues no token, so a leaked PIN buys a clock event and nothing
that outlives the request. There is no PIN uniqueness constraint within a
branch: verification takes the `userId` (the person taps their own tile first),
so it asks "is this that person's PIN", never "whose PIN is this".

### Deliberately not here

No `breakMinutes` or paid/unpaid break tracking. A break is a clock-out and a
later clock-in in version 1.

No scheduled shifts or rosters. This collection records what happened, not what
was planned.

No geolocation or device fingerprint on a clock event. The PIN plus the tablet's
own logged-in session is the control.

No `hourlyRateInPaise` or any pay figure. Attendance produces minutes. Turning
minutes into money is payroll, which BUILD-PLAN excludes from version 1.

No pay-period or `businessWeek` field. The summary endpoint takes an explicit
date range; a pay period is payroll's concept to impose later.

---

# M2 Order Taking and KOT

Owner: Rishi.

Four collections: `tables`, `orders`, `kots`, `counters`.

**On the section numbers.** These are 8 to 11 even though M2 was built before
M5, because this section was written *after* M5's. M2 shipped without a
DB-SCHEMA section at all, which broke the precedent M1 and M5 both set, and this
is the backfill. It documents the collections exactly as they were built and
merged; nothing here is a proposal. `attendanceentries` stays section 7 because
four places in this file and in API-CONTRACT.md already point at that number.

All four are ordinary tenant collections. None is a tenancy root, so all four
apply `baseSchemaPlugin` and then `tenantGuardPlugin` in full.

| Collection | `baseSchema` plugin | `tenantGuard` plugin |
|---|---|---|
| `tables` | Yes | Yes |
| `orders` | Yes | Yes |
| `kots` | Yes | Yes |
| `counters` | Yes | Yes |

---

## 8. `tables`

One table on the floor: a name, a section and a seat count, and from P19 an
optional place on its section's floor plan.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | `orders.tableId` points here |
| `restaurantId` | ObjectId | yes | From `baseSchema` |
| `branchId` | ObjectId | yes | From `baseSchema` |
| `name` | String | yes | Trimmed, 1 to 20 characters. "T1", "Garden 4". |
| `nameLower` | String | yes | Internal. Derived from `name`. Never in a response. |
| `section` | String | no | Trimmed, max 40 characters. "Garden", "AC Hall". Null when unset. |
| `seats` | Number | no | Integer 1 to 50. Null when unset. |
| `displayOrder` | Number | yes | Integer, minimum 0, default 0 |
| `isActive` | Boolean | yes | Default true. This is the delete for a table that has been used. A table no order has ever been on can be removed outright (API-CONTRACT 11.6, added 2 October 2026). |
| `layout` | Object | no | P19. Default null: no place on a floor plan yet. `{ x, y, w, h, shape }` on the section's 24 by 16 grid: `x` 0 to 23, `y` 0 to 15, `w` and `h` 1 to 4, `x + w` at most 24, `y + h` at most 16, `shape` `SQUARE`, `ROUND` or `LONG` (a `LONG` table has `w` and `h` different). Overlaps are refused by `PATCH /tables/layout`. |
| `createdAt` | Date | auto | UTC |
| `updatedAt` | Date | auto | UTC |

Indexes:

`{ restaurantId: 1, nameLower: 1 }` unique. Two tables in one restaurant cannot
share a name, compared case-insensitively.

`{ restaurantId: 1, branchId: 1, isActive: 1, displayOrder: 1 }` for the floor
read.

`nameLower` is the same derived-field technique M1 uses for categories and menu
items, and for the same reason: a collation-aware unique index is only honoured
by queries that specify the same collation, and one written without it silently
answers case-sensitively. Three collections now do this identically.

**A table has no `status` field, and that is deliberate.** Whether a table is
occupied is derived on read from whether an order with an occupying status
points at it. A stored occupancy flag drifts the first time a process dies
mid-write, and then a table is permanently occupied with no order on it and only
a database edit clears it.

---

## 9. `orders`

The record M3 bills from and M4 deducts stock from. The most important
collection in the project after `menuitems`.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | `bills.orderId` will point here |
| `restaurantId` | ObjectId | yes | `restaurants._id` | From `baseSchema` |
| `branchId` | ObjectId | yes | `branches._id` | From `baseSchema` |
| `orderNumber` | Number | yes | | Sequential per restaurant, from `counters`. Never reused. **Gaps are acceptable here.** |
| `orderType` | String | yes | | Enum `DINE_IN`, `TAKEAWAY`, `DELIVERY`. `DELIVERY` appended by P06. |
| `platform` | Object | no | | Added by P06. `{ code, name, orderId }` for a `DELIVERY` order, null otherwise. `code` from `server/config/platforms.js`, `name` frozen from that list, `orderId` the platform's own number, 3 to 40 letters and digits. |
| `taxTreatment` | String | yes | | Added by P06. `NORMAL` or `PLATFORM_COLLECTS`, default `NORMAL`. Set once when the order is created and never changed. |
| `tableId` | ObjectId | no | `tables._id` | Null on a takeaway |
| `tableName` | String | no | | Snapshot, so renaming a table does not rewrite last month's orders |
| `guestCount` | Number | no | | Integer 1 to 100. Null when unset. |
| `customerName` | String | no | | Trimmed, max 100 characters |
| `customerPhone` | String | no | | Trimmed |
| `status` | String | yes | | Enum `OPEN`, `READY_TO_BILL`, `BILLED`, `CANCELLED`, `NO_CHARGE`. `NO_CHARGE` appended by P07, built in P08. |
| `noCharge` | Object | no | | Added by P07. Null unless the status is `NO_CHARGE`: `{ reasonCode, note, approvedBy, at, businessDate, valueInPaise }`. `reasonCode` from `server/config/noChargeReasons.js`. `valueInPaise` is the sum of the order's live line totals at menu price, before GST, frozen at that moment. `businessDate` from `at` by `businessDateFor`. |
| `version` | Number | yes | | Optimistic concurrency. Starts at 1. See below. |
| `lines` | [OrderLine] | yes | | Default `[]`. Append only; a line is never removed. |
| `openedBy` | ObjectId | yes | `users._id` | |
| `openedAt` | Date | yes | | UTC |
| `readyToBillAt` | Date | no | | UTC. Set when the last line is served. |
| `reopenedFromBillId` | ObjectId | no | `bills._id` | P26. Default null. The bill voided by `POST /bills/:billId/reopen`, whose discount and payments the next bill of this order carries. Cleared when that bill is made. |
| `billId` | ObjectId | no | `bills._id` | **Reserved for M3. Null until billed. M2 never sets it.** |
| `isCancelled` | Boolean | yes | | Default false |
| `cancelledAt` | Date | no | | UTC |
| `cancelledBy` | ObjectId | no | `users._id` | |
| `cancelReason` | String | no | | Trimmed, max 200 characters. From P04 it holds the optional note. Older orders keep their free text here. |
| `cancelReasonCode` | String | no | | Added by P04. Enum from `ORDER_CANCEL_REASONS` in `server/config/cancelReasons.js`. Null on orders cancelled before P04. |
| `occupiesTable` | Boolean | yes | | Internal, never in a response. See below. |
| `origin` | Object | no | | Added by M14 (P23). Null, or `{ kind, id, reference, pickupAt }` when the order came from an online request or a reservation. See section 28. |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

### Subdocument: OrderLine

`_id` is on. **Every field from `itemName` down to `addOns` is a snapshot**
taken from the menu item when the line was created. Nothing downstream reads a
price back out of `menuitems`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | `kots.lines[].orderLineId` and M4's deduction key point here |
| `menuItemId` | ObjectId | yes | Reference only, for M6 reporting. **Never read for a price.** |
| `itemName` | String | yes | Snapshot of the item name |
| `variantId` | ObjectId | no | The variant subdocument id from the menu item. M4 attaches recipes to it. Null when no variant. |
| `variantName` | String | no | Snapshot. Null when no variant. |
| `unitPriceInPaise` | Number | yes | Integer paise. The variant's price when one was chosen, otherwise the item's base price. |
| `taxRateBps` | Number | yes | Integer basis points. **M3 reads this, not the live menu.** Same name as `menuitems.taxRateBps`, which it is copied from. |
| `quantity` | Number | yes | Integer 1 to 999 |
| `addOns` | [LineAddOn] | yes | Default `[]` |
| `notes` | String | no | Trimmed, max 200 characters. "No onion." |
| `status` | String | yes | Enum `PENDING`, `FIRED`, `READY`, `SERVED`, `CANCELLED` |
| `kotId` | ObjectId | no | `kots._id`. Null until fired. |
| `addedBy` | ObjectId | yes | `users._id` |
| `addedAt` | Date | yes | UTC |
| `firedAt` | Date | no | UTC |
| `readyAt` | Date | no | UTC |
| `servedAt` | Date | no | UTC |
| `cancelledAt` | Date | no | UTC |
| `cancelledBy` | ObjectId | no | `users._id` |
| `cancelReason` | String | no | Trimmed, max 200 characters. From P04 it holds the optional note; older lines keep their free text. |
| `cancelReasonCode` | String | no | Added by P04. Enum from `LINE_CANCEL_REASONS`. Null on lines cancelled before P04. |
| `wasPrepared` | Boolean | no | **The cancelled-item answer.** Required when cancelling a line that reached the kitchen, refused when cancelling one that did not. M4 reads it to decide whether the ingredients are gone. |
| `categoryId` | ObjectId | no | Added by P03. `categories._id` of the menu item's category **when the line was added**. Null on lines added before P03. |
| `categoryName` | String | no | Added by P03. That category's `name` when the line was added. Null on lines added before P03, or if the category could not be found. |
| `menuTaxRateBps` | Number | no | Added by P06. The item's own GST rate, kept for reference when the line itself is frozen at 0% on a `PLATFORM_COLLECTS` order. Null on `NORMAL` orders. |

`categoryId` and `categoryName` are frozen at add time for the same reason price
and name are: if a dish moves category between the order and the bill, the sale
belongs to the category it was ordered under. Reports never read today's
category for an old sale.

### Subdocument: LineAddOn

`_id: false`, on purpose. Nothing addresses one of these by id: an add-on is
changed by cancelling the line and adding a new one, because changing what was
ordered is not an edit.

| Field | Type | Required | Notes |
|---|---|---|---|
| `addOnId` | ObjectId | yes | Points back at the menu item's add-on subdocument, for reporting. Never read for a price. |
| `name` | String | yes | Snapshot |
| `priceInPaise` | Number | yes | Integer paise. Snapshot. |

**An add-on carries no tax rate of its own, and that is a decision, not an
omission.** It is taxed at the parent line's `taxRateBps`. Under GST an add-on
is naturally bundled with the dish it is attached to — a composite supply — and
a composite supply takes the rate of its principal supply. Extra cheese on a 5%
dish is taxed at 5% even if cheese sold alone would not be.

M3 must not look for a rate here, and nobody should add one without changing
the tax code at the same time: a second rate on the same line would break the
per-slab grouping M3 does, because one line would belong to two slabs.

### Derived money fields, computed on read and stored nowhere

Neither of these is a column in this collection. Both are computed by
`serialiseOrder` in `services/orderService.js` every time an order is read, and
both appear in every order response.

`lineTotalInPaise`, on each line:

```
lineTotalInPaise = (unitPriceInPaise + sum of every addOns[].priceInPaise) * quantity
```

Add-ons are added to the unit price *before* multiplying by quantity, so three
paneer tikkas with extra cheese are charged for three lots of cheese. Every
input is a whole-paise integer and the multiplication is exact, so there is no
rounding at this stage and no opportunity for one.

`totals`, on the order:

```json
{ "subtotalInPaise": 72000, "lineCount": 3 }
```

`subtotalInPaise` sums `lineTotalInPaise` over every line that is **not**
`CANCELLED`. A cancelled line keeps its snapshot and stays in the array as
evidence, but nobody is paying for it, so it counts towards neither number.
`lineCount` counts the same live lines.

**This is not a bill.** No tax, no discount, no rounding, no service charge. M3
owns every one of those, and M2 deliberately does not preview them: two pieces
of code that both work out a total will eventually disagree by a rupee and
nobody will trust either. M3's taxable base is built from `lineTotalInPaise`
grouped by the line's `taxRateBps`.

### Indexes

`{ restaurantId: 1, branchId: 1, status: 1, createdAt: -1 }` for the floor and
list reads.

`{ restaurantId: 1, orderNumber: 1 }` unique.

`{ restaurantId: 1, tableId: 1 }` **unique, partial on `{ occupiesTable: true }`**.
`branchId` is deliberately not in the key: the constraint is one live order per
table, and a table already belongs to exactly one branch, so adding `branchId`
would only weaken it if a table document were ever duplicated across branches.
This is what makes "one open order per table" a database constraint rather than
a race between two tablets.

`{ restaurantId: 1, 'lines.menuItemId': 1 }` for M6 reporting and for the M1
guard on removing a variant that an open line still points at.

### The platform order index (P06)

`{ restaurantId: 1, 'platform.code': 1, 'platform.orderId': 1 }` **unique, partial
on `{ 'platform.orderId': { $type: 'string' }, isCancelled: false }`**. One live
order per platform order number, so the same Swiggy order typed in twice is
refused by the database rather than by a check-then-write. A cancelled order
frees its number, so a mistyped entry can be cancelled and entered again. The
duplicate is reported as 409 `DUPLICATE` naming the existing order number.

### Tax treatment (P06)

When a `DELIVERY` order is created with a platform from the list and
`settings.delivery.platformCollectsGst` is true, the order is
`PLATFORM_COLLECTS`, and every line added to it is frozen at `taxRateBps: 0` with
the item's own rate kept in `menuTaxRateBps`. The tax arithmetic is untouched:
it sees 0% lines and produces a 0% slab. Every other order is `NORMAL`.

### `version`, and the only legal way to write an order

`version` is optimistic concurrency. It starts at 1 and the server increments it
on every successful write. It is **not** Mongoose's `__v`, which is about array
positions.

Every write puts the version in the update filter and never reads-then-compares:

```js
findOneAndUpdate({ _id, restaurantId, version }, { ..., $inc: { version: 1 } })
```

A null result is separated into 404 and 409 by one extra scoped read.
`applyVersionedUpdate` in `services/orderService.js` is the only way an order is
written. A read-modify-save reintroduces exactly the lost update the field
exists to prevent, so do not add one.

This is half the answer to the two waiters problem from BUILD-PLAN section 8.
The other half is the partial unique index above.

### `occupiesTable`, and why it exists

It mirrors `status`: true for `OPEN` and `READY_TO_BILL`, false for `BILLED` and
`CANCELLED`. It is internal and never appears in a response.

It exists for one reason. MongoDB's `partialFilterExpression` does not support
`$in`: it accepts one at index-creation time without complaint and then silently
matches nothing, so the unique index looks right and enforces nothing. Equality
is supported, so the partial index filters on this boolean instead of on
`status` directly.

Ordinary queries are free to keep using `status: { $in: OCCUPYING_ORDER_STATUSES }`,
because `$in` works fine outside a `partialFilterExpression` — it is only broken
there. Two `pre` hooks keep the boolean in sync, so no call site has to remember
to set a second field alongside `status`.

**A table is occupied by `OPEN` and by `READY_TO_BILL`, not by `OPEN` alone.**
The customers are still sitting there, unbilled, until a bill exists.
`OCCUPYING_ORDER_STATUSES` in `models/Order.js` is the single definition; the
partial index, the `GET /tables` occupancy lookup, the `TABLE_OCCUPIED` check
and the table-deactivation guard all read from it.

### What M3 must know

`billId` and the `BILLED` status are reserved and untouched. M2 never writes
either. Setting them is M3's job, and it must go through `applyVersionedUpdate`
or an equally version-safe write.

A bill copies `itemName`, `unitPriceInPaise` and `taxRateBps` **from the order
line**, which already copied them from the menu. The bill never reads
`menuitems`. Not for a name, not for a price, not for a tax rate.

The tax rate is called `taxRateBps` on both the menu item and the order line, so
the copy is name-for-name. It was not always: M2 shipped the line field as
`taxRateBasisPoints` and it was renamed on 2026-08-30, before M3 read either,
so that one quantity has one name. `unitPriceInPaise` and `priceInPaise` still
differ, and that difference is meaningful rather than accidental: the line price
is the *chosen variant's* price, which is not always the item's base price.
CONVENTIONS section 2 now carries the one-name-per-quantity rule.

Cancelled lines keep every snapshot value, because a cancelled line is evidence.
A bill must exclude them from its totals; a sales figure that includes cancelled
lines is the soft-delete leak from BUILD-PLAN section 8.

---

## 10. `kots`

One kitchen ticket. Produced by firing an order; never edited afterwards except
to mark lines ready or cancelled.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | |
| `restaurantId` | ObjectId | yes | `restaurants._id` | From `baseSchema` |
| `branchId` | ObjectId | yes | `branches._id` | From `baseSchema` |
| `kotNumber` | Number | yes | | Sequential per restaurant, from `counters`. Gaps acceptable. |
| `orderId` | ObjectId | yes | `orders._id` | |
| `orderNumber` | Number | yes | | Snapshot, so the ticket reads without a join |
| `orderType` | String | yes | | Enum `DINE_IN`, `TAKEAWAY`, `DELIVERY`. Snapshot. |
| `tableName` | String | no | | Snapshot |
| `lines` | [KotLine] | yes | | Default `[]` |
| `firedBy` | ObjectId | yes | `users._id` | |
| `firedAt` | Date | yes | | UTC |
| `stationId` | ObjectId | no | `stations._id` | Added by P05. Frozen when the KOT is created. Null when the restaurant has no active stations. |
| `stationName` | String | no | | Added by P05. The station's name, frozen at the same moment, so renaming a station never rewrites a printed ticket. |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

### Subdocument: KotLine

| Field | Type | Required | Notes |
|---|---|---|---|
| `orderLineId` | ObjectId | yes | `orders.lines[]._id` |
| `itemName` | String | yes | Snapshot |
| `variantName` | String | no | Snapshot |
| `quantity` | Number | yes | Integer, minimum 1 |
| `addOnNames` | [String] | yes | Default `[]`. Names only: the kitchen does not need prices. |
| `notes` | String | no | Trimmed, max 200 characters |
| `status` | String | yes | Enum `PENDING`, `READY`, `CANCELLED` |
| `readyAt` | Date | no | UTC |
| `changedAt` | Date | no | P42. UTC. Default null. When a sent line's quantity or note was changed. |

Indexes: `{ restaurantId: 1, branchId: 1, createdAt: 1 }` for the kitchen
display, `{ restaurantId: 1, orderId: 1 }`, and
`{ restaurantId: 1, kotNumber: 1 }` unique.

**A KOT carries no money.** No price, no tax rate, no total. The kitchen needs
to know what to cook, and a ticket that carries prices is a ticket that can
disagree with the bill.

**A ticket's own status is derived from its lines**, not stored. A partly-ready
ticket is a real state and storing a rollup would let it drift from the lines it
summarises.

Cancelling a fired order line also cancels its matching KOT line. Without that
the kitchen keeps cooking a dish the floor already voided.

---

## 11. `counters`

Atomic sequence generator. Written only by `services/counterService.js`. There
is no controller and no route for this collection, and nothing reads it directly.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | |
| `restaurantId` | ObjectId | yes | From `baseSchema` |
| `branchId` | ObjectId | yes | From `baseSchema` |
| `name` | String | yes | Enum `ORDER`, `KOT`. Closed, like the role list. |
| `value` | Number | yes | The last number issued. Starts at 0, so the first number handed out is 1. |
| `createdAt` | Date | auto | UTC |
| `updatedAt` | Date | auto | UTC |

Index: `{ restaurantId: 1, branchId: 1, name: 1 }` unique. Two counter documents
for the same sequence would each hand out numbers without knowing about the
other, which is the exact duplicate this collection exists to prevent.

### `BILL` is deliberately absent from the enum, and M3 cannot copy this pattern

A number is reserved by incrementing the counter document, and the order or KOT
is written afterwards. If that write fails, the number is spent and the sequence
has a hole in it.

For order numbers and kitchen ticket numbers that is fine. Nobody audits a
kitchen ticket sequence and a missing number costs nothing.

For bill numbers it is not fine. CLAUDE.md requires bill numbers to be
sequential and never reused, and BUILD-PLAN section 8 names the gap problem
directly: a hole in a bill sequence is a question from an auditor that nobody
can answer. M3 must reserve the number **inside the same transaction that
inserts the bill**, so both commit or neither does, rather than incrementing
first and writing second.

The reasoning is written out in full at the bottom of `models/Counter.js` so M3
does not reuse this by accident.

### Deliberately not here

No floor plan, table coordinates or table merging. One order to one table.

No split bills, item transfers between tables, or course timings.

No printed-KOT record. Firing produces a `kots` document; whether a physical
ticket was printed is not tracked in version 1.

---

# M3 Billing with GST

Owner: Rishi.

Two collections: `bills` and `auditlogs`, plus one additive change to M2's
`counters`.

Both are ordinary tenant collections, `baseSchemaPlugin` then
`tenantGuardPlugin` in full. Neither is a tenancy root.

| Collection | `baseSchema` plugin | `tenantGuard` plugin |
|---|---|---|
| `bills` | Yes | Yes |
| `auditlogs` | Yes | Yes |

**Menu prices are tax-exclusive.** `menuitems.priceInPaise` is the price before
tax, and GST is computed and added on top. This is decision D1 and it follows
from M1 already storing `priceInPaise` and `taxRateBps` as separate fields. It
is the single assumption a chartered accountant must confirm before a pilot; see
the known problems table.

---

## 12. `bills`

One bill for one order. The document a customer is handed and an auditor asks
about.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | `orders.billId` points here |
| `restaurantId` | ObjectId | yes | `restaurants._id` | From `baseSchema` |
| `branchId` | ObjectId | yes | `branches._id` | From `baseSchema` |
| `billNumber` | String | yes | | The printed number, `"2026-27/000148"`. Unique per restaurant. Never reused. |
| `financialYear` | String | yes | | `"2026-27"`. Indian FY, 1 April to 31 March. The sequence resets here and nowhere else. |
| `billSequence` | Number | yes | | The integer behind `billNumber`, 1 upwards within a financial year. Stored so a gap can be found by arithmetic rather than by parsing strings. In `PREFIX` mode (P02) it is the prefix series' running number, which does not reset each year. |
| `invoiceSeries` | String | no | | Added by P02. The series the number belongs to: the financial year, like `"2026-27"`, in `FINANCIAL_YEAR` mode, or the prefix, like `"CFA/C/"`, in `PREFIX` mode. `null` on bills created before P02, meaning the financial year series. The M19 invoice register groups by it. |
| `orderId` | ObjectId | yes | `orders._id` | One bill per order. See the partial unique index below. |
| `orderNumber` | Number | yes | | Snapshot, so a bill reads without a join |
| `orderType` | String | yes | | Enum `DINE_IN`, `TAKEAWAY`, `DELIVERY`. Snapshot. |
| `platform` | Object | no | | Added by P06. Copied from the order: `{ code, name, orderId }`, or null. Report C5 groups delivery bills by `platform.code`. |
| `taxTreatment` | String | no | | Added by P06. Copied from the order. A bill from before P06 reads as `NORMAL`. |
| `tableName` | String | no | | Snapshot |
| `businessDate` | String | yes | | `"YYYY-MM-DD"`, derived once at creation by `businessDateFor`. Never recomputed. |
| `status` | String | yes | | Enum `UNPAID`, `PAID`, `ON_ACCOUNT`. A voided bill keeps its last status and sets `isVoided`. `ON_ACCOUNT` appended by P07, built in P09: the bill was charged to an On Hold account. |
| `account` | Object | no | `accounts._id` | Added by P07. `{ accountId, accountName }` when charged to an account, else null. The name is frozen. |
| `chargedToAccountInPaise` | Number | no | | Added by P07. Bill total minus what was already paid when it was charged. Null unless charged. |
| `chargedAt` | Date | no | | Added by P07. UTC. |
| `chargedBy` | ObjectId | no | `users._id` | Added by P07. |
| `lines` | [BillLine] | yes | | Copied from the order's live lines at creation. Frozen. |
| `subtotalInPaise` | Number | yes | | Sum of `lineTotalInPaise` over `lines`. Pre-tax, pre-discount. |
| `discount` | Discount | no | | Null when none. See the subdocument. |
| `taxBreakdown` | [TaxSlab] | yes | | One row per distinct `taxRateBps`. The printed CGST/SGST lines. |
| `totalTaxInPaise` | Number | yes | | Sum of `taxBreakdown[].taxInPaise` |
| `roundOffInPaise` | Number | yes | | Signed, −49 to +50. What was added to reach a whole rupee. |
| `grandTotalInPaise` | Number | yes | | `subtotal − discount + totalTax + roundOff`. A whole multiple of 100. |
| `payments` | [Payment] | yes | | Default `[]` |
| `amountPaidInPaise` | Number | yes | | Sum of `payments[].amountInPaise`. Default 0. |
| `billedBy` | ObjectId | yes | `users._id` | Who created it |
| `billedAt` | Date | yes | | UTC |
| `paidAt` | Date | no | | UTC. Set when `amountPaid` first reaches `grandTotal`. |
| `isVoided` | Boolean | yes | | Default false. The CONVENTIONS section 4 void fields. |
| `voidedAt` | Date | no | | UTC |
| `voidedBy` | ObjectId | no | `users._id` | |
| `voidReason` | String | no | | Trimmed, at most 500 characters. From P04 it holds the optional note, required only for `OTHER`. Older bills keep their free text. |
| `voidReasonCode` | String | no | | Added by P04. Enum from `BILL_VOID_REASONS`. Null on bills voided before P04. |
| `captainId` | ObjectId | no | `users._id` | Added by P03. `orders.openedBy`, frozen at bill creation. "Captain" is the person who opened the order (GLOSSARY section 8). Null on bills created before P03. |
| `captainName` | String | no | | Added by P03. The captain's `name`, read when the bill is created, or `"Unknown"` if the user cannot be found. Renaming the user later does not change it. |
| `guestCount` | Number | no | | Added by P03. `orders.guestCount`, frozen. Covers. Null on a takeaway and on bills created before P03. |
| `orderOpenedAt` | Date | no | | Added by P03. `orders.openedAt`, frozen. UTC. For table time. |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

### Subdocument: BillLine

Copied from the order line at bill creation, which had already copied from the
menu. `_id: false`: nothing addresses a bill line individually, because a bill
is never edited.

| Field | Type | Required | Notes |
|---|---|---|---|
| `orderLineId` | ObjectId | yes | `orders.lines[]._id`, for tracing back |
| `menuItemId` | ObjectId | yes | Reference only, for M6 |
| `itemName` | String | yes | Snapshot of a snapshot |
| `variantName` | String | no | Snapshot |
| `addOnNames` | [String] | yes | Default `[]`. Names only; their prices are already inside `lineTotalInPaise`. |
| `quantity` | Number | yes | Integer |
| `unitPriceInPaise` | Number | yes | Integer paise, including add-ons: the per-unit price actually charged |
| `taxRateBps` | Number | yes | Integer basis points. The slab this line falls in. |
| `lineTotalInPaise` | Number | yes | `unitPriceInPaise * quantity`. Stored, not derived, because a bill is frozen. |
| `categoryId` | ObjectId | no | Added by P03. Copied from the order line. Null for lines on orders created before P03. |
| `categoryName` | String | no | Added by P03. Copied from the order line. Same. |
| `discountShareInPaise` | Number | no | Added by P03. This line's share of the bill discount. Integer, 0 or more. |
| `taxableInPaise` | Number | no | Added by P03. `lineTotalInPaise − discountShareInPaise`. Line net sales. |
| `taxInPaise` | Number | no | Added by P03. This line's share of its tax rate's GST. Integer, 0 or more. |

**Line shares (P03).** The three share fields are written on every bill created
or re-discounted from P03 onwards, by `allocateLineShares` in
`server/utils/tax.js`. Inside each tax rate on the bill, separately: the rate's
discount (the sum of its line totals minus the slab's `taxableInPaise`) is split
across its lines in proportion to line total, by the largest remainder method —
whole paise rounded down, then the paise left over one at a time to the largest
leftover fractions, ties to the earlier line. The slab's `taxInPaise` is then
split the same way in proportion to each line's `taxableInPaise`. The shares
therefore always add up exactly to the bill's discount and to each slab's
figures (check C2). `computeBillTotals` is unchanged; this splits its output.
On bills created before P03 the three fields are absent and mean "not
recorded". Old bills are not back-filled.

**Cancelled order lines are not copied.** Only lines whose status is not
`CANCELLED` become bill lines. This is the soft-delete leak from BUILD-PLAN
section 8 closed at the point it would first appear.

### Subdocument: Discount

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | String | yes | Enum `FLAT`, `PERCENT` |
| `valueInPaise` | Number | no | Set when `kind` is `FLAT`. Integer paise. |
| `rateBps` | Number | no | Set when `kind` is `PERCENT`. Integer basis points, 1 to 10000. |
| `amountInPaise` | Number | yes | The resolved rupee amount taken off, whichever kind it was. This is what the arithmetic uses. |
| `reason` | String | no | Trimmed, up to 200 characters. From P08 it holds the optional note; before P08 the free-text reason. |
| `reasonCode` | String | no | Added by P07, built in P08. From `server/config/discountReasons.js`. Null on discounts from before P08. |
| `fundedBy` | String | no | Added by P07. `RESTAURANT` or `PLATFORM`, default `RESTAURANT`. `PLATFORM` only with a platform reason. |
| `appliedBy` | ObjectId | yes | `users._id` |
| `appliedAt` | Date | yes | UTC |

Bill-level only. There is no per-line discount in version 1: a line-level
discount multiplies the per-slab apportionment below by the number of lines, and
the arithmetic is where this module can lose a customer's money.

### Subdocument: TaxSlab

One row per distinct `taxRateBps` on the bill. This is what prints.

| Field | Type | Required | Notes |
|---|---|---|---|
| `taxRateBps` | Number | yes | 0, 500, 1800, and so on |
| `taxableInPaise` | Number | yes | Sum of `lineTotalInPaise` at this rate, **after** its share of the discount |
| `taxInPaise` | Number | yes | `applyBasisPoints(taxableInPaise, taxRateBps)` |
| `cgstInPaise` | Number | yes | Half, rounded up when the total is odd |
| `sgstInPaise` | Number | yes | `taxInPaise − cgstInPaise` |

### Subdocument: Payment

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | |
| `method` | String | yes | A `paymentmethods.code` of this restaurant (P08). Before P08 the enum `CASH`, `UPI`, `CARD`, `OTHER`; the four built-in methods keep those codes, so every old payment still points at a real method. The fixed enum is removed and the check lives in the service. |
| `methodName` | String | no | Added by P07. Frozen from the method when the payment is taken. Null on old payments. |
| `methodKind` | String | no | Added by P07. `IN_HAND` or `PLATFORM`, frozen. A null reads as `IN_HAND`. |
| `tallyLedgerCode` | String | no | Added by P07. Frozen. |
| `commissionBps` | Number | no | Added by P07. Frozen from a `PLATFORM` method; null for `IN_HAND` or when the rate is not set. Payouts use this, never a live rate. |
| `businessDate` | String | no | Added by P07. From `receivedAt` and the restaurant's business day start, by `businessDateFor`. A null reads as the bill's `businessDate`. |
| `corrections` | [Object] | no | Added by P07. `{ fromMethod, toMethod, by, at, reason }`, one per method correction. The amount never changes. |
| `amountInPaise` | Number | yes | Integer, 1 or more |
| `reference` | String | no | Trimmed, max 100 characters. A UPI reference or the last four digits of a card. Never a full card number. |
| `receivedBy` | ObjectId | yes | `users._id` |
| `receivedAt` | Date | yes | UTC |

`payments` is an array so a split bill is possible without a migration. The
version 1 screen defaults to one payment for the full amount, so nobody pays for
the flexibility in taps. No gateway, no money movement: BUILD-PLAN section 4.

### Indexes

`{ restaurantId: 1, billNumber: 1 }` unique. The number is the thing an auditor
quotes, so it is unique per restaurant rather than per branch.

`{ restaurantId: 1, branchId: 1, financialYear: 1, billSequence: 1 }` unique.
The same guarantee expressed in integers, which is what a gap check reads.

`{ restaurantId: 1, orderId: 1 }` **unique, partial on `{ isVoided: false }`**.
One live bill per order. A voided bill leaves the order billable again, which is
why the filter is on `isVoided` rather than the whole collection. Same technique
as M2's one-open-order-per-table index, and for the same reason: a
check-then-write in a controller has a race in the middle.

`{ restaurantId: 1, branchId: 1, businessDate: 1, isVoided: 1 }` for the day's
bill list and every M6 sales read.

### The arithmetic, in one place

All of it lives in `server/utils/tax.js` and nothing outside that file computes
tax, the same rule that keeps money arithmetic inside `server/utils/money.js`.

**Rounding is per slab, not per line and not on the total.** Group the live
lines by `taxRateBps`, sum the taxable value of each group, then round that
group's tax once. Rounding each line separately and adding gives a different
answer from adding and rounding once, and BUILD-PLAN section 8 names this as a
thing that makes the printed bill and the report disagree by a rupee. Per slab
is chosen because that is exactly how a GST invoice prints — CGST and SGST shown
against each rate — so the bill and any later report are reading the same
numbers.

**A discount is apportioned across slabs before tax is computed.** A bill-level
discount reduces taxable value, so it cannot simply come off the grand total.
Each slab takes a share in proportion to its share of the subtotal:

```
slabShare = round_half_away(discountAmount * slabSubtotal / subtotal)
```

Apportioned shares are then corrected so they sum to the discount exactly: any
remainder from rounding is added to the slab with the largest taxable value.
Without that correction the shares can miss the discount by a paisa and the
grand total stops reconciling.

**CGST takes the extra paisa.** Intra-state supply splits in half, and when a
slab's tax is an odd number of paise the halves are unequal. `cgst = ceil(tax/2)`
and `sgst = tax − cgst`, always, so the split is deterministic and the two always
re-add to the total. There is a test asserting it.

**There is no IGST in version 1.** A dine-in restaurant in Ahmedabad serving a
customer in Ahmedabad is always an intra-state supply. Interstate supply is a
different form and a different return; stating its absence here is deliberate so
a reader does not assume it was forgotten.

**Round-off is last.** The grand total is rounded to the nearest whole rupee
after tax, and the difference is stored signed in `roundOffInPaise` so the
printed bill can show it. `grandTotalInPaise` is therefore always a multiple of
100.

### Bill numbers, and why this cannot reuse M2's counter as-is

`counters` gains one name, `BILL`, and one new field, `scope`.

M2's `nextNumber` increments the counter and the caller writes the document
afterwards. If that write fails the number is spent and the sequence has a hole.
For an order or a kitchen ticket that is fine and `models/Counter.js` says so.

For a bill it is not. CLAUDE.md requires bill numbers to be sequential and never
reused, and BUILD-PLAN section 8 names the gap as a question from an auditor
nobody can answer. So M3 reserves the number **inside the same transaction that
inserts the bill**: both commit or neither does, and an aborted insert rolls the
counter back with it.

**Bill creation therefore requires a transaction and refuses to run without
one.** This is a deliberate difference from every other write in the project,
which uses `withOptionalTransaction` and degrades gracefully on a standalone
`mongod`. A gap-free sequence is not something that can degrade gracefully:
without a transaction the guarantee is simply absent, and silently issuing
gappy bill numbers on a developer machine is how the pattern reaches production.
Atlas and the test replica set both support transactions, so this costs nothing
real.

The `scope` field carries the financial year, because the sequence resets each
year while `name` stays `BILL`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `scope` | String | no | Default `null`. `"2026-27"` on a `BILL` counter. `ORDER` and `KOT` counters leave it null. |

P02 adds a second kind of `BILL` scope. In `PREFIX` invoice mode the scope is
`"PREFIX:"` followed by the prefix, for example `"PREFIX:CFA/C/"`. That counter
never resets. It is created with `$setOnInsert: { value: startingNumber - 1 }`,
inside the bill transaction, so the first bill of a new series is
`startingNumber`. A `PREFIX:` counter whose value is above zero is how the
settings rules know a prefix "has issued bills".

The unique index becomes `{ restaurantId: 1, branchId: 1, name: 1, scope: 1 }`.
This is additive: existing `ORDER` and `KOT` documents have no `scope`, which
indexes as null, and their uniqueness is unchanged.

**That unique index is load-bearing, not decorative.** The reservation is an
upsert, so the very first bill of a financial year has two transactions both
finding no counter and both trying to create one. The index is what makes the
second fail with a duplicate key, which `withTransaction` then retries against
the row the first one committed. Without the index both inserts succeed and both
callers are handed sequence 1.

This is not theoretical: the concurrency test caught it. It passed when run
alone and failed under the full suite, because index creation is asynchronous
and had not finished before ten transactions raced. Production builds indexes
during a deploy — `autoIndex` is off outside development, a decision from
2026-08-28 — so the index is there before traffic is. Anything that creates this
collection by hand must create the index with it.

`financialYearFor(instant)` lives in `server/utils/time.js` beside
`businessDateFor`, so no caller does its own date arithmetic. The Indian
financial year runs 1 April to 31 March, so 2026-08-30 is `"2026-27"` and
2027-02-14 is also `"2026-27"`.

### Deliberately not here

No service charge and no tip. Both are policy decisions a restaurant makes and
neither is a tax; adding them changes the taxable base and needs the CA in the
room.

No credit notes or partial refunds. A wrong bill is voided and re-issued, which
is what a restaurant of this size actually does.

No customer GSTIN or B2B invoice fields. Version 1 prints a B2C bill.

No split-by-cover or per-guest bills. One order, one bill: decision D8, following
M2 shipping one order per table with no merge path.

---

## 13. `auditlogs`

Who did the thing that involved money or trust, when, and why.

BUILD-PLAN section 7 requires an audit trail on voiding a bill, applying a
discount, correcting an attendance entry and adjusting stock, and calls it the
feature that sells the product to an owner losing money to a dishonest cashier.
M5 decision D3 deferred the shared collection to M3 on the grounds that M3 is
the module that would need it. This is that collection.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | |
| `restaurantId` | ObjectId | yes | `restaurants._id` | From `baseSchema` |
| `branchId` | ObjectId | yes | `branches._id` | From `baseSchema` |
| `action` | String | yes | | Enum. See below. |
| `entityType` | String | yes | | Enum `BILL`, `STOCK`, `ORDER`, `SETTINGS` |
| `entityId` | ObjectId | yes | | The record acted on |
| `entityLabel` | String | no | | A human handle that survives, such as the bill number. So a log line reads without a join. |
| `actorId` | ObjectId | yes | `users._id` | |
| `actorRole` | String | yes | | Snapshot of the role at the time, because roles change |
| `at` | Date | yes | | UTC |
| `reason` | String | yes | | Trimmed, 1 to 500 characters. Never defaulted to `""`. |
| `amountInPaise` | Number | no | | The money involved, where there is one: the discount given, the bill voided. |
| `details` | Mixed | no | | Small, flat, and free of personal data. Not a dumping ground. |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

`action` is a closed enum: `BILL_VOIDED`, `DISCOUNT_APPLIED`,
`STOCK_ADJUSTED`, `ORDER_CANCELLED`, `SETTINGS_CHANGED`,
`LINE_CANCELLED_AFTER_PREP`. The last was appended by P04, which is also when
`ORDER_CANCELLED` was first actually written.

P07 appends the settlement actions, each written by the prompt that builds it:
`PAYMENT_METHOD_CORRECTED` (P08), `NO_CHARGE_GIVEN` (P08),
`BILL_CHARGED_TO_ACCOUNT` (P09), `ACCOUNT_BALANCE_ADJUSTED` (P09),
`PLATFORM_PAYOUT_RECORDED` (P09), `CASH_PAID_OUT` (P10), `DAY_CLOSED` (P10),
`DAY_REOPENED` (P10). `entityType` gains `ACCOUNT`, `CASH`, `DAY` and `PAYOUT`.

`entityType` gained `SETTINGS` alongside it. Both were appended by M7; see
section 18 for the shape of a settings audit line.

Indexes:

`{ restaurantId: 1, branchId: 1, at: -1 }` for the audit read.

`{ restaurantId: 1, entityType: 1, entityId: 1 }` for "everything that happened
to this bill".

**Append only.** There is no update and no delete endpoint, and no code path
writes to an existing document. A tamperable audit log is worse than none,
because it is trusted.

**M5's `corrections[]` stay where they are.** Decision D3 left M3 to decide
whether to absorb them, and the answer is no: they are shipped, tested and
embedded on the entry they describe, and rewriting live attendance data to move
an audit trail gains nothing operational and risks the one record that exists to
be trustworthy. Two shapes, each documented. If M6 ever needs one feed it reads
both.

No personal data goes in `details`. BUILD-PLAN section 7 keeps staff names and
phone numbers out of logs, and this collection is a log.

---

# M4 Inventory with recipe deduction

Owner: Arya.

Three collections: `ingredients`, `recipes`, `stockmovements`. All ordinary
tenant collections, `baseSchemaPlugin` then `tenantGuardPlugin` in full.

| Collection | `baseSchema` plugin | `tenantGuard` plugin |
|---|---|---|
| `ingredients` | Yes | Yes |
| `recipes` | Yes | Yes |
| `stockmovements` | Yes | Yes |

BUILD-PLAN section 3 calls this the hardest logic in the version 1 build. Four
things in it are load-bearing and each has its own note below: units,
idempotency, the append-only ledger, and what happens when a recipe is missing.

---

## 14. `ingredients`

A raw material with a stock level. Paneer, oil, a soft-drink bottle.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | `recipes.items[].ingredientId` and `stockmovements.ingredientId` point here |
| `restaurantId` | ObjectId | yes | From `baseSchema` |
| `branchId` | ObjectId | yes | From `baseSchema` |
| `name` | String | yes | Trimmed, 1 to 80 characters |
| `nameLower` | String | yes | Internal, derived. Never in a response. Same technique as M1 and M2. |
| `baseUnit` | String | yes | Enum `G`, `ML`, `PIECE`. **Immutable once any movement exists.** |
| `currentQtyInBase` | Number | yes | Integer in the base unit. Default 0. **May be negative.** A cache; see below. |
| `lowStockThresholdInBase` | Number | yes | Integer, minimum 0, default 0. Low stock is computed on read against this. |
| `purchaseUnitName` | String | no | Display only. "kg", "litre", "packet", "box". Null means the base unit is also how it is bought. |
| `unitsPerBase` | Number | yes | Integer, minimum 1, default 1. How many base units are in one purchase unit. 1 kg of paneer is `1000` with `baseUnit: G`. |
| `isActive` | Boolean | yes | Default true. This is the delete. |
| `createdAt` | Date | auto | UTC |
| `updatedAt` | Date | auto | UTC |

Indexes:

`{ restaurantId: 1, branchId: 1, nameLower: 1 }` unique.

`{ restaurantId: 1, branchId: 1, isActive: 1, name: 1 }` for the stock list.

### Exactly three base units, and everything is an integer

`G`, `ML`, `PIECE`. Nothing else. This is decision D11 and it exists to kill the
factor-of-one-thousand bug BUILD-PLAN section 8 names: paneer bought in
kilograms and used in grams, where the recipe and the stock record disagree
about units and every deduction is out by 1000×.

Both stock levels and recipe quantities are stored as **integers in the base
unit**, never as a float and never in a purchase unit, for exactly the reason
money is whole paise. A recipe asking for 0.15 kg is stored as `150` with
`baseUnit: G`.

A purchase unit is an entry and display convenience only. A storekeeper types
"2" against a kilogram tile and the screen shows "2 kg = 2000 g" underneath, and
`server/utils/units.js` is the only place that multiplies. Nothing else in the
server converts, so there is one function to get right and one to test.

**`baseUnit` is immutable once any `stockmovements` document references the
ingredient.** Changing it would silently reinterpret every historical quantity
in the ledger — 500 g of paneer becoming 500 ml — and there is no way to detect
that after the fact. Attempting it is a 422.

### `currentQtyInBase` is a cache, and the ledger is the truth

It exists so a stock list does not aggregate the whole ledger on every read. It
is maintained by `$inc` **inside the same transaction** that inserts the
movement, so the two cannot diverge by a failed write.

There is a test that recomputes every ingredient's quantity by summing its
movements and asserts it equals the cached value. If that test ever fails the
cache is wrong and the ledger is right.

### Negative stock is allowed, and is not blocked

The kitchen cooked the dish whether or not the system agreed there was paneer
left. A system that refuses a sale because a number is wrong gets worked around
within a week, and then it holds no useful data at all.

So a deduction that would take a quantity below zero is applied anyway. The
ingredient reads as out of stock and is flagged loudly in the stock list and the
low-stock read. Nothing is blocked, ever, on the ordering or billing path.

### Deliberately not here

No cost price and no stock valuation. Attendance produces minutes and this
produces quantities; turning either into money is a separate build. M6 reports
consumption, not margin. The known problems table already records that there is
no price history, which is the other half of a margin report.

No supplier, purchase order or goods-received document. BUILD-PLAN section 4
defers vendors until inventory numbers are trusted, which is after a pilot.

No batch, expiry or FEFO tracking. No per-storeroom locations.

---

## 15. `recipes`

What one sellable thing consumes. The join between M1's menu and M4's stock.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | |
| `restaurantId` | ObjectId | yes | `restaurants._id` | From `baseSchema` |
| `branchId` | ObjectId | yes | `branches._id` | From `baseSchema` |
| `menuItemId` | ObjectId | yes | `menuitems._id` | |
| `variantId` | ObjectId | no | `menuitems.variants[]._id` | Null means this is the item-level recipe. See the fallback below. |
| `items` | [RecipeItem] | yes | | Default `[]`. At most 50. |
| `isActive` | Boolean | yes | | Default true |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

### Subdocument: RecipeItem

| Field | Type | Required | Notes |
|---|---|---|---|
| `ingredientId` | ObjectId | yes | `ingredients._id` |
| `qtyInBase` | Number | yes | Integer, minimum 1, in that ingredient's base unit. Per one unit of the dish. |

`_id: false`. A recipe line is identified by its `ingredientId`, which is unique
within the recipe, so it needs no id of its own.

Indexes:

`{ restaurantId: 1, branchId: 1, menuItemId: 1, variantId: 1 }` unique. One
recipe per item, and one per variant.

`{ restaurantId: 1, 'items.ingredientId': 1 }` for "what uses this ingredient",
which is also the lookup that blocks deactivating an ingredient still in use.

### The variant fallback, and the missing recipe

When a line sells, the deduction looks for a recipe in this order:

1. A recipe for this `menuItemId` **and** this `variantId`.
2. Failing that, the recipe for this `menuItemId` with `variantId: null`.
3. Failing that, **nothing is deducted, and the sale succeeds.**

Case 3 records a `NO_RECIPE` note against the order line rather than raising an
error. Blocking a sale because inventory is half configured is the fastest way
to get the whole module switched off during a rush, and a restaurant that cannot
fire a KOT at 8pm will not use this software at all.

The honest answer to "then how does anyone find out" is a read: `GET
/inventory/unmapped` lists menu items that have sold with no recipe attached,
newest first. That list is also the seed-data gap from BUILD-PLAN section 8
answered in a way somebody will actually look at.

A half plate falling back to the full plate's recipe would over-deduct, which is
why step 1 is tried first. If a variant genuinely uses the same quantities, the
item-level recipe is the right place to say so once.

---

## 16. `stockmovements`

The ledger. Every change to a stock level is one row here, and this collection
is the truth about what happened.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | |
| `restaurantId` | ObjectId | yes | `restaurants._id` | From `baseSchema` |
| `branchId` | ObjectId | yes | `branches._id` | From `baseSchema` |
| `ingredientId` | ObjectId | yes | `ingredients._id` | |
| `qtyInBase` | Number | yes | | **Signed integer.** Negative consumes, positive adds. Never zero. |
| `type` | String | yes | | Enum. See below. |
| `eventKey` | String | yes | | The idempotency key. See below. |
| `sourceType` | String | yes | | Enum `ORDER_LINE`, `MANUAL` |
| `orderId` | ObjectId | no | `orders._id` | Set when `sourceType` is `ORDER_LINE` |
| `orderLineId` | ObjectId | no | `orders.lines[]._id` | Set when `sourceType` is `ORDER_LINE` |
| `reason` | String | no | | Required for every `MANUAL` movement. Trimmed, 1 to 200 characters. |
| `resultingQtyInBase` | Number | yes | | The ingredient's quantity after this movement. A snapshot, so the ledger can be read as a running balance without replaying it. |
| `actorId` | ObjectId | yes | `users._id` | Who caused it. On a deduction, whoever fired the KOT. |
| `at` | Date | yes | | UTC |
| `createdAt` | Date | auto | | UTC |
| `updatedAt` | Date | auto | | UTC |

`type` is a closed enum:

| Type | Sign | Raised by |
|---|---|---|
| `DEDUCTION` | negative | Firing a KOT line |
| `CANCELLATION_RETURN` | positive | Cancelling a fired line answered `wasPrepared: false` |
| `RECEIVED` | positive | Manual: stock arrived |
| `WASTAGE` | negative | Manual: spoiled |
| `SPILLAGE` | negative | Manual: dropped |
| `RECOUNT` | either | Manual: a physical count disagreed with the system |
| `RETURN` | positive | Manual: sent back to a supplier, or returned from the kitchen |

### Indexes

`{ restaurantId: 1, eventKey: 1 }` **unique.** This is the idempotency
guarantee, and it is an index rather than a check because a check has a race in
the middle of it.

`{ restaurantId: 1, branchId: 1, ingredientId: 1, at: -1 }` for one
ingredient's ledger, newest first.

`{ restaurantId: 1, branchId: 1, at: -1 }` for the consumption read M6 will
want.

### Idempotency, which is the thing most likely to break

A request is retried. A KOT is fired twice because a tablet lost its answer and
the waiter pressed again. An event is delivered twice. None of these may deduct
twice, because the second deduction is invisible: the number is simply wrong
from then on, and nothing ever flags it.

Every movement therefore carries a natural key:

```
eventKey = `${orderLineId}:${ingredientId}:${type}`  for sourceType ORDER_LINE
eventKey = `MANUAL:${new ObjectId()}`                for sourceType MANUAL
```

with a unique index on `{ restaurantId, eventKey }`. A repeat insert fails on
the duplicate key, the service catches exactly that error, undoes the `$inc` it
had already applied to the ingredient — the increment happens before the
insert, so it can be caught this way — and returns the movement that already
exists. A retry is a no-op, not an error and not a second row.

The key is per order **line and per ingredient**, not per line alone. A single
fired line's recipe usually touches more than one ingredient — Paneer Tikka
needs paneer, oil, and a spice mix — and one `DEDUCTION` movement is written
per ingredient. Keying only on `orderLineId:type` was the first draft of this
spec and it was wrong: the second ingredient's insert would have collided with
the first's on the unique index, and the idempotency guard would have silently
treated a genuinely new deduction as a duplicate and skipped it. Caught before
any code was written against it. It also still includes `type` so a
`CANCELLATION_RETURN` can exist alongside the `DEDUCTION` it reverses, and it
is per order **line**, not per order, because lines are fired in separate KOTs
at different times.

There is a test that calls the deduction twice and asserts the stock level moved
once. It is the single most important test in M4.

### Append only

A movement is never updated and never deleted. There is no endpoint that does
either and no code path that writes to an existing document.

A mistake is corrected by writing a **new, compensating movement** with a reason
and a user, exactly as a ledger works. If someone recorded 5 kg of wastage that
was really 500 g, the fix is a `RECOUNT` of +4500 g with the reason saying so,
not an edit that makes the first entry disappear.

This is the same rule as never hard deleting a bill, applied to the collection
where a dishonest correction would be worth the most.

### Cancel after fire, and what it does to stock

This follows M2's `wasPrepared`, which already exists on every order line and is
already tested. M4 adds no second mechanism.

Deduction happens at **KOT fire**, because that is when the ingredients
physically leave the shelf. Deducting at bill settlement would mean a table that
ate and walked out never deducted anything and stock drifted up forever.

When a fired line is cancelled:

`wasPrepared: true` — the food was made and the ingredients are gone. **Nothing
is written.** The deduction stands.

`wasPrepared: false` — it was never cooked. One `CANCELLATION_RETURN` movement
per recipe item puts the quantities back.

A line cancelled while still `PENDING` never reached the kitchen, so no
`DEDUCTION` exists for it and nothing is returned. M4 must key that decision on
**whether a `DEDUCTION` movement exists for the line**, not on `wasPrepared`
alone: `wasPrepared` is null on such a line by the rule fixed on 2026-08-30, but
the ledger is the reliable answer and the ledger is what M4 already reads.

**A voided bill never restocks automatically.** The food was made and eaten; the
bill being wrong does not put paneer back in the fridge. If it genuinely was not
consumed, a storekeeper writes a manual adjustment with a reason, and that is
visible in the audit log where an owner can see it. An automatic restock on void
is a way to turn a dishonest void into free inventory.

---

# M6 Reports and Dashboard

Owner: Rishi.

**M6 has no collections. It adds no model file, no field to any existing
collection, and no index.** This section exists so that a reader looking for
M6's schema finds this statement rather than an absence and wonders whether
something was forgotten.

Every M6 endpoint is a read that aggregates over collections other modules
already own and have frozen:

| Read from | Owned by | What M6 takes from it |
|---|---|---|
| `bills` | M3 | Every revenue, tax, discount and payment figure |
| `orders` | M2 | Open-order count and running value, for the dashboard only |
| `stockmovements` | M4 | Consumption, wastage and returns |
| `attendanceentries` | M5 | Minutes worked, and open shifts |
| `ingredients` | M4 | Low-stock rows, and a name and base unit for a movement |
| `users` | M0 | A name and role against a userId in a report row |

### The indexes M6 depends on already exist

M6 adds none, and needs none added, because each module already indexed the
shape its own reads needed and M6's reads are the same shape:

`bills` has `{ restaurantId, branchId, businessDate, isVoided }`, which is
exactly the leading filter on every sales, tax, discount and payment
aggregation.

`attendanceentries` has `{ restaurantId, branchId, businessDate }`.

`stockmovements` has `{ restaurantId, branchId, at }`, which is why the
consumption report converts a business-date range into a UTC instant range
rather than the other way round: that collection stores `at` and has no
`businessDate` field, so matching on an instant uses the index and deriving a
business date per row would not.

If a report is ever measurably slow on real data, the fix is an index on the
collection that owns the data, added by that module's section above, not a new
collection here.

### Why there is no rollup collection

Every figure is aggregated live on every request. A materialised daily-summary
collection would be a second source of truth for numbers that already exist,
and the failure mode is the worst kind: a stale rollup disagrees with the bills
it was built from, both look plausible, and nobody knows which to believe.

A restaurant of this size does a few hundred bills a day. The indexes above
cover every query. Revisit only if a real query is measurably slow against
real data, and then measure first.

### What M6 must never do to the data it reads

Never write. There is no `POST`, `PATCH`, `PUT` or `DELETE` in this module.

Never recompute a figure another module already stored. Tax in particular is
summed from `bills.taxBreakdown`, never recalculated from line totals: M3
rounded it once per slab under a documented rule, and a second implementation
here would disagree with the printed bill by a rupee. The same applies to
`workedMinutes`, which M5 computed and stored.

Never invent a value for a null. An open shift has `workedMinutes: null`
because M5 deliberately refuses to invent a clock-out time, and M6 refuses in
exactly the same way: an open shift contributes zero minutes and is listed
separately, never counted as elapsed-time-so-far.

Never include a voided record in a total. `bills.isVoided` and
`attendanceentries.isVoided` are excluded in the first `$match` of every
pipeline, not filtered out afterwards.

---

# M7 Restaurant Settings

Owner: Rishi.

**M7 adds no collection.** It expands the `settings` object already on
`restaurants` (section 1) and appends one value to each of the two `auditlogs`
enums (section 13). Nothing else in the database changes, and there is no
migration.

---

## 17. `restaurants.settings`, expanded

Every field below has a schema default. An existing restaurant document holding
only `settings.businessDayStartsAtMinutes` reads back a complete settings object
with every group filled in, because Mongoose applies subdocument defaults on
read for missing paths. **There is no migration and no backfill script**, and
adding one later would be a way to get this wrong rather than a way to fix it.

### `settings.businessDayStartsAtMinutes` — pre-existing, unmoved

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `settings.businessDayStartsAtMinutes` | Number | yes | 300 | Integer 0 to 1439. Minutes past midnight IST at which the business day rolls over. Added by M5, decision log D1. |

**It stays at the top level of `settings`. It is not nested under
`settings.business`.** M3 derives every bill's `businessDate` from it, M5 derives
every attendance entry's, and M6 reads it for every report. Nesting it for
tidiness would break three shipped modules at once and require a migration on
the one field that decides which day a sale belongs to.

The API groups it under `business` for readability. That mapping lives in
`services/settingsService.js` and nowhere else: the service reads and writes the
top-level path and presents the grouped one. See API-CONTRACT.md section M7.

### `settings.tax`

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `pricingMode` | String | yes | `EXCLUSIVE` | Enum `EXCLUSIVE`, `INCLUSIVE`. Whether `menuitems.priceInPaise` is before or after GST. **Stored and deliberately not consumed.** |
| `defaultTaxRateBps` | Number | yes | 500 | Integer 0 to 10000. The rate `POST /menu-items` fills in when the body omits `taxRateBps`. |
| `roundOffEnabled` | Boolean | yes | true | Whether a bill rounds to the nearest rupee. **Stored and deliberately not consumed.** |

`pricingMode` and `roundOffEnabled` are read by nothing. M3's tax code is frozen,
tested to the paisa, and carries a documented per-slab rounding rule; rewiring it
from inside a settings module is how billing breaks quietly. Wiring them is its
own task, and it must not run before a chartered accountant has confirmed which
pricing mode the pilot restaurant actually uses. That confirmation is decision
D1's open risk in BUILD-PLAN section 14.

`defaultTaxRateBps` changes only the API's default. `menuitems.taxRateBps` stays
required on every stored document, an explicitly sent rate always wins, and an
item created today keeps its own rate forever. Changing this setting tomorrow
does not touch a single existing item, which is the same snapshot discipline
order lines already follow.

### `settings.receipt`

Consumed by nothing until Phase 2 thermal printing exists. Stored now because
the values are worth collecting during onboarding.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `headerLine1` | String | no | `null` | Trimmed, max 40 characters. Printed above the restaurant name. |
| `headerLine2` | String | no | `null` | Trimmed, max 40 characters. |
| `footerText` | String | no | `null` | Trimmed, max 200 characters. |
| `showGstin` | Boolean | yes | true | Print the GSTIN on the bill. |
| `showFssai` | Boolean | yes | true | Print the FSSAI licence number. |
| `showServerName` | Boolean | yes | false | Print who took the order. |

Forty characters is not arbitrary. An 80mm thermal roll fits roughly 42
characters per line at normal font, and a longer line wraps and destroys the
layout. That is the printer problem from BUILD-PLAN section 12, caught at data
entry rather than in a kitchen during Phase 2.

### `settings.inventory`

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `lowStockAlertsEnabled` | Boolean | yes | true | Whether the low-stock list is surfaced. When false the low-stock reads return an empty list and the dashboard returns an empty `lowStock` array. Stock quantities are untouched; only the surfacing is switched off. |

### `settings.features` (added by P02)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `inventory` | Boolean | yes | true | M4 is in use. When false, the inventory routes and the stock report refuse with `FEATURE_DISABLED`, and firing or cancelling writes no `stockmovements`. Existing movements are never touched. |
| `attendance` | Boolean | yes | true | M5 is in use. When false, the attendance routes and the labour report refuse with `FEATURE_DISABLED`. |

The defaults are `true` so nothing changes for an existing restaurant. Caffeza's
setup in P11 switches both off.

### `settings.delivery` (added by P06)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `platformCollectsGst` | Boolean | yes | true | When true, an order placed through a platform on the list is billed at 0%, because the platform pays the GST under section 9(5). `TO CONFIRM` with Caffeza's CA. Affects only orders created after a change. |

### `settings.discounts` (added by P07)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `cashierMayApplyPlatformDiscounts` | Boolean | yes | false | When true, a CASHIER may apply a discount whose reason is a platform reason, and no other. `TO CONFIRM` with Caffeza. |

### `settings.appearance` (added by P20A)

| Field | Type | Default | Notes |
|---|---|---|---|
| `accentPreset` | String | `OCEAN` | One of six presets, or `CUSTOM` |
| `accentHex` | String | null | `#RRGGBB`, used with `CUSTOM`, validated by `utils/colour.js` |
| `wordmark` | String | null | Max 30 characters. Null means the restaurant's name. |
| `secondLanguage` | String | `NONE` | `NONE`, `GUJARATI`, `HINDI` |
| `todayTiles` | [String] | every R1 tile key in order | Which Today tiles show, in order |
| `neutralTone` | String | `COOL` | P22. `COOL` or `WARM` |
| `brandHex` | String | null | P22. `#RRGGBB`, the logo's background. Set with `onBrandHex`. |
| `onBrandHex` | String | null | P22. `#RRGGBB`, text on `brandHex`, at least 4.5 to 1 on it |

Additive, every field defaulted. P22's three fields are checked in the validator
and in `settingsService`, the same split as `accentHex`.

### `settings.floor` (added by P19)

| Field | Type | Default | Notes |
|---|---|---|---|
| `sectionOrder` | [String] | `[]` | Section names in floor order. Others follow by name. |
| `longOpenMinutes` | Number | 90 | Integer 15 to 600 |
| `requireGuestCount` | Boolean | false | When true, `DINE_IN` orders need `guestCount` |

Additive, every field defaulted: an existing document reads back complete.

### `settings.dayClose` (added by P07)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `showCashDifferenceToManager` | Boolean | yes | false | The blind count. When false, a MANAGER never sees expected cash or the difference in any Day Close response or print. |

### `settings.invoice` (added by P02)

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `mode` | String | yes | `FINANCIAL_YEAR` | Enum `FINANCIAL_YEAR`, `PREFIX` |
| `prefix` | String | no | `null` | `PREFIX` mode only. 1 to 7 characters of letters, digits, `/` and `-`. |
| `startingNumber` | Number | no | `null` | `PREFIX` mode only. Integer 1 to 999,999,999. The first number a new prefix series issues. |

Seven plus nine is sixteen, the GST limit on an invoice number's length. The
rules that stop a change from breaking the unique indexes on `bills` are in
API-CONTRACT.md section M7 3, and live in `settingsService`.

---

## 18. `auditlogs`, two appended enum values

Section 13 is otherwise unchanged. Both additions are append-only to a closed
enum, the same discipline `utils/errors.js` follows.

`action` gains `SETTINGS_CHANGED`. `entityType` gains `SETTINGS`.

One document per field that actually changed value. A field sent with a value
identical to the stored one writes no audit line and is not an error.

| Field | Value for a settings change |
|---|---|
| `action` | `SETTINGS_CHANGED` |
| `entityType` | `SETTINGS` |
| `entityId` | the `restaurantId` |
| `entityLabel` | the dotted path, for example `tax.defaultTaxRateBps` |
| `reason` | from the request body, required, never defaulted to `""` |
| `amountInPaise` | `null` |
| `details` | `{ field, previousValue, newValue }`, both values as strings |

The settings write and every audit line for it commit together, through
`withOptionalTransaction`. A settings change that persists without its audit
line is worse than one that fails outright, because the log is trusted.

`details` holds a field path and two scalar values and nothing else. No personal
data goes in it, for the reason section 13 already gives.

P22 appends `BRAND_LOGO_SET` and `BRAND_LOGO_REMOVED`, entity type `SETTINGS`,
entity id the `restaurantId`, `entityLabel` the slot. `details` is
`{ slot, hash, sizeBytes, width, height, contentType }`. Never the image bytes.

---

## What M7 deliberately does not add

**No settings collection.** Settings live on `restaurants`, which is already
read on every authenticated request. A separate collection adds a lookup to gain
nothing.

**No per-branch settings.** Version 1 is one branch per restaurant. A `branchId`
on a settings document would be dead weight and a decision made without a
customer.

**No settings history collection.** `auditlogs` is the history.

**No currency or locale setting.** Version 1 is INR and IST.

**No service charge or tip setting.** Both change the taxable base and need a
chartered accountant in the room.

**The M5 twelve-hour open-shift threshold stays a constant.** Decision D5 made
it one deliberately, and M7 does not reopen it. Neither the six roles, the three
inventory base units, nor the counter names become configurable; all three are
deliberately closed lists.

---

# M18 Kitchen Stations

Owner: Arya. Built in P05.

One new collection, `stations`, and one additive field each on `categories`,
`kots` and `users`.

## 19. `stations`

A place a KOT goes, like "Live Kitchen" or "Beverages". Ordinary tenant
collection: `baseSchemaPlugin` then `tenantGuardPlugin`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `_id` | ObjectId | auto | `categories.stationId`, `kots.stationId` and `users.stationId` point here |
| `restaurantId` | ObjectId | yes | From `baseSchema` |
| `branchId` | ObjectId | yes | From `baseSchema` |
| `name` | String | yes | Trimmed, 1 to 40 characters. Unique per restaurant and branch, ignoring case. |
| `nameLower` | String | yes | Internal, derived from `name`, never in a response. Same technique as `categories`. |
| `displayOrder` | Number | yes | Integer, minimum 0, default 0. The first active station by this order is the default station. |
| `printsTickets` | Boolean | yes | Default false. Whether this station wants paper KOTs. Read by the kitchen screen's auto-print. |
| `targetMinutes` | Number | yes | P20A. Integer 5 to 120, default 15. How long a ticket at this station may take before its time edge shows it as late. |
| `isActive` | Boolean | yes | Default true. This is the delete. A station is never removed. |
| `createdAt` | Date | auto | UTC |
| `updatedAt` | Date | auto | UTC |

Indexes:

`{ restaurantId: 1, branchId: 1, nameLower: 1 }` unique. Two stations in one
branch cannot share a name, compared case-insensitively.

`{ restaurantId: 1, branchId: 1, isActive: 1, displayOrder: 1 }` for the
routing read at fire time: the active stations, in order.

P05 also adds one index to `kots`: `{ restaurantId: 1, branchId: 1, stationId: 1,
createdAt: 1 }`, for the kitchen screen's station filter, oldest first.

### Routing, and why it is decided at fire time

When an order fires, each pending line is routed through its frozen
`categoryId` (P03) to that category's **current** `stationId`. A line whose
category has no station, is missing, or points at an inactive station goes to
the default station, the first active one by `displayOrder`. One KOT is created
per station that has lines, numbered in station order. With no active stations
at all, firing makes one KOT with `stationId: null`, exactly as before P05.

Routing reads the category at fire time on purpose: which counter cooks a dish
is a question about today, not history. The KOT then freezes `stationId` and
`stationName`, so moving a category to another station never changes a ticket
already printed.

---

# M10 Payments, M16 Settlement and Day Close, M17 payouts

Specified in P07, built in P08 (payment methods, discounts, No Charge), P09 (On
Hold accounts, payouts) and P10 (cash drawer, Day Close). Every collection below
is an ordinary tenant collection: `baseSchemaPlugin` then `tenantGuardPlugin`,
every index starting with `restaurantId`.

## 20. `paymentmethods`

How a bill may be settled. Configured per restaurant.

| Field | Type | Required | Links to | Notes |
|---|---|---|---|---|
| `_id` | ObjectId | auto | | |
| `restaurantId`, `branchId` | ObjectId | yes | | From `baseSchema` |
| `code` | String | yes | | 2 to 20 characters, capital letters, digits and `_`, starting with a letter. Unique per restaurant. Never changes. Payments store it. |
| `name` | String | yes | | 1 to 30 characters. What staff see. |
| `kind` | String | yes | | `IN_HAND` or `PLATFORM`. Never changes. |
| `orderTypes` | [String] | yes | | At least one of `DINE_IN`, `TAKEAWAY`, `DELIVERY`. Default all three. |
| `platformCode` | String | no | | A code from `server/config/platforms.js` for a delivery platform's own payment, like `SWIGGY`. Otherwise null. |
| `tallyLedgerCode` | String | no | | Up to 20 characters. Cafezza's were in `docs/archive/caffeza/CAFFEZA-PROFILE.md` section 10. |
| `commissionBps` | Number | no | | `PLATFORM` methods only. Integer 0 to 10000. Null means "rate not set". A change affects only payments taken after it. |
| `displayOrder` | Number | yes | | Integer, default 0 |
| `isActive` | Boolean | yes | | Default true. Never deleted. |
| `createdAt`, `updatedAt` | Date | auto | | UTC |

Index: `{ restaurantId: 1, code: 1 }` unique. Payments refer to a method by code,
so two methods with one code would make every report ambiguous.

Index: `{ restaurantId: 1, branchId: 1, isActive: 1, displayOrder: 1 }` for the
payment panel's list.

Every restaurant always has four built-in methods, created if missing by code,
never overwriting one that exists: `CASH` Cash, `CARD` Card, `UPI` UPI, all
`IN_HAND` and active, and `OTHER` Other, `IN_HAND`, inactive. They match the four
values the old fixed list allowed.

## 21. `accounts`

An On Hold account, such as "W-330 Office": someone who runs a tab.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `name` | String | yes | 1 to 40 characters, unique per restaurant ignoring case |
| `nameLower` | String | yes | Internal, derived from `name`, never in a response |
| `contactName`, `phone`, `note` | String | no | Optional. Up to 60, 15 and 200 characters. |
| `openingBalanceInPaise` | Number | yes | Integer 0 or more, default 0. Set at creation, never edited. Also written as an `OPENING` entry. |
| `isActive` | Boolean | yes | Default true |

Index: `{ restaurantId: 1, branchId: 1, nameLower: 1 }` unique.

The outstanding balance is never stored. It is computed from `accountentries`,
so it cannot drift from the ledger.

## 22. `accountentries`

The account ledger. Entries are never edited or deleted. A mistake is reversed
by another entry.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `accountId` | ObjectId | yes | `accounts._id` |
| `type` | String | yes | `OPENING`, `CHARGE`, `CHARGE_REVERSED`, `COLLECTION`, `ADJUSTMENT` |
| `direction` | String | yes | `UP` or `DOWN`. Fixed by type: `OPENING` and `CHARGE` are `UP`, `CHARGE_REVERSED` and `COLLECTION` are `DOWN`. `ADJUSTMENT` takes either. |
| `amountInPaise` | Number | yes | Integer above 0. Always positive; the direction carries the sign. |
| `billId`, `billNumber` | ObjectId, String | no | For `CHARGE` and `CHARGE_REVERSED` |
| `method`, `methodName`, `methodKind` | String | no | For `COLLECTION`, frozen like a payment |
| `reference`, `note` | String | no | Up to 100 and 200 characters. An adjustment's reason is its `note`. |
| `businessDate` | String | yes | The business date of the moment the entry was written, by `businessDateFor` |
| `at` | Date | yes | UTC |
| `by` | ObjectId | yes | `users._id` |

Outstanding balance is the `UP` amounts minus the `DOWN` amounts.

Indexes: `{ restaurantId: 1, accountId: 1, at: 1 }` for statements and balances,
and `{ restaurantId: 1, branchId: 1, businessDate: 1, type: 1 }` for a day's
collections.

## 23. `platformpayouts`

Money a platform sent, in a batch covering a range of business dates.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `method`, `methodName` | String | yes | A `PLATFORM` payment method's code, and its frozen name |
| `periodFrom`, `periodTo` | String | yes | Business dates, `YYYY-MM-DD`, inclusive, `periodFrom` not after `periodTo` |
| `amountReceivedInPaise` | Number | yes | Integer 0 or more |
| `receivedOn` | String | yes | The date it reached the bank, `YYYY-MM-DD` |
| `reference`, `note` | String | no | Up to 100 and 200 characters |
| `recordedBy`, `recordedAt` | ObjectId, Date | yes | |
| `isVoided`, `voidedBy`, `voidedAt`, `voidReason` | | | A wrong entry is voided, never edited |

Index: `{ restaurantId: 1, method: 1, periodFrom: 1, periodTo: 1 }` for the
overlap check and the list.

Two live payouts for the same method may not cover the same business date: 409
`PAYOUT_PERIOD_OVERLAP`. Checked in the service; a payout is recorded by a person
a few times a week, so there is no race worth an index.

## 24. `cashmovements`

The cash drawer's non-sale entries.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `type` | String | yes | `OPENING_FLOAT`, `PAID_IN`, `PAID_OUT` |
| `amountInPaise` | Number | yes | Integer above 0 |
| `reason` | String | no | 1 to 200 characters. Required for `PAID_IN` and `PAID_OUT`. |
| `businessDate` | String | yes | Always the current business date when entered. No back-dating. |
| `at`, `by` | Date, ObjectId | yes | |
| `isVoided`, `voidedBy`, `voidedAt`, `voidReason` | | | Voided, never deleted |

Index: `{ restaurantId: 1, branchId: 1, businessDate: 1, type: 1 }` **unique,
partial on `{ type: 'OPENING_FLOAT', isVoided: false }`**. One live opening
float per business date. A voided float frees the slot. Equality only in the
filter, as MongoDB requires.

Index: `{ restaurantId: 1, branchId: 1, businessDate: 1, at: 1 }` for a day's
drawer.

## 25. `dayclosures`

One document per business date, written by Day Close.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `businessDate` | String | yes | |
| `status` | String | yes | `CLOSED` or `REOPENED` |
| `countedCashInPaise`, `expectedCashInPaise`, `differenceInPaise` | Number | yes | From the latest close. Difference is counted minus expected. |
| `note` | String | no | Required when the cash difference is not zero |
| `snapshot` | Object | yes | The full output of `computeDayFigures` at the latest close |
| `checks` | [Object] | yes | The check results at the latest close |
| `closedBy`, `closedAt` | ObjectId, Date | yes | The latest close |
| `history` | [Object] | yes | Every close and reopen: `{ action, by, at, note, countedCashInPaise, expectedCashInPaise, differenceInPaise }` |

Index: `{ restaurantId: 1, branchId: 1, businessDate: 1 }` unique.

---

# M14 Online Ordering and Reservations

Specified 2026-10-08 for P23, before any code. Two new collections, and
additive fields on four existing ones. No migration: every new field has a
default, and an older server ignores them.

## 26. `onlineorders`

One takeaway request from the public page. It becomes an `orders` document
only when a staff member accepts it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema`. Set from the slug, never from the body. |
| `reference` | String | yes | `"W-42"`, from the `ONLINE_ORDER` counter. Gaps are fine. |
| `idempotencyKey` | String | yes | UUID from the page |
| `customerName` | String | yes | 1 to 60 characters |
| `customerPhone` | String | yes | 10 digits, normalised |
| `lines` | [Object] | yes | The quote: `{ menuItemId, variantId, addOnIds, itemName, variantName, unitPriceInPaise, addOns: [{ addOnId, name, priceInPaise }], quantity, notes, lineTotalInPaise }`. **A display record.** No report reads it. The order created at accept is snapshotted fresh. |
| `estimate` | Object | yes | `{ itemTotalInPaise, gstInPaise, roundOffInPaise, billTotalInPaise }` from `computeBillTotals` at placing. Display only. |
| `note` | String | no | Up to 200 characters |
| `pickupAt` | Date | yes | UTC. Staff may move it at accept. |
| `pickupWasAsap` | Boolean | yes | |
| `businessDate` | String | yes | From `createdAt`, by `businessDateFor` |
| `status` | String | yes | `WAITING`, `ACCEPTED`, `DECLINED`, `CANCELLED`, `EXPIRED`. `EXPIRED` is also derived on read for `WAITING` past `answerBy`. |
| `answerBy` | Date | yes | Placing time plus `takeawayAnswerWithinMinutes` |
| `statusTokenHash` | String | yes | SHA-256 hex of the guest's status token. **Never in any response.** |
| `marketingConsent` | Object | yes | `{ given: Boolean, textVersion: String, at: Date }`. `given` defaults to false. `textVersion` names the exact sentence in `server/config/consentText.js`. |
| `decidedBy`, `decidedAt` | ObjectId, Date | no | Who accepted or declined, and when |
| `declineReasonCode`, `declineNote` | String | no | From `server/config/onlineReasons.js`. The note is staff-only. |
| `acceptedChangedPrices` | Boolean | no | True when it was accepted with `acceptChangedPrices` |
| `orderId` | ObjectId | no | `orders._id`, set at accept |
| `cancelledAt` | Date | no | When the guest cancelled |

Indexes:
- `{ restaurantId: 1, branchId: 1, status: 1, createdAt: 1 }`, for the inbox
  and the lists.
- `{ restaurantId: 1, reference: 1 }`, unique.
- `{ restaurantId: 1, branchId: 1, idempotencyKey: 1 }`, unique.
- `{ restaurantId: 1, branchId: 1, customerPhone: 1, status: 1 }`, for the
  open-request limit.

Never deleted. A declined or expired request is kept, like a cancelled order.

## 27. `reservations`

One table booking, from the public page (`source: ONLINE`) or typed in by
staff from a phone call (`source: PHONE`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `reference` | String | yes | `"R-17"`, from the `RESERVATION` counter |
| `source` | String | yes | `ONLINE` or `PHONE` |
| `idempotencyKey` | String | no | Online only |
| `guestName` | String | yes | 1 to 60 characters |
| `guestPhone` | String | yes | 10 digits |
| `partySize` | Number | yes | 1 to `reservationMaxPartySize` |
| `at` | Date | yes | UTC, the booked time |
| `businessDate` | String | yes | From `at`, by `businessDateFor` |
| `note` | String | no | Up to 200 characters |
| `status` | String | yes | `REQUESTED`, `CONFIRMED`, `DECLINED`, `CANCELLED`, `EXPIRED`, `SEATED`, `NO_SHOW`. `EXPIRED` is also derived on read for `REQUESTED` past `answerBy`. |
| `answerBy` | Date | no | Online only: the later of `at` minus 30 minutes and placing time plus `takeawayAnswerWithinMinutes` |
| `statusTokenHash` | String | no | Online only. Never in any response. |
| `marketingConsent` | Object | yes | As in section 26. A phone booking stores `given: false`. |
| `tableId`, `tableName` | ObjectId, String | no | Set at confirm or seat. The name is a snapshot. |
| `decidedBy`, `decidedAt` | ObjectId, Date | no | Confirm or decline |
| `declineReasonCode`, `declineNote` | String | no | |
| `seatedBy`, `seatedAt`, `orderId` | ObjectId, Date, ObjectId | no | Set at seat |
| `cancelledBy`, `cancelledAt`, `cancelNote` | ObjectId, Date, String | no | `cancelledBy` is null when the guest cancelled |
| `noShowBy`, `noShowAt` | ObjectId, Date | no | |

Indexes:
- `{ restaurantId: 1, branchId: 1, businessDate: 1, at: 1 }`, for the day's
  book.
- `{ restaurantId: 1, branchId: 1, status: 1, createdAt: 1 }`, for the inbox.
- `{ restaurantId: 1, reference: 1 }`, unique.
- `{ restaurantId: 1, branchId: 1, idempotencyKey: 1 }`, unique, partial on
  `{ idempotencyKey: { $type: 'string' } }`.
- `{ restaurantId: 1, tableId: 1, status: 1, at: 1 }`, for clashes and the
  floor.
- `{ restaurantId: 1, branchId: 1, guestPhone: 1, status: 1 }`.

Never deleted.

## 28. Additions to existing collections

### `branches.online`

| Field | Type | Default | Notes |
|---|---|---|---|
| `publicSlug` | String | null | Lowercase, 3 to 40 characters. Unique across the whole platform. |
| `pausedUntil` | Date | null | Takeaway is paused until then |
| `pausedBy` | ObjectId | null | |

Index: `{ 'online.publicSlug': 1 }`, unique, partial on
`{ 'online.publicSlug': { $type: 'string' } }`.

`branches` is a tenancy root with the guard on `restaurantId`. **The lookup by
slug is the one query across restaurants that M14 adds.** It lives in
`publicSiteService.resolveSlug` and nowhere else, and the `skipTenantGuard`
tripwire counts it.

### `restaurants.settings.features.online`

Boolean, default `false`. Off: every `/public` route is 404 and every
`/online` route is 403 `FEATURE_DISABLED`.

### `restaurants.settings.online`

| Field | Type | Default | Notes |
|---|---|---|---|
| `takeawayEnabled` | Boolean | false | |
| `reservationsEnabled` | Boolean | false | |
| `opensAtMinutes` | Number | 600 | 0 to 1439, minutes past midnight IST. Caffeza TO CONFIRM. |
| `closesAtMinutes` | Number | 1380 | 0 to 1439. Smaller than `opensAtMinutes` means past midnight. |
| `takeawayMinLeadMinutes` | Number | 20 | 0 to 240 |
| `takeawayAnswerWithinMinutes` | Number | 10 | 3 to 60 |
| `reservationMaxPartySize` | Number | 10 | 1 to 50 |
| `reservationDaysAhead` | Number | 14 | 1 to 60 |
| `reservationSlotMinutes` | Number | 30 | 15, 30 or 60 |
| `reservationHoldMinutes` | Number | 90 | 30 to 240. How long a booking holds its table, for clashes and the floor. |
| `pageNote` | String | `"Pay at the counter when you collect."` | Up to 200 characters. `""` is stored as null. |
| `alertRoles` | [String] | `["OWNER", "MANAGER", "CASHIER"]` | Any of the six roles except `KITCHEN` |

### `orders.origin` and `bills.origin`

| Field | Type | Default | Notes |
|---|---|---|---|
| `origin` | Object | null | `{ kind: 'ONLINE_ORDER' \| 'RESERVATION', id, reference, pickupAt }`. Set when the order is opened by M14 and never changed. `createBill` copies it onto the bill. |

### `counters`

Two new names, `ONLINE_ORDER` and `RESERVATION`, per restaurant and branch.
Reserved before the document is written, so gaps are possible, as with order
numbers.

Rollback for all of section 28: none is needed to run an older server. To
remove the data, `$unset` each field and drop the two collections.

## 29. `onlinepayments` (P24)

One advance paid online through the cafe's own Razorpay account: a takeaway in
full, or a booking deposit. The one record of that money, from the link to the
last refund.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `kind` | String | yes | `TAKEAWAY` or `DEPOSIT` |
| `onlineOrderId`, `reservationId` | ObjectId | one of | What it pays for |
| `amountInPaise` | Number | yes | Integer. The takeaway estimate, or party size × deposit per person. |
| `status` | String | yes | `CREATED`, `PAID`, `EXPIRED`, `FAILED`, `REFUNDED`, `PARTLY_REFUNDED`, `REFUND_FAILED`, `FORFEITED` |
| `provider` | String | yes | `RAZORPAY` |
| `gatewayLinkId`, `payUrl` | String | yes | The payment link and its hosted page |
| `expiresAt` | Date | yes | When the link closes |
| `gatewayPaymentId` | String | no | Set when paid |
| `paidAt` | Date | no | |
| `lastCheckedAt` | Date | no | The last read-back, for the 10-second floor |
| `refunds` | [Object] | yes | `{ gatewayRefundId, amountInPaise, reason, status, at, by }`. `status` is `PROCESSED`, `PENDING` or `FAILED`. Append only. |
| `refundedInPaise` | Number | yes | Default 0. The sum of refunds not `FAILED`. |
| `appliedInPaise` | Number | yes | Default 0. The part applied to a bill. |
| `appliedToBillId`, `appliedAt`, `appliedBy` | ObjectId, Date, ObjectId | no | |
| `orderId` | ObjectId | no | The order it became an advance on |
| `forfeitedAt` | Date | no | |

Indexes: `{ restaurantId: 1, gatewayLinkId: 1 }` unique;
`{ restaurantId: 1, onlineOrderId: 1 }`; `{ restaurantId: 1, reservationId: 1 }`;
`{ restaurantId: 1, branchId: 1, status: 1 }`.

Never deleted. Money that arrived is always accounted for: applied, refunded,
or forfeited.

### Additions for P24

- `restaurants.paymentGateway`: `{ provider, keyId, keySecretEncrypted,
  webhookSecretEncrypted, mode, connectedAt, connectedBy }`, default null. The
  two encrypted fields are `select: false`. AES-256-GCM under
  `PAYMENT_SECRETS_KEY`, stored as `iv.tag.ciphertext` in base64.
- `restaurants.settings.online`: `takeawayPrepay` (false),
  `depositPerPersonInPaise` (0), `depositRefundCutoffMinutes` (120),
  `paymentWindowMinutes` (15).
- `onlineorders.status` gains `AWAITING_PAYMENT`, `PAYMENT_EXPIRED` and
  `PAYMENT_FAILED`. `answerBy` is null until paid. Gains `paymentId`.
- `reservations.status` gains the same three, and `FORFEITED` is recorded on
  the payment, not as a reservation status. Gains `paymentId`.
- `orders.advancePaymentId`: ObjectId, default null.
- `paymentmethods`: a restaurant connecting a gateway gets the method `ONLINE`,
  "Paid online", `IN_HAND`. It is used only by apply-advance.

## 30. `menuphotos` (P24)

One photo per menu item, kept out of `menuitems` so the ordering screen's read
never carries image bytes.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `menuItemId` | ObjectId | yes | |
| `contentType` | String | yes | From the file's own bytes |
| `data` | Buffer | yes | At most 300 KB |
| `sha256` | String | yes | The ETag and the cache key in the URL |
| `width`, `height`, `sizeBytes` | Number | yes | |
| `setBy`, `setAt` | ObjectId, Date | yes | |

Index: `{ restaurantId: 1, menuItemId: 1 }` unique.

`menuitems.photo`: `{ sha256, width, height }`, default null, written with the
photo and cleared with it. Removing a photo deletes its `menuphotos` row: like
a recipe, a photo is configuration, not a record of something that happened.

---

# P25: the cashier, and M21 Integrations

Specified in P25 Part A. Sections 31 to 39 are new collections; section 40 lists
every new field on an existing collection and in `settings`. Every collection is
an ordinary tenant collection, `baseSchemaPlugin` then `tenantGuardPlugin`, and
every index starts with `restaurantId`, except the key lookups in sections 32
and 39, the job runner's claim in section 34 and the TTL in section 33, each
explained beside it. The lookups and the claim are the three M21 uses of
`skipTenantGuard`. Every model is
registered in `server/models/index.js`. Every change is additive: new fields
with defaults, nothing renamed or removed.

## 31. `refunds` (P25 Part E)

Money owed back to a guest after an item was cancelled on a bill already paid
by card, UPI or a platform. It records money returned outside this system and
moves none inside it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `billId`, `billNumber` | ObjectId, String | no | The new bill. Null when every line was cancelled and no new bill was made. |
| `voidedBillId`, `voidedBillNumber` | ObjectId, String | yes | The bill that was voided |
| `orderId` | ObjectId | yes | |
| `method`, `methodName`, `methodKind` | String | yes | Frozen from the payment it came from |
| `amountInPaise` | Number | yes | Integer above 0 |
| `businessDate` | String | yes | The business date it was created on |
| `status` | String | yes | `OWED` or `REFUNDED` |
| `createdBy` | ObjectId | yes | |
| `refundedAt`, `refundedBy`, `reference` | Date, ObjectId, String | no | Set when a manager records the refund. `reference` 1 to 100 characters. |
| `createdAt`, `updatedAt` | Date | auto | |

Index: `{ restaurantId: 1, branchId: 1, businessDate: 1, status: 1 }` for Day
Close and R2's "Refunds owed" line.
Index: `{ restaurantId: 1, status: 1, createdAt: -1 }` for the list of what is
still owed.

## 32. `integrationconnections` (P25 Part G)

One partner connection per restaurant, branch and provider.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | From `baseSchema` |
| `provider` | String | yes | `SWIGGY`, `ZOMATO`, `SANDBOX_PLATFORM`, `PINE_LABS`, `TALLY` |
| `environment` | String | yes | `SANDBOX`, `UAT`, `PRODUCTION` |
| `status` | String | yes | `DRAFT`, `ACTIVE`, `PAUSED`, `ERROR`. Default `DRAFT`. |
| `credentials` | Object | no | `{ keyId, iv, tag, ciphertext }` from `encryptJson`. `select: false`; never returned. |
| `credentialHints` | Object | yes | Each secret field's last 4 characters. Default `{}`. |
| `config` | Object | yes | Plain settings, checked by the provider's config schema |
| `webhookKeyHash` | String | no | SHA-256 hex of the random key in this connection's webhook address |
| `storeOpen` | Boolean | yes | Order channels: the store, open or closed on the platform, as staff last set it. Default true. Auto-accept only while open. (Built in P25 Part H.) |
| `lastSuccessAt`, `lastErrorAt` | Date | no | |
| `lastError` | String | no | A plain sentence, up to 300 characters, with no secret in it |
| `createdBy`, `updatedBy` | ObjectId | yes | |

Index: `{ restaurantId: 1, branchId: 1, provider: 1 }` unique. One connection per
partner per outlet.
Index: `{ webhookKeyHash: 1 }` unique, partial on `{ webhookKeyHash: { $type:
'string' } }`. A webhook finds its connection by the key alone, before it knows
the restaurant, so this index does not start with `restaurantId`. It is one of
one of the three sanctioned `skipTenantGuard` uses in M21.

A `SANDBOX_PLATFORM` connection is refused when `NODE_ENV` is `production`.

## 33. `integrationevents` (P25 Part G)

One line per call to or from a partner. Diagnostics, not financial records.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | |
| `connectionId`, `provider` | ObjectId, String | yes | |
| `direction` | String | yes | `IN` or `OUT` |
| `kind` | String | yes | Like `ORDER_PLACED`, `ACCEPT_ORDER`, `GET_STATUS`, `POST_VOUCHERS` |
| `externalId` | String | no | The partner's id for the thing, like a platform order number or a PTRID |
| `outcome` | String | yes | `OK`, `FAILED`, `DUPLICATE`, `IGNORED`, `REJECTED` |
| `httpStatus`, `durationMs` | Number | no | |
| `request`, `response` | Mixed | no | Passed through `redactForLog(value, provider)`: every secret field and every customer phone number becomes `[hidden]`, then cut to 16 KB |
| `error` | String | no | |
| `at` | Date | yes | |

Index: `{ restaurantId: 1, connectionId: 1, at: -1 }` for the connection's log.
Index: `{ restaurantId: 1, provider: 1, externalId: 1 }` for finding every line
about one order or payment.
Index: `{ at: 1 }` with `expireAfterSeconds: 15552000`, 180 days. A TTL index
must be on a single date field, so it cannot start with `restaurantId`; it only
ever deletes, never reads.

## 34. `integrationjobs` (P25 Part G)

The queue for outgoing partner calls and incoming events.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | |
| `connectionId` | ObjectId | yes | |
| `type` | String | yes | Like `PROCESS_WEBHOOK_EVENT`, `MARK_FOOD_READY`, `SET_ITEM_AVAILABILITY`, `SET_STORE_STATUS`, `PUSH_MENU`, `CHECK_TERMINAL`, `POST_VOUCHERS`, `FETCH_LEDGERS`, `PING` |
| `payload` | Mixed | yes | Never a credential |
| `dedupeKey` | String | no | Like `ready:<platformOrderId>` |
| `status` | String | yes | `QUEUED`, `RUNNING`, `DONE`, `FAILED`, `DEAD`. `FAILED` waits for a retry. |
| `runAfter` | Date | yes | |
| `lockedUntil` | Date | no | |
| `attempts`, `maxAttempts` | Number | yes | Default 0 and 6 |
| `lastError` | String | no | |
| `forBridge` | Boolean | yes | Default false. True for Tally jobs that only a bridge picks up. |
| `acknowledgedAt`, `acknowledgedBy` | Date, ObjectId | no | A `DEAD` job's alert, acknowledged |

Index: `{ status: 1, forBridge: 1, runAfter: 1 }` for the runner, which claims
due jobs of every restaurant in one loop. It does not start with
`restaurantId` because the runner is the one reader that spans restaurants, a
sanctioned `skipTenantGuard` use; each job it claims then runs scoped to its own
restaurant.
Index: `{ restaurantId: 1, dedupeKey: 1 }` unique, partial on `{ dedupeKey: {
$type: 'string' } }`, so a used key is not queued twice.
Index: `{ restaurantId: 1, connectionId: 1, status: 1, runAfter: 1 }` for a
bridge's next job and the alerts read.

## 35. `platformitemmappings` (P25 Part H)

Which of our dishes a platform's item is.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | |
| `connectionId` | ObjectId | yes | |
| `externalItemId` | String | yes | 1 to 100 characters |
| `externalVariantId` | String | no | Null when the platform item has no variant |
| `externalName` | String | no | As last seen in an order |
| `menuItemId`, `variantId` | ObjectId | yes, no | Ours |
| `addOnMap` | Object | yes | `{ "<external add-on id>": "<our add-on id>" }`. Default `{}`. |
| `lastSeenAt` | Date | no | |

Index: `{ restaurantId: 1, connectionId: 1, externalItemId: 1, externalVariantId:
1 }` unique. One mapping per external pair.
Index: `{ restaurantId: 1, menuItemId: 1 }` for "which channels sell this dish",
read when its availability changes.

Unmapped items are not stored here. They are read from `platformorders`.

## 36. `platformorders` (P25 Part H)

A delivery platform's order, from arrival to delivery. **Not** `onlineorders`,
which P23 uses for the restaurant's own website.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | |
| `connectionId`, `provider` | ObjectId, String | yes | |
| `platformCode` | String | yes | `ZOMATO` or `SWIGGY`, what the order is billed as. The sandbox's `actsAs`. |
| `platformOrderId` | String | yes | The platform's own number |
| `status` | String | yes | `RECEIVED`, `NEEDS_ATTENTION`, `ACCEPTED`, `REJECTED`, `CANCELLED_BY_PLATFORM`, `PICKED_UP`, `DELIVERED`, `FAILED` |
| `attentionReasons` | [String] | yes | Any of `UNMAPPED_ITEMS`, `CASH_ON_DELIVERY`, `RESTAURANT_DELIVERY`, `NO_PLATFORM_PAYMENT_METHOD`, `PACKAGING_NOT_MAPPED`, `DAY_CLOSED`. Default `[]`. |
| `order` | Object | yes | The normalised order (P25 Part H2), with phone numbers already dropped |
| `orderId`, `billId` | ObjectId | no | Ours, once they exist |
| `acceptBy` | Date | no | |
| `decidedBy`, `decidedAt` | ObjectId, Date | no | |
| `rejectReasonCode`, `rejectNote` | String | no | |
| `prepMinutes` | Number | no | |
| `amountMismatch` | Object | no | `{ oursInPaise, platformInPaise }` when the bill and the platform disagree by more than the round-off |
| `failure` | String | no | Why a `FAILED` order could not be created here |
| `receivedAt` | Date | yes | |
| `businessDate` | String | yes | The business date of `receivedAt` |
| `history` | [Object] | yes | `{ status, at, by, note }`, `by` null for the platform |
| `acknowledgedAt`, `acknowledgedBy` | Date, ObjectId | no | Its alert, acknowledged |

Index: `{ restaurantId: 1, connectionId: 1, platformOrderId: 1 }` unique. A
duplicate `ORDER_PLACED` hits it and changes nothing.
Index: `{ restaurantId: 1, branchId: 1, status: 1, receivedAt: -1 }` for the
inbox and the list.
Index: `{ restaurantId: 1, branchId: 1, businessDate: 1, status: 1 }` for Day
Close blockers.

## 37. `terminaltransactions` (P25 Part I)

One attempt to take a payment on a card machine.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | |
| `connectionId` | ObjectId | yes | |
| `billId`, `billNumber` | ObjectId, String | yes | |
| `methodCode`, `allowedPaymentMode`, `amountInPaise` | String, Number, Number | yes | |
| `transactionNumber` | String | yes | The bill number with everything but letters and digits removed |
| `sequenceNumber` | Number | yes | 1, 2, … for every attempt on this bill |
| `terminal` | Object | yes | `{ name, clientId }` |
| `ptrid` | String | no | Pine Labs' PlutusTransactionReferenceID |
| `status` | String | yes | `CREATED`, `WAITING`, `APPROVED`, `DECLINED`, `CANCELLED`, `EXPIRED`, `UNKNOWN` |
| `result` | Object | no | `{ rrn, approvalCode, tid, mid, paymentMode, amountInPaise, maskedCard }`. `maskedCard` only as the machine sends it, masked. Never a full card number. |
| `paymentId` | ObjectId | no | The bill payment it became |
| `businessDate` | String | yes | Of `startedAt` |
| `startedBy`, `startedAt`, `finishedAt`, `lastCheckedAt` | | | |
| `acknowledgedAt`, `acknowledgedBy` | Date, ObjectId | no | An `UNKNOWN` alert, acknowledged |

Index: `{ restaurantId: 1, connectionId: 1, transactionNumber: 1, sequenceNumber:
1 }` unique.
Index: `{ restaurantId: 1, ptrid: 1 }` unique, partial on `{ ptrid: { $type:
'string' } }`.
Index: `{ restaurantId: 1, paymentId: 1 }` unique, partial on `{ paymentId: {
$type: 'objectId' } }`. One approval is never two payments.
Index: `{ restaurantId: 1, status: 1, startedAt: 1 }` for the checking job and
Day Close blockers.

## 38. `tallyexports` (P25 Part J)

One build of one closed business date's vouchers.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | |
| `connectionId` | ObjectId | yes | |
| `businessDate` | String | yes | |
| `granularity`, `version` | String | yes | Copied from the connection when built |
| `status` | String | yes | `BUILT`, `DOWNLOADED`, `QUEUED`, `POSTED`, `PARTIAL`, `FAILED`, `UNKNOWN`, `STALE` |
| `voucherCount`, `debitInPaise`, `creditInPaise` | Number | yes | Debits equal credits, or the build fails |
| `xml` | String | yes | `select: false` in lists |
| `xmlSha256` | String | yes | |
| `builtFromCloseAt` | Date | yes | The day closure's `closedAt` it was built from |
| `jobId` | ObjectId | no | The bridge job, when sent |
| `response` | String | no | Tally's answer, cut to 64 KB |
| `lineErrors` | [String] | yes | Default `[]` |
| `createdBy`, `postedAt` | ObjectId, Date | | |
| `redoneFromId` | ObjectId | no | The export a redo replaced |
| `acknowledgedAt`, `acknowledgedBy` | Date, ObjectId | no | A failure's alert, acknowledged |

Index: `{ restaurantId: 1, connectionId: 1, businessDate: 1, createdAt: -1 }` for
the calendar and the "already exported" check. Not unique: a stale export stays,
and its redo is a new row.

## 39. `tallybridges` (P25 Part K)

A computer allowed to post into Tally for one connection. A row is created when
the owner asks for a pairing code and becomes a bridge when the code is used.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | |
| `connectionId` | ObjectId | yes | |
| `name` | String | yes | 1 to 40 characters |
| `machineName` | String | no | Sent by the bridge |
| `pairingCodeHash` | String | no | SHA-256 of the 8-character code. Cleared when used. |
| `pairingExpiresAt` | Date | no | 10 minutes after the code was made |
| `tokenHash` | String | no | SHA-256 of the bridge's token. The token is never stored. |
| `lastSeenAt` | Date | no | |
| `tallyVersionSeen` | String | no | |
| `companiesSeen` | [String] | yes | Default `[]` |
| `ledgersSeen` | [String] | yes | From the latest `FETCH_LEDGERS`. Default `[]`. |
| `ledgersSeenAt` | Date | no | |
| `pairedBy`, `pairedAt` | ObjectId, Date | no | `pairedBy` is the owner who made the code |
| `revokedAt`, `revokedBy` | Date, ObjectId | no | |

Index: `{ pairingCodeHash: 1 }` unique, partial on `{ pairingCodeHash: { $type:
'string' } }`, and `{ tokenHash: 1 }` unique, partial on `{ tokenHash: { $type:
'string' } }`. The bridge is found by its code or token before the restaurant is
known: another of the three sanctioned M21 `skipTenantGuard` uses.
Index: `{ restaurantId: 1, connectionId: 1, revokedAt: 1 }` for the list.

## 40. Additions to existing collections and settings (P25)

### `bills`

| Field | Type | Default | Notes |
|---|---|---|---|
| `printRequestedAt`, `printRequestedBy` | Date, ObjectId | null | Part D. The latest request to print at the counter. |
| `lastPrintedAt` | Date | null | Part D |
| `printCount` | Number | 0 | Part D. From 1, every print says "Duplicate". |
| `payments[].carriedFromBillId` | ObjectId | null | Part E. The voided bill this payment was carried from. |
| `payments[].tender` | Object | null | Part F. `{ cashCount, tenderedInPaise, changeInPaise }`. Cash only. Read by no figure. |
| `payments[].terminal` | Object | null | Part I. `{ provider, ptrid, rrn, approvalCode, tid, paymentMode }` |

Index: `{ restaurantId: 1, branchId: 1, printRequestedAt: 1 }`, partial on `{
printRequestedAt: { $type: 'date' } }`, for the print queue.

### `orders`

| Field | Type | Default | Notes |
|---|---|---|---|
| `lines[].priceSource` | String | `MENU` | Part H. `PLATFORM` when the line's price is the platform's, frozen from the platform order. |
| `origin.kind` | | | Gains `PLATFORM_ORDER`, with `id` the `platformorders` id |

### `cashmovements` and `dayclosures`

| Field | Type | Default | Notes |
|---|---|---|---|
| `cashmovements.cashCount` | [Object] | null | Part F. `[{ valueInPaise, kind, count }]` on an opening float counted by notes |
| `dayclosures.cashCount` | [Object] | null | Part F. The latest close's count by notes |
| `dayclosures.history[].cashCount` | [Object] | null | Part F |

### `paymentmethods`

| Field | Type | Default | Notes |
|---|---|---|---|
| `terminalProvider` | String | null | Part I. `PINE_LABS` or null. `IN_HAND` methods only. |
| `terminalPaymentMode` | Number | null | Part I. Pine Labs' `AllowedPaymentMode`. Required with a provider. |

### `users`

| Field | Type | Default | Notes |
|---|---|---|---|
| `isSystem` | Boolean | false | Part G. The integration user. Refused at sign-in, left out of staff lists. Its `phone` is `system:<restaurantId>`. |

### `auditlogs`

`action` and `entityType` gain the values in API-CONTRACT M8, "Added by P25".

### `restaurants.settings`

| Path | Type | Default |
|---|---|---|
| `receipt.reviewLinkUrl` | String or null | null |
| `billing.captainsMayBill` | Boolean | true |
| `billing.captainsMayTakePayment` | Boolean | false |
| `cash.denominations` | `[{ valueInPaise, kind, isActive }]` | India, API-CONTRACT M16 section 8.1 |
| `payments.requireTerminalForLinkedMethods` | Boolean | true |
| `reports.onHoldTallyCode` | String or null | null |

Every field has a schema default, so a restaurant saved before P25 reads back
complete, with no migration.

## 41. `customers` (P27)

One guest at one restaurant, by phone. Built from orders.

| Field | Type | Required | Notes |
|---|---|---|---|
| `restaurantId`, `branchId` | ObjectId | yes | |
| `phone` | String | yes | 10 digits, normalised |
| `name` | String | no | The latest name given, up to `CUSTOMER_NAME_MAX_LENGTH` |
| `firstVisitAt`, `lastVisitAt` | Date | yes | UTC |
| `lastOrderId` | ObjectId | no | |
| `visitCount` | Number | yes | Orders opened with this phone |
| `offers` | Object | yes | `{ given, textVersion, at, source }`, default not given. `source` is `STAFF` or `ONLINE`. |
| `offersHistory` | [Object] | yes | `{ given, textVersion, at, source, by, reason }`, append only. Default `[]`. |

Index: `{ restaurantId: 1, phone: 1 }` unique; `{ restaurantId: 1, lastVisitAt: -1 }`
for the list. Orders already store `customerName` and `customerPhone`; a
dine-in order may now carry them too.


## 42. Additions for manager approval by PIN (P28)

Every new field has a default, so nothing is migrated.

| Collection | Field | Type | Default | Notes |
|---|---|---|---|---|
| `orders` | `lines[].cancelApprovedBy` | ObjectId or null | null | The OWNER or MANAGER who approved a cashier's or captain's cancel |
| `orders` | `cancelApprovedBy` | ObjectId or null | null | The same, for a whole-order cancel |
| `bills` | `voidApprovedBy` | ObjectId or null | null | The same, for a void |
| `cashmovements` | `approvedBy` | ObjectId or null | null | The same, for a paid in or paid out |
| `cashmovements` | `voidApprovedBy` | ObjectId or null | null | Added 2026-10-17. The OWNER or MANAGER who approved a cashier's void of a cash entry |
| `restaurants` | `settings.approvals.lineCancel` | Boolean | true | |
| `restaurants` | `settings.approvals.paidIn` | Boolean | true | |
| `restaurants` | `settings.approvals.managerTasks` | Boolean | true | |
| `auditlogs` | `action` | enum | | Gains `LINE_CANCELLED_APPROVED` and `CASH_PAID_IN` |

`orders.noCharge.approvedBy` already exists; from P28 it is the approver when a
cashier asked.

## 43. Additions for bill revisions, ready means served, kitchen undo and the cash book (P29)

Every new field has a default, so nothing is migrated, and nothing is renamed or
removed. The one data script, `npm run migrate:ready-to-served`, moves order
lines a kitchen already marked ready to served for restaurants with
`kitchen.readyMeansServed` on; it changes statuses only, never a figure.

### `bills`

| Field | Type | Default | Notes |
|---|---|---|---|
| `revision` | Number | 0 | Whole number. How many times the bill was revised (API-CONTRACT M3 16.8). |
| `revisions` | Array | `[]` | Append-only, one entry per revision, below |
| `lastPrintedRevision` | Number or null | null | `revision` at the last `POST /printed`. Null on a bill printed before P29, read as 0. |
| `paymentBeforePrint` | Boolean | false | Set when a payment is recorded while `printCount` is 0 (16.9) |

One `revisions` entry:

| Field | Type | Notes |
|---|---|---|
| `revision` | Number | The bill's `revision` after this change, 1 for the first |
| `kind` | String | `REMOVED` or `ADDED` |
| `at` | Date | UTC |
| `by` | ObjectId | The person who changed it |
| `approvedBy` | ObjectId or null | The owner or manager who typed their PIN; null when the actor approved themselves or none was needed |
| `lines` | Array | `{ orderLineId, itemName, variantName, quantity, lineTotalInPaise, wasPrepared }`, frozen. `wasPrepared` is null on `ADDED`. |
| `reasonCode` | String or null | From `LINE_CANCEL_REASONS` on `REMOVED`; null on `ADDED` |
| `note` | String or null | Up to 200 characters |
| `previousGrandTotalInPaise` | Number | Whole paise |
| `newGrandTotalInPaise` | Number | Whole paise. Equals the bill's `grandTotalInPaise` for the last entry (C13). |
| `wasPrinted` | Boolean | `printCount` was above 0 when it changed |

No index is added: a revision is read with its bill.

### `orders`

| Field | Type | Default | Notes |
|---|---|---|---|
| `lines[].removedFromBillId` | ObjectId or null | null | Set when the line was cancelled by removing it from an unpaid bill, so R15 can say so |

### `kots`

No new field. Undoing ready (API-CONTRACT M2 13.5) sets a line back to
`PENDING` and its `readyAt` to null.

### `cashmovements`

| Field | Type | Default | Notes |
|---|---|---|---|
| `type` | enum | | Gains `CASH_TAKEN_OUT` and `CASH_CHECK` |
| `amountInPaise` | Number | | May be 0 on a `CASH_CHECK` only; every other type keeps the minimum of 1 |
| `source` | String or null | null | `PAID_IN`: `OWNER`, `BANK`, `CHANGE` or `OTHER` |
| `category` | String or null | null | `PAID_OUT`: an expense category code from settings, frozen |
| `categoryLabel` | String or null | null | The category's label when the expense was written, frozen, so renaming a category never rewrites history |
| `destination` | String or null | null | `CASH_TAKEN_OUT`: `BANK_DEPOSIT`, `OWNER` or `OTHER` |
| `takenBy` | ObjectId or null | null | `CASH_TAKEN_OUT`: who took the cash |
| `broughtForwardFrom` | String or null | null | `OPENING_FLOAT`: the closed business date its kept cash came from |
| `openingDifferenceInPaise` | Number or null | null | `OPENING_FLOAT`: counted minus kept, signed, when a brought-forward float was recounted and differed |
| `expectedCashInPaise` | Number or null | null | `CASH_CHECK`: the cash in the drawer at that moment |
| `differenceInPaise` | Number or null | null | `CASH_CHECK`: counted minus expected, signed |

The partial unique index for one live opening float per date is unchanged.

### `dayclosures`

| Field | Type | Default | Notes |
|---|---|---|---|
| `keptForTomorrowInPaise` | Number or null | null | Cash left in the drawer at close. Null on a close from before P29, or when it was not given. |
| `keptForTomorrowCount` | Array or absent | absent | Notes and coins kept, `cashCountRowSchema` |
| `takenOutAtCloseInPaise` | Number or null | null | Counted minus kept |
| `takenOutTo` | String or null | null | `BANK_DEPOSIT`, `OWNER` or `OTHER` |
| `takenOutBy` | ObjectId or null | null | Who took it |
| `history[].keptForTomorrowInPaise`, `history[].takenOutAtCloseInPaise` | Number or null | null | The same, per close |

### `integrationjobs`

| Field | Type | Notes |
|---|---|---|
| `status` | enum | Gains `CANCELLED`, set only when a kitchen undo stops a queued "food is ready" call. A cancelled job's `dedupeKey` gets the suffix `:cancelled:{jobId}`, so the key is free again. |

### `restaurants`

| Field | Type | Default |
|---|---|---|
| `settings.billing.reviseUnpaidBills` | Boolean | true |
| `settings.billing.printBeforePayment` | Boolean | true |
| `settings.approvals.revisePrintedBill` | Boolean | true |
| `settings.kitchen.readyMeansServed` | Boolean | true, in the new group `settings.kitchen` |
| `settings.cash.expenseCategories` | Array of `{ code, label, isActive }` | the ten in API-CONTRACT M16 9.2 |
| `settings.cash.usualFloatInPaise` | Number | 200000 |
| `settings.cash.showDrawerTotalToStaff` | Boolean | false |

### `auditlogs`

`action` gains `BILL_REVISED`, `KITCHEN_READY_UNDONE`, `CASH_TAKEN_OUT` and
`OPENING_FLOAT_DIFFERED`.

## 44. `serverstarts` (P30)

One document each time the server process starts listening. It belongs to the
server, not to a restaurant, so it is the second collection after
`restaurants` with no `restaurantId`, and it applies neither `baseSchema` nor
`tenantGuard`. It holds no restaurant's data: a time, a release and a reason.
`models/index.js` lists it in `SERVER_MODELS`, which the purge tool and the
seed wipe skip, because no restaurant owns its documents.

| Field | Type | Notes |
|---|---|---|
| `startedAt` | Date | UTC. When the process started, not when the row was written. |
| `release` | String or null | `RELEASE_VERSION`, the commit the host deployed, or null |
| `nodeEnv` | String | `NODE_ENV` |
| `reason` | String | `FIRST`, `DEPLOY` or `RESTART`, against the previous start (API-CONTRACT P30 section 3) |
| `createdAt` | Date | UTC |

Indexes: `{ startedAt: -1 }`, with `expireAfterSeconds` of 60 days: a start
older than 60 days is removed by the database. Written once per start, never
updated, never read by a report or a bill.

## 45. Setting a password from the sign-in screen (P34)

No collection and no field. `auditlogs` already has `USER_PASSWORD_RESET`; a
reset from the sign-in screen writes it with the approving OWNER or MANAGER as
`actorId` and `details: { role, source: "SIGN_IN_SCREEN" }`. A reset from the
Staff screen has no `source`, and reads as it always has.

The person is looked up by phone or email across the platform, through the
existing global unique indexes on `users.phone` and `users.email`, the same
lookup login makes. The approver is looked up inside that person's restaurant
only.

## 46. One kitchen ticket per table (P36)

Additive. Every field has a default, and a ticket written before P36 reads as
before: a line without its own station or sent time takes the ticket's.

### `kots`

| Field | Type | Default | Notes |
|---|---|---|---|
| `rounds` | Number | 1 | How many Sends this ticket holds. Whole number, 1 or more |
| `lastFiredAt` | Date or null | null | When the latest round was sent. Null on a ticket from before P36, which means `firedAt` |
| `lines[].stationId` | ObjectId or null | null | The station that makes this dish, frozen when it was sent. Null: the ticket's `stationId` |
| `lines[].stationName` | String or null | null | Frozen with it |
| `lines[].firedAt` | Date or null | null | When this dish was sent. Null: the ticket's `firedAt` |
| `lines[].round` | Number | 1 | Which Send of the ticket it came in, from 1 |

With `settings.kitchen.oneTicketPerOrder` on, an order has one ticket: the
first Send creates it, later Sends add lines and rounds to it, and its
`kotNumber` never changes. Its own `stationId` and `stationName` are the one
station every line went to, or null when they went to more than one.

New index, for a station's screen: `{ restaurantId: 1, branchId: 1, 'lines.stationId': 1, createdAt: 1 }`.
The old `{ restaurantId, branchId, stationId, createdAt }` stays, for tickets
from before P36.

### `restaurants.settings.kitchen`

| Field | Type | Default | Notes |
|---|---|---|---|
| `oneTicketPerOrder` | Boolean | true | One ticket per order, every round and station on it. Off: one per station per Send, as P05 |

## 47. Kitchen recall and undo after Send (P41)

No new collection or field.

`orders.lines[].cancelReasonCode` gains `SENT_BY_MISTAKE`, written only by
`POST /orders/:orderId/undo-send`. `auditlogs.action` gains `KOT_SEND_UNDONE`.

## 48. Changing a sent dish (P42)

`kots.lines[]` gains `changedAt` (above). Lowering a sent line's quantity
splits it: the line keeps the new quantity, and a cancelled line with the same
snapshot holds the difference, so reports read the cancelled quantity as for
any cancel. Its stock comes back as `CANCELLATION_RETURN` movements on the
original line, keyed `{lineId}:{ingredientId}:CANCELLATION_RETURN:{newLineId}`.

## 49. The day-end email (P44)

`restaurants.settings.reports.dayEndEmails`: [String], default `[]`, at most
5, lowercased. `dayclosures.dayEndEmail`: `{ sentAt: Date, to: [String],
error: String }` or null, default null; written after a close, never part of
the close's transaction.

## 50. Open items (P46)

`menuitems.isOpenItem`: Boolean, default false. `orders.lines[].isOpenItem` and
`bills.lines[].isOpenItem`: Boolean, default false, frozen when the line is
added; on such a line `itemName` and `unitPriceInPaise` are what staff typed.

## 51. Other modes (P47)

`restaurants.settings.payments.otherModes`: [String], default the six of the
prompt, at most 12, each 1 to 40 characters.

## 52. Typed extras (P48)

`orders.lines[].addOns[].addOnId` is no longer required: null marks an extra
typed at the table, whose `name` and `priceInPaise` are what staff typed.

## 53. A table closed by mistake (P50)

`orders.cancelReasonCode` gains `OPENED_BY_MISTAKE`, written only by
`POST /orders/:orderId/close` on an order nothing was sent from. Its unsent lines
are removed, as P49 removes one. Additive: no existing value changes.

## 54. WhatsApp: templates and the receipt (P37)

### `messagetemplates` (new)

One per template a restaurant sends on WhatsApp. Configuration, scoped like
everything else.

| Field | Type | Default | Notes |
|---|---|---|---|
| `key` | String | | Ours, like `BILL_RECEIPT`. Unique per restaurant and branch |
| `metaName` | String | | The name registered with Meta: lowercase letters, digits, underscores |
| `category` | enum | | `UTILITY`, `MARKETING` or `AUTHENTICATION`: what we asked for |
| `approvedCategory` | enum or null | null | What Meta decided. Every price is worked out from this, never `category` |
| `language` | String | `en` | |
| `bodyText` | String | | With numbered variables, `{{1}}`, as Meta stores it. Up to 1,024 characters |
| `variables` | [String] | [] | What fills each numbered variable, in order |
| `example` | [String] | [] | The example values sent to Meta for review |
| `status` | enum | `DRAFT` | `DRAFT`, `PENDING`, `APPROVED`, `REJECTED`, `PAUSED`, `DISABLED` |
| `rejectionReason` | String or null | null | What Meta said |
| `metaTemplateId` | String or null | null | Meta's id for it |
| `lastSyncedAt` | Date or null | null | |
| `createdBy` | ObjectId | | |

Indexes: `{ restaurantId, branchId, key }` unique; `{ restaurantId, branchId, metaName, language }`.

### `integrationconnections`

`provider` gains `WHATSAPP`. No new field: its credentials sit in the sealed
`credentials` box and its settings in `config`, as every provider's do.

### `integrationjobs`

New job types `SEND_WHATSAPP_TEMPLATE` and `SEND_WHATSAPP_TEXT`. Their
`payload` names the guest by `customerId`, never by number. `result` gains, on
a sent message, `messageId`, `customerId`, `deliveryStatus` (`SENT`,
`DELIVERED`, `READ`, `FAILED`) and `deliveryAt`; on a refusal from Meta,
`failed` and `message`. The idempotency key is the job's `dedupeKey`
(`whatsapp:bill:<billId>:receipt`), on the existing unique index.

### `customers`

| Field | Type | Default | Notes |
|---|---|---|---|
| `whatsappUnreachableAt` | Date or null | null | When Meta said this number is not on WhatsApp. Nothing more is sent to it |

A STOP writes `offers.given: false` and an `offersHistory` entry with source
`ONLINE`, `by: null` and the reason "Replied STOP on WhatsApp".

## 55. The WhatsApp assistant (P51)

### `conversations` (new)

One per guest per branch.

| Field | Type | Default | Notes |
|---|---|---|---|
| `customerId` | ObjectId | | The guest. Never the number |
| `status` | enum | `BOT` | `BOT`, `NEEDS_STAFF`, `STAFF`, `CLOSED` |
| `lastInboundAt` | Date or null | null | The guest's last message: the 24-hour window |
| `lastMessageAt` | Date | | Either side. Kept 30 days after it, then removed (TTL) |
| `turns` | [{ role, text, at, toolName }] | [] | The last 30. `role`: `GUEST`, `ASSISTANT`, `STAFF`, `TOOL`. Text up to 1,000 characters |
| `pendingBooking` | Object or null | null | What the guest has given so far |
| `handoffReason` | String or null | null | |
| `aiCallsDate` | String or null | null | A business date |
| `aiCallsToday` | Number | 0 | Model calls on `aiCallsDate` |

Indexes: `{ restaurantId, branchId, customerId }` unique;
`{ restaurantId, branchId, status, lastMessageAt }`; `{ lastMessageAt }` with a
30-day TTL, which does not lead with `restaurantId` because MongoDB's TTL needs a
single date field, the same as `integrationevents`.

### `customers`

| Field | Type | Default | Notes |
|---|---|---|---|
| `source` | enum | `ORDER` | `ORDER`, or `WHATSAPP` for a guest known only from writing on WhatsApp |
| `whatsappStoppedAt` | Date or null | null | The guest asked for no messages at all. Nothing is sent, bills included |

`firstVisitAt` and `lastVisitAt` are no longer required: a `WHATSAPP` guest has
had no visit. Every guest from an order still has both. Additive: no stored
document changes.

### `reservations`

`source` gains `WHATSAPP`.

### `messagetemplates`

Two more keys the restaurant may add: `BOOKING_CONFIRMED` and `BOOKING_DECLINED`.

### `integrationconnections`

`provider` gains `GEMINI`, `ANTHROPIC` and `GROQ` (Groq added at Arya's request).

### `restaurants.settings.assistant`

| Field | Type | Default |
|---|---|---|
| `enabled` | Boolean | false |
| `bookingsEnabled` | Boolean | true |
| `greeting` | String or null | null |
| `handoffHours` | String or null | null |
| `dailyAiLimit` | Number | 500 |

## 56. Backups (P54)

`docs/prompts/P54-constant-backups.md`. Two collections about the server, not a
restaurant, exactly like `serverstarts` (section 44): neither has a
`restaurantId`, neither applies `baseSchema` or `tenantGuard`, and both are in
`SERVER_MODELS`, which the purge tool and the seed wipe skip. They hold no
restaurant's data: times, sizes, object keys and plain error words. Neither is
in a full copy or the change diary, so the diary never records its own writing.

### `backupruns` (new)

One document per attempt. Kept 90 days by a TTL index on `startedAt`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `kind` | enum | | `SNAPSHOT` or `JOURNAL` |
| `status` | enum | `RUNNING` | `RUNNING`, `OK` or `FAILED` |
| `startedAt`, `finishedAt` | Date | | UTC; `finishedAt` null while running |
| `folder` | enum or null | null | Snapshots: `monthly`, `daily` or `6h`. Journal: `journal` |
| `objectKey` | String or null | null | Where the file went, like `snapshots/daily/2026/10/14/2026-10-14T00-00-00Z.snap.gz.enc` |
| `bytes` | Number | 0 | Size of the uploaded, encrypted file |
| `sha256` | String or null | null | Of the uploaded, encrypted file |
| `fromClusterTime`, `toClusterTime` | Timestamp or null | null | A snapshot's start time, or the first and last change in a diary file |
| `eventCount` | Number | 0 | Diary files only |
| `collections` | [{ name, count }] | [] | Snapshots only |
| `databaseBytes` | Number | 0 | Snapshots only: data plus index size from `dbStats` |
| `error` | String or null | null | Plain words, never a secret, never a document. Also the note when full copies switch between every 6 hours and once a day |

Indexes: `{ startedAt: 1 }` with a 90-day TTL, which does not lead with
`restaurantId` because MongoDB's TTL needs a single date field, as
`serverstarts`; `{ kind: 1, status: 1, startedAt: -1 }`. The one-snapshot-at-a-time
claim is a unique partial index on `{ kind: 1 }` filtered to
`status: 'RUNNING'`, so two copies can never run at once.

### `backupstate` (new)

Small documents by `_id`. Built with three, not the prompt's one, because
`backupruns` expires after 90 days and the running state must not:

| `_id` | Fields | Notes |
|---|---|---|
| `journal` | `resumeToken`, `lastFlushAt`, `lastEventClusterTime`, `lastEventAt`, `gapSince` | `gapSince` is null unless the diary lost its place |
| `snapshots` | `fullCopies` (`EVERY_6_HOURS` or `DAILY`), `changedAt` | The slow-down rule's current setting |
| `storage` | `foreverBytes` | Bytes of every monthly copy and diary file ever uploaded: they are kept forever, but their `backupruns` rows are not |

### In the bucket, not the database

A gap the diary could not cover is also written to the bucket as a small
encrypted marker, `journal/YYYY/MM/DD/<from UTC>_<to UTC>.gap.enc`, because a
real restore starts from an empty database and cannot read `backupruns`.

## 57. A note for every dish, the guest before the first KOT, whole voids (P56)

`docs/prompts/P56-order-note-guest-before-kot-whole-voids.md`. Additive: every
field has a default, and no existing value changes.

| Collection | Field | Type | Default | Notes |
|---|---|---|---|---|
| `orders` | `kitchenNote` | String or null | null | Up to 200 characters. One note for every dish on the order, set by `PATCH /orders/:orderId/kitchen-note` |
| `kots` | `kitchenNote` | String or null | null | The order's `kitchenNote`, copied when the ticket is made, when a round is added, and when the note changes |
| `bills` | `isVoidedToChangeItems` | Boolean | false | True only on a bill voided by cancelling items after billing (M3 16.4) or reopening to add items (P26). Never set on a bill voided before P56 |

`orders.customerName` and `orders.customerPhone` (section 41) can now also be
set after the order opens, by `PATCH /orders/:orderId/customer`, until it has a
bill.

## 58. One kitchen ticket per Send (P58)

`docs/prompts/P58-one-ticket-per-send.md`. Additive: a default, no existing
value changes, and no migration.

| Collection | Field | Type | Default | Notes |
|---|---|---|---|---|
| `restaurants` | `settings.kitchen.splitTicketsByStation` | Boolean | true | Off: a Send's dishes go on one ticket with no station of its own, instead of one ticket per station. Each ticket line still keeps its station |

## 59. Bill without KOT (P60)

`docs/prompts/P60-bill-without-kot.md`. Additive: a default, no existing value
changes, and no migration.

| Collection | Field | Type | Default | Notes |
|---|---|---|---|---|
| `orders` | `lines[].billedWithoutKot` | Boolean | false | True on a dish the counter billed without sending to the kitchen: it went from not sent straight to served, with `servedAt` set and `firedAt` and `kotId` left null |
| `bills` | `lines[].billedWithoutKot` | Boolean | false | Copied from the order line when the bill is made |

## 60. Invoice themes, HSN codes and print fields (P64)

`docs/prompts/P64-invoice-themes-and-print-fields.md`. Additive: every field
has a default, no existing value changes, no migration. Adds to sections 1
(`settings`, `brandLogos`), 6 (`menuitems`) and 12 (`bills.lines`).

| Collection | Field | Type | Default | Notes |
|---|---|---|---|---|
| `menuitems` | `hsnCode` | String or null | null | 4 to 8 digits. The item's own HSN or SAC code |
| `orders` | `lines[].hsnCode` | String or null | null | Frozen when the line is added: the item's code, else `settings.invoice.defaultSacCode`. Null on lines from before P64 |
| `bills` | `lines[].hsnCode` | String or null | null | Copied from the order line. Never back-filled |
| `restaurants` | `panNumber` | String or null | null | `AAAAA9999A` |
| `restaurants` | `msmeNumber` | String or null | null | An Udyam number, `UDYAM-GJ-01-0012345` |
| `restaurants` | `brandLogos.signature` | Logo slot | empty | The P22 slot shape; `data` is `select: false` |
| `restaurants` | `settings.invoice.defaultSacCode` | String | `"996331"` | 4 to 8 digits |
| `restaurants` | `settings.receipt.termsText` | String or null | null | Up to 600 characters |
| `restaurants` | `settings.invoiceLayout.theme` | String | `CLASSIC` | `CLASSIC`, `GST_DETAILED`, `MODERN`, `COMPACT` |
| `restaurants` | `settings.invoiceLayout.useBrandAccent` | Boolean | false | |
| `restaurants` | `settings.invoiceLayout.show.*` | Boolean | see API-CONTRACT P64 2 | Twenty switches for the full page |
| `restaurants` | `settings.invoiceLayout.thermalShow.*` | Boolean | see API-CONTRACT P64 2 | Twelve switches for the roll |

The defaults print what CLASSIC and the thermal bill printed before P64.

---

# P62. Replication, intake and the box

Built 2026-10-21. Additive: new collections only, one new audit action
(`BOX_WIFI_CHANGED`), no field renamed or removed. Classification of every
collection: `server/config/replication.js` and `docs/REPLICATION.md` section 2.

| Collection | Model | Where | Fields | Indexes |
|---|---|---|---|---|
| `changelog` | ChangelogEntry | box | `restaurantId`, `seq` (int ≥ 1), `epoch`, `coll`, `documentId`, `op` (insert, update, replace, delete, baseline), `doc` (Mixed or null), `capturedAt`, `eventId` (string or null). No `branchId`, no timestamps. Append only | `{ restaurantId, seq }` unique; `{ eventId }` unique where a string; `{ restaurantId, capturedAt: -1 }`; `{ coll, documentId, seq: -1 }` |
| `changelogcounters` | ChangelogCounter | box | `restaurantId`, `value` | `{ restaurantId }` unique |
| `replicationstate` | ReplicationState | each | `_id` string: `writer` (`epoch`, `fenced`, `fencedAt`, `fencedReason`, `promoted`, `promotedAt`), `changestream` (`resumeToken`, `baselineDoneAt`), `shipper:<rid>` (`shippedSeq`, `shippedAt`, `lastError`, `lastErrorAt`), `boxseen:<rid>` (`seenAt`), `reconcile:<rid>` (`status`, `checkedAt`, `mismatches`), `clock` (`refusing`, `newestKnownAt`, `observedAt`). No `restaurantId`: in `SERVER_MODELS` | |
| `replicacursors` | ReplicaCursor | mirror | `restaurantId`, `appliedSeq`, `appliedAt`, `lastCapturedAt`, `epoch`, `gap { expectedSeq, gotSeq, at }` | `{ restaurantId }` unique |
| `replicationquarantine` | ReplicationQuarantine | mirror | `restaurantId`, `sentEpoch`, `currentEpoch`, `firstSeq`, `lastSeq`, `entries` (EJSON text), `receivedAt`. Append only | `{ restaurantId, firstSeq }` |
| `intake` | IntakeItem | mirror | base schema, `source`, `externalId`, `params`, `body`, `rawBody`, `headers`, `receivedAt`, `status` (RECEIVED, CLAIMED, APPLIED, REJECTED), `claimedAt`, `claimExpiresAt`, `attempts`, `decidedAt`, `reasonCode`, `reasonMessage`, `result`, `pendingStatusToken` (select: false), `guestSecretHash` | `{ restaurantId, source, externalId }` unique; `{ restaurantId, status, receivedAt }` |
| `intakeapplications` | IntakeApplication | box, ships | base schema, `intakeId`, `source`, `status` (STARTED, APPLIED, REJECTED), `attempts`, `reasonCode`, `result`, `reportedAt` | `{ restaurantId, intakeId }` unique |

`auditlogs.action` gains `BOX_WIFI_CHANGED` (entity `SETTINGS`, OWNER only to read).

P54's `EXCLUDED_COLLECTIONS` gains `replicationstate`; its change diary also
leaves out `changelog` and `changelogcounters`.

Rollback: set `DEPLOYMENT_ROLE=CLOUD` (the default). Nothing reads the new
collections then; they can stay.

# P63. Two-way sync

Spec 2026-10-21, `docs/prompts/P63-two-way-sync.md`. Additive: two new
collections, no field renamed or removed, no index changed.

| Collection | Model | Where | Fields | Indexes |
|---|---|---|---|---|
| `syncdocs` | SyncDoc | each side, LOCAL_ONLY | `_id` string `<coll>:<documentId as EJSON>`, `restaurantId`, `coll`, `documentId` (Mixed), `baseHash` (sha256 of the canonical EJSON of the agreed version, or `DELETED`), `baseDoc` (Mixed or null), `appliedHashes` (last 8 hashes written from the other side), `knownHashes` (last 16 versions this side held), `createdAt`, `updatedAt` | `{ restaurantId, coll }` |
| `syncconflicts` | SyncConflict | both, MIRROR | base schema, `coll`, `documentId` (Mixed), `kind` (EDITED_BOTH, SAME_SLOT, DELETED_HERE), `title`, `detail`, `fields` [string], `keptFrom` (BOX, CLOUD), `detectedOn` (BOX, CLOUD), `detectedAt`, `localDoc`, `incomingDoc`, `resultDoc` (Mixed), `seenAt`, `seenBy` | `{ restaurantId, seenAt, detectedAt: -1 }` |

`replicationstate` gains `_id` `peerpull:<rid>` (`pulledSeq`, `pulledAt`,
`lastError`, `lastErrorAt`) on the box and `peerseen:<rid>` (`seenPeerSeq`) on
the cloud.

`counters`: on the cloud while `TWO_WAY`, `scope` `W` for ORDER, KOT,
ONLINE_ORDER and RESERVATION (first value 900001), and `<fy>/W` or the prefix
scope plus `W` for BILL. `bills.invoiceSeries` takes `2026-27/W` or the prefix
plus `W` for website bills; `billSequence` is 900,000,000 plus the number.

Rollback: `SYNC_MODE=ONE_WAY` on both. Nothing reads `syncdocs` then; website
bills already made keep their W numbers, which stay valid in their series.
