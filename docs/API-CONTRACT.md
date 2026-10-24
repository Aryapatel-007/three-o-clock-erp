# API CONTRACT

Base URL: `/api/v1`

Every response uses the envelope defined in `docs/CONVENTIONS.md` section 3. Status codes and error codes come from the same place.

`restaurantId` and `branchId` are never sent by the client. The server reads them from the access token. If a client sends them, they are stripped silently.

Last updated: [DATE] by [NAME]

---

# M0 Foundation

Owner: Rishi.

Split into three build tasks:

M0-A, plumbing. Done.
M0-B, authentication and provisioning. This document, sections 1 and 2.
M0-C, user management. This document, section 3.

---

## Token model

Access token. Lifetime 15 minutes. Sent as `Authorization: Bearer <token>`.

Payload, locked by M0-A and not changeable without touching the tenant middleware:

```json
{
  "sub": "<userId>",
  "role": "OWNER",
  "restaurantId": "<restaurantId>",
  "branchId": "<branchId>",
  "iat": 0,
  "exp": 0
}
```

Refresh token. Lifetime 365 days (30 before 2026-10-14), renewed on every refresh, so a device in use stays signed in until Sign out. Opaque random string, 64 bytes, base64url. Not a JWT.

Only the SHA-256 hash of a refresh token is stored. The raw value is delivered once, as an `httpOnly` cookie, and is never returned in a response body, never readable by JavaScript, and never recoverable from the database. M0-D moved it from the body to a cookie; before that a single cross-site scripting hole handed over a 30-day credential.

The cookie, set on login and re-set on every refresh:

```
Set-Cookie: refreshToken=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth; Max-Age=2592000
```

`Path=/api/v1/auth` so the browser only sends it to the four auth endpoints that need it, never on a `/api/v1/menu` call. `Secure` is always set; `http://localhost` counts as a secure context, so this still works in local development.

Refresh tokens rotate. Every successful refresh issues a new one, revokes the old one, and overwrites the cookie.

**CSRF defence on refresh and logout.** `POST /auth/refresh` and `POST /auth/logout` read the credential from a cookie the browser attaches automatically, so they need protection a body-borne token did not. Two independent checks, and **both** are load-bearing:

1. `SameSite=Lax` keeps the cookie off a cross-site `POST` and off most cross-site sub-requests, but it still rides along on a top-level cross-site navigation.
2. Both endpoints require a custom request header, `X-Requested-With` (any value). A cross-site `<form>` submit or an `<img>` cannot set one; a cross-origin `fetch` that sets one triggers a CORS preflight, which this API's origin allowlist rejects.

A later cleanup must not remove one on the assumption the other covers it. It does not.

---

## 1. Authentication endpoints

### 1.1 Login

```
POST /api/v1/auth/login
```

No authentication. Strict rate limiter applies.

Request. Exactly one of `phone` or `email`, plus `password`:

```json
{
  "phone": "9876543210",
  "password": "correct horse battery"
}
```

```json
{
  "email": "owner@example.com",
  "password": "correct horse battery"
}
```

`email` is matched case-insensitively and is globally unique (DB-SCHEMA.md section 3), so it names exactly one account, the same as `phone`. Sending both, or neither, is `400 VALIDATION_FAILED`.

Response 200:

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOi...",
    "expiresInSeconds": 900,
    "user": {
      "id": "652f...",
      "name": "Rishi Patel",
      "phone": "9876543210",
      "email": null,
      "role": "OWNER",
      "restaurantId": "652a...",
      "branchId": "652b..."
    },
    "restaurant": {
      "id": "652a...",
      "name": "Shreeji Dining Hall"
    },
    "branch": {
      "id": "652b...",
      "name": "Main"
    }
  }
}
```

The refresh token is **not** in the body. It is set as the `refreshToken` cookie described under "Token model" above.

Failure 401, error code `INVALID_CREDENTIALS`:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Phone number or password is incorrect."
  }
}
```

This exact response is returned for all of these cases, with no difference in body, status, or response time:

The phone number, or the email, does not exist.
The password is wrong.
The user has `isActive: false`.
The user's restaurant has `isActive: false`.

Never tell the caller which one it was. A different message for a deactivated account confirms the account exists. The real reason is written to the server log.

Password comparison runs even when the identifier is not found, against a dummy hash, so that response timing does not reveal whether a phone number or an email is registered. The message stays "Phone number or password is incorrect." for both identifier types, on purpose.

### 1.2 Refresh

```
POST /api/v1/auth/refresh
```

No access token required. The credential is the `refreshToken` cookie, sent automatically by the browser. Strict rate limiter applies.

No request body. The `X-Requested-With` header is required (see "Token model", CSRF defence). A request without it is `403 FORBIDDEN`.

Response 200:

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOi...",
    "expiresInSeconds": 900
  }
}
```

The rotated refresh token is set as a fresh `refreshToken` cookie. It is not in the body.

Failure 401, code `INVALID_REFRESH_TOKEN`, for a missing, unknown, expired, or already revoked cookie. On any of these the cookie is also cleared, so the browser stops sending a dead credential.

**Reuse detection.** If a refresh token that has already been revoked is presented, that means either a stolen token or a replayed one. Revoke every refresh token belonging to that user immediately, log at warn level, and return 401. The user is forced to log in again everywhere. This is intended.

### 1.3 Logout

```
POST /api/v1/auth/logout
```

Access token required. Any role. The `X-Requested-With` header is required; a request without it is `403 FORBIDDEN`.

No request body. The session revoked is the one named by the `refreshToken` cookie.

Response 200:

```json
{ "success": true, "data": { "loggedOut": true } }
```

Revokes only that one session. Other devices stay logged in. The `refreshToken` cookie is cleared on this device.

Returns 200 even if the cookie is missing, or the token was already revoked or unknown. Logout must never fail in a way that leaves a user stuck on a POS screen.

### 1.4 Logout everywhere

```
POST /api/v1/auth/logout-all
```

Access token required. Any role.

No request body.

Response 200:

```json
{ "success": true, "data": { "sessionsRevoked": 3 } }
```

Revokes every refresh token for the calling user, and clears the `refreshToken` cookie on this device.

Does not require `X-Requested-With`: it is authenticated by the access token and cannot be driven by a cross-site request that lacks one.

### 1.5 Current user

```
GET /api/v1/auth/me
```

Access token required. Any role.

Response 200:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "652f...",
      "name": "Rishi Patel",
      "phone": "9876543210",
      "email": null,
      "role": "OWNER",
      "restaurantId": "652a...",
      "branchId": "652b...",
      "lastLoginAt": "2026-08-28T14:22:11.000Z"
    },
    "restaurant": {
      "id": "652a...",
      "name": "Shreeji Dining Hall",
      "gstin": "24AAACS1234A1Z5"
    },
    "branch": {
      "id": "652b...",
      "name": "Main"
    },
    "features": { "inventory": true, "attendance": true },
    "discounts": { "cashierMayApplyPlatformDiscounts": false }
  }
}
```

Reads live from the database, not from the token. A role changed five minutes ago must show here.

`user.stationId` (P05) is the station a `KITCHEN` user's screen opens on, or
`null`.

`features` (added by P02) is `settings.features`, returned to every role, because every screen needs to know what to hide and `GET /settings` is owner and manager only.

`discounts` (added by P08) is `settings.discounts`, for the same reason: the bill screen shows a cashier the discount panel only when `cashierMayApplyPlatformDiscounts` is true. The server still decides every discount.

### 1.6 Change own password

```
PATCH /api/v1/auth/password
```

Access token required. Any role.

Request:

```json
{
  "currentPassword": "old one",
  "newPassword": "new one"
}
```

Response 200:

```json
{ "success": true, "data": { "passwordChanged": true } }
```

Failure 401 `INVALID_CREDENTIALS` if `currentPassword` is wrong.
Failure 422 `BUSINESS_RULE_VIOLATED` if `newPassword` equals `currentPassword`.

On success, revoke every refresh token for this user and clear the `refreshToken` cookie on this device. The caller must log in again. A password change that leaves old sessions alive is not a password change.

### 1.7 Set a new password from the sign-in screen (P34)

```
POST /api/v1/auth/password-reset
```

Public: no token. Behind the login limiter (`authLimiter`), keyed on the address
and the submitted phone. For a person who cannot sign in, with an owner or
manager beside them to approve it.

Request, with exactly one of `phone` or `email`, as at login:

```json
{
  "phone": "9000003003",
  "newPassword": "a new one",
  "approval": { "approverPhone": "9000003002", "pin": "2468" }
}
```

`newPassword` follows the login rules: 8 to 128 characters, not trimmed.
`approval.pin` is 4 to 6 digits. Unknown fields are a 400.

Response 200:

```json
{ "success": true, "data": { "passwordSet": true } }
```

No token is issued. The screen signs in through `POST /auth/login` with the new
password.

The server:

1. Finds the person by phone or email across the platform, as login does. The
   one new `skipTenantGuard` use in `authService.js`.
2. Finds the approver by `approverPhone` **inside the person's restaurant only**:
   active, OWNER or MANAGER, not the integration user.
3. Refuses when the approver is the person, and when a MANAGER would approve an
   OWNER (`assertCanResetPassword`).
4. Checks the PIN with `verifyPin`: five wrong tries lock it until an owner sets
   it again on the Staff screen, as for every P28 approval.
5. Replaces the password with `setPassword`, which stamps `passwordChangedAt`,
   and revokes every refresh token of the person (`PASSWORD_CHANGED`).
6. Writes `USER_PASSWORD_RESET` with the approver as actor, `entityId` the
   person, and `details: { role, source: "SIGN_IN_SCREEN" }`.

Failure 401 `INVALID_CREDENTIALS`, one body for every reason: an unknown phone
or email, an inactive person, the integration user, an unknown or wrong
approver, a person approving themselves, a manager approving an owner, a wrong
PIN, a PIN not set, and a locked PIN:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "The password was not changed. Check both phone numbers and the PIN. Five wrong PINs lock it until the owner sets it again."
  }
}
```

Every path costs one bcrypt comparison, so the answer and its timing never say
which phone exists or who works where. Failure 400 `VALIDATION_FAILED` for a
bad shape. Failure 429 `RATE_LIMITED` from the login limiter.

Why the approver types a phone and does not pick a name, as P28 screens do: the
name list is read with a session, and on this screen there is none. A list here
would give every staff name to anyone who knows one phone number.

---

## 2. Restaurant and branch endpoints

### 2.1 Read own restaurant

```
GET /api/v1/restaurant
```

Access token required. Any role.

No ID in the URL. The restaurant is the one in the token. There is no endpoint that takes a restaurant ID, because there is no legitimate reason for a client to name a restaurant other than its own.

Response 200 returns the full restaurant document minus internal fields. It includes `settings.businessDayStartsAtMinutes` (added for M5, decision log D1).

### 2.2 Update own restaurant

```
PATCH /api/v1/restaurant
```

Access token required. Role: `OWNER` only.

Request, all fields optional, at least one required:

```json
{
  "name": "Shreeji Dining Hall",
  "legalName": "Shreeji Foods Private Limited",
  "gstin": "24AAACS1234A1Z5",
  "fssaiLicenseNumber": "12345678901234",
  "contactPhone": "9876543210",
  "contactEmail": "owner@example.com",
  "address": {
    "line1": "12 CG Road",
    "line2": "Navrangpura",
    "city": "Ahmedabad",
    "state": "Gujarat",
    "pincode": "380009"
  },
  "settings": {
    "businessDayStartsAtMinutes": 300
  }
}
```

Response 200 returns the updated restaurant.

`isActive` cannot be changed through this endpoint. Deactivating a restaurant is a platform operation, not a customer one.

`settings.businessDayStartsAtMinutes` is an integer from 0 to 1439, the minutes past midnight IST at which the business day rolls over. It was added for M5 (decision log D1). A value outside that range is 400 `VALIDATION_FAILED`.

### 2.3 List branches

```
GET /api/v1/branches
```

Access token required. Any role.

Response 200 returns an array. In version 1 it always contains exactly one branch.

There is no create, update, or delete branch endpoint in version 1. Branches are created by the provisioning script only. The field exists on every record so that multi-outlet works later without a migration, but the feature is not built.

---

## 3. User management endpoints (M0-C, not part of M0-B)

Written here so the contract is complete. Do not build these in M0-B.

### 3.1 Create staff user

```
POST /api/v1/users
```

Roles: `OWNER`, `MANAGER`.

A `MANAGER` cannot create an `OWNER`. Only an `OWNER` can create another `OWNER`.

Request:

```json
{
  "name": "Arya Shah",
  "phone": "9876543211",
  "email": "arya@example.com",
  "role": "CASHIER",
  "password": "initial password"
}
```

Response 201 returns the created user without `passwordHash`.

Failure 409 `DUPLICATE` if the phone number is already registered anywhere on the platform.

### 3.2 List staff

```
GET /api/v1/users?page=1&limit=50&role=CASHIER&isActive=true
```

Roles: `OWNER`, `MANAGER`.

Returns the paginated list envelope. Never includes `passwordHash`.

### 3.3 Read one staff user

```
GET /api/v1/users/:userId
```

Roles: `OWNER`, `MANAGER`.

404 `NOT_FOUND` if the user belongs to another restaurant. Never 403.

### 3.4 Update staff user

```
PATCH /api/v1/users/:userId
```

Roles: `OWNER`, `MANAGER`.

Updatable: `name`, `email`, `role`.

`phone` is not updatable, because it is the login identity and is globally unique. A phone change is a new user record plus a deactivation.

A `MANAGER` cannot set a role to `OWNER` and cannot edit an `OWNER`.

Nobody can change their own role, including an `OWNER`. This prevents the only owner from accidentally demoting themselves and locking everyone out.

### 3.5 Activate or deactivate staff user

```
PATCH /api/v1/users/:userId/status
```

Roles: `OWNER`, `MANAGER`.

Request:

```json
{ "isActive": false }
```

There is no delete endpoint for a user. Attendance history must survive staff turnover.

On deactivation, revoke every refresh token for that user immediately.

Failure 422 if this would deactivate the last active `OWNER` of the restaurant.

### 3.6 Reset a staff password

```
PATCH /api/v1/users/:userId/password
```

Roles: `OWNER`, `MANAGER`.

Request:

```json
{ "newPassword": "temporary one" }
```

The current password is not required. This is a manager resetting a password for someone who forgot it.

A `MANAGER` cannot reset an `OWNER` password.

Revokes every refresh token for the target user.

### 3.7 Set or reset a staff PIN

```
PATCH /api/v1/users/:userId/pin
```

Roles: `OWNER`, `MANAGER`. A `MANAGER` cannot set an `OWNER`'s PIN, the same rule as resetting a password.

Request:

```json
{ "pin": "4821" }
```

The PIN is a string of 4 to 6 digits. Response 200:

```json
{ "success": true, "data": { "pinSet": true } }
```

The PIN is never echoed back. Setting a PIN clears any lock on it and resets the failed-attempt count to zero.

This is the only endpoint that touches a PIN. There is no endpoint that returns one, or that says whether a user has one. A wrong PIN and a user with no PIN both fail verification identically.

**What the PIN is for.** M5's shared-tablet attendance clock, `POST /api/v1/attendance/station/clock`, verifies a PIN through `authService.verifyPin` and records a clock event. That verification issues **no token of any kind**, access or refresh — see DB-SCHEMA.md section 3 for why. Its failure codes are `INVALID_PIN` (401) and `PIN_LOCKED` (429), after five consecutive wrong attempts. They are listed here because M0-D owns the credential; M5 raises them.

---

## Permission summary for M0

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /auth/login | public | public | public | public | public | public |
| POST /auth/refresh | public | public | public | public | public | public |
| POST /auth/logout | yes | yes | yes | yes | yes | yes |
| POST /auth/logout-all | yes | yes | yes | yes | yes | yes |
| GET /auth/me | yes | yes | yes | yes | yes | yes |
| PATCH /auth/password | yes | yes | yes | yes | yes | yes |
| GET /restaurant | yes | yes | yes | yes | yes | yes |
| PATCH /restaurant | yes | no | no | no | no | no |
| GET /branches | yes | yes | yes | yes | yes | yes |
| POST /users | yes | yes* | no | no | no | no |
| GET /users | yes | yes | no | no | no | no |
| GET /users/:id | yes | yes | no | no | no | no |
| PATCH /users/:id | yes | yes* | no | no | no | no |
| PATCH /users/:id/status | yes | yes* | no | no | no | no |
| PATCH /users/:id/password | yes | yes* | no | no | no | no |
| PATCH /users/:id/pin | yes | yes* | no | no | no | no |

`yes*` means yes, except on a user whose role is `OWNER`, and except when setting a role to `OWNER`.

`POST /auth/refresh` and `POST /auth/logout` additionally require the `X-Requested-With` header, because both act on a credential the browser sends automatically. See "Token model".

---

# M1 Menu Management

Owner: Arya.

The single source of truth for what the restaurant sells and what it costs.

M2 copies item name, price and tax rate onto an order line at the moment the
line is created. M3 prints those copied values on the bill. M4 attaches a recipe
to a `menuItemId` plus an optional `variantId`. Nothing downstream reads a price
from here at bill time.

Two consequences run through every endpoint below:

Nothing is ever hard deleted. There is no `DELETE` verb in M1. `isActive: false`
is the delete, because a bill from M3 references an item by id forever.

Variant and add-on ids are permanent once issued. See section 4.8.

---

## 4. Category endpoints

### 4.1 Create category

```
POST /api/v1/categories
```

Roles: `OWNER`, `MANAGER`.

Request:

```json
{ "name": "Starters", "displayOrder": 10 }
```

`displayOrder` is optional and defaults to 0.

Response 201:

```json
{
  "success": true,
  "data": {
    "id": "652c...",
    "name": "Starters",
    "displayOrder": 10,
    "isActive": true,
    "restaurantId": "652a...",
    "branchId": "652b...",
    "createdAt": "2026-08-29T09:14:02.000Z",
    "updatedAt": "2026-08-29T09:14:02.000Z"
  }
}
```

Failure 409 `DUPLICATE_CATEGORY_NAME` if the name is already taken in this
branch, compared case-insensitively. "Starters" and "starters" are the same name.

### 4.2 List categories

```
GET /api/v1/categories?includeInactive=false
```

Roles: all six.

`includeInactive` defaults to false.

Response 200 returns an array sorted by `displayOrder` ascending, then `name`
ascending. Not paginated: a restaurant has tens of categories, not thousands.

### 4.3 Update category

```
PATCH /api/v1/categories/:categoryId
```

Roles: `OWNER`, `MANAGER`.

Request, both optional, at least one required:

```json
{ "name": "Veg Starters", "displayOrder": 20 }
```

Response 200 returns the updated category.

400 if the body is empty. 404 `NOT_FOUND` if it does not exist or belongs to
another restaurant. 409 `DUPLICATE_CATEGORY_NAME` on a name clash.

`isActive` cannot be changed here. It has its own endpoint.

`stationId` (P05): an active station of this restaurant, or `null` to route
the category to the default station. A station from another restaurant or an
inactive one is 422 `BUSINESS_RULE_VIOLATED`. See M18 Kitchen Stations.

### 4.4 Activate or deactivate category

```
PATCH /api/v1/categories/:categoryId/active
```

Roles: `OWNER`, `MANAGER`.

Request:

```json
{ "isActive": false }
```

Response 200 returns the updated category.

**This does not cascade.** Deactivating a category leaves the `isActive` of
every item inside it untouched. Those items disappear from `GET /menu` and from
the default `GET /menu-items` list because their category is off, not because
they were changed. Reactivating the category brings them back exactly as they
were. Nothing is written to the items and nothing is deleted.

---

## 5. Menu item endpoints

### 5.1 Create menu item

```
POST /api/v1/menu-items
```

Roles: `OWNER`, `MANAGER`.

Request:

```json
{
  "categoryId": "652c...",
  "name": "Paneer Tikka",
  "description": "Char-grilled cottage cheese",
  "priceInPaise": 24000,
  "taxRateBps": 500,
  "displayOrder": 10,
  "variants": [
    { "name": "Half", "priceInPaise": 14000 },
    { "name": "Full", "priceInPaise": 24000 }
  ],
  "addOns": [
    { "name": "Extra cheese", "priceInPaise": 4000 }
  ]
}
```

`description`, `displayOrder`, `variants` and `addOns` are optional.

A variant `priceInPaise` is the **absolute price of that variant**, not a delta
from the item's base price. "Half" at 14000 costs 140 rupees, full stop.

Response 201 returns the created item, with `variants` and `addOns` carrying
their newly assigned ids.

404 `NOT_FOUND` if `categoryId` does not exist in this restaurant and branch.
422 `BUSINESS_RULE_VIOLATED` if the category exists but is inactive.
409 `DUPLICATE_MENU_ITEM_NAME` on a name clash in this branch.

### 5.2 List menu items

```
GET /api/v1/menu-items?categoryId=&search=&availableOnly=false&includeInactive=false&page=1&limit=50
```

Roles: all six.

All query parameters optional. `availableOnly` and `includeInactive` default to
false. Paging is the standard envelope from CONVENTIONS section 3.

`search` matches the item name as a case-insensitive substring, capped at 60
characters. The value is escaped before it becomes a regular expression, so
`search=.*` matches items whose name literally contains ".*" and nothing else.

`includeInactive=false` also excludes items whose **category** is inactive, not
only items that are themselves inactive.

Response 200 returns the list envelope, sorted by `displayOrder` then `name`.

### 5.3 Read one menu item

```
GET /api/v1/menu-items/:menuItemId
```

Roles: all six.

Response 200 returns the item with its variants and add-ons.

404 `NOT_FOUND` if it does not exist or belongs to another restaurant. Never 403.

### 5.4 Update menu item

```
PATCH /api/v1/menu-items/:menuItemId
```

Roles: `OWNER`, `MANAGER`.

Request, all optional, at least one required: `categoryId`, `name`,
`description`, `priceInPaise`, `taxRateBps`, `displayOrder`, `variants`,
`addOns`.

`isActive` and `isAvailable` are refused here with 400. Each has its own
endpoint.

**Variant and add-on ids are permanent.** When `variants` or `addOns` is
supplied it replaces the whole array, but not by regenerating it:

An entry carrying an `id` that exists on this item updates that subdocument in
place and **keeps its `_id` unchanged**.

An entry carrying no `id` becomes a new subdocument with a new `_id`.

An entry carrying an `id` that is not on this item is 404 `VARIANT_NOT_FOUND`
for variants, `ADDON_NOT_FOUND` for add-ons. It is never silently created, and
nothing else in the request is applied.

An existing subdocument whose id is absent from the incoming array is removed
from the array.

This rule exists because M4 attaches recipes to a `variantId` and M2 stores a
`variantId` on an open order line. If a plain array replacement regenerated every
`_id` on every edit, a manager renaming "Half" to "Half Plate" would silently
detach the recipe from the variant, and the damage would not surface until M4.

Response 200 returns the updated item.

### 5.5 Toggle availability

```
PATCH /api/v1/menu-items/:menuItemId/availability
```

Roles: **all six**.

Request:

```json
{ "isAvailable": false, "variantId": null }
```

`variantId` null or absent sets the item's `isAvailable`. A supplied `variantId`
sets that variant's `isAvailable` and leaves the item alone, answering 404
`VARIANT_NOT_FOUND` if the variant is not on this item.

Any other field in the body is 400. `priceInPaise` sent here is rejected, not
ignored.

This is the one write in M1 open to a `CASHIER`, `WAITER`, `KITCHEN` or
`STOREKEEPER`, and it is deliberate. A kitchen that runs out of paneer at 8pm
cannot wait for the owner to unlock a phone. The endpoint changes one boolean
and cannot change a price, so the worst it can do is make a dish disappear from
the ordering screen.

### 5.6 Activate or deactivate menu item

```
PATCH /api/v1/menu-items/:menuItemId/active
```

Roles: `OWNER`, `MANAGER`.

Request:

```json
{ "isActive": false }
```

**This is the delete.** There is no `DELETE /menu-items/:id` and there will not
be one. A bill from M3 references the item by id forever, so the document has to
survive.

`isActive` is "on the menu at all". `isAvailable` from 5.5 is "in stock right
now". They are different questions and are answered by different endpoints with
different permissions.

---

## 6. The menu tree

### 6.1 Read the whole menu

```
GET /api/v1/menu?includeUnavailable=false
```

Roles: all six.

The read the POS ordering screen calls. One request, the whole sellable menu.

Response 200:

```json
{
  "success": true,
  "data": [
    {
      "id": "652c...",
      "name": "Starters",
      "displayOrder": 10,
      "items": [
        {
          "id": "652d...",
          "name": "Paneer Tikka",
          "description": "Char-grilled cottage cheese",
          "priceInPaise": 24000,
          "taxRateBps": 500,
          "displayOrder": 10,
          "isAvailable": true,
          "variants": [
            { "id": "652e...", "name": "Half", "priceInPaise": 14000, "isAvailable": true }
          ],
          "addOns": []
        }
      ]
    }
  ]
}
```

Active categories in `displayOrder` order, each with its active items nested in
`displayOrder` order.

`includeUnavailable` defaults to false, so by default an item with
`isAvailable: false` is not in the response at all. The ordering screen shows
only what can actually be sold.

**Inactive categories and inactive items never appear here under any query.**
`includeUnavailable` controls availability only. There is no query parameter
that reveals an inactive record on this endpoint.

Not paginated. A category with no visible items is still returned, with an empty
`items` array, so the screen keeps a stable set of tabs.

---

## Permission summary for M1

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /categories | yes | yes | no | no | no | no |
| GET /categories | yes | yes | yes | yes | yes | yes |
| PATCH /categories/:id | yes | yes | no | no | no | no |
| PATCH /categories/:id/active | yes | yes | no | no | no | no |
| POST /menu-items | yes | yes | no | no | no | no |
| GET /menu-items | yes | yes | yes | yes | yes | yes |
| GET /menu-items/:id | yes | yes | yes | yes | yes | yes |
| PATCH /menu-items/:id | yes | yes | no | no | no | no |
| PATCH /menu-items/:id/availability | yes | yes | yes | yes | yes | yes |
| PATCH /menu-items/:id/active | yes | yes | no | no | no | no |
| GET /menu | yes | yes | yes | yes | yes | yes |

Reads are open to all six roles because a waiter taking an order and a cook
reading a ticket both need to see the menu. Writes are `OWNER` and `MANAGER`,
with the single deliberate exception in 5.5.

---

## Error codes added by M1

| Code | Status | When |
|---|---|---|
| `DUPLICATE_CATEGORY_NAME` | 409 | A category with that name already exists in this branch |
| `DUPLICATE_MENU_ITEM_NAME` | 409 | A menu item with that name already exists in this branch |
| `VARIANT_NOT_FOUND` | 404 | A `variantId` that is not on this item |
| `ADDON_NOT_FOUND` | 404 | An add-on id that is not on this item |

Everything else reuses the existing codes. `BUSINESS_RULE_VIOLATED` for creating
an item under an inactive category, `NOT_FOUND` for a plain 404,
`VALIDATION_FAILED` for a 400.

---

## What M1 deliberately does not contain

Combos and meal bundles. Cut on purpose, not missing.

A shared or global add-on library. Add-ons are typed per item.

Item images and file upload.

Price history and scheduled price changes. Changing a price overwrites the old
one. The 7pm order keeps the 7pm price because M2 copies it, not because M1
remembers it.

Happy-hour or any time-based pricing.

---

# M5 Employee Attendance

Owner: Arya.

Staff clock in and out on a shared tablet. The system stores exact minutes
worked. A manager can correct an entry, and the correction is recorded with who,
when and why, never applied silently.

M5 hangs off M0 alone. It does not read the menu, an order or a bill, which is
why BUILD-PLAN section 5 allows it to be built in parallel with the M1 to M3
chain.

Four things run through every endpoint below.

Timestamps are the server's clock. A tablet with a wrong system time must not be
able to write a shift boundary. The only times a client supplies are on the two
manager endpoints that reconstruct a missed or mistaken entry.

The business day is not the calendar day. Every entry stores a `businessDate`
derived at clock-in from `restaurants.settings.businessDayStartsAtMinutes`
(default 300, meaning 05:00 IST). A shift from 18:00 to 01:30 belongs to the day
it started. See DB-SCHEMA.md section 7.

Nothing is hard deleted. A wrong entry is voided with a reason and a user. There
is no `DELETE` verb in M5.

Minutes, not hours. `workedMinutes` is a whole integer, recomputed from the
timestamps on every write, never sent by a client.

---

## 7. Clock endpoints

The self-service pair, plus the "what is my status" read. All three act on the
caller identified by the access token and are open to all six roles.

### 7.1 Clock in

```
POST /api/v1/attendance/clock-in
```

Roles: all six. Acts on the caller.

No request body.

Response 201:

```json
{
  "success": true,
  "data": {
    "id": "6530...",
    "userId": "652f...",
    "userName": "Arya Shah",
    "clockInAt": "2026-08-29T03:30:00.000Z",
    "clockOutAt": null,
    "workedMinutes": null,
    "businessDate": "2026-08-29",
    "clockInSource": "SELF",
    "clockOutSource": null,
    "isVoided": false,
    "corrections": [],
    "createdAt": "2026-08-29T03:30:00.000Z",
    "updatedAt": "2026-08-29T03:30:00.000Z"
  }
}
```

`userName` is a read-time convenience so the register and the clock screen do not
each fetch the user list. It is never stored on the entry.

Failure 409 `ALREADY_CLOCKED_IN` if the caller already has an open shift. The
partial unique index in DB-SCHEMA.md section 7 is the backstop; this is the
friendly error.

### 7.2 Clock out

```
POST /api/v1/attendance/clock-out
```

Roles: all six. Acts on the caller.

No request body.

Response 200 returns the now-closed entry, with `clockOutAt` set to the server's
clock, `clockOutSource: "SELF"`, and `workedMinutes` computed.

Failure 409 `NOT_CLOCKED_IN` if the caller has no open shift.

### 7.3 My attendance

```
GET /api/v1/attendance/me
```

Roles: all six. Reads the caller's own entries only. No parameters.

Response 200:

```json
{
  "success": true,
  "data": {
    "openShift": {
      "id": "6530...",
      "clockInAt": "2026-08-29T03:30:00.000Z",
      "openMinutes": 126,
      "businessDate": "2026-08-29"
    },
    "recent": [
      {
        "id": "652e...",
        "clockInAt": "2026-08-28T04:00:00.000Z",
        "clockOutAt": "2026-08-28T12:45:00.000Z",
        "workedMinutes": 525,
        "businessDate": "2026-08-28",
        "clockInSource": "STATION",
        "clockOutSource": "STATION"
      }
    ],
    "rangeMinutes": 2280,
    "rangeFrom": "2026-08-23",
    "rangeTo": "2026-08-29"
  }
}
```

`openShift` is `null` when the caller is clocked out. `recent` is the caller's
non-voided **closed** entries whose `businessDate` falls in the last seven days
including today, newest first; the open shift, if any, is in `openShift` and not
repeated here. `rangeMinutes` sums `workedMinutes` over those entries. Read
only: the only write paths are 7.1 and 7.2.

---

## 8. The station endpoint

```
POST /api/v1/attendance/station/clock
```

Roles: all six, for the tablet's own logged-in session. The clock event is
recorded against the **target** user named in the body, after their PIN is
verified within the caller's restaurant and branch.

This is the shared-tablet path. One tablet holds one ordinary session. A staff
member taps their tile and enters a PIN. The server verifies the PIN and records
the clock event. No access token, no refresh token, nothing that outlives the
request is returned to the person who typed the PIN. This endpoint is the only
thing a PIN can reach.

The strict login rate limiter does not apply here. The per-user PIN limiter
does, because forty staff share one tablet and one IP.

Request:

```json
{
  "userId": "652f...",
  "pin": "4821",
  "action": "clock"
}
```

`action` is `"clock"` (default) or `"undo"`.

`action: "clock"` toggles: if the target has no open shift it clocks them in, if
they have one it clocks them out. `clockInSource` / `clockOutSource` is
`"STATION"`.

Response 200:

```json
{
  "success": true,
  "data": {
    "event": "CLOCK_IN",
    "userName": "Arya Shah",
    "at": "2026-08-29T03:30:00.000Z",
    "entryId": "6530...",
    "openMinutes": 0,
    "undoUntil": "2026-08-29T03:30:05.000Z"
  }
}
```

`event` is `CLOCK_IN`, `CLOCK_OUT` or `UNDO`. On a `CLOCK_OUT`, `openMinutes` is
replaced by `workedMinutes`. `undoUntil` is the instant after which `action:
"undo"` is refused for this event; the window is about 5 seconds, a server
constant.

`action: "undo"` reverses the caller's own most recent station event on their
current entry, if `undoUntil` has not passed:

An undo of a `CLOCK_IN` voids the just-created entry with `voidReason:
"MIS_TAP"`. Nothing is hard deleted.

An undo of a `CLOCK_OUT` reopens the entry: `clockOutAt` back to `null`,
`workedMinutes` back to `null`, `clockOutSource` back to `null`, and one
`corrections[]` entry appended with `field: "clockOutAt"`, `newValue: null`,
`reason: "MIS_TAP"`, `correctedBy` the target user.

The undo is the single exception to "nobody corrects their own entry"
(section 9.4). It is safe because it is PIN-authenticated, expires in seconds,
and can only reverse the caller's own last station action. Past `undoUntil` the
fix is a manager correction.

Failures. The body and the response time are identical whether the cause is an
unknown user, a user with no PIN set, or a wrong PIN, so the response never
reveals which:

401 `INVALID_PIN` for a bad or missing PIN, or an unknown `userId`. The real
reason is written to the server log. A dummy bcrypt comparison runs on the
not-found path so timing does not leak.

429 `PIN_LOCKED` after 5 consecutive failures for that user. Cleared by an OWNER
or MANAGER reset (M0-D). Rate limiting is per target user, not only per IP.

409 `ALREADY_CLOCKED_IN` / `NOT_CLOCKED_IN` surface only on `action: "undo"`,
when the entry state no longer matches the event being undone because someone
else already corrected it. A plain `action: "clock"` toggles and cannot hit
these.

422 `ENTRY_VOIDED` on an undo whose entry has since been voided.

400 `VALIDATION_FAILED` if `pin` is not 4 to 6 digits.

This endpoint uses the per-user PIN credential from M0-D. `verifyPin` issues no
token of any kind (DB-SCHEMA.md section 3), so nothing that outlives the request
reaches the person who typed the PIN. The undo window is a server constant of
about 8 seconds; `undoUntil` in the response is the exact cutoff.

---

## 9. Attendance register and corrections

Manager reads and writes. `OWNER` and `MANAGER` only. Everything here is audited.

### 9.1 The register

```
GET /api/v1/attendance?from=2026-08-01&to=2026-08-29&openOnly=false&includeVoided=false&page=1&limit=50
```

Roles: `OWNER`, `MANAGER`.

`from` and `to` are `"YYYY-MM-DD"` business dates, inclusive, matched against
`businessDate`. Both optional; the default is today only. `openOnly=true` returns
every currently open shift and ignores the date range. `includeVoided` defaults
to false. Standard paging envelope from CONVENTIONS section 3, sorted by
`clockInAt` descending.

Each entry carries the fields from DB-SCHEMA.md section 7 plus three read-time
extras:

`userName` and `userRole`, so the screen does not join against the user list.

`openMinutes` on an open entry, so the screen can show "14h 20m open".

`requiresAttention`, `true` when the shift is still open and started more than 12
hours ago. The client sorts these to the top. The server never closes them
(decision log D5).

```json
{
  "success": true,
  "data": [
    {
      "id": "6530...",
      "userId": "652f...",
      "userName": "Arya Shah",
      "userRole": "CASHIER",
      "clockInAt": "2026-08-29T03:30:00.000Z",
      "clockOutAt": null,
      "workedMinutes": null,
      "openMinutes": 126,
      "businessDate": "2026-08-29",
      "clockInSource": "STATION",
      "clockOutSource": null,
      "requiresAttention": false,
      "isVoided": false,
      "corrections": [],
      "createdAt": "2026-08-29T03:30:00.000Z",
      "updatedAt": "2026-08-29T03:30:00.000Z"
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 12 }
}
```

### 9.2 One person's history

```
GET /api/v1/users/:userId/attendance?from=&to=&page=1&limit=50
```

Roles: `OWNER`, `MANAGER`.

Same shape as 9.1, filtered to one user. It is a path under `/users/:userId`,
matching `GET /users/:userId`, and **not** `GET /attendance?userId=`, because
CONVENTIONS section 3 keeps a person's identifier out of the query string: query
strings land in server logs, browser history and analytics, and BUILD-PLAN
section 7 keeps personal data out of all three. Keeping it a path segment also
matches the existing user endpoints. Do not "simplify" this into a query
parameter.

404 `NOT_FOUND` if the user belongs to another restaurant. Never 403.

### 9.3 Create a missed entry

```
POST /api/v1/attendance
```

Roles: `OWNER`, `MANAGER`.

For a shift that was never clocked because someone forgot. The times are supplied
by the manager here, the one place a client-supplied time is trusted.

Request:

```json
{
  "userId": "652f...",
  "clockInAt": "2026-08-29T03:30:00.000Z",
  "clockOutAt": "2026-08-29T11:30:00.000Z",
  "reason": "Forgot to clock in; confirmed with the shift lead"
}
```

`clockOutAt` is optional. Omit it to create an already-open shift, which a
manager fixing a forgotten clock-in mid-shift needs. `reason` is required.

The created entry has `clockInSource: "MANAGER"`, `clockOutSource: "MANAGER"`
when closed, `businessDate` derived from `clockInAt`, and one `corrections[]`
entry with `field: "CREATION"` carrying the reason.

Response 201 returns the entry.

Failure 404 `NOT_FOUND` if `userId` is in another restaurant.
Failure 422 `CLOCK_OUT_BEFORE_CLOCK_IN` if `clockOutAt` is at or before
`clockInAt`.
Failure 409 `ALREADY_CLOCKED_IN` if the entry is left open and the user already
has an open shift.
Failure 422 `SELF_CORRECTION_FORBIDDEN` if `userId` is the caller.

### 9.4 Correct an entry

```
PATCH /api/v1/attendance/:entryId
```

Roles: `OWNER`, `MANAGER`.

Request. `reason` required, at least one of `clockInAt` / `clockOutAt` required:

```json
{
  "clockOutAt": "2026-08-29T11:15:00.000Z",
  "reason": "Clock-out was 20 minutes late; corrected to the CCTV time"
}
```

Setting `clockOutAt` on an open entry is how a manager closes a forgotten
clock-out. Each changed field appends one `corrections[]` entry with its previous
and new value and the reason. `workedMinutes` is recomputed. `businessDate` is
**not** recomputed from a changed `clockInAt`; move an entry to another day by
voiding it and recreating it, so a day already reported on stays stable.

Response 200 returns the updated entry.

Failure 404 `NOT_FOUND` if the entry is in another restaurant.
Failure 422 `ENTRY_VOIDED` if the entry is voided.
Failure 422 `SELF_CORRECTION_FORBIDDEN` if the entry's `userId` is the caller,
including an OWNER (decision log D4).
Failure 422 `CLOCK_OUT_BEFORE_CLOCK_IN` if the result would have `clockOutAt` at
or before `clockInAt`.
Failure 400 `VALIDATION_FAILED` if `reason` is missing, empty or whitespace. It
is never defaulted to `""`.

A `MANAGER` may correct an `OWNER`'s attendance entry, unlike the M0-C user
endpoints where a manager cannot touch an owner. Attendance is operational data,
every change is on the audit trail, and a single-owner shop still needs its
owner's forgotten clock-out fixed by someone. Only the self-correction rule
applies here.

### 9.5 Void an entry

```
PATCH /api/v1/attendance/:entryId/void
```

Roles: `OWNER`, `MANAGER`.

Request:

```json
{ "reason": "Duplicate - clocked in on two tablets" }
```

Sets `isVoided`, `voidedAt`, `voidedBy`, `voidReason`. A voided entry is excluded
from the summary and from `GET /attendance/me`, and hidden from the register
unless `includeVoided=true`. It is never removed.

Response 200 returns the voided entry.

Failure 422 `ENTRY_VOIDED` if it is already voided.
Failure 422 `SELF_CORRECTION_FORBIDDEN` if the entry's `userId` is the caller.
Failure 404 `NOT_FOUND` if the entry is in another restaurant.

---

## 10. The hours-worked summary

```
GET /api/v1/attendance/summary?from=2026-08-01&to=2026-08-29
```

Roles: `OWNER`, `MANAGER`.

`from` and `to` are `"YYYY-MM-DD"` business dates, inclusive, both required.
Minutes worked per user across that range of business days.

Response 200:

```json
{
  "success": true,
  "data": {
    "from": "2026-08-01",
    "to": "2026-08-29",
    "rows": [
      {
        "userId": "652f...",
        "userName": "Arya Shah",
        "userRole": "CASHIER",
        "isActive": true,
        "totalMinutes": 9240,
        "entryCount": 22,
        "openEntryCount": 0
      }
    ]
  }
}
```

One row per user with at least one non-voided entry in the range, sorted by
`userName`. `totalMinutes` sums closed entries only. `openEntryCount` is how many
entries in the range are still open and therefore contribute nothing yet, so a
manager can see the total is provisional. Voided entries are in no count.

This is the endpoint M6 reads for its hours-worked report. It is M5, owned by M5,
and is not part of M6. When M6 is built it aggregates from here rather than
re-implementing the arithmetic. Not paginated: a restaurant has tens of staff.

---

## Permission summary for M5

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /attendance/clock-in | yes | yes | yes | yes | yes | yes |
| POST /attendance/clock-out | yes | yes | yes | yes | yes | yes |
| GET /attendance/me | yes | yes | yes | yes | yes | yes |
| POST /attendance/station/clock | yes | yes | yes | yes | yes | yes |
| GET /attendance | yes | yes | no | no | no | no |
| GET /users/:userId/attendance | yes | yes | no | no | no | no |
| POST /attendance | yes | yes | no | no | no | no |
| PATCH /attendance/:entryId | yes | yes | no | no | no | no |
| PATCH /attendance/:entryId/void | yes | yes | no | no | no | no |
| GET /attendance/summary | yes | yes | no | no | no | no |

The clock endpoints are open to all six roles because every staff member clocks
their own shift. `POST /attendance/station/clock` needs any valid session for the
tablet plus the target user's PIN; the PIN, not the role, is the control on whose
shift is written. The register, corrections and summary are `OWNER` and `MANAGER`
only. There is no `yes*` row: a manager may correct an owner's entry here
(section 9.4). The one rule that binds everyone, including an owner, is
`SELF_CORRECTION_FORBIDDEN`, which is a 422 business rule, not a permission.

---

## Error codes added by M5

| Code | Status | When |
|---|---|---|
| `ALREADY_CLOCKED_IN` | 409 | Clock-in while the caller, or the target, already has an open shift |
| `NOT_CLOCKED_IN` | 409 | Clock-out with no open shift |
| `CLOCK_OUT_BEFORE_CLOCK_IN` | 422 | A resulting `clockOutAt` at or before `clockInAt` |
| `ENTRY_VOIDED` | 422 | A correction to, or a void of, an already-voided entry |
| `SELF_CORRECTION_FORBIDDEN` | 422 | Correcting, voiding or manually creating your own entry |
| `INVALID_PIN` | 401 | Station clock: bad PIN, no PIN set, or unknown user. Identical body and timing for all three |
| `PIN_LOCKED` | 429 | Station clock: 5 consecutive PIN failures for that user. Needs a manager reset |

`INVALID_PIN` and `PIN_LOCKED` are shared with M0-D, which owns the PIN
credential itself. They are listed here because `POST /attendance/station/clock`
is the endpoint that raises them. `PIN_LOCKED` reuses status 429 rather than
adding 423 to CONVENTIONS section 3; M0-D confirms the choice when it wires the
lockout.

Everything else reuses existing codes: `NOT_FOUND` for a plain 404 (including an
entry or user in another restaurant), `VALIDATION_FAILED` for a 400 such as a
missing correction reason, `FORBIDDEN` for a wrong role, `UNAUTHENTICATED` for no
token.

---

## What M5 deliberately does not contain

No payroll, no pay rates, no money field of any kind. Attendance produces minutes
worked. BUILD-PLAN excludes payroll from version 1.

No scheduled shifts, rosters or "expected hours". This module records what
happened, not what was planned.

No break tracking. A break is a clock-out and a later clock-in in version 1.

No geofencing, selfie capture or device binding on a clock event. The PIN plus
the tablet's own session is the control that was chosen.

No overtime calculation or daily / weekly caps. Those are payroll rules and need
a CA, like the rest of payroll.

No i18n layer. The clock screen carries English-primary, Hindi-secondary label
pairs from one hardcoded file, and nothing else in the product is translated
(decision log D6). This is a screen decision, recorded here so the absence of a
translation system is not read as an omission.

---

## Open questions still unanswered

These belong to later modules but are recorded here so they are not forgotten.

Simultaneous table access by two waiters. Affects M2.

Recipe unit conversion. Affects M4.

Resolved since this list was written:

Business day start time - decided 2026-08-29 (decision log D1). It is
`restaurants.settings.businessDayStartsAtMinutes`, default 300 (05:00 IST),
configurable through `PATCH /api/v1/restaurant`. M3 and M6 consume it; M5 derives
and stores `businessDate` from it.

PIN-based quick login for shift staff - decided 2026-08-29 (decision log D2). It
returns as a per-user PIN credential, not a second user, exactly as this note
predicted. It never issues a session and reaches only
`POST /api/v1/attendance/station/clock`. Delivered by M0-D.

---

# M2 Order Taking and KOT

Owner: Rishi.

**On the section numbers.** These are 11 to 13 even though M2 was built before
M5, because this section was written *after* M5's. M2 shipped without an
API-CONTRACT section at all, which broke the precedent M1 and M5 both set, and
this is the backfill. It documents the endpoints exactly as they were built,
merged and tested; nothing here is a proposal.

An order is created against a table or as a takeaway, lines are added and
removed before it is fired, the kitchen sees a ticket, and the kitchen marks
items ready. M3 turns a finished order into a bill.

Five things run through every endpoint below.

**Every line is a snapshot.** When a line is added, the server looks up the menu
item and writes `itemName`, `unitPriceInPaise` and `taxRateBps` onto the
line itself. The client never sends a price. A body carrying one is a 400 naming
the field, not a silently stripped value.

**Every write carries a `version`.** The client sends the version it last read;
the server puts it in the update filter and increments it. A stale version is
`409 VERSION_CONFLICT` carrying the version the order actually has. This is the
two waiters problem from BUILD-PLAN section 8 and it is answered here, not in
the client.

**One open order per table**, enforced by a partial unique index, not by a
check in a controller. The `409 TABLE_OCCUPIED` carries the winning order's id
so the second waiter joins that order rather than hitting a dead end.

**Nothing is hard deleted.** There is no `DELETE` verb anywhere in M2. A line is
cancelled with a reason and keeps every snapshot value, because a cancelled line
is evidence.

**Totals are derived on read and stored nowhere.** Line totals, order subtotals,
table occupancy and KOT status are all computed from their parts, so they cannot
silently disagree with them.

---

## 11. Table endpoints

### 11.1 Create table

```
POST /api/v1/tables
```

Roles: `OWNER`, `MANAGER`.

Request. `section`, `seats` and `displayOrder` optional:

```json
{ "name": "T1", "section": "Garden", "seats": 4, "displayOrder": 10 }
```

Response 201 returns the created table.

409 `DUPLICATE` if the name is already taken in this restaurant, compared
case-insensitively.

### 11.2 List tables

```
GET /api/v1/tables?section=Garden&isOccupied=true&includeInactive=false
```

Roles: all six. All parameters optional.

Response 200 returns an array sorted by `displayOrder` then `name`. Not
paginated: a restaurant has tens of tables.

Each table carries an `isOccupied` boolean and, when occupied, the id and number
of the order sitting on it. **Occupancy is derived on read**, never stored: a
table is occupied when an order with status `OPEN` or `READY_TO_BILL` points at
it.

`includeInactive` exists for the same reason M1's does: without it a deactivated
table cannot be seen and so can never be switched back on.

**P19, M20: the occupancy block, extended.** Each table also carries `layout`
(see 11.5) and its `occupancy` block gains, additively:

| Field | Meaning |
|---|---|
| `isOccupied`, `orderId`, `orderNumber`, `openedAt`, `runningTotalInPaise` | As before |
| `state` | `FREE`; `OPEN`; `SERVED` when the order is `READY_TO_BILL`; `BILL_PRINTED` when the order has a live bill that is `UNPAID` |
| `guestCount` | From the order, or null |
| `isLong` | Open longer than `settings.floor.longOpenMinutes` |
| `captainName` | The current name of whoever opened the order, `orders.openedBy`, read once for the whole floor |
| `itemTotalInPaise` | The order's live line totals, from the values frozen on its lines, before GST. The same number as `runningTotalInPaise`. |
| `billId`, `billNumber`, `billTotalInPaise` | When `BILL_PRINTED`, that bill's id, number and bill total. Otherwise null. |

Free tables carry `state: "FREE"` and null in every other new field. The read
is a fixed number of queries for the whole floor, whatever the number of
tables: the tables, the occupying orders, their live unpaid bills, the names of
the people who opened them, and the settings.

### 11.5 Save a section's floor plan (P19)

```
PATCH /api/v1/tables/layout
```

Roles: `OWNER`, `MANAGER`.

```json
{ "section": "Cafe", "tables": [ { "tableId": "652f...", "x": 0, "y": 0, "w": 2, "h": 2, "shape": "SQUARE" }, { "tableId": "652g...", "layout": null } ] }
```

Each section is a grid of 24 columns by 16 rows. `x` 0 to 23, `y` 0 to 15, `w`
and `h` 1 to 4, `x + w` at most 24 and `y + h` at most 16. `shape` is `SQUARE`,
`ROUND` or `LONG`; a `LONG` table has `w` and `h` different. An entry with
`layout: null` takes that table off the plan. A table of the section not in the
request keeps its layout.

400 when a table is not this restaurant's, is not in the named section, or a
value is out of bounds. 422 `BUSINESS_RULE_VIOLATED` when two tables would
overlap, against each other or against a table of the section that keeps its
place, naming each overlapping pair. Every table is written inside one
transaction, so a refused save changes nothing. Response 200: the section's
tables as `GET /tables` returns them.

### 11.3 Update table

```
PATCH /api/v1/tables/:tableId
```

Roles: `OWNER`, `MANAGER`. Updatable: `name`, `section`, `seats`, `displayOrder`.

`isActive` is refused here with 400. It has its own endpoint.

The table setup screen edits name, section and seats together through this
endpoint (2 October 2026).

### 11.4 Activate or deactivate table

```
PATCH /api/v1/tables/:tableId/status
```

Roles: `OWNER`, `MANAGER`.

```json
{ "isActive": false }
```

**This is the delete.** 422 `BUSINESS_RULE_VIOLATED` if an order currently
occupies the table. Deactivating a table out from under a seated party is how a
bill goes missing.

### 11.6 Delete a table that was never used (added 2 October 2026)

```
DELETE /api/v1/tables/:tableId
```

Roles: `OWNER`, `MANAGER`. No body.

For a table added by mistake. Allowed only when no order, in any status, has
ever been on the table; the table document is then removed, with its place on
the floor plan. A table with any order history is refused with 422
`BUSINESS_RULE_VIOLATED`: "Table 5 has orders in its history, so it cannot be
deleted. Turn it off instead: it leaves the floor and every old bill keeps its
table." Old orders and bills point at a table by id, so a used table is only
ever switched off (11.4).

200 with `{ "id": "...", "deleted": true }`. 404 for another restaurant's table.

---

## 12. Order endpoints

### 12.1 Create order

```
POST /api/v1/orders
```

Roles: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`.

The body is a discriminated union on `orderType`, so the conditional fields are
enforced by the schema rather than by an if-statement in a controller. Each
branch refuses the other's fields outright: a `TAKEAWAY` carrying a `tableId` is
a validation error naming the field, not a silently ignored value that leaves
the caller believing they booked a table.

Dine-in:

```json
{ "orderType": "DINE_IN", "tableId": "652f...", "guestCount": 4, "lines": [] }
```

P19: when `settings.floor.requireGuestCount` is true, a `DINE_IN` order without
`guestCount` is 400 `VALIDATION_FAILED`, with `fields.guestCount` and the message
"How many guests? Enter the number before opening the table." Takeaway and
delivery orders never take one. No endpoint changes `guestCount` once the order
is open. P59 changes both: the rule moves to the first Send, and
`PATCH /orders/:orderId/customer` sets the count.

Takeaway:

```json
{
  "orderType": "TAKEAWAY",
  "customerName": "Rishi",
  "customerPhone": "9876543210",
  "lines": [{ "menuItemId": "652d...", "quantity": 2 }]
}
```

`lines` is optional at creation; an order may be opened empty and filled in.

Delivery (P06), for orders typed in from Zomato or Swiggy:

```json
{
  "orderType": "DELIVERY",
  "platform": { "code": "SWIGGY", "orderId": "249377796192385" },
  "customerName": "Rishi",
  "lines": [{ "menuItemId": "652d...", "quantity": 1 }]
}
```

The rules, the 409 for a platform order entered twice, and the 0% tax treatment
are in M17 Delivery and Platform Orders.

Response 201 returns the order with `orderNumber`, `version: 1`, and every line
priced by the server.

Every order line in every order response carries `categoryId` and
`categoryName` (P03), frozen from the menu item's category when the line was
added, alongside its other snapshot fields:

```json
{
  "id": "6531...",
  "menuItemId": "652d...",
  "itemName": "Paneer Tikka",
  "variantId": null,
  "variantName": null,
  "unitPriceInPaise": 24000,
  "taxRateBps": 500,
  "categoryId": "652c...",
  "categoryName": "Starters",
  "quantity": 2,
  "addOns": [],
  "status": "PENDING",
  "lineTotalInPaise": 48000
}
```

Neither is accepted from a client. Both are set by the server.

409 `TABLE_OCCUPIED` if an order is already open on that table. The error
carries `existingOrderId` at the top level of `error`, beside `code` and
`message`, so the client can open that order instead:

```json
{
  "success": false,
  "error": {
    "code": "TABLE_OCCUPIED",
    "message": "An order is already open on this table.",
    "existingOrderId": "6530..."
  }
}
```

404 `NOT_FOUND` if the table is in another restaurant.
422 `BUSINESS_RULE_VIOLATED` if the table is inactive, or a menu item is
inactive or unavailable.

### 12.2 List orders

```
GET /api/v1/orders?status=OPEN&orderType=DINE_IN&tableId=&page=1&limit=50
```

Roles: all six. Standard paging envelope, sorted by `createdAt` descending.

### 12.3 Read one order

```
GET /api/v1/orders/:orderId
```

Roles: all six. Returns the order with its lines and its current `version`.

**Read this before every write.** The `version` in the response is what the next
write must send back.

404 `NOT_FOUND` if it belongs to another restaurant. Never 403.

### 12.4 Add lines

```
POST /api/v1/orders/:orderId/lines
```

Roles: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`.

```json
{
  "version": 3,
  "lines": [
    { "menuItemId": "652d...", "variantId": "652e...", "quantity": 2,
      "addOnIds": ["652g..."], "notes": "No onion" }
  ]
}
```

A line is described by ids and a quantity and nothing else. The object is
`.strict()`, and that is a security control rather than a tidiness preference:
a body carrying `unitPriceInPaise` or `taxRateBps` is either a bug or
someone pricing their own dinner, and it fails loudly with a 400 naming the
field.

This is the partial order problem from BUILD-PLAN section 8: a table orders
starters, then mains twenty minutes later, on the same order. Lines may be added
to an `OPEN` order at any time, including after an earlier KOT has been fired.

422 `BUSINESS_RULE_VIOLATED` if the order is not `OPEN`, or `READY_TO_BILL`
with no live bill (P26).

P26: a served table orders more. Adding lines to a `READY_TO_BILL` order with no
live bill moves it back to `OPEN` and clears `readyToBillAt`, in the same write.
The new lines go to the kitchen as usual, and when the last is served the order
is `READY_TO_BILL` again (12.7). An order with a live bill takes new lines only
after `POST /bills/:billId/reopen` (M3 section 16.7).

P29: an order whose live bill can be revised (M3 section 16.8) takes new lines
directly. The order goes back to `OPEN`, keeps its `billId`, and the bill is
revised in the same transaction (16.8.2). An order with a live bill that cannot
be revised is still 422, and `reopen` is the way.

422 `BUSINESS_RULE_VIOLATED` (P04) if the chosen variant is marked unavailable,
with the message `The {variant name} size of "{item name}" is out of stock right
now.`, or if a chosen add-on is, with `"{add-on name}" is out of stock right
now.` The same checks apply to lines sent with 12.1. `GET /menu` already returns
`isAvailable` on every variant and add-on, so the ordering screen greys them out.

### 12.5 Edit a line

```
PATCH /api/v1/orders/:orderId/lines/:lineId
```

Roles: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`.

```json
{ "version": 4, "quantity": 3, "notes": "Extra spicy" }
```

**Only `quantity` and `notes`.** Changing what was ordered is a cancel plus a
new line, not an edit, because the snapshot on a line has to stay the thing that
was actually ordered.

422 `BUSINESS_RULE_VIOLATED` if the line has already been fired. P42: a `FIRED`
line takes `notes` alone (its quantity changes through 12.6a), and its kitchen
ticket line takes the same note with `changedAt` set; a `READY` or `SERVED` line
is still refused.

P29: 422 `BUSINESS_RULE_VIOLATED` also when the order has a live bill, "This
table has a bill. Change the items from the bill." The same rule applies to
12.6. A line on a billed order is removed through M3 section 16.8.1, or 16.4.

### 12.6 Cancel a line

P29: with `settings.kitchen.readyMeansServed` on, a line may also be cancelled
on an order that is `READY_TO_BILL` and has no bill yet, because the kitchen's
ready makes the order wait for the cashier while the guest can still send a
made dish back. When that leaves no live line, the order is `OPEN` again, with
`readyToBillAt` null. With the setting off, a `READY_TO_BILL` order is refused
exactly as before.

```
POST /api/v1/orders/:orderId/lines/:lineId/cancel
```

Roles: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`.

```json
{ "version": 5, "reasonCode": "WRONG_ITEM", "note": "Captain tapped the wrong pizza", "wasPrepared": false }
```

**Cancel and void reasons (P04).** Reasons are fixed codes from
`server/config/cancelReasons.js`, mirrored on the client in
`client/src/features/orders/cancelReasons.js`. They are constants, not settings:
reports group by code, so a restaurant renaming codes would split its own
history. A new reason is an append, never a rename.

| `LINE_CANCEL_REASONS` code | Label |
|---|---|
| `MODIFICATION` | Guest changed the order |
| `WRONG_ITEM` | Wrong item entered |
| `DUPLICATE` | Entered twice |
| `OUT_OF_STOCK` | Kitchen ran out |
| `TOO_SLOW` | Took too long |
| `QUALITY` | Quality complaint |
| `GUEST_LEFT` | Guest left |
| `OTHER` | Other |

| `ORDER_CANCEL_REASONS` code | Label |
|---|---|
| `GUEST_LEFT` | Guest left |
| `WRONG_TABLE` | Opened on the wrong table |
| `DUPLICATE` | Opened twice |
| `OTHER` | Other |

| Field | Rule |
|---|---|
| `reasonCode` | Required. One of the codes in the matching list. Anything else is 400 `VALIDATION_FAILED`, and the field message lists the allowed codes. |
| `note` | Optional, trimmed, at most 200 characters. Required and non-empty when `reasonCode` is `OTHER`. |

The old `reason` field is no longer accepted; the strict schema refuses it with
a 400. The code is stored in `cancelReasonCode` and the note in the existing
`cancelReason` field, which may be null. Every response returns both.

A line cancelled with `wasPrepared: true` writes one `auditlogs` line,
`LINE_CANCELLED_AFTER_PREP`, inside the same transaction as the cancel:
`entityType: ORDER`, `entityId` the order, `entityLabel` "Order {orderNumber}",
`reason` the label followed by ": " and the note when there is one,
`amountInPaise` the line total, and `details: { lineId, itemName, variantName,
quantity, reasonCode, tableName }`. A line cancelled before preparation writes
nothing: that is normal operation.

`wasPrepared` is **the cancelled-item answer** from
BUILD-PLAN section 8, and its handling is deliberately asymmetric:

Sending it for a line that never reached the kitchen is `400`. The question does
not arise, and recording an answer would give M4 something meaningless to read.

Omitting it for a line the kitchen has (`FIRED`, `READY` or `SERVED`) is `422`.
The request is well formed and breaks a business rule. The rule depends on the
line's stored status, so it cannot be a schema refinement.

M2 records the answer and does nothing else with it. M4 reads it to decide
whether the ingredients are gone.

Cancelling a fired line also cancels its matching KOT line, so the kitchen stops
cooking a dish the floor already voided.

P26: when cancelling a line leaves every other live line `SERVED`, the order
moves to `READY_TO_BILL` in the same write, exactly as serving the last line
does. Before P26 a served table whose one unsent dish was cancelled stayed
`OPEN` and could not be billed.

### 12.7 Mark a line served

```
PATCH /api/v1/orders/:orderId/lines/:lineId/served
```

Roles: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`.

```json
{ "version": 6 }
```

When the last non-cancelled line reaches `SERVED`, the order moves to
`READY_TO_BILL` on its own and `readyToBillAt` is stamped. **The table stays
occupied**, because the customers are still sitting there until a bill exists.

P29 Part C: with `settings.kitchen.readyMeansServed` on (M7, default true) the
kitchen's ready already serves the line (13.3), and the floor has no served
step. This endpoint stays, for the setting's off state and for a line left
`READY` from before the setting: with the setting on, a `READY` line is served
as before, and a line already `SERVED` answers 200 with the order unchanged, so
a screen written before P29 is never stuck on an error. With the setting off,
behaviour is exactly as before P29.

The move to `READY_TO_BILL` is worked out by one shared function in
`orderService.js`, `readyToBillChange(lines, at)`, used here, by the kitchen's
ready (13.3), by a line cancel, and by the kitchen undo (13.5).

### 12.8 Fire the order

```
POST /api/v1/orders/:orderId/fire
```

Roles: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`.

```json
{ "version": 7 }
```

Sends every `PENDING` line to the kitchen. Creates one `kots` document holding
exactly those lines and sets each line to `FIRED` with its `kotId` and
`firedAt`.

Response 200 is **both** records, because the caller needs the new ticket and
the moved-on order together:

```json
{ "success": true, "data": { "kot": { }, "order": { } } }
```

This is the one M2 endpoint whose `data` is not a single record. A client
reading `data.id` here gets `undefined`; read `data.order.id`.

From P05, one fire makes one KOT per station (see M18 Kitchen Stations). The
response then also carries `kots`, every ticket created, in station order;
`kot` stays the first of them, so a client written before P05 keeps working.

Firing twice is not an error: the second call fires whatever is `PENDING` now,
which is how a table that ordered mains later gets a second ticket. If nothing
is pending it is `422 BUSINESS_RULE_VIOLATED`.

**This is the moment M4 deducts stock**, because it is the moment the
ingredients physically leave the shelf.

### 12.9 Move an order to another table

```
PATCH /api/v1/orders/:orderId/table
```

Roles: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`.

```json
{ "version": 8, "tableId": "652h..." }
```

409 `TABLE_OCCUPIED` if the destination already has an order.

### 12.10 Cancel the whole order

```
POST /api/v1/orders/:orderId/cancel
```

Roles: **`OWNER` and `MANAGER` only.**

```json
{ "version": 9, "reasonCode": "GUEST_LEFT", "note": null, "wasPrepared": true }
```

`reasonCode` comes from `ORDER_CANCEL_REASONS` and `note` follows the same rule
as 12.6 (P04). The old `reason` field is refused.

Sets `isCancelled`, `cancelledAt`, `cancelledBy`, `cancelReasonCode`,
`cancelReason` (the note), moves the order to `CANCELLED`, cancels every open
line with the same code and note, and frees the table.

Every whole-order cancel writes one `auditlogs` line, `ORDER_CANCELLED`, inside
the same transaction: `entityType: ORDER`, `entityLabel` "Order {orderNumber}",
`reason` the label plus the note, `amountInPaise` the sum of the line totals of
every line not already cancelled, and `details: { orderNumber, tableName,
lineCount, reasonCode, wasPrepared }`.

P29: an order with a live bill that nothing has been paid on and that is not On
Hold is cancelled with its bill: the bill is voided in the same transaction,
`voidReasonCode: ITEMS_CHANGED` and the note "Order cancelled", through the same
code as 14.6, with the same `approvedBy`. A live bill with money on it, or On
Hold, is 422 `BUSINESS_RULE_VIOLATED`, "This bill has money on it. Void the bill
first." Before P29 the order was cancelled and its bill left live and unpaid,
which blocked Day Close.

**The narrower permission here is deliberate and is not an inconsistency to tidy
up.** Cancelling one line is open to all four floor roles; cancelling a whole
order is not. A whole-order cancel is how a table disappears, and a table
disappearing is how cash walks out of a restaurant. It is the exact gap owners
lose money to today. Do not widen it to match 12.6.

---

## 13. Kitchen ticket endpoints

There is no `POST /kots`. A ticket is created by firing an order and never
directly, because a ticket with no order behind it is food cooked for nobody.

### 13.1 List tickets

```
GET /api/v1/kots?status=PENDING&page=1&limit=50
```

Roles: all six. Sorted oldest first: the kitchen works the queue in order.

A ticket's status is **derived from its lines**, not stored, so the `status`
filter is applied after the rollup is computed rather than in the database
query. This is noted in the known problems table.

`stationId` (P05), optional: a station id returns only that station's tickets;
the word `none` returns only tickets with no station.

`sort` (P41), optional: `recent` sorts by when the ticket last changed
(`updatedAt`), newest first, instead of oldest first. With `status=COMPLETED`
it is the kitchen's Recall list.

### 13.2 Read one ticket

```
GET /api/v1/kots/:kotId
```

Roles: all six.

### 13.3 Mark one ticket line ready

```
PATCH /api/v1/kots/:kotId/lines/:lineId/ready
```

Roles: all six. No request body.

Sets the KOT line to `READY` with `readyAt`, and the matching order line to
`READY`.

### 13.4 Mark a whole ticket ready

```
PATCH /api/v1/kots/:kotId/ready
```

Roles: all six. No request body. Marks every `PENDING` line on the ticket ready.

**Both ready endpoints are open to all six roles, including `STOREKEEPER`, and
that is on purpose.** Whoever is standing at the pass marks the food ready.
Asking someone their job title while a dish goes cold helps nobody, and the
worst this endpoint can do is say a dish is ready when it is not, which the
person carrying the plate discovers immediately.

The KOT endpoints take no `version`. A ticket is not edited by two people racing
to change the same value; marking an already-ready line ready again is a no-op,
not a conflict.

**P29 Part C, ready means served.** With `settings.kitchen.readyMeansServed` on
(M7, default true), 13.3 and 13.4 set the KOT line to `READY` as before, and the
matching order line, when it is `FIRED`, straight to `SERVED`, with `readyAt`
and `servedAt` the same moment. When every live line of the order is then
served, the order moves to `READY_TO_BILL` with `readyToBillAt`, through the
same `readyToBillChange` as 12.7, in the same transaction. With the setting off,
the order line becomes `READY` exactly as before. A platform order is told its
food is ready (M21 section 7) when every live line is `READY` or `SERVED`, as
before; from P29 that call waits 60 seconds (13.5).

### 13.5 Undo ready (P29 Part E)

```
POST /api/v1/kots/:kotId/lines/:lineId/undo-ready
POST /api/v1/kots/:kotId/undo-ready
```

Roles: all six, the same as marking ready. No body.

The first undoes one line; the second every `READY` line on the ticket.
Allowed only while the order has **no live bill**: otherwise 422
`ORDER_ALREADY_BILLED`, "This table has been billed. Ask the cashier to change the
bill." A line that is not `READY` is 422 "That one is not marked ready."

In one transaction:

1. The KOT line goes from `READY` back to `PENDING`, and `readyAt` is cleared.
2. The matching order line, when it is `READY` or `SERVED`, goes back to
   `FIRED`, clearing `readyAt` and `servedAt`.
3. If the order was `READY_TO_BILL`, it goes back to `OPEN`, clearing
   `readyToBillAt`.
4. `KITCHEN_READY_UNDONE` is written, entity `ORDER`, `entityLabel` "Order
   {orderNumber}", `reason` the item names, `details: { kotId, kotNumber,
   lineIds, itemNames, tableName }`. A MANAGER may read it.

**Platform orders.** The "food is ready" call (M21 section 7) is queued with
`runAfter` 60 seconds ahead and its `dedupeKey` per platform order, as before.
An undo cancels that job while it is still `QUEUED`: the job's status becomes
`CANCELLED` and its `dedupeKey` is released (suffixed `:cancelled:{jobId}`), so
the next ready queues a fresh call. When the job has already run, the undo
still works here and the response says so.

Response 200: the ticket, as 13.2, with `platformAlreadyTold` (boolean) beside
it.

**A ticket carries no money.** No price, no tax rate, no total. A ticket that
carries prices is a ticket that can disagree with the bill.

---

## Permission summary for M2

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /tables | yes | yes | no | no | no | no |
| GET /tables | yes | yes | yes | yes | yes | yes |
| PATCH /tables/:id | yes | yes | no | no | no | no |
| PATCH /tables/:id/status | yes | yes | no | no | no | no |
| POST /orders | yes | yes | yes | yes | no | no |
| GET /orders | yes | yes | yes | yes | yes | yes |
| GET /orders/:id | yes | yes | yes | yes | yes | yes |
| POST /orders/:id/lines | yes | yes | yes | yes | no | no |
| PATCH /orders/:id/lines/:lineId | yes | yes | yes | yes | no | no |
| POST /orders/:id/lines/:lineId/cancel | yes | yes | yes | yes | no | no |
| PATCH /orders/:id/lines/:lineId/served | yes | yes | yes | yes | no | no |
| POST /orders/:id/fire | yes | yes | yes | yes | no | no |
| PATCH /orders/:id/table | yes | yes | yes | yes | no | no |
| POST /orders/:id/cancel | yes | yes | **no** | **no** | no | no |
| GET /kots | yes | yes | yes | yes | yes | yes |
| GET /kots/:id | yes | yes | yes | yes | yes | yes |
| PATCH /kots/:id/lines/:lineId/ready | yes | yes | yes | yes | yes | yes |
| PATCH /kots/:id/ready | yes | yes | yes | yes | yes | yes |

Reads are open to all six. Order taking is the four floor roles; the kitchen and
the storekeeper are kept out of writing orders. Marking food ready is open to
all six. The one asymmetry in the table is whole-order cancel, explained in
12.10.

---

## Error codes added by M2

| Code | Status | When |
|---|---|---|
| `TABLE_OCCUPIED` | 409 | An order is already open on this table. Carries `existingOrderId`. |
| `VERSION_CONFLICT` | 409 | The order changed between the client reading it and writing to it. Carries `currentVersion`. |

Both carry an extra field at the top level of `error`, beside `code` and
`message`, because the client acts on the value rather than displaying it.
`AppError` gained a `details` option for exactly these two, and the error
handler merges it into the envelope. It is not a second `fields`, which is a
per-field message map for validation errors, and nothing internal ever goes in
it: whatever it holds is sent to the browser.

Everything else reuses existing codes. `BUSINESS_RULE_VIOLATED` for firing an
order with nothing pending or opening one on an inactive table, `NOT_FOUND` for
a plain 404 including a record in another restaurant, `VALIDATION_FAILED` for a
400 such as sending a price on a line.

---

## What M2 deliberately does not contain

No split bills, item transfers between tables, or merging two tables onto one
bill. One order, one table, and M3 bills one order.

No floor plan or table coordinates. A table is a name, a section and a seat
count.

No course timings or "hold the mains" scheduling.

No realtime push. The kitchen display polls every ten seconds. At one
restaurant's scale that is enough, and a dropped websocket that silently stops
delivering tickets is a far worse failure than a ten second delay, because
nobody notices it.

No printed-ticket record. Firing produces a `kots` document; whether paper came
out of a printer is not tracked.

---

# M3 Billing with GST

Owner: Rishi.

**Menu prices are tax-exclusive.** `priceInPaise` is the price before tax and
GST is added on top (decision D1). This is the one assumption in this module a
chartered accountant must confirm on a real printed bill before a pilot.

A finished order becomes a bill. The bill carries GST split per rate slab, an
optional discount, the payment method used, and a printed number that is
sequential and never reused.

Five things run through every endpoint below.

**A bill copies from the order line, never from the menu.** `itemName`,
`unitPriceInPaise` and `taxRateBps` come off `orders.lines[]`, which copied them
from `menuitems` when the line was added. Nothing here reads `menuitems`. The
7pm order bills at the 7pm price.

**A bill is frozen once created.** Its lines are a snapshot and there is no
endpoint that edits them. A wrong bill is voided and re-issued.

**Nothing is hard deleted, and a number is never reused.** Voiding sets
`isVoided` with a reason and an actor. The number stays spent.

**Voided bills are excluded from every total.** The list endpoint's running
total, the day's summary, and every M6 read. BUILD-PLAN section 8 calls this the
soft delete leak and it is the easiest way to ship a wrong sales figure.

**Every money-or-trust event is audited.** Applying a discount and voiding a
bill each write an `auditlogs` row with who, when, why and how much.

---

## 14. Bill endpoints

### 14.1 Create a bill

```
POST /api/v1/bills
```

Roles: `OWNER`, `MANAGER`, `CASHIER`.

```json
{ "orderId": "652f...", "version": 9 }
```

`version` is the order's optimistic-concurrency version, sent for the same
reason every M2 write sends it: a waiter adding a line while the cashier is
billing must not be silently overwritten.

Creates the bill from the order's **non-cancelled** lines, computes the tax
breakdown, reserves the bill number inside the same transaction, and sets
`orders.billId`. The order stays `READY_TO_BILL` and **the table stays
occupied**: the customers are still sitting there until they have paid.

Response 201 returns the bill, `status: "UNPAID"`.

From P06 every bill also carries `platform` and `taxTreatment`, copied from
the order. See M17 Delivery and Platform Orders.

From P03 every bill also carries, frozen at creation, `captainId` and
`captainName` (who opened the order), `guestCount` and `orderOpenedAt`, and
every bill line carries `categoryId`, `categoryName`, `discountShareInPaise`,
`taxableInPaise` and `taxInPaise`:

```json
{
  "billNumber": "CFA/C/22443",
  "captainId": "652f...",
  "captainName": "Budha Singh",
  "guestCount": 3,
  "orderOpenedAt": "2026-09-26T07:31:00.000Z",
  "lines": [
    {
      "itemName": "Indian Platters",
      "quantity": 1,
      "unitPriceInPaise": 45000,
      "taxRateBps": 500,
      "lineTotalInPaise": 45000,
      "categoryId": "652c...",
      "categoryName": "Platters",
      "discountShareInPaise": 2268,
      "taxableInPaise": 42732,
      "taxInPaise": 2137
    }
  ]
}
```

The line shares add up exactly to the bill's discount and to each tax slab's
net sales and GST. The rule is in DB-SCHEMA.md section 12. None of these fields
is accepted from a client; the strict request schemas refuse them.

422 `BUSINESS_RULE_VIOLATED` if the order is not `READY_TO_BILL`, or has no
live lines. A zero-line bill is not a bill.
409 `DUPLICATE` if a live bill already exists for that order; the existing
bill's id travels with it as `existingBillId`, the same shape M2's
`TABLE_OCCUPIED` uses, so the client opens that bill instead of making a second.
409 `VERSION_CONFLICT` on a stale order version.
404 `NOT_FOUND` if the order is in another restaurant.
503 `TRANSACTION_REQUIRED` if the connection cannot start a transaction. Bill
creation is the one write in this project that refuses to degrade, because a
gap-free sequence has no degraded mode; see DB-SCHEMA.md section 12.

**The bill number format depends on `settings.invoice` (P02).** In
`FINANCIAL_YEAR` mode it is `"2026-27/000148"`, exactly as before. In `PREFIX`
mode it is the prefix followed by an unpadded running number, `"CFA/C/22442"`,
and the series never resets. `billSequence` is the running number in both
modes, and `financialYear` is always the financial year the bill falls in.

Every bill created from P02 onwards carries `invoiceSeries`: the financial year,
like `"2026-27"`, in `FINANCIAL_YEAR` mode, and the prefix, like `"CFA/C/"`, in
`PREFIX` mode. Bills created before P02 have `null`, which means the financial
year series.

From P57 the request may also carry a `discount` and `preview: true`; see "P57
The bill in one place".

### 14.2 Read one bill

```
GET /api/v1/bills/:billId
```

Roles: all six. A waiter needs to read the bill they are carrying to a table.

404 `NOT_FOUND` if it belongs to another restaurant. Never 403.

**`itemRows` (P35).** Every bill sent back as a whole document, by this read
and by every write that answers with the bill (create, discount, payment,
correction, void, print, remove-lines, apply advance and the rest), carries
`itemRows` beside `lines`. It is the bill's lines grouped for a person to read,
computed each time the bill is sent and **never stored**; `lines` is unchanged,
one bill line per order line, each still tracing to its order line and kitchen
ticket. Each bill in the list (14.3) carries it too, being the whole document;
the print queue, which sends only a few fields of each bill, carries none.

Two lines join one row only when all of these are the same: `menuItemId`,
`itemName`, `variantName` (two nulls are the same), `addOnNames` as a set (the
same names in any order), `unitPriceInPaise` and `taxRateBps`. So a price
changed between two rounds, a different size and different extras stay
separate rows.

```json
"itemRows": [
  { "itemName": "Roti", "variantName": null, "addOnNames": [], "quantity": 2, "unitPriceInPaise": 4000,
    "taxRateBps": 500, "lineTotalInPaise": 8000, "orderLineIds": ["6601…", "6602…"] }
]
```

`quantity` and `lineTotalInPaise` are the sums of the row's lines, added with
`sumPaise`; `addOnNames` is the first line's; `orderLineIds` are every line's
`orderLineId`, in bill order. Rows are in the order of each row's first line.
Built by `groupBillLines` in `server/utils/billLines.js`, the only place lines
are grouped; the client never groups them itself. A row's line totals add up
exactly to `subtotalInPaise`.

### 14.3 List bills

```
GET /api/v1/bills?from=2026-08-30&to=2026-08-30&status=UNPAID&includeVoided=false&page=1&limit=50
```

Roles: `OWNER`, `MANAGER`, `CASHIER`.

`from` and `to` are `"YYYY-MM-DD"` **business dates**, inclusive, matched
against `businessDate`. Both optional; the default is today's business day only,
which is what the cashier's screen wants.

Standard paging envelope, sorted by `billedAt` descending, plus a `meta.totals`
block for the running total the screen shows:

```json
{
  "success": true,
  "data": [ ],
  "meta": {
    "page": 1, "limit": 50, "total": 37,
    "totals": {
      "grandTotalInPaise": 4820000,
      "amountPaidInPaise": 4520000,
      "billCount": 37,
      "voidedCount": 2
    }
  }
}
```

`totals` covers the **whole matched range, not the current page**, and excludes
voided bills from every figure except `voidedCount`. A running total that only
adds up one page is a wrong number on a busy evening.

### 14.4 Apply a discount

```
POST /api/v1/bills/:billId/discount
```

Roles: **`OWNER`, `MANAGER` only.** A cashier cannot discount a bill. This is
the control an owner is buying.

```json
{ "kind": "PERCENT", "rateBps": 1000, "reason": "Regular customer" }
```

```json
{ "kind": "FLAT", "valueInPaise": 5000, "reason": "Service was slow" }
```

`reason` is required, trimmed, and never defaulted to `""`.

Replaces any existing discount rather than stacking, and **recomputes the whole
tax breakdown**, because a discount reduces taxable value and therefore reduces
tax. The apportionment across slabs is in DB-SCHEMA.md section 12.

Response 200 returns the recomputed bill. Writes one `auditlogs` row,
`DISCOUNT_APPLIED`, carrying the amount.

From P08 the request is `{ kind, valueInPaise | rateBps, reasonCode, note?,
fundedBy? }` with a fixed reason list, and a CASHIER may apply platform reasons
when a setting allows it. See M10 Payments, section 4.

Applying a discount also replaces every line's `discountShareInPaise`,
`taxableInPaise` and `taxInPaise` (P03), so the line shares always match the
recomputed bill.

422 `BUSINESS_RULE_VIOLATED` if the bill is `PAID`, if it is voided, or if the
discount is greater than the subtotal. 400 if `rateBps` is outside 1 to 10000 or
`valueInPaise` is not a positive integer.

There is no approval ceiling in version 1 — a manager may discount any amount
up to the subtotal. Every one is on the audit trail with a name against it,
which is the version 1 control. A ceiling with an owner approval step is a
deferred idea, not a missing feature.

### 14.5 Record a payment

```
POST /api/v1/bills/:billId/payments
```

Roles: `OWNER`, `MANAGER`, `CASHIER`.

```json
{ "method": "UPI", "amountInPaise": 48200, "reference": "42XXXX9911" }
```

From P08, `method` is a payment method code from `GET /payment-methods`, and
each payment freezes its method's name, kind, Tally code, commission and its own
business date. See M10 Payments, section 3. A bill charged to an On Hold account
takes no payment (M16).

Appends to `payments[]` and adds to `amountPaidInPaise`. When the paid amount
first reaches `grandTotalInPaise` the bill becomes `PAID`, `paidAt` is stamped,
the order moves to `BILLED`, and **the table frees**.

Response 200 returns the bill.

The array exists so a split payment works without a migration; the screen
defaults to one payment for the full amount. No gateway and no money movement:
we record which method was used (BUILD-PLAN section 4).

422 `BUSINESS_RULE_VIOLATED` if the bill is voided, already `PAID`, or the
payment would take the paid amount above the grand total. Overpayment is
refused rather than stored, because change given in cash is not a payment.

P43: for `method: "OTHER"`, `reference` is the mode of payment and is required,
422 `BUSINESS_RULE_VIOLATED` "Say how it was paid, for example Cheque." without
it.

### 14.6 Void a bill

```
POST /api/v1/bills/:billId/void
```

Roles: **`OWNER`, `MANAGER` only.**

```json
{ "reasonCode": "WRONG_TABLE", "note": null }
```

`reasonCode` is required, one of `BILL_VOID_REASONS` (P04):

| Code | Label |
|---|---|
| `WRONG_TABLE` | Billed to the wrong table |
| `ITEMS_CHANGED` | Items need changing |
| `DISCOUNT_CHANGED` | Discount needs changing |
| `DUPLICATE` | Billed twice |
| `GUEST_DISPUTE` | Guest disputed the bill |
| `OTHER` | Other |

`note` is optional, trimmed, at most 500 characters, and required for `OTHER`.
The old `reason` field is refused with a 400. The code is stored in
`voidReasonCode` and the note in `voidReason`.

Sets `isVoided`, `voidedAt`, `voidedBy`, `voidReasonCode`, `voidReason`. Returns the order to
`READY_TO_BILL`, clears `orders.billId`, and **re-occupies the table**, so the
order can be billed again correctly.

Voiding an `ON_ACCOUNT` bill is allowed and writes a `CHARGE_REVERSED` account
entry in the same transaction (M16). Voiding a bill of a closed business date
is refused with 409 `DAY_CLOSED` (M16).

**The bill number stays spent.** It is never reissued, not to the replacement
bill and not to anything else. A gap in what a customer holds is fine; a
duplicate number is not.

Response 200 returns the voided bill. Writes one `auditlogs` row, `BILL_VOIDED`,
carrying the grand total that was voided. Its `reason` is the label followed by
": " and the note when there is one, and its `details` carry `reasonCode` (P04).

422 `ENTRY_VOIDED` if it is already voided.
404 `NOT_FOUND` if it is in another restaurant.

**Voiding does not restock.** The food was made and eaten. See DB-SCHEMA.md
section 16.

### 14.7 The day's summary

```
GET /api/v1/bills/summary?from=2026-08-30&to=2026-08-30
```

Roles: `OWNER`, `MANAGER`.

Business dates, inclusive, both required. Sales, tax collected per slab,
discount given away, and a split by payment method, over that range.

```json
{
  "success": true,
  "data": {
    "from": "2026-08-30", "to": "2026-08-30",
    "billCount": 37,
    "grossInPaise": 4400000,
    "discountInPaise": 120000,
    "taxInPaise": 214000,
    "netInPaise": 4494000,
    "roundOffInPaise": -1400,
    "byTaxSlab": [
      { "taxRateBps": 500, "taxableInPaise": 3800000, "cgstInPaise": 95000, "sgstInPaise": 95000 }
    ],
    "byPaymentMethod": [
      { "method": "CASH", "amountInPaise": 1800000, "billCount": 15 },
      { "method": "UPI", "amountInPaise": 2694000, "billCount": 22 }
    ],
    "voidedCount": 2,
    "voidedInPaise": 340000
  }
}
```

Voided bills are in `voidedCount` and `voidedInPaise` and in **no** other
figure. This is the endpoint M6 reads for its sales report; M6 aggregates from
here rather than re-implementing the arithmetic, the same relationship M5's
`GET /attendance/summary` has with M6's hours report.

---

## 15. The receipt

```
GET /api/v1/bills/:billId/receipt?width=32
```

Roles: all six.

`width` is `32` (58mm paper) or `48` (80mm). Default 32. Any other value is 400.

Response 200:

```json
{
  "success": true,
  "data": { "width": 32, "text": "        SHREEJI DINING HALL\n..." }
}
```

**The layout is generated on the server and the client prints what it is
given.** It does no wrapping, no padding and no column arithmetic of its own.

This is not a preference. A thermal printer has a fixed character width, and
BUILD-PLAN section 8 names a long dish name wrapping and destroying the layout
as a thing that bites teams late. One server-side implementation can be snapshot
tested; a browser and a printer each doing their own layout will disagree, and
the disagreement only shows up on paper in a restaurant.

A name longer than the column allows is wrapped onto a continuation line
indented under itself, never truncated and never allowed to push the amount
column out of alignment. There is a snapshot test with a 60-character dish name.

The payload carries, in this order: restaurant name, `legalName`, GSTIN, FSSAI
number, address, bill number, business date, the timestamp in IST, each line
with quantity and amount, subtotal, discount with its reason, CGST and SGST per
rate slab, round-off, grand total, and the payment method.

Money is rendered by the server in rupees with two decimals. It is the one place
the server formats money for display, and it is here because the layout depends
on the exact character count.

---

## 16. P25: the full-page invoice, captains billing, printing at the counter, cancelling after billing

Specified in P25 Parts C, D and E. Everything below is additive: no existing
request or response changes shape.

### 16.1 The full-page tax invoice

```
GET /api/v1/bills/:billId/invoice
```

Roles: all six, the same as the receipt (section 15).

The bill as structured data, for an A4 or A5 page laid out on the client. The
receipt text and this data are built by **one** function in
`receiptService.js`, `buildInvoiceData({ restaurant, bill, settings })`:
`renderReceipt` lays that data out as fixed-width text, and this endpoint
returns it as it is. So every amount on the thermal receipt and on the full page
is the same number, read from the same object. A test compares them for every
golden day bill.

P35: the data carries `itemRows` beside `lines`, built from the same
`groupBillLines` as 14.2, and the receipt text, the thermal bill and the
full-page invoice all list `itemRows`, so the same dish ordered in two rounds
prints once. "Total Qty" is unchanged: the rows' quantities add up to the
lines'.

```json
{
  "success": true,
  "data": {
    "restaurant": {
      "name": "Z Chaat", "legalName": "…", "address": "…", "addressLines": ["…"], "phone": "7600858900",
      "gstin": "…", "fssaiNumber": "…", "headerAbove": null, "headerLines": ["Indian Street Food"]
    },
    "billId": "6600…", "billNumber": "ZC/1001", "isVoided": false,
    "isDuplicate": false, "printCount": 0,
    "issuedAt": "2026-10-09T14:05:00.000Z", "issuedAtIst": "9 Oct 2026, 7:35 PM",
    "businessDate": "2026-10-09",
    "orderType": "DINE_IN", "tableName": "Table 4", "captainName": "Ravi", "guestCount": 3,
    "platform": null, "taxTreatment": "NORMAL",
    "lines": [
      { "itemName": "Pani Puri With 6 Flavoured Pani", "variantName": null, "addOnNames": [],
        "quantity": 2, "unitPriceInPaise": 27000, "lineTotalInPaise": 54000, "taxRateBps": 500 }
    ],
    "itemTotalInPaise": 54000,
    "discount": { "label": "Regular guest", "amountInPaise": 5400 },
    "taxRows": [ { "taxRateBps": 500, "netSalesInPaise": 48600, "cgstInPaise": 1215, "sgstInPaise": 1215 } ],
    "cgstInPaise": 1215, "sgstInPaise": 1215, "gstInPaise": 2430,
    "roundOffInPaise": -30, "billTotalInPaise": 51000,
    "payments": [ { "methodName": "UPI", "amountInPaise": 51000 } ],
    "accountName": null,
    "footerText": "Swaad bhi, Yaad bhi!",
    "reviewLinkUrl": "https://g.page/r/…/review"
  }
}
```

`gstin` and `fssaiNumber` are null when the matching receipt switch
(`showGstin`, `showFssai`) is off or the value is not set; `captainName` is null
unless `showServerName` is on. `headerAbove` is `receipt.headerLine1`, printed
above the name, and `headerLines` holds `receipt.headerLine2`. From P25 the
receipt settings are wired: the thermal text and this data both read them, and
the receipt endpoint also returns `reviewLinkUrl` so the client can draw its QR
code under the text, which ends "Scan to review us". `isDuplicate` is true
when `printCount` is 1 or more (16.3). Money is whole paise; the client formats
it through `Money`.

404 for another restaurant's bill.

**Added 2026-10-09, for the thermal bill's layout:** `cashierName`, the name of
the person who made the bill (`billedBy`), read when the bill is printed, a
label only, like the KOT's fired-by name; and `customer`, `{ name, mobileLast4 }`
from the order's `customerName` and `customerPhone`, or null when the order has
neither. Only the last four digits of a mobile ever leave the server here; the
bill prints them as `XXXXXX1234`.

**The printer belongs to the device** (P25 Part C). "This device" stores one
printer setting, `THERMAL_80`, `THERMAL_58`, `A4` or `A5`, under the single
device storage key from P05; a device that stored 80 or 58 becomes
`THERMAL_80` or `THERMAL_58` on its next load. From 2026-10-09 a thermal
printer prints a bill from this endpoint's data too, laid out in the
restaurant's familiar thermal layout (logo, store block, guest, order details,
Item, Qty., Price and Amount, totals), at the head's printable width, 48 mm or
72 mm, less the device's edge margin (none, 2 or 4 mm each side), on a page
exactly that wide and as long as the bill (`@page { size: 72mm <height>mm }`,
never `auto`), or, when the device's paper length is
`ROLL`, from the top of the driver's roll (`@page { margin: 0 }`), both from
the pure function `pageCss`. The receipt text from section 15 is still what KOTs and the
Day Close print, and what the receipt endpoint returns. A4 and A5 print this endpoint's data as a full
tax invoice, black on white, 12 mm margins. KOTs and the Day Close print follow
the same setting; on A4 or A5 they print as one large block at the top of the
page. When `receipt.reviewLinkUrl` is set, every printed bill ends with its QR
code and "Scan to review us", drawn on the client.

### 16.2 Who may make a bill and take a payment (P25 Part D)

`settings.billing` (M7, P25):

| Field | Default | Meaning |
|---|---|---|
| `captainsMayBill` | `true` | A `WAITER` may create the bill for a dine-in or takeaway order |
| `captainsMayTakePayment` | `false` | A `WAITER` may also record payments, count notes and send a payment to the card machine on those bills |

1. `POST /bills` lets `WAITER` through the route; `billPermissionService.assertCanBill(actor, order, settings)` decides. A `WAITER` is refused 403 when `captainsMayBill` is off, and 403 for a `DELIVERY` order whatever the setting: platform orders are billed by the integration (M21).
2. `POST /bills/:billId/payments` and `POST /bills/:billId/terminal-payments` (M21) let `WAITER` through; `assertCanTakePayment(actor, bill, settings)` refuses 403 unless both settings are on and the bill is not a delivery bill.
3. Discounts, voids, payment corrections, charging to an account and applying an online advance do not change.

`GET /auth/me` gains `billing: { captainsMayBill, captainsMayTakePayment }`
beside `features`, `discounts` and `floor`, because a captain cannot read
`GET /settings`.

### 16.3 Printing a captain's bill at the counter (P25 Part D)

Bills gain, additively: `printRequestedAt`, `printRequestedBy`, `lastPrintedAt`,
`printCount` (default 0). DB-SCHEMA section 40.

| Method and path | Roles | What it does |
|---|---|---|
| `POST /api/v1/bills/:billId/print-request` | all six | Sets `printRequestedAt` to now and `printRequestedBy`. A voided bill is 422. Response 200: the bill. |
| `GET /api/v1/bills/print-queue` | OWNER, MANAGER, CASHIER | Bills of this branch, not voided, whose `printRequestedAt` is set and later than `lastPrintedAt` (or `lastPrintedAt` is null), oldest request first, at most 50. Each `{ id, billNumber, tableName, printRequestedAt, printRequestedByName, printCount }`. |
| `POST /api/v1/bills/:billId/printed` | all six | Adds 1 to `printCount` and sets `lastPrintedAt` to now. Response 200: `{ printCount, isDuplicate }`, `isDuplicate` true when `printCount` is now 2 or more. |

The queue is a read of the bills collection, not a second collection, so a bill
can never be in the queue twice. A second print request after a print puts it
back. Every print, from any device, calls `printed`, so the receipt and the
full page print "Duplicate" at the top from the second print on: the receipt
text endpoint (section 15) and `GET /invoice` both read `printCount` before the
client records the print, and print "Duplicate" when it is already 1 or more.

The counter device's "Print bills sent by captains" setting is a device setting
(no endpoint): it polls the queue every 5 seconds, prints each bill once, calls
`printed`, and remembers the ids it printed in the device's storage so a reload
never prints twice. P59: it claims each request with `printed` and
`forRequestAt` before printing, so only one device prints it.

### 16.4 Cancelling an item after the bill is made (P25 Part E)

```
POST /api/v1/bills/:billId/cancel-lines
```

```json
{
  "lines": [{ "lineId": "6601…", "wasPrepared": true }],
  "reasonCode": "MODIFICATION",
  "note": "Guest changed their mind",
  "approval": { "approverId": "652c…", "pin": "1234" }
}
```

`lineId` is the **order line's** id, which every bill line carries as
`orderLineId`. Whole lines only: the existing line cancel has no part-quantity
cancel, so neither does this. `reasonCode` is from `LINE_CANCEL_REASONS`, plus
`PLATFORM_CANCELLED` (M21); `note` up to 200 characters, as on the existing line cancel, required for `OTHER`.

`preview: true` (built in P25) runs the whole request inside its transaction, reads the result and rolls it back: nothing is written and no bill number is used. It answers `{ preview, voidedBillNumber, voidedBillTotalInPaise, newBillTotalInPaise, orderCancelled, cashToGiveBackInPaise, refundsOwed, onlineRefundInPaise }`, so the confirmation can state the consequence in real numbers while GST stays on the server. A preview needs no `approval`.

`GET /api/v1/users/approvers` (built in P25), OWNER, MANAGER, CASHIER, WAITER: the active owners and managers, `{ id, name, role }` only, for the till to pick an approver from. `GET /users` stays owner and manager only.
`wasPrepared` is required on every line, default yes on the screen.

Who:

| Caller | Rule |
|---|---|
| OWNER, MANAGER | No `approval`. An `approval` sent anyway is ignored. |
| CASHIER | `approval` required, else 403 "A manager has to approve this." |
| WAITER | Only when `settings.billing.captainsMayBill` is on, and with `approval`; else 403. |
| KITCHEN, STOREKEEPER | 403 |

`approval.approverId` must be an active OWNER or MANAGER of the same restaurant
(403 otherwise, without saying whether the person exists), and `approval.pin`
is checked with `authService.verifyPin`, which issues no session: a wrong PIN is
401 `INVALID_PIN` and the fifth wrong PIN locks it, 429 `PIN_LOCKED`, exactly as
at the attendance station. The approver is stored on the audit line.

Refused, each with a plain message:

1. The bill's business date is closed: 409 `DAY_CLOSED`, before any other rule.
2. The bill is voided: 422 `ENTRY_VOIDED`.
3. The bill is a delivery bill with a platform: 422 "Platform orders change through the platform."
4. A `lineId` is not a live line on this bill: 422.
5. The same `lineId` twice: 400.

What happens, in **one transaction** (bill creation already needs one):

1. Void the bill with `voidReasonCode: ITEMS_CHANGED` and the note
   "Items cancelled after billing: " followed by the dish names, through the
   same code as `voidBill`, so the order returns to `READY_TO_BILL`, an On Hold
   charge is reversed, and an online advance is released.
2. Cancel each chosen order line with the given reason and `wasPrepared`,
   through the same code as the existing line cancel, so stock and the KOT line
   are handled exactly as before and `LINE_CANCELLED_AFTER_PREP` is written for a
   prepared line.
3. If live lines remain, create a new bill for the order through `createBill`'s
   core, which from P25 runs inside a transaction it is given
   (`createBillInSession(req, { orderId, version }, session)`); `createBill`
   keeps its behaviour and opens its own.
4. Re-apply the old discount, same `reasonCode`, `note` and `fundedBy`: a
   percent stays the same `rateBps`; a flat amount stays the same, capped at the
   new item total.
5. Carry the payments over, in this order: `PLATFORM` kind first, then `CARD`,
   `UPI` and every other non-cash `IN_HAND` method, then `ONLINE` (P24), then
   `CASH`; within a kind, oldest first. Each is pushed onto the new bill with the
   same method and frozen fields, its original `receivedAt`, `receivedBy`,
   `businessDate` and `reference`, plus `carriedFromBillId`, until the new bill
   total is covered. The last carried payment is cut down to what is still due.
6. What is left over:
   1. Cash: returned as `cashToGiveBackInPaise`. Nothing is recorded: the voided
      bill's cash no longer counts, and the smaller carried amount is what the
      drawer keeps, so expected cash is already right.
   2. Anything else: one `refunds` row per method left over, status `OWED`
      (DB-SCHEMA section 31). An `ONLINE` leftover is refunded through Razorpay
      by the P24 refund path instead and is not a `refunds` row.
7. If the old bill was `ON_ACCOUNT`, the new bill is charged to the same account
   for whatever is not paid, through the same code as `charge-to-account`.
8. If no live lines remain, the whole order is cancelled with the same reason
   (mapped: `GUEST_LEFT` stays, `PLATFORM_CANCELLED` stays, every other line
   reason becomes `OTHER` with the note "Every item cancelled after billing"),
   and every payment is left over.
9. Writes `BILL_LINES_CANCELLED_AFTER_BILLING`, entity `BILL`, on the voided
   bill, `amountInPaise` the old bill total minus the new (the old total when
   nothing remains), `details: { voidedBillNumber, newBillId, newBillNumber,
   lineIds, reasonCode, approvedBy, cashToGiveBackInPaise, refundsOwedInPaise }`.
   OWNER only in the audit trail.

The new bill is numbered in the same transaction, so the invoice register shows
the voided number with its reason and the next number, with no gap.

Response 200:

```json
{
  "success": true,
  "data": {
    "bill": { "…": "the new bill, or null when nothing remains" },
    "voidedBillId": "6600…", "voidedBillNumber": "CFA/C/22446",
    "orderCancelled": false,
    "cashToGiveBackInPaise": 34600,
    "refundsOwed": [ { "id": "6602…", "methodName": "Card", "amountInPaise": 12000 } ]
  }
}
```

### 16.5 Refunds owed

```
GET  /api/v1/refunds?status=OWED&from&to
POST /api/v1/refunds/:refundId/done
```

`GET`: OWNER, MANAGER, CASHIER. Paged, newest first; `from` and `to` are
business dates. `POST .../done`: OWNER, MANAGER, body `{ reference }`, 1 to 100
characters, required. Sets `REFUNDED`, `refundedAt`, `refundedBy`, `reference`,
and writes `REFUND_RECORDED`, entity `BILL`, on the new bill. A refund already
`REFUNDED` is 422.

Refunds move no money in this system. They record money returned outside it,
on the card machine or by UPI. They appear on Day Close and in R2 and R5 as
their own line "Refunds owed", and as a **warning** on Day Close, never a
blocker. Marking one done is allowed on a closed day: it changes no figure of
that day.

### 16.7 Adding items after the bill is made (P26)

```
POST /api/v1/bills/:billId/reopen
```

Roles: OWNER, MANAGER directly; CASHIER, and WAITER when `captainsMayBill`, with
`approval: { approverId, pin }` exactly as 16.4.

```json
{ "approval": { "approverId": "6610…", "pin": "2468" } }
```

In one transaction: the bill is voided with `voidReasonCode: ITEMS_CHANGED`
and the note "Reopened to add items", which returns the order to
`READY_TO_BILL` and re-occupies its table, and the order's `reopenedFromBillId`
is set to the voided bill. Dishes are then added with 12.4, fired and served as
usual. Paid, unpaid and On Hold bills alike.

When an order with `reopenedFromBillId` is billed again (`POST /bills`), inside
the same transaction as the new bill: the voided bill's discount is applied
when the request sends none; its payments are carried in 16.4's order up to the
new bill total, each with `carriedFromBillId`; whatever is not needed is cash to
give back or a refund owed, as in 16.4; a voided On Hold bill's unpaid rest is
charged to the same account; and `reopenedFromBillId` is cleared. The response
is the bill, with `carried: { fromBillId, fromBillNumber, carriedInPaise,
cashToGiveBackInPaise, refundsOwed }` beside it when anything was carried.

Response 200: `{ orderId, voidedBillId, voidedBillNumber }`. Writes
`BILL_REOPENED`, entity `BILL`, on the voided bill, with `details: { approvedBy,
paidInPaise }`.

422 `BUSINESS_RULE_VIOLATED` for a voided bill, or a platform order ("Platform
orders change through the platform."). 409 `DAY_CLOSED` for a closed day. 409
`TABLE_OCCUPIED` when the table has another order since. 403 as 16.4 without
the approval.

From P29 a bill that can be **revised** (16.8) is never reopened this way to add
items: dishes are added to the order directly and the same bill is revised.
`reopen` on a revisable bill is still accepted, for a client written before
P29, and behaves exactly as above.

### 16.8 Revising an unpaid bill (P29 Part B)

A bill nothing has been paid on yet is still being agreed with the guest.
Removing an item from it, or adding one, is a **revision of the same bill**:
the same invoice number, new totals, and a revision record. It is not a void.
Once any money is recorded on a bill, 16.4 and 16.7 apply exactly as before,
because money has moved.

**When a bill can be revised.** All of these, checked on the server by one
function, `billRevisionService.revisability(req, bill)`, which returns
`{ revisable, reason }`:

1. The bill is not voided.
2. Its status is `UNPAID`, `amountPaidInPaise` is 0, no online advance is
   applied to it, and it is not charged to an account.
3. No terminal payment on it is `WAITING` or `UNKNOWN`.
4. It is not a delivery bill with a platform.
5. Its business date is open.
6. `settings.billing.reviseUnpaidBills` is true (M7, default true).

`GET /bills/:billId` gains `revisable` (boolean) and `revisableReason` (the
plain sentence why not, or null), so the screen knows which flow to offer. A
bill that cannot be revised keeps 16.4 and 16.7 exactly as they are.

#### 16.8.1 Removing items

```
POST /api/v1/bills/:billId/remove-lines
```

P35: unchanged on the server. The bill screen lists `itemRows` (14.2); removing
from a row made of several lines first asks which of them, and sends every
line picked, each with its own `wasPrepared` when it reached the kitchen. The
preview (`preview: true`) gains `removedQuantity` and `removedLineTotalInPaise`,
the picked lines added up on the server, so the screen says "2 × Roti ₹80.00
comes off bill …" with no money arithmetic of its own.

```json
{
  "lines": [{ "lineId": "6601…", "wasPrepared": false }],
  "reasonCode": "WRONG_ITEM",
  "note": null,
  "approval": { "approverId": "652c…", "pin": "1234" },
  "preview": false
}
```

`lineId` is the order line's id, as in 16.4. `wasPrepared` follows the order
line rule (12.6): required for a line the kitchen has, refused for one never
sent. `reasonCode` is from `LINE_CANCEL_REASONS`; `note` up to 200 characters,
required for `OTHER`. The same `lineId` twice is 400.

Roles: OWNER, MANAGER, CASHIER, WAITER, the same as cancelling a line before
billing (12.6). An approval is needed when the caller is a CASHIER or WAITER
and either:

1. `approvals.lineCancel` is on and any chosen line went to the kitchen
   (`FIRED`, `READY` or `SERVED`), the same rule as 12.6; or
2. `approvals.revisePrintedBill` is on (M7, default true) and the bill has been
   printed (`printCount` above 0). A printed bill has been shown to the guest,
   and lowering it after the guest paid cash in hand, keeping the difference, is
   the commonest till fraud; the cash count cannot catch it, because expected
   cash falls too.

An OWNER or MANAGER approves their own. An approval follows the P28 rules.

`preview: true` runs the whole request inside its transaction, reads the result
and rolls it back, as 16.4 does, and answers `{ preview: true, billNumber,
previousGrandTotalInPaise, newGrandTotalInPaise, removed: [{ itemName,
variantName, quantity, lineTotalInPaise }] }`, so the confirmation can say
"Water Bottle ₹47.61 comes off bill CFA/C/22446. The bill becomes ₹746.00." with
GST worked out on the server. A preview needs no approval.

Refused, in this order, each with a plain message:

1. The bill's business date is closed: 409 `DAY_CLOSED`.
2. The bill cannot be revised: 422 `BILL_NOT_REVISABLE`, with `revisableReason`
   as the message. The client offers 16.4 instead.
3. A `lineId` is not a live line on this bill: 422.
4. Every live line would go: 422 `BUSINESS_RULE_VIOLATED`, "To remove
   everything, cancel the order instead." Cancelling the whole order voids the
   bill (12.10), which is right, because no sale happened.

What happens, in **one transaction**:

1. Each chosen order line is cancelled through `cancelLineInSession`, with its
   reason and `wasPrepared`, so stock and the kitchen ticket behave exactly as a
   cancel before billing, and `LINE_CANCELLED_AFTER_PREP` is written for a
   prepared line. The order line also gets `removedFromBillId`, the bill's id.
2. The bill's lines are rebuilt from the order's live lines, and every total is
   recomputed with `computeBillTotals` and `allocateLineShares` through
   `applyTotals`, the same code bill creation uses. The discount is re-applied:
   a percent stays the same `rateBps`; a flat amount stays the same, capped at
   the new item total. Its reason, note, funder, `appliedBy` and `appliedAt` are
   kept.
3. `billNumber`, `billSequence`, `invoiceSeries`, `financialYear`, `billedAt`
   and `businessDate` do not change. No number is used.
4. `revision` goes up by 1, and one entry is pushed to `revisions`:
   `{ revision, at, by, approvedBy, kind: 'REMOVED', lines: [{ orderLineId,
   itemName, variantName, quantity, lineTotalInPaise, wasPrepared }],
   reasonCode, note, previousGrandTotalInPaise, newGrandTotalInPaise,
   wasPrinted }`. `approvedBy` is null when the actor approved themselves.
5. `BILL_REVISED` is written, entity `BILL`, `amountInPaise` the amount the bill
   went down by, `details: { kind, revision, lineIds, reasonCode,
   previousGrandTotalInPaise, newGrandTotalInPaise, wasPrinted, approvedBy }`.
   A MANAGER may read it.

Response 200: the revised bill, read as `GET /bills/:billId`.

#### 16.8.2 Adding items

12.4 changes for an order whose live bill can be revised: lines are added to it
directly, without `reopen`. In one transaction the lines are pushed, the order
moves back to `OPEN` and clears `readyToBillAt` (it keeps `billId`), and the
bill is rebuilt as in 16.8.1 step 2 with a revision of kind `ADDED`, `lines` the
added lines, no reason, and an approval only when P40 asks for one (a printed
bill, a CASHIER, `approvals.revisePrintedBill` on). `BILL_REVISED` is written with
`amountInPaise` the amount the bill went up by. The new lines are then sent to
the kitchen as usual (12.8).

While such an order is `OPEN`, its bill **takes no money**: a payment, an online
advance, a card machine payment and a charge to an account are each 422
`WAITING_FOR_KITCHEN`, "The new items are not ready yet. Take payment once the
kitchen has them ready." The order becomes `READY_TO_BILL` again when its last
line is served, which with `kitchen.readyMeansServed` on (13.3) is when the
kitchen marks it ready.

While an order has a live bill, its lines change only through the bill: 12.5
editing a line and 12.6 cancelling a line are 422 `BUSINESS_RULE_VIOLATED`,
"This table has a bill. Change the items from the bill."

A bill that cannot be revised keeps 16.7's void-and-reopen path exactly as it
is, and 12.4 still refuses lines on an order with such a bill.

#### 16.8.3 Printing a revised bill

`GET /bills/:billId/invoice` and the receipt text (15) gain `revision` and
`isRevised` (true when `revision` is above 0). Both print "Revised bill" under
the invoice number when `isRevised`.

Bills gain `lastPrintedRevision`, set by `POST /bills/:billId/printed` to the
bill's `revision` at that moment. `isDuplicate` (16.3) becomes: `printCount` is
1 or more **and** `lastPrintedRevision` equals `revision` (null reads as 0). So
the first print after a revision is not a duplicate, because its content
changed, and a second print with no change since is. `printed`'s response gains
`revision`.

#### 16.8.4 Where revisions show

1. R15 (M19 section 17): a removed item is an item cancelled with stage "Removed
   from the bill before payment", and never a void. A new section, "Bills changed
   before payment", lists each revision.
2. R2 Day Close controls: "Bills changed before payment", count and value
   removed.
3. R10 Invoice Register: one row per number as before, with "Revised" and the
   count when above 0.
4. The bill screen shows each revision in its timeline.

Bills voided by 16.4 and 16.7 before P29 stay voided. Nothing is converted.

### 16.9 Print the bill, then take payment (P29 Part D)

`settings.billing.printBeforePayment` (M7, default true) is read by the client
only. The server accepts a payment on a bill that was never printed, because
staff may need to, and records it: when a payment is recorded on a bill whose
`printCount` is 0, the bill's `paymentBeforePrint` is set to true and stays true.
R15 lists those bills in their own section.

`GET /auth/me` `billing` gains `printBeforePayment` and `reviseUnpaidBills`.

### 16.6 Permission summary for P25 in M3

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /bills | yes | yes | yes | when `captainsMayBill`, not delivery | no | no |
| POST /bills/:id/payments | yes | yes | yes | when both billing settings, not delivery | no | no |
| GET /bills/:id/invoice | yes | yes | yes | yes | yes | yes |
| POST /bills/:id/print-request | yes | yes | yes | yes | yes | yes |
| GET /bills/print-queue | yes | yes | yes | no | no | no |
| POST /bills/:id/printed | yes | yes | yes | yes | yes | yes |
| POST /bills/:id/cancel-lines | yes | yes | with a manager's PIN | with a manager's PIN, when `captainsMayBill` | no | no |
| POST /bills/:id/remove-lines (P29) | yes | yes | yes, a PIN as 16.8.1 says | yes, a PIN as 16.8.1 says | no | no |
| GET /refunds | yes | yes | yes | no | no | no |
| POST /refunds/:id/done | yes | yes | no | no | no | no |

---

## Permission summary for M3

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /bills | yes | yes | yes | no | no | no |
| GET /bills/:id | yes | yes | yes | yes | yes | yes |
| GET /bills | yes | yes | yes | no | no | no |
| POST /bills/:id/discount | yes | yes | **no** | no | no | no |
| POST /bills/:id/payments | yes | yes | yes | no | no | no |
| POST /bills/:id/void | yes | yes | **no** | no | no | no |
| GET /bills/summary | yes | yes | no | no | no | no |
| GET /bills/:id/receipt | yes | yes | yes | yes | yes | yes |

Reading one bill and its receipt is open to all six, because a waiter carries
the bill to the table. Creating and taking payment is the cashier's job.
**Discounting and voiding are not**, and that is the whole point: BUILD-PLAN
section 7 names voids and discounts as the events an owner is losing money to,
so they need a manager's credentials and they land on the audit trail.

Every rule lives in `services/billPermissionService.js`, one file, the way M0-C
put staff rules in `userPermissionService.js`. Asking "what may a cashier do"
is one file to read.

---

## Error codes added by M3

| Code | Status | When |
|---|---|---|
| `BILL_ALREADY_EXISTS` | 409 | A live bill already exists for that order. Carries `existingBillId`. |
| `TRANSACTION_REQUIRED` | 503 | The connection cannot start a transaction, so a gap-free bill number cannot be guaranteed |

`ENTRY_VOIDED` (422) is reused from M5 for voiding an already-voided bill: it is
the same condition with the same meaning, and a second code for it would be two
names for one thing. `VERSION_CONFLICT` is reused from M2. Everything else
reuses `BUSINESS_RULE_VIOLATED`, `NOT_FOUND` and `VALIDATION_FAILED`.

---

# M4 Inventory with recipe deduction

Owner: Arya.

Ingredients with a stock level, a recipe per sellable thing, and automatic
deduction when a dish is fired to the kitchen.

**Deduction happens at KOT fire**, because that is when the ingredients leave
the shelf. It is not an endpoint anyone calls: `POST /orders/:orderId/fire`
triggers it inside the same transaction that writes the KOT. There is no way to
fire a ticket and not deduct, and no way to deduct twice.

**Nothing here ever blocks a sale.** Not a missing recipe, not negative stock.
See DB-SCHEMA.md sections 14 and 15 for why.

---

## 16. Ingredient endpoints

### 16.1 Create an ingredient

```
POST /api/v1/ingredients
```

Roles: `OWNER`, `MANAGER`, `STOREKEEPER`.

```json
{
  "name": "Paneer",
  "baseUnit": "G",
  "purchaseUnitName": "kg",
  "unitsPerBase": 1000,
  "lowStockThresholdInBase": 2000,
  "openingQtyInBase": 5000
}
```

`openingQtyInBase` is optional and, when given, writes one `RECEIVED` movement
rather than setting the quantity directly, so the ledger explains the opening
balance like every other change.

Response 201 returns the ingredient. 409 `DUPLICATE` on a name clash in this
branch, case-insensitive.

### 16.2 List ingredients

```
GET /api/v1/ingredients?search=&lowStockOnly=false&includeInactive=false&page=1&limit=50
```

Roles: all six. Reads are open because a cook needs to see what is out.

`lowStockOnly=true` returns only ingredients where
`currentQtyInBase <= lowStockThresholdInBase`. **Computed on read**, not stored
and not maintained by a job: there is no job runner in this project and adding
one is out of scope.

Each row carries a derived `stockState` of `IN_STOCK`, `LOW` or `OUT`, so the
three states have one definition on the server rather than one per screen.
`OUT` is `currentQtyInBase <= 0`, which includes negative.

`search` is escaped before it becomes a regular expression, the same rule every
other search box in this project follows.

### 16.3 Update an ingredient

```
PATCH /api/v1/ingredients/:ingredientId
```

Roles: `OWNER`, `MANAGER`, `STOREKEEPER`.

Updatable: `name`, `purchaseUnitName`, `unitsPerBase`, `lowStockThresholdInBase`.

`baseUnit` is **refused with 422 once any movement exists** for this ingredient,
and is otherwise updatable. Changing it later would reinterpret every historical
quantity in the ledger with no way to detect it afterwards.

`currentQtyInBase` is refused with 400 always. Stock changes through a movement,
never by assignment, or the ledger stops being the truth.

### 16.4 Activate or deactivate

```
PATCH /api/v1/ingredients/:ingredientId/active
```

Roles: `OWNER`, `MANAGER`.

```json
{ "isActive": false }
```

**This is the delete.** 422 `BUSINESS_RULE_VIOLATED` if any active recipe still
references it, with the message naming how many recipes do. Deactivating an
ingredient a live recipe consumes would silently stop deducting it.

---

## 17. Recipe endpoints

### 17.1 Create or replace a recipe

```
PUT /api/v1/recipes
```

Roles: `OWNER`, `MANAGER`.

The one `PUT` in this project, and it is deliberate: a recipe is identified by
what it is attached to rather than by its own id, and writing one is
idempotent — the same body twice leaves the same single recipe.

```json
{
  "menuItemId": "652d...",
  "variantId": null,
  "items": [
    { "ingredientId": "6540...", "qtyInBase": 150 },
    { "ingredientId": "6541...", "qtyInBase": 30 }
  ]
}
```

`qtyInBase` is in that ingredient's own base unit, per one unit of the dish.

Response 200, or 201 when it did not exist.

404 `NOT_FOUND` if the menu item, the variant, or any ingredient is not in this
restaurant. 422 `BUSINESS_RULE_VIOLATED` if an ingredient is inactive, or if the
same `ingredientId` appears twice.

### 17.2 Read recipes

```
GET /api/v1/recipes?menuItemId=&page=1&limit=50
```

Roles: `OWNER`, `MANAGER`, `STOREKEEPER`.

Each recipe is returned with its ingredient names and base units resolved, so
the editor does not fetch the ingredient list separately to render.

### 17.3 Delete a recipe

```
DELETE /api/v1/recipes/:recipeId
```

Roles: `OWNER`, `MANAGER`.

**The one `DELETE` in the project.** A recipe is configuration, not a record of
something that happened: it holds no history, nothing references it, and the
movements it produced are in `stockmovements` and are untouched by removing it.
Detaching a recipe is the ordinary way to stop deducting for a dish, and a soft
delete here would mean carrying an `isActive` that means exactly the same thing
as the row not existing.

Nothing in CLAUDE.md's no-hard-delete rule is bent: that rule names bills,
orders and stock entries, and a recipe is none of them.

### 17.4 Dishes selling with no recipe

```
GET /api/v1/inventory/unmapped?from=&to=
```

Roles: `OWNER`, `MANAGER`, `STOREKEEPER`.

Menu items that have been fired with no recipe resolvable, newest first, with
how many times. This is where a half-configured inventory becomes visible
instead of silently deducting nothing forever, and it is the honest answer to
the seed data gap in BUILD-PLAN section 8.

---

## 18. Stock movement endpoints

### 18.1 The ledger

```
GET /api/v1/ingredients/:ingredientId/movements?from=&to=&page=1&limit=50
```

Roles: `OWNER`, `MANAGER`, `STOREKEEPER`.

One ingredient's movements, newest first, each with its `resultingQtyInBase` so
the screen reads as a running balance without replaying the ledger.

### 18.2 Adjust stock

```
POST /api/v1/ingredients/:ingredientId/movements
```

Roles: `OWNER`, `MANAGER`, `STOREKEEPER`.

```json
{ "type": "WASTAGE", "qtyInBase": 500, "reason": "Spoiled overnight" }
```

`type` is one of `RECEIVED`, `WASTAGE`, `SPILLAGE`, `RECOUNT`, `RETURN`. The
deduction types `DEDUCTION` and `CANCELLATION_RETURN` are refused with 400: they
are written by the fire and cancel paths and by nothing else.

`qtyInBase` is a positive integer for every type except `RECOUNT`, where it is
the signed difference and may be negative. The sign is applied by the server
from the type, so a storekeeper never types a minus sign.

`reason` is required on every manual movement.

Response 201 returns the movement and the ingredient's new quantity. Writes one
`auditlogs` row, `STOCK_ADJUSTED`.

The quantity is sent in the **base unit**. The screen converts from the
purchase unit and shows the working; `server/utils/units.js` is the only place
that multiplies, and the API takes what the ledger stores.

### 18.3 Consumption

```
GET /api/v1/inventory/consumption?from=2026-08-01&to=2026-08-30
```

Roles: `OWNER`, `MANAGER`.

Quantity consumed per ingredient over a range of business days, deductions net
of cancellation returns. Not paginated. This is the read M6's "stock consumed"
report aggregates from.

---

## Permission summary for M4

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /ingredients | yes | yes | no | no | no | yes |
| GET /ingredients | yes | yes | yes | yes | yes | yes |
| PATCH /ingredients/:id | yes | yes | no | no | no | yes |
| PATCH /ingredients/:id/active | yes | yes | no | no | no | no |
| PUT /recipes | yes | yes | no | no | no | no |
| GET /recipes | yes | yes | no | no | no | yes |
| DELETE /recipes/:id | yes | yes | no | no | no | no |
| GET /inventory/unmapped | yes | yes | no | no | no | yes |
| GET /ingredients/:id/movements | yes | yes | no | no | no | yes |
| POST /ingredients/:id/movements | yes | yes | no | no | no | yes |
| GET /inventory/consumption | yes | yes | no | no | no | no |

`STOREKEEPER` is the role this module exists for, and it is the first module
where that role does real work. They receive stock, count it and record wastage,
so they own movements and can maintain ingredients. They do **not** write
recipes, because a recipe changes what every future sale deducts, and they do
not deactivate an ingredient, because that stops deduction silently.

Reading the ingredient list is open to all six: a cook who can see paneer is out
marks the dish unavailable in M1, which is the loop these two modules close
together.

---

## Error codes added by M4

| Code | Status | When |
|---|---|---|
| `INGREDIENT_IN_USE` | 422 | Deactivating an ingredient an active recipe still consumes |
| `BASE_UNIT_IMMUTABLE` | 422 | Changing `baseUnit` after a movement exists |
| `DUPLICATE_RECIPE_INGREDIENT` | 422 | The same `ingredientId` twice in one recipe |

Everything else reuses existing codes. `DUPLICATE` for an ingredient name clash,
`NOT_FOUND` for a plain 404, `BUSINESS_RULE_VIOLATED` for an inactive
ingredient in a recipe, `VALIDATION_FAILED` for a bad quantity or a
server-owned movement type.

---

## What M3 and M4 deliberately do not contain

Service charge, tip, credit note, partial refund, customer GSTIN, B2B invoice
fields, split-by-cover.

Ingredient cost, stock valuation, margin. Attendance produces minutes, this
produces quantities, and turning either into money is a separate build.

Suppliers, purchase orders and goods-received notes. BUILD-PLAN section 4 defers
vendors until inventory numbers are trusted, which is after a pilot.

Batch, expiry, FEFO, or per-storeroom locations.

Any background job. Low stock is computed on read, because this project has no
job runner and adding one is out of scope.


# M6 Reports and Dashboard

Owner: Rishi.

**M6 adds no collections and writes nothing.** Every endpoint is a read. This is the one module in the project with no model file, no `POST`, no `PATCH`, and no soft-delete fields, because it owns no data. It aggregates over `bills`, `orders`, `stockmovements` and `attendanceentries`, all of which are already built and frozen.

Add this to `DB-SCHEMA.md` as its own short section saying exactly that, so a reader looking for M6's collections finds the statement rather than an absence.

---

## Rules every M6 endpoint obeys

**Voided is excluded, everywhere, always.** `bills` with `isVoided: true` count towards no revenue figure, no item count, no tax total, no payment split. `attendanceentries` with `isVoided: true` count towards no minutes. This is the soft-delete leak from BUILD-PLAN section 8, and M6 is where it would first show up as a wrong number an owner acts on.

**Every date range is in business days, not calendar days.** Every endpoint takes `from` and `to` as `"YYYY-MM-DD"` strings and matches them against the stored `businessDate` string on `bills` and `attendanceentries`. No `Date` arithmetic, no timezone conversion, no `$dateToString` in an aggregation. The hard work was done at write time by `businessDateFor`, and M6's job is to not undo it.

**`from` and `to` are both required and both inclusive.** No defaults. A report that silently decides its own range is a report that shows a different number depending on when it was opened.

**Maximum range is 366 days.** A longer range is 422 `RANGE_TOO_LARGE`. Without a cap, one request scans years of bills and takes the database down during service.

**Every aggregation pipeline starts with `$match` on `restaurantId` and `branchId`.** The tenant guard requires this on `aggregate` and throws otherwise, which is the intended behaviour, not an obstacle to work around. Never use `skipTenantGuard` in this module. The count stays at four.

**Money out of M6 is whole paise integers**, same as everywhere. Formatting to rupees happens on the client, in the shared helper.

---

## 1. `GET /api/v1/reports/dashboard`

Roles: `OWNER`, `MANAGER`.

The one call the owner opens every morning. Today's business day only, no parameters.

```json
{
  "success": true,
  "data": {
    "businessDate": "2026-08-30",
    "sales": {
      "grossSalesInPaise": 4820000,
      "billCount": 62,
      "averageBillInPaise": 77742,
      "totalTaxInPaise": 229523,
      "totalDiscountInPaise": 145000
    },
    "openOrders": { "count": 8, "runningValueInPaise": 612000 },
    "topItems": [
      { "menuItemId": "664d...", "itemName": "Paneer Tikka", "quantity": 34, "revenueInPaise": 1428000 }
    ],
    "lowStock": [
      { "ingredientId": "667a...", "name": "Paneer", "currentQtyInBase": 400, "baseUnit": "G", "lowStockThresholdInBase": 2000 }
    ],
    "staffOnShift": 7,
    "unpaidBills": { "count": 3, "amountInPaise": 184000 }
  }
}
```

`grossSalesInPaise` is the sum of `grandTotalInPaise` across non-voided bills for today's business date. It is what was billed, not what was collected.

`topItems` is capped at 5. `lowStock` is capped at 10 and lists ingredients where `currentQtyInBase <= lowStockThresholdInBase`.

`staffOnShift` counts attendance entries with `clockOutAt: null` and `isVoided: false`.

Today's business date is computed once, server-side, with `businessDateFor(new Date())`. Never taken from the client.

## 2. `GET /api/v1/reports/sales-summary?from=&to=`

Roles: `OWNER`, `MANAGER`.

Headline totals across a range.

```json
{
  "success": true,
  "data": {
    "from": "2026-08-01",
    "to": "2026-08-30",
    "grossSalesInPaise": 128400000,
    "subtotalInPaise": 118900000,
    "totalDiscountInPaise": 3200000,
    "totalTaxInPaise": 12300000,
    "totalRoundOffInPaise": -1400,
    "billCount": 1642,
    "voidedBillCount": 11,
    "voidedBillValueInPaise": 84000,
    "averageBillInPaise": 78197,
    "dineIn": { "billCount": 1204, "salesInPaise": 104200000 },
    "takeaway": { "billCount": 438, "salesInPaise": 24200000 }
  }
}
```

`voidedBillCount` and `voidedBillValueInPaise` are the one place voided bills appear, reported separately and never mixed into a revenue figure. An owner wants to see that number rising.

`averageBillInPaise` is integer division, floored. It is not stored and not used for anything but display.

## 3. `GET /api/v1/reports/sales-by-day?from=&to=`

Roles: `OWNER`, `MANAGER`.

One row per business day, in ascending date order.

```json
{
  "success": true,
  "data": [
    {
      "businessDate": "2026-08-01",
      "grossSalesInPaise": 4120000,
      "billCount": 54,
      "averageBillInPaise": 76296,
      "totalDiscountInPaise": 92000
    }
  ]
}
```

**Days with no bills are returned with zeros, not omitted.** A chart with missing days draws a misleading line. The server fills the gaps by walking the string dates, which is why `businessDate` being a `"YYYY-MM-DD"` string rather than a `Date` matters here too.

## 4. `GET /api/v1/reports/hourly?from=&to=`

Roles: `OWNER`, `MANAGER`.

Sales grouped by hour of day, IST, across the range. Twenty-four rows always, including empty hours.

```json
{
  "success": true,
  "data": [
    { "hourIst": 0, "grossSalesInPaise": 0, "billCount": 0 },
    { "hourIst": 20, "grossSalesInPaise": 18400000, "billCount": 204 }
  ]
}
```

This is the one place a real timestamp is used rather than `businessDate`, because "which hour" is a question about clock time. Group on `billedAt` converted to IST inside the aggregation with `$hour` and `timezone: "Asia/Kolkata"`. Do not convert in JavaScript after fetching every bill.

## 5. `GET /api/v1/reports/top-items?from=&to=&limit=20&sort=quantity`

Roles: `OWNER`, `MANAGER`.

`sort` is `quantity` or `revenue`. `limit` is 1 to 100, default 20.

```json
{
  "success": true,
  "data": [
    {
      "menuItemId": "664d...",
      "itemName": "Paneer Tikka",
      "quantity": 842,
      "revenueInPaise": 35364000,
      "billCount": 611
    }
  ]
}
```

Read from `bills.lines`, not from `orders.lines`. Bill lines already exclude cancelled order lines, so grouping over bills gives the sold figure without a filter. Grouping over orders would need one and would eventually be forgotten.

Group by `menuItemId`, but report `itemName` from the most recent bill line, so a renamed dish shows its current name while its history stays joined.

## 6. `GET /api/v1/reports/payment-methods?from=&to=`

Roles: **`OWNER` only.**

```json
{
  "success": true,
  "data": {
    "methods": [
      { "method": "CASH", "amountInPaise": 41200000, "paymentCount": 704 },
      { "method": "UPI", "amountInPaise": 78600000, "paymentCount": 812 },
      { "method": "CARD", "amountInPaise": 8600000, "paymentCount": 118 },
      { "method": "OTHER", "amountInPaise": 0, "paymentCount": 0 }
    ],
    "totalCollectedInPaise": 128400000,
    "unpaidInPaise": 420000
  }
}
```

Owner-only because the cash figure is the number a dishonest manager most wants to see and most wants to control. The module catalog names exactly this: only the owner sees the day's total cash.

All four methods are always present, with zeros where unused.

`unpaidInPaise` is the sum of `grandTotalInPaise − amountPaidInPaise` across non-voided bills with `status: UNPAID`.

## 7. `GET /api/v1/reports/tax-summary?from=&to=`

Roles: `OWNER`, `MANAGER`.

The number an accountant files from.

```json
{
  "success": true,
  "data": {
    "from": "2026-08-01",
    "to": "2026-08-31",
    "slabs": [
      {
        "taxRateBps": 500,
        "taxableInPaise": 88400000,
        "cgstInPaise": 2210000,
        "sgstInPaise": 2210000,
        "taxInPaise": 4420000
      }
    ],
    "totalTaxableInPaise": 118900000,
    "totalCgstInPaise": 6150000,
    "totalSgstInPaise": 6150000,
    "totalTaxInPaise": 12300000
  }
}
```

Sum `bills.taxBreakdown` across non-voided bills, grouped by `taxRateBps`. **Sum the stored values. Never recompute tax here.** M3 already computed it per slab with a documented rounding rule, and a second implementation in M6 will disagree with the printed bill by a rupee, which is the exact failure BUILD-PLAN section 8 names.

Slabs are returned ascending by rate. A slab with no sales in the range is omitted.

## 8. `GET /api/v1/reports/discounts?from=&to=&page=&limit=`

Roles: `OWNER`, `MANAGER`.

```json
{
  "success": true,
  "data": {
    "totalDiscountInPaise": 3200000,
    "discountedBillCount": 184,
    "discountAsPercentOfSubtotalBps": 269,
    "byUser": [
      { "userId": "664f...", "name": "Kaival", "amountInPaise": 1840000, "billCount": 96 }
    ],
    "recent": [
      {
        "billId": "668a...",
        "billNumber": "2026-27/000148",
        "businessDate": "2026-08-29",
        "amountInPaise": 12000,
        "reason": "Regular customer",
        "appliedBy": "Kaival",
        "appliedAt": "2026-08-29T15:04:00.000Z"
      }
    ]
  }
}
```

`byUser` is the point of this report. "How much did each person give away" is what an owner actually wants and cannot get today.

`recent` is paginated. Read it from `bills.discount`, not from `auditlogs`, because the bill is the authoritative record and the audit log is the trail. They should agree; if they ever do not, the bill is right.

`discountAsPercentOfSubtotalBps` is basis points, integer, same convention as everywhere else.

## 9. `GET /api/v1/reports/stock-consumption?from=&to=&ingredientId=`

Roles: `OWNER`, `MANAGER`, `STOREKEEPER`.

`ingredientId` is an optional filter.

```json
{
  "success": true,
  "data": [
    {
      "ingredientId": "667a...",
      "name": "Paneer",
      "baseUnit": "G",
      "consumedInBase": 184000,
      "returnedInBase": 2400,
      "netConsumedInBase": 181600,
      "wastageInBase": 3200,
      "receivedInBase": 200000,
      "recountAdjustmentInBase": -1400
    }
  ]
}
```

`consumedInBase` is the absolute value of `DEDUCTION` movements. `returnedInBase` is `CANCELLATION_RETURN`. `netConsumedInBase` is the difference and is the number that answers "how much paneer did we actually use".

`wastageInBase` sums `WASTAGE` and `SPILLAGE` together, absolute. A separate wastage number is what turns "we seem to waste a lot of tomatoes" into something actionable.

`stockmovements` has no `businessDate` field, only `at`. So this endpoint converts the `from` and `to` business dates into a UTC instant range on the server before matching, using the restaurant's `businessDayStartsAtMinutes`. Write that conversion once, in `server/utils/time.js`, as `businessDateRangeToUtc(from, to, startsAtMinutes)`. Do not inline it.

Sorted by `netConsumedInBase` descending. Storekeeper has access because this is the read their job depends on.

## 10. `GET /api/v1/reports/labour-hours?from=&to=&userId=`

Roles: `OWNER`, `MANAGER`.

`userId` is an optional filter.

```json
{
  "success": true,
  "data": {
    "totalMinutes": 84200,
    "byUser": [
      {
        "userId": "664f...",
        "name": "Ramesh",
        "role": "WAITER",
        "totalMinutes": 12400,
        "shiftCount": 26,
        "openShiftCount": 0,
        "averageShiftMinutes": 476
      }
    ],
    "openShifts": [
      { "userId": "664g...", "name": "Suresh", "clockInAt": "2026-08-29T06:20:00.000Z", "businessDate": "2026-08-29" }
    ]
  }
}
```

**Open shifts contribute zero minutes and are listed separately.** `workedMinutes` is null while a shift is open and M5 deliberately never invents a clock-out time. M6 must not invent one either: do not compute elapsed time for an open shift. A number that grows while you look at it is not an hours-worked figure, and this feeds payroll later.

`openShifts` is what surfaces a forgotten clock-out to whoever reads the report.

Excludes `isVoided: true` entries entirely.

---

## Permission summary for M6

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| GET /reports/dashboard | yes | yes | no | no | no | no |
| GET /reports/sales-summary | yes | yes | no | no | no | no |
| GET /reports/sales-by-day | yes | yes | no | no | no | no |
| GET /reports/hourly | yes | yes | no | no | no | no |
| GET /reports/top-items | yes | yes | no | no | no | no |
| GET /reports/payment-methods | yes | no | no | no | no | no |
| GET /reports/tax-summary | yes | yes | no | no | no | no |
| GET /reports/discounts | yes | yes | no | no | no | no |
| GET /reports/stock-consumption | yes | yes | no | no | no | yes |
| GET /reports/labour-hours | yes | yes | no | no | no | no |

---

## Decisions made for M6

**No cached or precomputed report collection.** Every figure is aggregated live. A restaurant does a few hundred bills a day, indexes exist on `{ restaurantId, branchId, businessDate, isVoided }`, and a materialised rollup is a second source of truth that goes stale. Revisit only if a real query is measurably slow on real data.

**No CSV or PDF export in version 1.** The screen is the deliverable. Export is a day of work whenever someone actually asks.

**No comparison-to-previous-period figures.** No "up 12% on last month". They are easy to add later and easy to get subtly wrong now, and the client can compute one from two calls.

**No profit, margin, or food-cost figures.** `ingredients` deliberately has no cost price, so there is no honest way to produce one. This is M13's problem once purchase orders exist.

**Tax is summed from stored values, never recomputed.** See section 7.

# M7 Restaurant Settings

Owner: Rishi.

**M7 adds no collection.** It expands the `settings` object already on `restaurants`, adds two endpoints to read and write it, and gives every other module one typed, defaulted, audited place to read configuration from instead of a constant buried in a service file.

It also adds one value to the `auditlogs` action enum. Nothing else in the database changes.

---

## The rule that makes M7 safe to build alongside M6

`settings.businessDayStartsAtMinutes` already exists. M5 put it there, M3 derives `businessDate` from it, and M6 reads it for every report.

**M7 does not move it, rename it, change its type, change its default, or change its meaning.** It stays exactly where it is, as an integer number of minutes past midnight IST, default 300. M7 only brings it under one editing endpoint alongside the new settings.

Every other setting M7 adds is new. Nothing existing is restructured. That is why M6 and M7 can be built at the same time by two people without a merge conflict that matters.

---

## What lives in settings, and what does not

A setting is a value an owner would reasonably change, that the software must not hardcode.

A constant is a value the software depends on being stable and that an owner changing would break something. The 12-hour open-shift threshold in M5 is a constant, and decision D5 says so explicitly. M7 does not turn it into a setting. Neither does it touch the six-role enum, the three base units, or the counter names, all of which are deliberately closed lists.

---

## 1. The settings object

Added to `restaurants.settings`. Every field has a default, so an existing restaurant document with only `businessDayStartsAtMinutes` reads back a complete settings object without a migration.

### `settings.business`

| Field | Type | Default | Notes |
|---|---|---|---|
| `businessDayStartsAtMinutes` | Number | 300 | **Pre-existing. Untouched.** Integer 0 to 1439. Minutes past midnight IST at which the business day rolls over. Stays at `settings.businessDayStartsAtMinutes`, not nested under `business`. See the note below. |

**This one field stays at the top level of `settings`, not inside `settings.business`.** Nesting it would be tidier and would break M3, M5 and M6 at once. Tidiness is not worth a migration on a field three modules already read. The `business` group in the API response reads it from the top level and writes it back there.

### `settings.tax`

| Field | Type | Default | Notes |
|---|---|---|---|
| `pricingMode` | String | `EXCLUSIVE` | Enum `EXCLUSIVE`, `INCLUSIVE`. Whether `menuitems.priceInPaise` is before or after GST. **Stored but not yet consumed. See section 4.** |
| `defaultTaxRateBps` | Number | 500 | Integer 0 to 10000. Prefilled on a new menu item so an owner does not retype 5% two hundred times. |
| `roundOffEnabled` | Boolean | true | Whether a bill rounds to the nearest rupee. **Stored but not yet consumed. See section 4.** |

### `settings.receipt`

Printed on every bill from P25 Part C, thermal and full page alike.

| Field | Type | Default | Notes |
|---|---|---|---|
| `headerLine1` | String | `null` | Max 40 characters. Printed above the restaurant name. |
| `headerLine2` | String | `null` | Max 40 characters. |
| `footerText` | String | `null` | Max 200 characters. "Thank you, visit again." |
| `showGstin` | Boolean | true | Print the GSTIN on the bill. |
| `showFssai` | Boolean | true | Print the FSSAI licence number. |
| `showServerName` | Boolean | false | Print who took the order. |

Forty characters is not arbitrary. A standard 80mm thermal roll fits roughly 42 characters per line at normal font, and a longer line wraps and destroys the layout, which BUILD-PLAN section 8 names as the printer problem. Enforce it now, before anyone types a 90-character footer and discovers it in a kitchen.

### `settings.inventory`

| Field | Type | Default | Notes |
|---|---|---|---|
| `lowStockAlertsEnabled` | Boolean | true | Whether the low-stock list appears on the dashboard and in the stock screens. |

### `settings.features` (added by P02)

| Field | Type | Default | Notes |
|---|---|---|---|
| `inventory` | Boolean | true | M4 is in use for this restaurant. When false, every inventory route and `GET /reports/stock-consumption` refuse with 403 `FEATURE_DISABLED`, and firing or cancelling an order writes no stock movement. |
| `attendance` | Boolean | true | M5 is in use for this restaurant. When false, every attendance route, including the station clock, and `GET /reports/labour-hours` refuse with 403 `FEATURE_DISABLED`. |

Both default to `true`, so nothing changes for an existing restaurant. Switching a feature off never deletes data. Switching it back on does not back-fill anything: stock levels resume from where they stopped and are wrong until someone does a stock count.

### `settings.delivery` (added by P06)

| Field | Type | Default | Notes |
|---|---|---|---|
| `platformCollectsGst` | Boolean | true | When true, a `DELIVERY` order from a platform on the list is frozen at 0% GST when created. `TO CONFIRM` with the CA. A change affects only orders created after it, and writes `SETTINGS_CHANGED`. |

### `settings.discounts` (added by P07)

| Field | Type | Default | Notes |
|---|---|---|---|
| `cashierMayApplyPlatformDiscounts` | Boolean | false | When true, a CASHIER may apply a discount with a platform reason, and no other. `TO CONFIRM` with Caffeza. |

### `settings.dayClose` (added by P07)

| Field | Type | Default | Notes |
|---|---|---|---|
| `showCashDifferenceToManager` | Boolean | false | The blind count. When false, Day Close responses and prints to a MANAGER leave out expected cash and the difference. |

### `settings.floor` (added by P19)

| Field | Type | Default | Notes |
|---|---|---|---|
| `sectionOrder` | [String] | `[]` | Section names in the order the floor shows them. Sections not listed follow, by name. At most 40 names, each at most 40 characters. |
| `longOpenMinutes` | Number | 90 | Integer 15 to 600. A table open longer is marked as running long. |
| `requireGuestCount` | Boolean | false | When true, a dine-in order cannot be opened without a guest count. On for Caffeza. From P59: cannot be sent to the kitchen the first time without one. |

`GET /auth/me` returns `floor` beside `features` and `discounts`, so every role's
floor screen knows the section order, the long-open threshold and whether
"Skip" may be offered. The server still decides.

### `settings.appearance` (added by P20A)

The restaurant's look, from `docs/DESIGN-SYSTEM.md` section 11a. OWNER only to
change, audited like every setting.

| Field | Type | Default | Notes |
|---|---|---|---|
| `accentPreset` | String | `OCEAN` | `OCEAN`, `INDIGO`, `PLUM`, `OLIVE`, `ESPRESSO`, `GRAPHITE` or `CUSTOM` |
| `accentHex` | String | null | `#RRGGBB`. Required with `CUSTOM`, ignored otherwise. Validated as below. |
| `wordmark` | String | null | The name in the top bar, 1 to 30 characters. Null means the restaurant's name. |
| `secondLanguage` | String | `NONE` | `NONE`, `GUJARATI` or `HINDI`. The restaurant's default; a device may override it. |
| `todayTiles` | [String] | every R1 tile key, in contract order | Which R1 tiles show on Today, in order. Keys from R1's tile columns, each once. |
| `neutralTone` | String | `COOL` | P22. `COOL` or `WARM`: which neutral set every screen uses. DESIGN-SYSTEM section 4a. State colours never change with it. |
| `brandHex` | String | null | P22. `#RRGGBB`, the logo's own background colour. Used only for the sign-in brand panel and the plate behind a logo. Set together with `onBrandHex`. |
| `onBrandHex` | String | null | P22. `#RRGGBB`, text on `brandHex`. Set together with `brandHex`. |

A custom `accentHex` is accepted only when, by `server/utils/colour.js`:
1. it is a six-digit hex colour;
2. white text on it is at least 4.5 to 1;
3. it is at least 3 to 1 against day `ground` in both neutral sets, `#F2F4F3`
   (cool) and `#EFE9E1` (warm), so switching the tone can never break a saved
   accent (P22);
4. its hue is at least 30 degrees from the hue of each state colour, `#7A4F00`,
   `#16614F`, `#922457`, `#A8321C` and `#256640`, unless its saturation is under 25%.

Otherwise 400 `VALIDATION_FAILED` with `fields["appearance.accentHex"]` naming
the rule it broke and the nearest preset by hue.

The brand pair (P22): `brandHex` and `onBrandHex` are both six-digit hex colours
or both null; sending one when the other would be left null is 400 on the one
missing. When both are set, `onBrandHex` on `brandHex` must be at least 4.5 to 1,
or 400 `VALIDATION_FAILED` with `fields["appearance.onBrandHex"]` giving the
measured ratio. A pair that would only be complete with the stored value is
checked against the stored value, the same way `CUSTOM` is checked against a
stored `accentHex`. Neither colour is held to the accent rules: `brand` is never
a button and never a state.

`GET /auth/me` returns `appearance` beside `features`, for every role:

```json
{
  "accentPreset": "CUSTOM", "accent": "#49302D", "accentNight": "#A6746E",
  "wordmark": "Cafezza", "secondLanguage": "GUJARATI",
  "todayTiles": ["billTotalInPaise", "netSalesInPaise"],
  "neutralTone": "WARM", "brandHex": "#4A2E2A", "onBrandHex": "#F2D7BC",
  "logos": {
    "LIGHT_GROUND": null,
    "DARK_GROUND": { "hash": "9f2c...e1", "contentType": "image/png", "width": 447, "height": 285 }
  }
}
```

`accent` is the preset's day colour or the custom colour; `accentNight` is its
night variant, worked out on the server by `nightVariant`, so the client does no
colour arithmetic on load. `nightVariant` raises lightness until the colour reads
at 4.5 to 1 on both night grounds, `#0F1715` and `#1A1310`; every preset's night
value is unchanged by the second ground. `wordmark` is already resolved to the
restaurant's name when unset. `logos` carries each slot's SHA-256 hash and
dimensions, or null for an empty slot, and never the image bytes: the client
fetches a logo from `GET /restaurant/logo/:slot` only when the hash differs from
the one it saved (M20 section P22).

### `settings.invoice` (added by P02)

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | String | `FINANCIAL_YEAR` | Enum `FINANCIAL_YEAR`, `PREFIX` |
| `prefix` | String or null | `null` | Used only in `PREFIX` mode. 1 to 7 characters: letters, digits, `/` and `-`. Like `CFA/C/`. |
| `startingNumber` | Number or null | `null` | Used only in `PREFIX` mode. The first number the series issues. Whole number, 1 to 999,999,999. |

| Mode | Example | Counter scope | Resets |
|---|---|---|---|
| `FINANCIAL_YEAR` | `2026-27/000148` | the financial year | Every 1 April. Unchanged from M3. |
| `PREFIX` | `CFA/C/22442` | `PREFIX:` followed by the prefix, for example `PREFIX:CFA/C/` | Never. It runs on across financial years. |

In `PREFIX` mode the number is not padded: `CFA/C/22442`, not `CFA/C/000022442`.

Why 7 characters and 9 digits: GST rules allow an invoice number of at most 16 characters, using only letters, numbers, `-` and `/`, unique within the financial year. 7 plus 9 is 16, so no number this series issues can break that rule.

---

### Setting groups added by P25

Each is read and written through `GET` and `PATCH /settings` like every group,
OWNER to change, every change audited as `SETTINGS_CHANGED`. Every field has a
schema default, so a restaurant saved before P25 reads back complete.

| Group and field | Type | Default | Meaning |
|---|---|---|---|
| `receipt.reviewLinkUrl` | String or null | null | An `https` address up to 300 characters. When set, every printed bill, thermal and full page, ends with a QR code for it and "Scan to review us". `http`, anything that is not a web address, and anything longer are 400. |
| `billing.captainsMayBill` | Boolean | true | M3 section 16.2 |
| `billing.captainsMayTakePayment` | Boolean | false | M3 section 16.2 |
| `cash.denominations` | List | India, M16 section 8.1 | Notes and coins to count. A PATCH replaces the list. |
| `payments.requireTerminalForLinkedMethods` | Boolean | true | M10 section 5.2 |
| `approvals.*` | Booleans | true | Added by P28, see the P28 section at the end of this file |
| `reports.onHoldTallyCode` | String or null | null | Up to 20 characters. The Tally code R9 prints on its On Hold row. Null prints "On Hold" with no code. Was the constant `P03` before P25. |

`GET /auth/me` gains `billing` (both fields) and `cash.denominations`, because
a captain and a cashier need them and cannot read `GET /settings`.

### Settings added by P29

OWNER to change, audited as `SETTINGS_CHANGED`, every field with a schema
default, so a restaurant saved before P29 reads back complete.

| Group and field | Type | Default | Meaning |
|---|---|---|---|
| `billing.reviseUnpaidBills` | Boolean | true | An unpaid bill is revised, not voided, when an item is removed or added (M3 section 16.8). Off: 16.4 and 16.7 exactly as before P29. |
| `billing.printBeforePayment` | Boolean | true | The bill screen asks for the print before the payment (M3 section 16.9). Read by the client only. |
| `approvals.revisePrintedBill` | Boolean | true | A CASHIER or WAITER removing an item from a bill already printed needs a manager's PIN (16.8.1); from P40 a CASHIER adding dishes to one does too (16.8.2) |
| `kitchen.readyMeansServed` | Boolean | true | The kitchen's ready serves the line, and the floor has no served step (M2 section 13). New group `kitchen`. |
| `cash.expenseCategories` | List | ten, M16 section 9.2 | `[{ code, label, isActive }]`, at most 30. `code` is 2 to 30 capital letters, digits or `_`, unique, and never changes once used; `label` 1 to 40 characters. `OTHER` is always present and active. A PATCH replaces the list. |
| `cash.usualFloatInPaise` | Number | 200000 | Whole paise, 0 to 10,00,000 rupees. What Day Close proposes to keep in the drawer for tomorrow (M16 section 9.4). |
| `cash.showDrawerTotalToStaff` | Boolean | false | Whether a MANAGER or CASHIER is shown the cash in the drawer and any difference in the cash book (M16 section 9.5). The OWNER always is. |

`GET /auth/me` gains, beside the groups it already returns:
`billing.reviseUnpaidBills`, `billing.printBeforePayment`,
`approvals.revisePrintedBill`, `kitchen: { readyMeansServed }`, and in `cash`
the active `expenseCategories` and `usualFloatInPaise`.
## 2. `GET /api/v1/settings`

Roles: `OWNER`, `MANAGER`.

No parameters. Returns the full settings object for the restaurant in the token, with every default filled in.

```json
{
  "success": true,
  "data": {
    "business": { "businessDayStartsAtMinutes": 300 },
    "tax": { "pricingMode": "EXCLUSIVE", "defaultTaxRateBps": 500, "roundOffEnabled": true },
    "receipt": {
      "headerLine1": null,
      "headerLine2": null,
      "footerText": "Thank you, visit again.",
      "showGstin": true,
      "showFssai": true,
      "showServerName": false
    },
    "inventory": { "lowStockAlertsEnabled": true },
    "features": { "inventory": true, "attendance": true },
    "invoice": { "mode": "FINANCIAL_YEAR", "prefix": null, "startingNumber": null },
    "delivery": { "platformCollectsGst": true },
    "discounts": { "cashierMayApplyPlatformDiscounts": false },
    "dayClose": { "showCashDifferenceToManager": false }
  }
}
```

A restaurant created before M7 has no `settings.tax` object in its document. This endpoint still returns the block above, filled from schema defaults. There is no migration and no seeding step.

## 3. `PATCH /api/v1/settings`

Roles: **`OWNER` only.**

Owner-only because this object contains the GST pricing mode, which is a legally significant choice, and the business day boundary, which silently moves which day every future sale lands on. Neither is a thing a manager should be able to change on a Tuesday afternoon.

Request. Every group optional, every field within a group optional, at least one field present overall. Send only what changes.

```json
{
  "tax": { "defaultTaxRateBps": 1800 },
  "receipt": { "footerText": "GST included. Thank you." }
}
```

Response 200 returns the full settings object, same shape as `GET`.

Failure 400 if the body is empty or contains an unknown group or an unknown field. **Reject unknown keys loudly rather than ignoring them.** A settings endpoint that silently drops a typo'd field name is how someone spends an hour wondering why their change did nothing.

### Every change is audited

Each field that actually changes value writes one `auditlogs` document.

```
action: "SETTINGS_CHANGED"
entityType: "SETTINGS"
entityId: the restaurantId
entityLabel: the dotted path, for example "tax.defaultTaxRateBps"
reason: from the request body, required
amountInPaise: null
details: { "field": "tax.defaultTaxRateBps", "previousValue": "500", "newValue": "1800" }
```

`reason` is a required string on the request body, 1 to 200 characters, and applies to the whole patch. Not defaulted to `""`. An owner changing the GST pricing mode with no recorded reason is exactly the kind of gap the audit log exists to close.

A field sent with a value identical to the stored one writes no audit line and is not an error.

### Feature switches and the invoice series (added by P02)

`features.inventory` and `features.attendance` must be booleans. Nothing else.

`invoice` is validated as a whole group. If any of its three fields is sent, all three must be sent, so the stored group is never half-changed.

| Rule | Error |
|---|---|
| Only some of `invoice.mode`, `invoice.prefix`, `invoice.startingNumber` sent | 400 `VALIDATION_FAILED` |
| `mode` is `FINANCIAL_YEAR` and `prefix` or `startingNumber` is not null | 400 `VALIDATION_FAILED` |
| `mode` is `PREFIX` and `prefix` or `startingNumber` is missing or null | 400 `VALIDATION_FAILED` |
| `prefix` is not 1 to 7 characters of letters, digits, `/` and `-` | 400 `VALIDATION_FAILED`, field message "An invoice prefix can use letters, numbers, / and -, up to 7 characters." |
| `startingNumber` is not a whole number from 1 to 999,999,999 | 400 `VALIDATION_FAILED` |

Three business rules protect the two unique indexes on `bills`, `{ restaurantId, billNumber }` and `{ restaurantId, branchId, financialYear, billSequence }`. Breaking either would make bill creation fail at the till. They read the database, so they run in the service, not the validator. Each is 422 with its own code.

| Rule | Code | Message |
|---|---|---|
| A prefix that has never issued a bill (no `PREFIX:<prefix>` counter above zero) must start above the highest `billSequence` on any bill of this restaurant in the current financial year, in any series. With no bills this year, any start from 1 is fine. | `INVOICE_START_TOO_LOW` | "The starting number must be above {highest}, the highest bill number already used this financial year." |
| A prefix that has issued bills cannot have its `startingNumber` changed, and cannot be switched back to after moving to another prefix. Sending the stored values back unchanged is not an error. | `INVOICE_SERIES_STARTED` | "{prefix} has already issued bills up to {prefix}{last}. Its starting number cannot change, and it cannot be started again." |
| Switching `mode` to `FINANCIAL_YEAR` while this restaurant has any bill in the current financial year whose `invoiceSeries` is a prefix. | `INVOICE_SERIES_LOCKED` | "Bills have already been issued under {prefix} this financial year. You can switch back on or after 1 April." |

Every change still writes one `SETTINGS_CHANGED` line per field that changed, for example `features.inventory` or `invoice.prefix`.

`auditlogs.action` gains `SETTINGS_CHANGED` and `entityType` gains `SETTINGS`. Both are additive to a closed enum, the same append-only discipline `errors.js` follows.

---

## 4. What is stored but deliberately not yet wired

Two settings are saved, validated, returned, and read by nothing.

`tax.pricingMode` and `tax.roundOffEnabled` both change M3's bill arithmetic. M3's tax code is frozen, tested to the paisa, and carries a documented per-slab rounding rule. Rewiring it from inside a settings module is how billing breaks quietly.

So M7 stores them and stops there. Wiring them into `server/utils/tax.js` is its own task, with its own tests, and must not run before a chartered accountant has confirmed which pricing mode the pilot restaurant actually uses. That question is already in the known problems table as decision D1's open risk.

The settings screen shows both fields with a short note saying they take effect once billing is updated. That is honest, and it is better than hiding a control an owner will ask about.

`settings.receipt.*` was consumed by nothing until P25. From P25 Part C the receipt and the full-page invoice both read it: see M3 section 16.1.

## 5. What is wired now

`tax.defaultTaxRateBps` — `POST /api/v1/menu-items` uses it as the default when `taxRateBps` is absent from the request body. The field stays required in the schema and required on the stored document; only the API's default changes. An explicitly sent rate always wins.

`inventory.lowStockAlertsEnabled` — when false, `GET /api/v1/reports/dashboard` returns an empty `lowStock` array and the inventory low-stock read returns an empty list. The data is unchanged; only the surfacing is switched off.

Both are one-line reads through `settingsService`. Neither changes stored data or frozen arithmetic.

`features.inventory` and `features.attendance` (P02) — read by the `requireFeature(name)` middleware, which runs after `authenticate` and `tenant` and before `requireRole`, so anyone reaching a switched-off feature is told it is switched off rather than that they lack the role. It throws 403 `FEATURE_DISABLED` with "Inventory is switched off for this restaurant. An owner can switch it on in Settings." (or "Attendance ..."). With inventory off, `kitchenService.fireOrder` skips `deductForFiredLines` and the line and order cancels skip `returnStockForCancelledLine`; firing and cancelling otherwise behave exactly as before. The dashboard keeps its shape: `lowStock` is `[]` when inventory is off and `staffOnShift` is `null` when attendance is off.

`invoice.*` (P02) — read by `createBill` inside its transaction and passed to `reserveBillNumber`. See section 14.1.

---

## 6. `settingsService`

`server/services/settingsService.js` is the only place any module reads settings from.

`getSettings(restaurantId)` returns the full object with defaults applied.

`getSetting(restaurantId, path)` returns one value by dotted path.

No controller reads `restaurant.settings` directly. Same discipline as no controller reading `process.env` and no controller touching `passwordHash`. When a setting moves or gains a default, one file changes.

Cache within a single request only, on `req`. Do not add a process-level cache with a time-to-live. A stale settings cache means an owner changes the business day boundary, sees nothing happen, changes it again, and now two servers disagree about which day a sale belongs to.

---

## Permission summary for M7

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| GET /settings | yes | yes | no | no | no | no |
| PATCH /settings | yes | no | no | no | no | no |

`PATCH /settings` also sets `features` and `invoice` (P02); its roles are unchanged. Inventory routes, attendance routes and the two reports keep their roles and are now also refused for everyone when the feature is off.

## Error codes added by P02

| Code | Status | When |
|---|---|---|
| `FEATURE_DISABLED` | 403 | The route belongs to a feature switched off in `settings.features` |
| `INVOICE_START_TOO_LOW` | 422 | A new prefix series would start at or below a sequence already used this financial year |
| `INVOICE_SERIES_STARTED` | 422 | A prefix that has issued bills would be restarted or returned to |
| `INVOICE_SERIES_LOCKED` | 422 | Switching back to financial-year numbering mid-year after prefix bills |

---

## Decisions made for M7

**No settings collection.** Settings live on `restaurants`, which already has a `settings` object and is already read on every authenticated request. A separate collection adds a lookup to gain nothing.

**No per-branch settings.** Version 1 is one branch per restaurant. A `branchId` on a settings document would be dead weight and a decision made without a customer.

**No settings history collection.** The audit log is the history.

**`businessDayStartsAtMinutes` stays at the top level of `settings`.** Nesting it for tidiness would break M3, M5 and M6 at once.

**The M5 open-shift threshold stays a constant.** Decision D5 made it one deliberately and M7 does not reopen it.

**Unknown keys in a PATCH are rejected, not ignored.**
# M8 Audit Trail

Owner: Rishi.

**M8 adds no collection.** `auditlogs` was built by M3. M8 does three things to it: makes it readable, makes it structurally append-only, and closes the coverage gaps where a trust-relevant action currently leaves no trace.

BUILD-PLAN section 7 calls the audit trail the feature that sells the product to an owner losing money to a dishonest cashier. Right now it is a write-only collection. An audit log nobody can read is not a feature, it is disk usage.

---

## Sequencing

M8 must be built **after M7 is merged.** Both append to `auditlogs.action` and `auditlogs.entityType`, in the same two lines of the same file. Run them in parallel and you get a conflict for no reason.

M8 also uses `businessDateRangeToUtc` from `server/utils/time.js`, which M6 introduces. If M6 has not merged, M8 writes that function itself, in that exact file with that exact signature, and the merge resolves cleanly. Section 9.2 covers this.

---

## 1. What currently writes an audit line

| Action | Entity | Written by |
|---|---|---|
| `BILL_VOIDED` | `BILL` | M3 |
| `DISCOUNT_APPLIED` | `BILL` | M3 |
| `STOCK_ADJUSTED` | `STOCK` | M4 |
| `ORDER_CANCELLED` | `ORDER` | M2, from P04 onwards. Listed before P04 but never written until then. |
| `SETTINGS_CHANGED` | `SETTINGS` | M7 |
| `LINE_CANCELLED_AFTER_PREP` | `ORDER` | M2, from P04. A line cancelled with `wasPrepared: true`. |
| `PAYMENT_METHOD_CORRECTED` | `BILL` | M10, from P08. A payment's method changed after the fact. |
| `NO_CHARGE_GIVEN` | `ORDER` | M16, from P08. Food given away free. |
| `BILL_CHARGED_TO_ACCOUNT` | `BILL` | M16, from P09. A sale whose money arrives later. |
| `ACCOUNT_BALANCE_ADJUSTED` | `ACCOUNT` | M16, from P09. Writing off or adding to what someone owes. |
| `PLATFORM_PAYOUT_RECORDED` | `PAYOUT` | M17, from P09. Platform money arriving. |
| `CASH_PAID_OUT` | `CASH` | M16, from P10. Cash leaving the drawer. |
| `DAY_CLOSED` | `DAY` | M16, from P10. The day is locked. |
| `DAY_REOPENED` | `DAY` | M16, from P10. A locked day was opened again. |

`entityType` gains `ACCOUNT`, `CASH`, `DAY` and `PAYOUT` (P07).

Checked against the code in P17: these fourteen actions are every action written today, and each is written only by the module named.

## 2. What M8 adds

Each of these is an action an owner would want to see and which today leaves nothing behind.

| Action | Entity | Written by | Why it matters |
|---|---|---|---|
| `USER_DEACTIVATED` | `USER` | M0-C | Someone removing a colleague's access |
| `USER_REACTIVATED` | `USER` | M0-C | Someone restoring an account that was switched off for a reason |
| `USER_ROLE_CHANGED` | `USER` | M0-C | A manager promoting an accomplice to a role that can void bills |
| `USER_PASSWORD_RESET` | `USER` | M0-C, and P34 from the sign-in screen with the approver as actor and `details.source: "SIGN_IN_SCREEN"` | A manager resetting someone's password is a way to use their account |
| `USER_PIN_RESET` | `USER` | M0-D | Same, for the attendance clock |
| `MENU_PRICE_CHANGED` | `MENU_ITEM` | M1 | A price quietly moved before or after a shift |
| `RECIPE_CHANGED` | `RECIPE` | M4 | Changing a recipe changes how much stock a sale deducts. It is the cleanest way to hide theft in this system. |

`entityType` gains `USER`, `MENU_ITEM`, `RECIPE`.

`MENU_PRICE_CHANGED` fires only when `priceInPaise`, a variant's `priceInPaise`, an add-on's `priceInPaise`, or `taxRateBps` changes. Renaming a dish or editing its description writes nothing. An audit log that records every keystroke is one nobody reads.

`RECIPE_CHANGED` fires on any change to `items[]`: an ingredient added, removed, or its `qtyInBase` altered.

Added by P22, OWNER only to read like every action outside the manager list:

| Action | Entity | Written by | Why it matters |
|---|---|---|---|
| `BRAND_LOGO_SET` | `SETTINGS` | M20, from P22 | The restaurant's logo changed. `details` carries the slot, hash, size, dimensions and type, never the bytes. |
| `BRAND_LOGO_REMOVED` | `SETTINGS` | M20, from P22 | The restaurant's logo was removed. The same `details`, of the file removed. |

Added by P25, OWNER only to read like every action outside the manager list:

| Action | Entity | Written by | Why it matters |
|---|---|---|---|
| `BILL_LINES_CANCELLED_AFTER_BILLING` | `BILL` | M3, from P25 Part E | A paid bill was voided and re-issued smaller. `details` carry both bill numbers, the lines, the approver, the cash given back and the refunds owed. |
| `REFUND_RECORDED` | `BILL` | M3, from P25 Part E | Money owed back to a guest was returned outside the system, with its reference |
| `BILL_REOPENED` | `BILL` | M3, from P26 | A bill voided so the table could order more. `details` carry the approver and what was already paid, which the next bill carries. |
| `TERMINAL_BYPASSED` | `BILL` | M10, from P25 Part I | A card-machine method recorded by hand, with the reason |
| `INTEGRATION_CONNECTED` | `INTEGRATION` | M21, from P25 Part G | A partner connection saved for the first time |
| `INTEGRATION_CREDENTIALS_CHANGED` | `INTEGRATION` | M21 | A partner credential replaced. `details` carry the field names, never the values. |
| `INTEGRATION_PAUSED`, `INTEGRATION_RESUMED` | `INTEGRATION` | M21 | A connection stopped or started |
| `PLATFORM_ORDER_REJECTED` | `PLATFORM_ORDER` | M21, from P25 Part H | A platform order turned away, with the reason |
| `TALLY_EXPORT_POSTED` | `TALLY_EXPORT` | M21, from P25 Part J | A day's vouchers reached Tally |
| `TALLY_EXPORT_REDONE` | `TALLY_EXPORT` | M21 | A day exported again after the owner confirmed deleting the old vouchers in Tally |
| `TALLY_BRIDGE_PAIRED`, `TALLY_BRIDGE_REVOKED` | `INTEGRATION` | M21, from P25 Part K | A computer given, or refused, the right to post into Tally |

`entityType` gains `INTEGRATION`, `PLATFORM_ORDER` and `TALLY_EXPORT`.

Added by P29:

| Action | Entity | Written by | MANAGER may read | Why it matters |
|---|---|---|---|---|
| `BILL_REVISED` | `BILL` | M3, P29 Part B | Yes | An unpaid bill's items changed under the same number. `details` carry the kind, the revision, the lines, the totals before and after, whether it was printed, and the approver. A cut after printing is where till fraud hides. |
| `KITCHEN_READY_UNDONE` | `ORDER` | M2, P29 Part E | Yes | A dish ticked ready by mistake, ticked back. Not an alert, but a fact worth keeping. |
| `KOT_SEND_UNDONE` | `ORDER` | M2, P41 | Yes | A Send to kitchen taken back within 60 seconds, before anything was ready. `details` carry the lines, the item names, the tickets and the table. |
| `CASH_TAKEN_OUT` | `CASH` | M16, P29 Part F | No | Cash removed from the drawer that is not an expense: a bank deposit, or cash given to the owner |
| `OPENING_FLOAT_DIFFERED` | `CASH` | M16, P29 Part F | No | The float counted in the morning was not what was kept in the drawer the night before. `details` carry both amounts. |

Reason codes added by P25, appended to the existing lists, server and client:

| List | Code | Label |
|---|---|---|
| `LINE_CANCEL_REASONS`, `ORDER_CANCEL_REASONS`, `BILL_VOID_REASONS` | `PLATFORM_CANCELLED` | Cancelled by the platform |
| `platformRejectReasons.js` (new) | `ITEM_OUT_OF_STOCK`, `KITCHEN_BUSY`, `STORE_CLOSING`, `OTHER` | Item out of stock, Kitchen too busy, Closing soon, Other (note required) |
## 3. What deliberately does not write an audit line

Normal operation. Taking an order, firing a KOT, marking a dish ready, recording a payment, clocking in. These are the job, not exceptions to it, and burying seven real events in forty thousand routine ones defeats the collection.

Creating a user, creating a menu item, creating an ingredient. Creation is visible in the record itself, with `createdAt` and a creator. It is the later quiet change that needs a trail.

Attendance corrections. See section 6.

---

## 4. `GET /api/v1/audit`

Roles: `OWNER` full access. `MANAGER` restricted, see below.

Query parameters, all optional except the range.

| Parameter | Notes |
|---|---|
| `from`, `to` | `"YYYY-MM-DD"` business dates. Both required. Max 366 days. |
| `action` | One of the enum values, or a comma-separated list |
| `entityType` | One of the enum values |
| `actorId` | Filter to one person |
| `page`, `limit` | Default 50, max 200 |

Sorted by `at` descending. Newest first, because the question is almost always "what happened recently".

```json
{
  "success": true,
  "data": [
    {
      "id": "669a...",
      "action": "BILL_VOIDED",
      "entityType": "BILL",
      "entityId": "668a...",
      "entityLabel": "2026-27/000148",
      "actorId": "664f...",
      "actorName": "Kaival",
      "actorRole": "CASHIER",
      "at": "2026-08-29T15:04:00.000Z",
      "reason": "Wrong table",
      "amountInPaise": 68400,
      "details": {},
      "source": "AUDIT_LOG"
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 213 }
}
```

`actorName` is resolved at read time from `users`, not stored. `actorRole` **is** stored, snapshotted at the time of the action, because roles change and the question is what they were allowed to do then.

If the actor's user record has since been deactivated, `actorName` still resolves. Nothing is hard deleted, so the name is always there.

`source` is either `AUDIT_LOG` or `ATTENDANCE_CORRECTION`. See section 6.

### The manager restriction

A `MANAGER` sees only entries whose action is `ORDER_CANCELLED`, `STOCK_ADJUSTED` or `LINE_CANCELLED_AFTER_PREP`. Everything else returns nothing for them.

The reason is plain: this collection exists to catch an insider, and a manager is an insider. A manager who can read the log knows exactly which of their actions were recorded. But a manager investigating a stock discrepancy or a run of cancelled orders is doing their job, so those stay open.

P17 applied the same rule to every action added since the rule was written. An owner watches what managers approve, so a manager does not read the trail of discounts, voids, No Charge, payment corrections, account charges and adjustments, payouts, cash paid out, Day Close and reopening, settings, or staff and menu changes. Food made and thrown away is the kitchen's and the captains' waste, which a manager runs, so `LINE_CANCELLED_AFTER_PREP` is open to them:

| Action | MANAGER may see it |
|---|---|
| `ORDER_CANCELLED`, `STOCK_ADJUSTED` | Yes, as first specified |
| `LINE_CANCELLED_AFTER_PREP` | Yes, from P17 |
| Every other action, and `ATTENDANCE_CORRECTED` | No. OWNER only. |

The filter is applied server-side by injecting it into the query, not by post-filtering the results. A post-filter leaks the true `total` in the pagination block.

## 5. `GET /api/v1/audit/entity/:entityType/:entityId`

Roles: `OWNER` full. `MANAGER` restricted the same way as section 4.

Everything that ever happened to one record, oldest first, so it reads as a history.

No date range, no pagination. One bill has a handful of audit lines, not thousands.

404 if the entity belongs to another restaurant. Never 403.

## 6. Attendance corrections are merged at read time, not copied

M5 embedded its correction trail on the attendance entry as `corrections[]`, decision D3. M3 revisited it and left it there, on the grounds that rewriting live attendance data to move an audit trail gains nothing and risks the one record that exists to be trustworthy.

M8 agrees and does not copy them either. It merges them at read time.

When `GET /audit` runs with no `entityType` filter, or with `entityType=ATTENDANCE`, it also queries `attendanceentries.corrections[]` across the range and maps each one into the same response shape:

```
action        ATTENDANCE_CORRECTED
entityType    ATTENDANCE
entityId      the attendance entry id
entityLabel   the staff member's name plus the business date
actorId       corrections[].correctedBy
actorRole     resolved from users at read time, since M5 did not snapshot it
at            corrections[].correctedAt
reason        corrections[].reason
amountInPaise null
details       { field, previousValue, newValue }
source        ATTENDANCE_CORRECTION
```

`entityType` gains `ATTENDANCE` and `action` gains `ATTENDANCE_CORRECTED` **as read-time values only.** Nothing ever writes them to the `auditlogs` collection. Document this in the model file, because a future reader will otherwise see the enum values and assume something writes them.

`actorRole` on a merged correction is the actor's role **now**, not at the time, because M5 did not snapshot it. Mark this in the response with `actorRoleIsCurrent: true` on merged entries only. Do not silently present a current role as a historical one.

This is `OWNER` only. A manager does not read attendance corrections, because correcting attendance is a manager's own action.

## 7. `GET /api/v1/audit/summary?from=&to=`

Roles: **`OWNER` only.**

This is the report that sells the product.

```json
{
  "success": true,
  "data": {
    "from": "2026-08-01",
    "to": "2026-08-31",
    "byAction": [
      { "action": "BILL_VOIDED", "count": 34, "amountInPaise": 284000 },
      { "action": "DISCOUNT_APPLIED", "count": 184, "amountInPaise": 3200000 }
    ],
    "byActor": [
      {
        "actorId": "664f...",
        "actorName": "Kaival",
        "actorRole": "CASHIER",
        "totalCount": 41,
        "voidCount": 28,
        "voidAmountInPaise": 231000,
        "discountCount": 13,
        "discountAmountInPaise": 84000
      }
    ],
    "totalEventCount": 267
  }
}
```

P17 adds three figures to each `byActor` entry, in the same style: `noChargeCount` and `noChargeAmountInPaise`, the No Charge orders the person approved and their value before GST; and `paymentCorrectionCount`, the payment methods they changed after the fact. `discountCount` and `discountAmountInPaise` are the discounts they applied. Each comes from the `amountInPaise` the audit line froze. OWNER only, as the summary already is.

`byAction` and `totalEventCount` include merged attendance corrections when the attendance feature is on; `byActor` never does.

`byActor` is sorted by `voidAmountInPaise` descending. The person voiding the most money appears first, which is the whole point.

An owner looking at this sees one cashier who voided twenty-eight bills when everyone else voided two. That is a conversation they cannot currently have, and it is the single most concrete thing in the sales pitch.

`byActor` excludes attendance corrections. Mixing a manager's legitimate timesheet fixes into a money-and-trust ranking makes the ranking useless.

---

## 8. Append-only, enforced structurally

`auditlogs` is append-only by convention today. M8 makes it append-only by construction.

A Mongoose plugin, `appendOnlyGuard`, attaches `pre` hooks to `findOneAndUpdate`, `updateOne`, `updateMany`, `findOneAndDelete`, `deleteOne`, `deleteMany`, and `save` on an existing document. Each throws `AuditLogImmutableError`.

Same spirit as `tenantGuard`: turn the worst possible mistake from a silent data problem into a loud crash on a developer's machine.

There is no escape hatch. `tenantGuard` needed one because three legitimate lookups run before tenant context exists. Nothing legitimately updates an audit line. If a line is wrong, the truth is that a wrong line was written, and the fix is a new line saying so.

**No TTL index.** `refreshtokens` has one because expired session state has no audit value. This collection is the audit value. A few thousand rows a month is nothing, and the moment an owner most needs the log is the moment someone would most want it gone.

---

## Permission summary for M8

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| GET /audit | yes, all | yes, ORDER_CANCELLED, STOCK_ADJUSTED and LINE_CANCELLED_AFTER_PREP only | no | no | no | no |
| GET /audit/entity/:type/:id | yes, all | same restriction | no | no | no | no |
| GET /audit/summary | yes | no | no | no | no | no |

---

## Decisions made for M8

**Manager access is restricted to three actions** (two until P17). The collection exists to catch insiders and a manager is one. Operational investigation stays open; trust and money do not.

**Attendance corrections are merged at read time, never copied.** Two shapes, one feed, no data rewritten. Third module to reach this conclusion; it is settled.

**Creation events are not audited.** Only later quiet changes.

**Renaming a dish is not audited. Changing its price is.**

**Recipe changes are audited**, because a recipe change is the cleanest way to hide stock theft in this system and nothing currently records it.

**No retention limit, no TTL, no archival.**

**No hash chain or cryptographic tamper evidence.** The append-only guard plus no update path is proportionate at this scale. Revisit if a customer ever asks a question this cannot answer.

**No CSV export.** Same call as M6. A day of work whenever someone asks.

## Settled while building M8 (P17)

1. A `USER` line stores no name. Its `entityLabel` is null in the collection and is the staff member's current name in the response, resolved at read time like `actorName`, so a log never carries a name written into it. `details` carries roles only.
2. `MENU_PRICE_CHANGED` carries `details.changes`, each `{ field, from, to }`, where `field` is `priceInPaise`, `taxRateBps`, `variant:{id}` or `addOn:{id}`. A size or extra added or removed counts. `amountInPaise` is the new base price when it changed.
3. `RECIPE_CHANGED` is written when a saved recipe's ingredients or quantities differ from before, and when a recipe is deleted (`details.deleted: true`). Saving the same items again writes nothing.
4. `GET /audit/entity/...` is 404 when this restaurant has no line for the record at all. A MANAGER asking for a record whose every line is outside their actions gets `[]`, not a 404: the record is theirs to know exists.
5. An attendance correction keeps its own subdocument id as `id`. A MANAGER never sees one, in the feed or in an entity's history.
6. The guard is `appendOnlyGuardPlugin` in `server/models/plugins/appendOnlyGuard.js`, and the error `AuditLogImmutableError`, a 500.

---

# M20 Floor Plan

Owner: Arya. P19 builds the floor plan; P20 the look.

Nothing of its own: M20's floor plan is three additions to M2 and M7.

1. `layout` on each table and `PATCH /tables/layout`: M2 section 11.5.
2. The extended occupancy block on `GET /tables`, with the four floor states
   Free, Open, Served and Bill printed, and the long-running marker: M2 section
   11.2.
3. `settings.floor` (section order, long-open minutes, the guest count rule):
   M7, and the rule itself in M2 section 12.1.

## P22. The restaurant's logo

Added by P22. The tone and brand colours are fields of `settings.appearance`
(M7 section 1). The logo is not: an image does not belong in a settings object,
so it never travels with `GET /settings` and never lands in a `SETTINGS_CHANGED`
line. It is stored on the restaurant, `restaurants.brandLogos` (DB-SCHEMA
section 1).

### Slots

| Slot | Artwork | Shown on |
|---|---|---|
| `LIGHT_GROUND` | Dark artwork on a transparent background | Day screens |
| `DARK_GROUND` | Light artwork, transparent or on its own solid background | Night screens and the sign-in brand panel |

Both optional. When a screen's ground has no matching logo, the client shows the
other one on a plate: a `DARK_GROUND` logo sits on a `brand` plate, 8px radius.

### The file

Accepted only when every check below passes on the decoded bytes. The file
name, a data URL prefix and anything the client says about the type are never
read.

1. PNG, WebP or JPEG, recognised by the file signature: `89 50 4E 47 0D 0A 1A 0A`
   for PNG, `RIFF....WEBP` for WebP, `FF D8 FF` for JPEG.
2. Width and height read from the image header: PNG `IHDR`, WebP `VP8 `,
   `VP8L` or `VP8X`, JPEG the first start-of-frame marker. No image library.
3. At most 200 KB (204,800 bytes).
4. At most 1024 pixels on the longest side, at least 128 on the shortest.
5. SVG is refused, always. An SVG can carry script, and refusing it is safer
   than cleaning it. A vector from the owner is converted to PNG before upload.

A failure is 400 `VALIDATION_FAILED` with `fields.image` saying what is wrong in
plain words: "This is an SVG. Upload a PNG, WebP or JPEG instead.", "This file is
not a PNG, WebP or JPEG image.", "This image is 240 KB. The largest allowed is
200 KB.", "This image is 2048 pixels wide. The largest allowed is 1024.", "This
image is 96 pixels tall. The smallest allowed is 128."

### `PUT /api/v1/settings/appearance/logo/:slot`

Roles: OWNER. Checked on the server. `:slot` is `LIGHT_GROUND` or `DARK_GROUND`;
anything else is 400.

`PUT`, not `PATCH`, because the request replaces the whole slot, the same reason
`PUT /recipes` is a `PUT`. CONVENTIONS section 3 otherwise says `PATCH`.

```json
{ "reason": "Cafezza's logo", "image": "iVBORw0KGgoAAAANSUhEUgAA..." }
```

`image` is the file as base64, with no `data:` prefix (one is stripped and
ignored if sent). `reason` 1 to 200 characters, required, the same limit as `PATCH /settings`.

The JSON body limit on this route alone is 300 KB, enough for 200 KB as base64.
Every other route keeps 100 KB.

200 with the slot as `/auth/me` gives it: `{ "slot": "DARK_GROUND", "hash", "contentType", "width", "height", "sizeBytes", "setAt" }`.
Uploading a file identical to the stored one (the same hash) changes nothing and
writes no audit line.

Writes `BRAND_LOGO_SET`, entity `SETTINGS`, entity id the `restaurantId`,
`entityLabel` the slot, the reason, and `details: { slot, hash, sizeBytes,
width, height, contentType }`. Never the bytes. The slot and its audit line
commit together.

### `DELETE /api/v1/settings/appearance/logo/:slot`

Roles: OWNER. Body `{ "reason": "..." }`, required. An empty slot is 404
`NOT_FOUND`. 200 with `{ "slot": "DARK_GROUND", "removed": true }`.

Writes `BRAND_LOGO_REMOVED`, with the removed file's `details` as above. The
slot is cleared, not kept: a logo is configuration, not a record of something
that happened, the same reasoning as `DELETE /recipes/:recipeId`. The audit line
keeps its hash, size and dimensions.

### `GET /api/v1/restaurant/logo/:slot`

Roles: all six. The caller's own restaurant, from the token; there is no
restaurant in the path. Returns the image bytes with:

| Header | Value |
|---|---|
| `Content-Type` | the stored type, `image/png`, `image/webp` or `image/jpeg` |
| `ETag` | `"<sha256 hex>"` |
| `Cache-Control` | `private, max-age=0, must-revalidate` |
| `X-Content-Type-Options` | `nosniff`, from helmet |

`If-None-Match` with the current hash is 304. An empty slot is 404 `NOT_FOUND`
in the JSON envelope. Another restaurant's logo cannot be asked for, and so is
always 404, never 403.

### Permission summary

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| `PUT /settings/appearance/logo/:slot` | yes | 403 | 403 | 403 | 403 | 403 |
| `DELETE /settings/appearance/logo/:slot` | yes | 403 | 403 | 403 | 403 | 403 |
| `GET /restaurant/logo/:slot` | yes | yes | yes | yes | yes | yes |

---

# M18 Kitchen Stations

Owner: Arya. Built in P05.

A station is a place a KOT goes: "Live Kitchen", "Beverages". Categories are
routed to stations, so firing an order makes one KOT per station and the coffee
bar never reads the kitchen's ticket. Printing, of KOTs and bills, happens from
the browser on a device in the cafe. The server never talks to a printer.

## 1. Station endpoints

### 1.1 List stations

```
GET /api/v1/stations?includeInactive=false
```

Roles: all six. Active stations by `displayOrder`. `includeInactive=true` is
for OWNER and MANAGER only; any other role sending it is 403.

```json
{
  "success": true,
  "data": [
    { "id": "6540...", "name": "Live Kitchen", "displayOrder": 0, "printsTickets": false, "isActive": true },
    { "id": "6541...", "name": "Beverages", "displayOrder": 1, "printsTickets": true, "isActive": true }
  ]
}
```

Not paginated: a restaurant has a handful of stations.

### 1.2 Create a station

```
POST /api/v1/stations
```

Roles: OWNER, MANAGER.

```json
{ "name": "Beverages", "displayOrder": 1, "printsTickets": true }
```

`name` 1 to 40 characters, trimmed. `displayOrder` integer 0 or more, default 0.
`printsTickets` boolean, default false.

201 with the station. 409 `DUPLICATE` on a name already used in this branch,
compared case-insensitively. 400 on anything else.

### 1.3 Update a station

```
PATCH /api/v1/stations/:stationId
```

Roles: OWNER, MANAGER. Any of `name`, `displayOrder`, `printsTickets`,
`targetMinutes`, `isActive`, at least one.

P20A: every station carries `targetMinutes`, an integer 5 to 120, default 15,
settable on create and update. A kitchen ticket's time edge measures against its
station's target; a ticket older than it is shown as late.

Deactivating a station that categories still point at is allowed. Those
categories fall back to the default station. The response carries
`meta.categoriesFallingBack`, the number of categories that now route to the
default station because of this station, so the manager knows to fix them.

404 for another restaurant's station. 409 `DUPLICATE` on a name clash.

## 2. Routing when an order fires

In `fireOrder`:

1. Load the restaurant's active stations, by `displayOrder`.
2. No active stations: one KOT with `stationId: null`, exactly as before P05.
3. Otherwise, for each line being fired, find its station through the
   category's **current** `stationId`, using the line's frozen `categoryId`.
4. A line whose category has no station, whose category is missing, or whose
   station is inactive, goes to the default station: the first active station
   by `displayOrder`.
5. One KOT per station that has lines, each with its own `kotNumber`, and its
   own frozen `stationId` and `stationName`. KOTs are created in station order,
   so their numbers follow it.
6. Each order line's `kotId` points at the KOT it actually went on. The same
   transaction, the same order update, and the same stock deduction as before.

## 3. KOT changes

`GET /api/v1/kots` takes an optional `stationId`: a station id, or `none` for
tickets with no station. Every ticket carries `stationId` and `stationName`.

### 3.1 The ticket text

```
GET /api/v1/kots/:kotId/ticket?width=32&reprint=false
```

Roles: all six. `width` is 32 (58mm) or 48 (80mm), default 32, anything else is
400. `reprint=true` adds a REPRINT line.

```json
{ "success": true, "data": { "width": 48, "text": "..." } }
```

Laid out on the server, like the receipt in section 15, for the same reason: one
layout can be snapshot tested. Top to bottom:

1. The station name in capitals, centred. `KITCHEN` when there is no station.
2. `KOT {kotNumber}` and the time fired, India time, 12-hour.
3. Dine-in: the table name and the guest count. Takeaway: `TAKEAWAY`.
   Delivery (P06): `DELIVERY  {PLATFORM} {platformOrderId}`, and the customer
   name below it when there is one.
4. `By {name}`: who fired it.
5. A rule line.
6. Each line: quantity and item name; the variant on its own indented line; each
   add-on on its own indented line starting with `+`; the note on its own
   indented line starting with `Note:`.
7. A rule line, and `REPRINT` when asked for.

No prices, anywhere. A long name wraps onto an indented continuation line and is
never cut off.

## 4. Category and user changes

`PATCH /api/v1/categories/:categoryId` accepts `stationId`: an active station of
this restaurant, or `null`. Another restaurant's station or an inactive one is
422 `BUSINESS_RULE_VIOLATED`.

`POST /api/v1/users` and `PATCH /api/v1/users/:userId` accept `stationId` for
`KITCHEN` users: an active station of this restaurant, or `null`. Sending a
station for any other role is 400 `VALIDATION_FAILED`. A user changed away from
`KITCHEN` has its station cleared. `GET /auth/me` and every user response carry
`stationId`.

## 5. Printing, on the client

One small piece of printing code writes plain text into a hidden iframe as a
`<pre>` sized for 58mm or 80mm paper and calls `print()` on that iframe only.
With Chrome started with `--kiosk-printing` (DEPLOYMENT.md section 10) it prints
with no dialog.

Paper width and KOT auto-print belong to the device, not the user: they are kept
in the browser's `localStorage`. The kitchen screen can print every new ticket
once, remembering the last 500 printed KOT ids on the device.

## Permission summary for M18

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| GET /stations | yes | yes | yes | yes | yes | yes |
| GET /stations?includeInactive=true | yes | yes | no | no | no | no |
| POST /stations | yes | yes | no | no | no | no |
| PATCH /stations/:id | yes | yes | no | no | no | no |
| GET /kots/:id/ticket | yes | yes | yes | yes | yes | yes |

---

# M17 Delivery and Platform Orders

Owner: Arya. Delivery orders built in P06. Payouts are designed in P07 and
built in P09.

Zomato and Swiggy orders are typed in by hand at the counter. No platform API.

## 1. The platform list

`server/config/platforms.js`, a frozen list, mirrored codes and names only in
`client/src/features/orders/platforms.js`:

| Code | Name | Order type |
|---|---|---|
| `ZOMATO` | Zomato | `DELIVERY` |
| `SWIGGY` | Swiggy | `DELIVERY` |

Zomato Gold, Dineout and EazyDiner are not on this list. Those guests sit at a
table, so the order is `DINE_IN`, and only the payment goes through the app.
They are payment methods (M10).

## 2. Creating a delivery order

`POST /api/v1/orders` with `orderType: "DELIVERY"`. Roles: the four that open
orders today.

| Rule | Error |
|---|---|
| `DELIVERY` without `platform` | 400 `VALIDATION_FAILED` |
| `platform.code` not on the list | 400, the field message lists the allowed codes |
| `platform.orderId` missing, or not 3 to 40 letters and digits | 400 |
| `DELIVERY` with a `tableId` or a `guestCount` | 400. A delivery order has no table and no guests. |
| The same platform order number already on a live order | 409 `DUPLICATE`, "Swiggy order 249377796192385 is already entered as order {orderNumber}." |

`customerName` and `customerPhone` stay optional. A delivery order never
occupies a table. `platform` and `platform` alone are refused on `DINE_IN` and
`TAKEAWAY` orders.

Response 201 is the order, with `platform: { code, name, orderId }` and
`taxTreatment`.

## 3. Tax treatment

When a `DELIVERY` order is created with a listed platform and
`settings.delivery.platformCollectsGst` is true, `taxTreatment` is
`PLATFORM_COLLECTS`. Every other order is `NORMAL`. It is set once and never
changed, so changing the setting later moves no existing order.

On a `PLATFORM_COLLECTS` order, every line is frozen at `taxRateBps: 0` when it
is added, and `menuTaxRateBps` keeps the item's own rate. `computeBillTotals`
and `allocateLineShares` are untouched: they see 0% lines and produce a 0% slab.
The rate is never decided at bill time.

## 4. Billing

`createBill` copies `platform` and `taxTreatment` onto the bill. Nothing else in
billing changes. Discounts and payments work on delivery bills as on any other
bill, until M10 restricts the payment method.

## 5. The KOT ticket

For a delivery order, the ticket's destination line reads
`DELIVERY  SWIGGY 249377796192385`, with the customer name below it when there
is one, and no table.

## Permission summary for M17 (P06)

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /orders with `DELIVERY` | yes | yes | yes | yes | no | no |
| PATCH /settings `delivery` | yes | no | no | no | no | no |

## 6. Platform payouts (P07, built in P09)

Platforms pay out in batches, usually weekly, covering a range of business
dates. Stored in `platformpayouts`, DB-SCHEMA section 23.

### 6.1 List payouts

```
GET /api/v1/platform-payouts?method=SWIGGY&from=2026-09-01&to=2026-09-30
```

Roles: OWNER, MANAGER. All filters optional; `from` and `to` select payouts whose
period overlaps that range. Newest first. Each payout comes with its expected
figure and the difference:

```json
{
  "id": "6550...", "method": "SWIGGY", "methodName": "Swiggy",
  "periodFrom": "2026-09-26", "periodTo": "2026-09-26",
  "amountReceivedInPaise": 74400, "receivedOn": "2026-10-02", "reference": "UTR123",
  "expectedInPaise": 74400, "differenceInPaise": 0,
  "includedPaymentCount": 1, "rateNotSet": [],
  "isVoided": false
}
```

### 6.2 Record a payout

```
POST /api/v1/platform-payouts
```

Roles: OWNER, MANAGER.

```json
{ "method": "SWIGGY", "periodFrom": "2026-09-26", "periodTo": "2026-09-26",
  "amountReceivedInPaise": 74400, "receivedOn": "2026-10-02", "reference": "UTR123", "note": null }
```

`method` must be an active `PLATFORM` method: 422
`PAYMENT_METHOD_NOT_ALLOWED` otherwise. `periodFrom` not after `periodTo`: 400.
A live payout for the same method already covering any date in the period: 409
`PAYOUT_PERIOD_OVERLAP`. Writes `PLATFORM_PAYOUT_RECORDED`, entity `PAYOUT`,
with the amount received. Refused with 409 `DAY_CLOSED` when today's business
date is closed.

### 6.3 Void a payout

```
POST /api/v1/platform-payouts/:payoutId/void
```

Roles: OWNER. Body `{ reason }`, 1 to 200 characters. The record is kept, marked
voided, and stops counting for the overlap rule.

### 6.4 Expected payout

For one payout: every payment with that method code whose own `businessDate` is
inside the period, on a bill that is not voided. Each payment's expected payout
is its amount times `(10000 − commissionBps)` basis points, through
`applyBasisPoints`, which rounds half away from zero. The batch's expected payout
is the sum of those per-payment figures. Payments whose frozen `commissionBps` is
null are listed under `rateNotSet` and left out of the expected figure. Nothing
is invented, and a live rate is never read.

### Permission summary for payouts

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| GET /platform-payouts | yes | yes | no | no | no | no |
| POST /platform-payouts | yes | yes | no | no | no | no |
| POST /platform-payouts/:id/void | yes | no | no | no | no | no |

---

# M10 Payments

Owner: Rishi. Specified in P07, built in P08. Pulled forward for Caffeza with an
adjusted scope: configurable payment methods including platforms. No gateway,
no UPI QR, no money movement. We record how a bill was settled.

## 1. Payment methods

Stored in `paymentmethods`, DB-SCHEMA section 20. Every restaurant always has the
built-in `CASH`, `CARD`, `UPI` (active) and `OTHER` (inactive), created if
missing, before a method is listed or a payment taken, and at provisioning.

### 1.1 List

```
GET /api/v1/payment-methods?includeInactive=false
```

Roles: all six. Active methods by `displayOrder`. `includeInactive=true` for
OWNER and MANAGER only, 403 otherwise.

```json
{ "success": true, "data": [
  { "id": "6560...", "code": "CASH", "name": "Cash", "kind": "IN_HAND", "orderTypes": ["DINE_IN","TAKEAWAY","DELIVERY"],
    "platformCode": null, "tallyLedgerCode": "P01", "commissionBps": null, "displayOrder": 0, "isActive": true },
  { "id": "6561...", "code": "SWIGGY", "name": "Swiggy", "kind": "PLATFORM", "orderTypes": ["DELIVERY"],
    "platformCode": "SWIGGY", "tallyLedgerCode": "868", "commissionBps": 2000, "displayOrder": 7, "isActive": true }
] }
```

### 1.2 Create

```
POST /api/v1/payment-methods
```

Roles: OWNER. Body: `code`, `name`, `kind` required; `orderTypes`,
`platformCode`, `tallyLedgerCode`, `commissionBps`, `displayOrder` optional.

| Rule | Error |
|---|---|
| `code` not 2 to 20 of capital letters, digits and `_` starting with a letter | 400 |
| `kind` not `IN_HAND` or `PLATFORM` | 400 |
| `orderTypes` empty or with an unknown type | 400 |
| `platformCode` not on the platform list | 400 |
| `commissionBps` on an `IN_HAND` method, or outside 0 to 10000 | 400 |
| `code` already used in this restaurant | 409 `DUPLICATE` |

### 1.3 Update

```
PATCH /api/v1/payment-methods/:methodId
```

Roles: OWNER. Any of `name`, `orderTypes`, `platformCode`, `tallyLedgerCode`,
`commissionBps`, `displayOrder`, `isActive`. `code` and `kind` are refused with
400: they never change after creation. A commission change affects only payments
taken after it, because each payment freezes its own rate.

## 2. Taking a payment

`POST /api/v1/bills/:billId/payments` keeps its shape. `method` holds a method
code. Each rule is 422 `PAYMENT_METHOD_NOT_ALLOWED` with a message naming the
reason:

1. The code is an active method of this restaurant.
2. The method's `orderTypes` include the bill's order type.
3. On a delivery bill with a platform, only the method whose `platformCode`
   matches that platform. A Swiggy order is paid by the Swiggy method only.
4. A method with a `platformCode` is used only on delivery bills from that
   platform.

Each payment freezes `methodName`, `methodKind`, `tallyLedgerCode`,
`commissionBps` (null for `IN_HAND`), and `businessDate`, from `receivedAt` by
`businessDateFor`. Old payments have null frozen fields: readers treat a null
`methodKind` as `IN_HAND` and a null `businessDate` as the bill's.

A `method` that is not 2 to 20 capital letters, digits and `_` is a 400. A
well-formed code the restaurant does not have is rule 1, a 422 (P08).

A bill that is `ON_ACCOUNT` takes no payment: 422 `BUSINESS_RULE_VIOLATED`.
Refused with 409 `DAY_CLOSED` when the bill's business date, or today's, is
closed (P10).

## 3. Correcting a payment's method

```
POST /api/v1/bills/:billId/payments/:paymentId/correct
```

Roles: OWNER, MANAGER. Body `{ method, reason }`, `reason` 1 to 200 characters.

Only the method changes, never the amount; to change an amount, void and bill
again. The new method must pass every rule in section 2. The payment gains a
`corrections` entry `{ fromMethod, toMethod, by, at, reason }`, and its frozen
method fields are replaced with the new method's; its `businessDate` stays.

Writes `PAYMENT_METHOD_CORRECTED`, entity `BILL`, with the payment amount and
`details: { paymentId, fromMethod, toMethod }`.

Refused with 409 `DAY_CLOSED` when the payment's business date or the bill's is
closed (P10). 404 for an unknown payment id. Correcting to the same method is 422.

## 4. Discount reasons

`POST /api/v1/bills/:billId/discount` changes the way cancels did in P04:

```json
{ "kind": "FLAT", "valueInPaise": 7307, "reasonCode": "ZOMATO_GOLD", "note": null, "fundedBy": "PLATFORM" }
```

`server/config/discountReasons.js`, mirrored on the client:

| Code | Label | Platform reason |
|---|---|---|
| `ZOMATO_GOLD` | Zomato Gold | yes |
| `DINEOUT` | Dineout | yes |
| `EAZYDINER` | EazyDiner | yes |
| `REGULAR_GUEST` | Regular guest | no |
| `REFERRAL` | Referral | no |
| `STAFF_OFFICE` | Staff or office | no |
| `MERCHANT_PROMO` | Merchant promo | no |
| `SERVICE_RECOVERY` | Service recovery | no |
| `OTHER` | Other, note required | no |

`note` optional, up to 200 characters, required for `OTHER`. `fundedBy` is
`RESTAURANT` or `PLATFORM`, default `RESTAURANT`; `PLATFORM` with a non-platform
reason is 400. The old `reason` field is refused with 400.

The bill's `discount` gains `reasonCode` and `fundedBy`; its `reason` holds the
note. `DISCOUNT_APPLIED` gains `reasonCode` and `fundedBy` in `details`, and its
`reason` is the label followed by ": " and the note when there is one.

Who may discount: OWNER and MANAGER. Plus CASHIER, for platform reasons only,
when `settings.discounts.cashierMayApplyPlatformDiscounts` is true (default
false). A cashier is refused with 403 otherwise. Discounting an `ON_ACCOUNT`
bill is refused like a paid one.

## 5. P25: notes and change on a cash payment, and methods linked to a card machine

### 5.1 Counting notes on a cash payment (P25 Part F)

`POST /api/v1/bills/:billId/payments` accepts an optional `tender`, only with
`method: "CASH"`:

```json
{
  "method": "CASH",
  "amountInPaise": 79500,
  "tender": {
    "cashCount": [ { "valueInPaise": 50000, "count": 2 } ],
    "tenderedInPaise": 100000,
    "changeInPaise": 20500
  }
}
```

1. `cashCount` is optional. When sent, the server totals it with
   `sumCashCount` against the restaurant's active denominations (M16 section
   8), and the total must equal `tenderedInPaise`: 422 `CASH_COUNT_MISMATCH`
   otherwise.
2. `tenderedInPaise` must be at least `amountInPaise`, and `changeInPaise` must
   equal `tenderedInPaise − amountInPaise`: 422 `BUSINESS_RULE_VIOLATED`
   otherwise.
3. The payment records `amountInPaise`, the amount applied to the bill, never
   the amount handed over. `tender` is stored on the payment as it is, for the
   record. Nothing reads it for a figure.
4. `tender` with any method but `CASH` is 400.

Typing an amount without counting notes works exactly as before.

### 5.2 Methods linked to a card machine (P25 Part I)

Payment methods gain, additively:

| Field | Notes |
|---|---|
| `terminalProvider` | `PINE_LABS` or null. Only on an `IN_HAND` method. |
| `terminalPaymentMode` | Required with a provider, null without. Pine Labs' `AllowedPaymentMode` code, an integer: 1 card, 10 UPI sale, 11 UPI Bharat QR, 0 every mode the machine has. |

Set through `POST` and `PATCH /payment-methods`, OWNER, like every other field.
A provider on a `PLATFORM` method, or a mode without a provider, is 400.

`settings.payments.requireTerminalForLinkedMethods` (M7, P25), default `true`:
a payment with a linked method, recorded by hand through `POST
/bills/:billId/payments`, is refused with 422 `TERMINAL_REQUIRED` "Send this
payment to the card machine." unless:

1. the caller is OWNER or MANAGER, and
2. the body carries `terminalBypassReason`, 1 to 200 characters ("The machine is
   down").

Such a payment is recorded normally and writes `TERMINAL_BYPASSED`, entity
`BILL`, with the amount and the reason. A CASHIER or WAITER sending a bypass
reason is 403. With the setting off, linked methods are taken by hand as
before. Payments made through the machine are recorded by the integration
(M21 section 5) and carry `terminal: { provider, ptrid, rrn, approvalCode, tid,
paymentMode }`.
## Permission summary for M10

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| GET /payment-methods | yes | yes | yes | yes | yes | yes |
| GET /payment-methods?includeInactive=true | yes | yes | no | no | no | no |
| POST /payment-methods | yes | no | no | no | no | no |
| PATCH /payment-methods/:id | yes | no | no | no | no | no |
| POST /bills/:id/payments | yes | yes | yes | no | no | no |
| POST /bills/:id/payments/:paymentId/correct | yes | yes | no | no | no | no |
| POST /bills/:id/discount | yes | yes | platform reasons, when the setting is on | no | no | no |

## Settled while building P08

The discount `reason` stored on the bill is the note; receipts, the M6
discounts report and the audit line print the reason's label followed by ": "
and the note, through `discountReasonText` in `server/config/discountReasons.js`.
A discount from before P08 keeps its free text.

Provisioning creates the four built-in methods inside its transaction; the
no-transaction fallback removes them again if a later step fails.

`GET /auth/me` returns `discounts.cashierMayApplyPlatformDiscounts`, so the till
knows whether to show a cashier the discount panel. See section 1.5.

## Error codes added by M10

| Code | Status | When |
|---|---|---|
| `PAYMENT_METHOD_NOT_ALLOWED` | 422 | The method is inactive, not allowed for the order type, or the wrong platform |

---

# M16 Settlement and Day Close

Owner: Rishi. Specified in P07. No Charge built in P08, On Hold accounts in P09,
the cash drawer and Day Close in P10.

## 1. No Charge

No Charge closes an order without a bill. It is not a sale and takes no invoice
number.

```
POST /api/v1/orders/:orderId/no-charge
```

Roles: OWNER, MANAGER. Body `{ version, reasonCode, note? }`, reasons from
`server/config/noChargeReasons.js`, mirrored on the client:

| Code | Label |
|---|---|
| `CORPORATE_OFFICE` | Corporate office order |
| `STAFF_MEAL` | Staff meal |
| `OWNER_GUEST` | Owner's guest |
| `TASTING` | Tasting or trial |
| `SERVICE_RECOVERY` | Service recovery |
| `OTHER` | Other, note required |

Rules, each 422 `BUSINESS_RULE_VIOLATED`:

1. The order is `OPEN` or `READY_TO_BILL`.
2. It has no live bill. "Void the bill first."
3. It has no line still waiting to be sent to the kitchen. "Send or cancel the
   unsent items first."
4. It has at least one live line.

Effect, in one transaction: status `NO_CHARGE`, the table freed, `noCharge`
filled in (`approvedBy` is the caller, `valueInPaise` the sum of the live line
totals before GST, `businessDate` from now), and `NO_CHARGE_GIVEN`, entity
`ORDER`, with `amountInPaise` equal to `valueInPaise` and `details: { orderNumber,
tableName, reasonCode, lineCount }`. Stock was already deducted at fire, so
nothing else moves. Refused with 409 `DAY_CLOSED` when today's business date is
closed (P10).

A `NO_CHARGE` order is never open, never billable, and never a sale.

## 2. On Hold accounts

An On Hold bill is a sale whose money arrives later, from a named account.
Collections are dated when the money arrives and are never sales.

### 2.1 Endpoints

| Method and path | Roles | Notes |
|---|---|---|
| `GET /api/v1/accounts?includeInactive=false` | OWNER, MANAGER, CASHIER | Each with `outstandingInPaise` and `oldestUncollectedDate`, the business date of the oldest charge not yet covered by later collections and reversals, or null |
| `POST /api/v1/accounts` | OWNER, MANAGER | `{ name, contactName?, phone?, note?, openingBalanceInPaise? }`. A positive opening balance writes an `OPENING` entry in the same transaction. 409 `DUPLICATE` on a name. |
| `PATCH /api/v1/accounts/:accountId` | OWNER, MANAGER | `name`, `contactName`, `phone`, `note`, `isActive`. Never the opening balance: 400. |
| `POST /api/v1/bills/:billId/charge-to-account` | OWNER, MANAGER | `{ accountId }`. Who else may: `TO CONFIRM` with Caffeza. |
| `POST /api/v1/accounts/:accountId/collections` | OWNER, MANAGER, CASHIER | `{ method, amountInPaise, reference?, note? }`. `IN_HAND` methods only. |
| `POST /api/v1/accounts/:accountId/adjustments` | OWNER | `{ direction, amountInPaise, reason }`. Writes `ACCOUNT_BALANCE_ADJUSTED`, entity `ACCOUNT`. |
| `GET /api/v1/accounts/:accountId/statement?from&to` | OWNER, MANAGER | Balance before `from`, every entry in the range with a running balance, balance after `to` |

### 2.2 Charging a bill

1. The bill is `UNPAID` and not voided, and the account is active: 422
   otherwise.
2. The amount charged is the bill total minus what was already paid. It must be
   above zero: 422 otherwise.
3. In one transaction: the bill becomes `ON_ACCOUNT` with `account`,
   `chargedToAccountInPaise`, `chargedAt` and `chargedBy`; the order becomes
   `BILLED` and frees its table exactly as a full payment does; a `CHARGE` entry;
   and `BILL_CHARGED_TO_ACCOUNT`, entity `BILL`, with the amount charged.

Refused with 409 `DAY_CLOSED` when the bill's business date is closed (P10).

Voiding an `ON_ACCOUNT` bill is allowed, by the roles that void today, and writes
a `CHARGE_REVERSED` entry for the charged amount in the same transaction.

### 2.3 Collections and adjustments

A collection larger than the outstanding balance is refused with 422
`ACCOUNT_BALANCE_EXCEEDED`. A `PLATFORM` method is refused with 422
`PAYMENT_METHOD_NOT_ALLOWED`. A collection freezes `method`, `methodName`,
`methodKind`, and takes today's business date. It counts in the drawer on the
day it arrives and is never a sale.

An adjustment's `direction` is `UP` or `DOWN`; a `DOWN` larger than the
outstanding balance is refused with 422 `ACCOUNT_BALANCE_EXCEEDED`.

Collections and adjustments are refused with 409 `DAY_CLOSED` when today's
business date is closed (P10).

### 2.4 Settled while building P09

`POST /accounts/:id/collections` and `/adjustments` answer 201 with the ledger
entry they wrote: `{ id, accountId, type, direction, amountInPaise, method,
methodName, methodKind, reference, note, businessDate, at, by }`.

`GET /accounts/:id/statement` answers:

```json
{
  "account": { "id": "...", "name": "W-330 Office", "isActive": true },
  "from": "2026-09-26", "to": "2026-09-27",
  "openingBalanceInPaise": 0,
  "entries": [
    { "type": "CHARGE", "direction": "UP", "amountInPaise": 50400, "billNumber": "CFA/C/22451", "businessDate": "2026-09-26", "balanceInPaise": 50400 },
    { "type": "COLLECTION", "direction": "DOWN", "amountInPaise": 50400, "methodName": "Cash", "businessDate": "2026-09-27", "balanceInPaise": 0 }
  ],
  "closingBalanceInPaise": 0
}
```

`openingBalanceInPaise` is the balance from every entry before `from`;
`closingBalanceInPaise` is the balance after the last entry on or before `to`.
Both dates are business dates and both are optional.

`oldestUncollectedDate` applies every DOWN amount to the UP entries oldest
first; the first UP entry not fully covered gives the date.

`ACCOUNT_BALANCE_ADJUSTED` carries the amount signed: negative for `DOWN`.

Voiding an already voided payout is a 422.

## 3. The cash drawer

Stored in `cashmovements`, DB-SCHEMA section 24.

| Method and path | Roles |
|---|---|
| `GET /api/v1/cash-movements?date=YYYY-MM-DD` | OWNER, MANAGER, CASHIER. Default today's business date. |
| `POST /api/v1/cash-movements` | `OPENING_FLOAT` and `PAID_IN`: OWNER, MANAGER, CASHIER. `PAID_OUT`: OWNER, MANAGER, and writes `CASH_PAID_OUT`, entity `CASH`, with the amount and reason. |
| `POST /api/v1/cash-movements/:id/void` | OWNER, MANAGER, CASHIER. Body `{ reason, approval? }`. From 2026-10-17 a CASHIER may void with an owner's or manager's PIN, as for a paid out (P28 `approverForManagerTask`): `approval` is required for a cashier, and a cashier is refused with 403 when `approvals.managerTasks` is off. The approver is stored as `voidApprovedBy`. |

Body `{ type, amountInPaise, reason? }`. `reason` 1 to 200 characters, required
for `PAID_IN` and `PAID_OUT`. The business date is always today's; no request can
set it. A second live opening float for the date is 409 `DUPLICATE`. Writes and
voids are refused with 409 `DAY_CLOSED` when the movement's business date is
closed.

## 4. Day figures

`server/services/dayFiguresService.js`, `computeDayFigures(req, businessDate, {
session })`. The only place day-level figures are computed. Day Close stores its
output as the snapshot, and R2 returns it. Frozen fields only, whole paise, and
averages as a sum divided by a sum rounded half away from zero. "Cash" means
payments and collections whose frozen `methodKind` is `IN_HAND` (or null) and
whose method code is `CASH`.

```json
{
  "businessDate": "2026-09-26",
  "sales": {
    "billCount": 15, "covers": 27,
    "itemTotalInPaise": 931022, "discountInPaise": 42390, "netSalesInPaise": 888632,
    "cgstInPaise": 19131, "sgstInPaise": 19126, "gstInPaise": 38257,
    "roundOffInPaise": 11, "billTotalInPaise": 926900,
    "averageBillInPaise": 59242, "dineInNetSalesInPaise": 721132, "averagePerCoverInPaise": 26709
  },
  "money": {
    "methods": [ { "method": "CASH", "methodName": "Cash", "methodKind": "IN_HAND", "amountInPaise": 175400, "paymentCount": 3 } ],
    "inHandInPaise": 470700, "platformInPaise": 401100,
    "onHold": [ { "accountId": "...", "accountName": "E-210 Office", "amountInPaise": 4700, "billCount": 1 } ],
    "onHoldInPaise": 55100, "unpaidInPaise": 0, "unpaidBillCount": 0, "totalInPaise": 926900
  },
  "collections": { "entries": [], "totalInPaise": 0, "cashInPaise": 0 },
  "cash": {
    "openingFloatInPaise": 200000, "cashFromBillsInPaise": 175400, "cashCollectionsInPaise": 0,
    "paidInInPaise": 0, "paidOutInPaise": 35000, "expectedCashInPaise": 340400,
    "paidIn": [], "paidOut": [ { "amountInPaise": 35000, "reason": "Milk from the dairy", "at": "..." } ]
  },
  "orderTypes": [ { "orderType": "DINE_IN", "platformCode": null, "billCount": 12, "covers": 27, "netSalesInPaise": 721132, "billTotalInPaise": 757200 } ],
  "gst": [ { "taxRateBps": 500, "platformCollects": false, "netSalesInPaise": 765132, "cgstInPaise": 19131, "sgstInPaise": 19126, "gstInPaise": 38257 } ],
  "controls": {
    "discounts": { "count": 6, "totalInPaise": 42390, "largest": [ { "billNumber": "CFA/C/22449", "amountInPaise": 20000 } ] },
    "noCharge": { "count": 1, "valueInPaise": 23000 },
    "cancelledItems": { "count": 2, "valueInPaise": 75000, "wastedValueInPaise": 39000 },
    "cancelledOrders": { "count": 0, "valueInPaise": 0 },
    "voidedBills": { "count": 1, "valueInPaise": 34700, "bills": [ { "billNumber": "CFA/C/22452", "amountInPaise": 34700, "reasonCode": "WRONG_TABLE", "reason": "Billed to the wrong table" } ] }
  },
  "invoices": [ { "series": "CFA/C/", "first": "CFA/C/22442", "last": "CFA/C/22457", "issued": 16, "voided": 1, "gaps": [] } ]
}
```

| Section | Reads |
|---|---|
| `sales` (A) | Non-voided bills with this `businessDate` |
| `money` (B) | Those bills' payments by frozen method, grouped by frozen kind; their `chargedToAccountInPaise` by account; and bill total minus paid minus charged for the rest, as unpaid |
| `collections` (C) | `accountentries` of type `COLLECTION` with this `businessDate` |
| `cash` (D) | `cashmovements` for this date, cash payments whose own `businessDate` is this date, and cash collections |
| `orderTypes` (E) | Bills grouped by `orderType`, delivery split by frozen `platform.code` |
| `gst` (F) | Bills' `taxBreakdown`, with `PLATFORM_COLLECTS` bills in their own 0% row |
| `controls` (G) | Discounts from bills; No Charge from orders with `noCharge.businessDate` on this date; cancelled lines and whole orders by the business date of their cancel time; voided bills of this date |
| `invoices` (H) | Per `invoiceSeries` (null reads as the bill's `financialYear`), bills of this date including voided: first, last, issued, voided, missing numbers between first and last |

Counted cash and the difference are not day figures; Day Close adds them.

## 5. Checks at close

`server/services/reconciliationService.js`. P10 builds C1, C3, C4, C6, C8 and C9
for one business date; P14 adds the rest and the range versions. Each check
returns `{ id, severity, passed, message, expected, actual, difference, refs }`,
`refs` listing the bill numbers or record ids behind a failure.

## 6. Day Close

Stored in `dayclosures`, DB-SCHEMA section 25.

| Method and path | Roles | Notes |
|---|---|---|
| `POST /api/v1/day-close` | OWNER, MANAGER | `{ businessDate, countedCashInPaise, note? }` |
| `GET /api/v1/day-close/:businessDate` | OWNER, MANAGER | The closure, or for an open date the live figures and blockers. The blind count applies. |
| `GET /api/v1/day-close?from&to` | OWNER, MANAGER | One row per date with a closure record |
| `GET /api/v1/day-close/:businessDate/print?width=32` | OWNER, MANAGER | Plain text for a thermal printer, laid out on the server like the receipt: sections A, B, D and G, the checks, and "Closed by {name} at {time}". The blind count applies. |
| `POST /api/v1/day-close/:businessDate/reopen` | OWNER | `{ reason }`. Writes `DAY_REOPENED`, entity `DAY`. |

Closing:

1. The date is today's business date or earlier, and not already `CLOSED`: 422
   otherwise.
2. Blockers, reported together in one 422 `DAY_NOT_READY` with `blockers` beside
   the message in `error` (the same place `TABLE_OCCUPIED` puts `existingOrderId`),
   each `{ kind, message, ref }`, `kind` one of `OPEN_ORDER`, `UNPAID_BILL`,
   `CHECK`: an order opened on that business date still
   `OPEN` or `READY_TO_BILL`; a bill of that date still `UNPAID`; any failed
   ERROR check from section 5.
3. A cash difference other than zero needs a `note`: 422 otherwise, with
   `noteRequired: true` in `error` and a message that does not say by how much.
4. Effect, in one transaction: compute the figures, store the snapshot and
   checks, set `CLOSED`, add to `history`, and write `DAY_CLOSED`, entity `DAY`,
   with the day's bill total.

**The blind count.** A MANAGER enters the counted cash without seeing the
expected figure. Responses and prints to a MANAGER leave out
`expectedCashInPaise` and `differenceInPaise`, and the snapshot's
`cash.expectedCashInPaise`, unless `settings.dayClose.showCashDifferenceToManager`
is true. OWNER always sees both.

Reopening needs the date to be `CLOSED`, sets `REOPENED`, and adds to `history`.
A `REOPENED` date is open, and can be closed again.

### 6.1 Settled while building P10

`GET /day-close/:businessDate` and `POST /day-close` answer one shape:

```json
{
  "businessDate": "2026-09-26", "status": "CLOSED", "isClosed": true,
  "countedCashInPaise": 340000, "expectedCashInPaise": 340400, "differenceInPaise": -400,
  "note": "Four rupees short, coins",
  "figures": { "...": "computeDayFigures, section 4" },
  "checks": [ { "id": "C1", "severity": "ERROR", "passed": true, "message": "..." } ],
  "blockers": [],
  "closedBy": "652c...", "closedAt": "...",
  "history": [ { "action": "CLOSED", "by": "...", "at": "...", "note": "...", "countedCashInPaise": 340000 } ]
}
```

For an open or reopened date, `status` is `OPEN` or `REOPENED`, `figures` and
`checks` are live, `blockers` lists what stops the close, and the counted and
difference fields are null.

For a blind manager the server leaves out `expectedCashInPaise`,
`differenceInPaise`, `figures.cash.expectedCashInPaise`, the same two fields on
every `history` entry, and the numbers of the C9 check, whose message becomes
"C9 Cash: the count is recorded." The print follows the same rule.

An order waiting on an unpaid bill is reported once, as the bill. Opening
orders are those opened inside the business date's hours.

The lock answers before any rule about the bill itself, so a write on a closed
day's bill is always 409 `DAY_CLOSED`. Charging to an account also checks
today's date, because the CHARGE entry is written today; correcting a payment
also checks the payment's own business date.

## 7. The lock

Once a business date is `CLOSED`, every write that would change that date's
figures is refused with 409 `DAY_CLOSED`, message "{date} is closed. An owner can
reopen it." One helper, `assertDayOpen(req, businessDate, { session })`, called
once per write:

| Write | Date checked |
|---|---|
| Create a bill | The business date the new bill would get |
| Discount, void, charge to account | The bill's `businessDate` |
| Take a payment, correct a payment | The bill's `businessDate`, and today's |
| No Charge | Today's business date |
| Cash movement, and voiding one | Its business date |
| Account collection, adjustment | Today's business date |
| Record or void a payout | Today's business date |

## Permission summary for M16

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| POST /orders/:id/no-charge | yes | yes | no | no | no | no |
| GET /accounts | yes | yes | yes | no | no | no |
| POST /accounts | yes | yes | no | no | no | no |
| PATCH /accounts/:id | yes | yes | no | no | no | no |
| POST /bills/:id/charge-to-account | yes | yes | no | no | no | no |
| POST /accounts/:id/collections | yes | yes | yes | no | no | no |
| POST /accounts/:id/adjustments | yes | no | no | no | no | no |
| GET /accounts/:id/statement | yes | yes | no | no | no | no |
| GET /cash-movements | yes | yes | yes | no | no | no |
| POST /cash-movements, float or paid in | yes | yes | yes | no | no | no |
| POST /cash-movements, paid out | yes | yes | no | no | no | no |
| POST /cash-movements/:id/void | yes | yes | with a manager's PIN | no | no | no |
| POST /cash-movements, cash taken out (P29) | yes | yes | no | no | no | no |
| POST /cash-movements, cash check (P29) | yes | yes | yes | no | no | no |
| GET /cash-book (P29) | yes | yes | yes | no | no | no |
| POST /day-close | yes | yes | no | no | no | no |
| GET /day-close, /day-close/:date, print | yes | yes | no | no | no | no |
| POST /day-close/:date/reopen | yes | no | no | no | no | no |

## Error codes added by M16 and M17 payouts

| Code | Status | When |
|---|---|---|
| `ACCOUNT_BALANCE_EXCEEDED` | 422 | A collection or a downward adjustment larger than the outstanding balance |
| `PAYOUT_PERIOD_OVERLAP` | 409 | Two live payouts for one method would cover the same business date |
| `DAY_NOT_READY` | 422 | Day Close blocked; `details.blockers` lists every reason |
| `DAY_CLOSED` | 409 | A write would change a closed business date |

## 8. P25: counting cash by notes and coins, refunds owed, and new blockers

### 8.1 Denominations

`settings.cash.denominations` (M7, P25), OWNER to change, audited like every
setting: a list of `{ valueInPaise, kind, isActive }`, `kind` `NOTE` or `COIN`.

Default, India, largest first:

| Value | Kind | Active |
|---|---|---|
| ₹2,000 | NOTE | no, withdrawn from circulation |
| ₹500, ₹200, ₹100, ₹50, ₹20, ₹10 | NOTE | yes |
| ₹20, ₹10, ₹5, ₹2, ₹1 | COIN | yes |

₹20 and ₹10 appear once as a note and once as a coin. A value is unique within
its kind, above 0 and a whole number of paise; at least one is active. A `PATCH
/settings` replaces the whole list.

### 8.2 One shape everywhere

```json
"cashCount": [ { "valueInPaise": 50000, "kind": "NOTE", "count": 6 } ]
```

`kind` is optional when the value exists only once in the active list, and
required when it exists as both a note and a coin: 400 otherwise. Counts are
whole numbers from 0 to 10,000. A value that is not an active denomination is
422 `BUSINESS_RULE_VIOLATED` naming it. **The server always works out the total
itself**, with one helper in `server/utils/money.js`, `sumCashCount(cashCount,
denominations)`. A client total is never trusted. Rows with a count of 0 are
dropped before storing.

### 8.3 Where it is used

1. **Opening float.** `POST /cash-movements` with `type: OPENING_FLOAT` accepts
   `cashCount` in place of `amountInPaise`. With both, they must agree: 422
   `CASH_COUNT_MISMATCH` otherwise. The count is stored on the movement.
   `cashCount` on `PAID_IN` or `PAID_OUT` is 400.
2. **Day Close.** `POST /day-close` accepts `cashCount` in place of
   `countedCashInPaise`. With both, they must agree: 422 `CASH_COUNT_MISMATCH`.
   One of the two is required. The count is stored on the day closure and on its
   `history` entry. **The blind count does not change**: the count by notes is
   the manager's own entry, so they see it, and still never see the expected
   figure. The Day Close print lists each denomination, its count and its value,
   after counted cash.
3. **A cash payment.** M10 section 5.1.

### 8.4 Refunds owed on Day Close

`computeDayFigures` gains `refunds: { owed: [ { billNumber, methodName,
amountInPaise } ], owedInPaise, refundedInPaise }`, the refunds rows created on
that business date. Day Close shows them, and an open refund adds a check
result of severity `WARNING` with the message "₹X is owed back to guests on
card or UPI." It never blocks.

### 8.5 New blockers

`blockersFor` gains three kinds, reported with the others:

| Kind | When |
|---|---|
| `PLATFORM_ORDER` | A platform order (M21) received on that business date still `RECEIVED`, `NEEDS_ATTENTION`, or `ACCEPTED` and not picked up |
| `TERMINAL_PAYMENT` | A terminal payment (M21) started on that business date still `WAITING` or `UNKNOWN` |
| `PLATFORM_ORDER_FAILED` | A platform order of that date `FAILED`: accepted on the platform but not created here |

### 8.6 Reports

R2 and R7 show the counted denominations for a closed day that has them, under
Counted cash. A day counted as a total shows the total only. R2 and R5 show
"Refunds owed" as their own line.

### 8.7 Permission summary for P25 in M16

| Action | OWNER | MANAGER | CASHIER | WAITER |
|---|---|---|---|---|
| Count notes for the opening float | yes | yes | yes | no |
| Count notes at Day Close | yes | yes | no | no |
| Count notes on a cash payment | yes | yes | yes | when both billing settings |

### 8.8 Error codes added by P25 in M16

| Code | Status | When |
|---|---|---|
| `CASH_COUNT_MISMATCH` | 422 | A count by notes and a total sent beside it disagree |

## 9. P29: the cash book

The cash drawer and the cash part of Day Close become one screen, the **cash
book**, that reads top to bottom like the owner's own drawing:

```
  Brought forward       yesterday's cash kept in the drawer, with its notes
+ Top-ups               cash added: from the owner, from the bank, change
+ Cash sales            cash payments on bills today
+ Cash collections      On Hold accounts paid in cash today
- Expenses              cash spent, by category
- Cash taken out        cash removed that is not an expense: a bank deposit, given to the owner
= Cash in drawer        what should be in the drawer now
```

On screen `PAID_IN` is always **Top-up** and `PAID_OUT` is always **Expense**.
The stored type names do not change.

### 9.1 Expected cash

Everywhere, in `computeDayFigures` and Day Close:

expected cash = opening float (brought forward or counted) + top-ups + cash
sales + cash collections − expenses − cash taken out.

A day with no `CASH_TAKEN_OUT` gives exactly the figure it gave before P29.

### 9.2 Cash movements

`POST /api/v1/cash-movements` keeps its shape and gains, additively:

| Type | New fields | Rules |
|---|---|---|
| `OPENING_FLOAT` | `broughtForward` (boolean, request only) | See 9.3. |
| `PAID_IN`, a top-up | `source`: `OWNER`, `BANK`, `CHANGE` or `OTHER` | `reason` becomes optional when `source` is sent; one of the two is required. `OTHER` needs a `reason`. |
| `PAID_OUT`, an expense | `category`: a code from `settings.cash.expenseCategories` | `reason` becomes optional when `category` is sent; one of the two is required. A code not in the active list is 422. `OTHER` needs a `reason`. |
| `CASH_TAKEN_OUT`, new | `destination`: `BANK_DEPOSIT`, `OWNER` or `OTHER`, required; `takenBy`, an active user of the restaurant, default the actor; `cashCount`, optional | `amountInPaise` or `cashCount`, as the float. `OTHER` needs a `reason`. Writes `CASH_TAKEN_OUT`, entity `CASH`. |
| `CASH_CHECK`, new | `cashCount` or `amountInPaise`, 0 allowed | Moves no money. Stores `expectedCashInPaise` and `differenceInPaise` worked out at that moment from `computeDayFigures`. |

The ten default expense categories, `settings.cash.expenseCategories`: `MILK`
Milk and dairy, `VEGETABLES` Vegetables and fruit, `GROCERIES` Groceries, `GAS`
Gas, `PACKAGING` Packaging, `CLEANING` Cleaning, `REPAIRS` Repairs,
`STAFF_ADVANCE` Staff advance, `TRANSPORT` Transport, `OTHER` Other. A code is
stored on each expense and never changes, so a renamed category keeps its
history.

Every movement keeps `businessDate` from the server clock, and the existing
rules: 409 `DAY_CLOSED` on a closed date, voided and never deleted.

### 9.3 Brought forward

Day closures gain `keptForTomorrowInPaise`, `keptForTomorrowCount` (notes and
coins left in the drawer), `takenOutAtCloseInPaise`, `takenOutTo` and
`takenOutBy` (9.4).

The cash book proposes today's opening float from the most recent closed day
before today whose `keptForTomorrowInPaise` is set. Confirming it is
`POST /cash-movements` `{ type: 'OPENING_FLOAT', broughtForward: true }`:

1. With no amount and no count, the float is the kept amount and count, and
   `broughtForwardFrom` is that date.
2. With an amount or a count (a recount), the float is what was counted;
   `broughtForwardFrom` is still that date, and when it differs from the kept
   amount, `openingDifferenceInPaise` is counted minus kept, a `reason` is
   required (422 "Say why the drawer is not what was kept last night."), and
   `OPENING_FLOAT_DIFFERED` is written, entity `CASH`.
3. With no closed day that kept cash, 422 "There is no cash kept from a closed
   day to bring forward. Count the float instead."

An opening float sent without `broughtForward` is counted as before P29.

### 9.4 Closing the day

`POST /day-close` gains, optional, so a client written before P29 closes as
before:

```json
{ "businessDate": "2026-09-26", "cashCount": [ … ], "note": "₹4 short",
  "keptForTomorrowInPaise": 200000, "keptForTomorrowCount": [ … ],
  "takenOutTo": "BANK_DEPOSIT", "takenOutBy": "652c…" }
```

1. The count is entered first, as before. The blind count rule does not change.
2. `keptForTomorrowInPaise` or `keptForTomorrowCount` (the server totals it;
   both must agree) is what stays in the drawer. More than the count is 422
   "You cannot keep more than you counted."
3. The rest, counted minus kept, is `takenOutAtCloseInPaise`. When it is above
   0, `takenOutTo` is required. It is recorded on the closure and its history
   entry **after** the count, so it never changes expected cash or the
   difference.
4. The day closes as before, with its blockers and checks.

`settings.cash.usualFloatInPaise` is what the screen proposes to keep, never
more than the count.

### 9.5 The cash book read, and who sees the total

```
GET /api/v1/cash-book?date=YYYY-MM-DD
```

OWNER, MANAGER, CASHIER. Default today's business date.

```json
{
  "businessDate": "2026-09-26",
  "isClosed": false,
  "broughtForward": {
    "fromDate": "2026-09-25", "keptInPaise": 200000, "keptCount": [ … ],
    "confirmed": { "id": "…", "amountInPaise": 200000, "openingDifferenceInPaise": null, "at": "…" }
  },
  "openingFloatInPaise": 200000,
  "topUps": { "totalInPaise": 0, "count": 0, "bySource": [] },
  "cashSales": { "totalInPaise": 175400, "billCount": 3 },
  "cashCollections": { "totalInPaise": 0, "count": 0 },
  "expenses": { "totalInPaise": 35000, "count": 1, "byCategory": [ { "code": "MILK", "label": "Milk and dairy", "totalInPaise": 35000, "count": 1 } ] },
  "cashTakenOut": { "totalInPaise": 0, "count": 0 },
  "cashInDrawerInPaise": 340400,
  "lastCheck": { "at": "…", "countedInPaise": 340000, "differenceInPaise": -400 },
  "yesterday": { "businessDate": "2026-09-25", "countedCashInPaise": 1240000, "keptForTomorrowInPaise": 200000, "takenOutAtCloseInPaise": 1040000, "takenOutTo": "BANK_DEPOSIT" },
  "lastUsedExpense": { "MILK": 35000 },
  "movements": [ … ]
}
```

`cashSales` is cash payments whose own business date is this date (M16 section
4). `lastUsedExpense` is the most recent expense amount per category in the last
7 business days, for "Same as last time". `movements` is `GET /cash-movements`.

**Who sees the total.** The blind count must still work, so the server leaves
`cashInDrawerInPaise`, every `differenceInPaise` (on `lastCheck`, on each
`CASH_CHECK` and on the check's `expectedCashInPaise`), and `yesterday`'s
expected and difference out of the response, here and in `GET
/cash-movements`, unless the caller is the OWNER, or
`cash.showDrawerTotalToStaff` is on, or the caller is a MANAGER and
`dayClose.showCashDifferenceToManager` is on. A cash check then answers "Check
saved" with no difference. Whatever the settings, Day Close takes the count
before it shows any expected figure. These fields are left out by the server,
never only hidden on screen.

### 9.6 Permissions

| Action | OWNER | MANAGER | CASHIER |
|---|---|---|---|
| `GET /cash-book` | yes | yes | yes |
| Confirm the opening float | yes | yes | yes |
| Top-up | yes | yes | yes, with a PIN when `approvals.paidIn` is on |
| Expense | yes | yes | with a PIN when `approvals.managerTasks` is on, refused when it is off |
| Cash taken out | yes | yes | no |
| Cash check | yes | yes | yes |
| Close the day, keep for tomorrow | yes | yes | no |
| Expense categories, usual float, staff total switch | yes | no | no |
| Void any of these | yes | yes | no |

Voiding keeps the existing rule for voiding a cash movement (section 3), which
matches the last row.

### 9.7 Checks

C9 uses the formula in 9.1. C14 "Brought forward" is new, WARNING: a day's
confirmed opening float differs from the kept cash of the closed day it was
brought forward from. RECONCILIATION-RULES has both. Day Close and R2 run C14
for the day.

C12 compares a stored snapshot with today's figures on the keys the snapshot
itself holds, so a figure added by a later prompt (like `cashTakenOutInPaise`)
never reads as a changed day for a day closed before it existed.

---

# M19 Reports v2

Owner: Arya. Specified in P13. P14 builds the engine, R19 and the export; P15
to P17 add the reports; P18 builds the screens and R1. Every report in
`docs/REPORT-SPEC.md`, with the words of `docs/GLOSSARY.md` and the checks of
`docs/RECONCILIATION-RULES.md`.

M19 owns no collection and writes nothing, like M6. Every endpoint is a `GET`.

## 1. Principles

**Carried over from M6, unchanged** (see "Rules every M6 endpoint obeys"):
voided bills are out of every sales and money figure; ranges are business
dates, never calendar dates; `from` and `to` are both required and inclusive;
the range is at most `MAX_RANGE_DAYS`, 366, or 422 `RANGE_TOO_LARGE`; every
pipeline opens with the tenant `$match` through `scopedForAggregate`; money out
is whole paise; `skipTenantGuard` is never used.

**Added by M19.** Each is a rule the code follows:

1. **One source.** A figure is a sum of values frozen on a record when the event
   happened: `bills` for sales, `bills.payments` and `accountentries` and
   `cashmovements` for money, `orders` for cancellations and No Charge,
   `platformpayouts` for payouts, `dayclosures` for closed days, `auditlogs`
   for activity. A report never recomputes tax, never reads `menuitems`,
   `categories`, `users` or `paymentmethods` to produce a figure, and never
   groups on a live name.
2. **One engine.** Every report runs through `runReport` in
   `server/services/reports/engine.js`. The engine validates the request, checks
   the range, builds the tenant, branch, date and not-voided match, runs the
   report's own query, works out `openDays`, runs the checks, writes the filter
   sentence, attaches columns and drill downs, and returns the envelope. A
   report definition only groups and sorts.
3. **The filter sentence.** Every response carries one, built by the engine, and
   every screen, print and export shows it first.
4. **Open days.** Every response lists the business dates in its range that are
   not closed. Screens show "26 Sep is still open. These numbers will change
   until Day Close."
5. **Totals and averages.** A totals row is the exact sum of its rows, in paise.
   An average is a total divided by a total, worked out after totalling with
   `averagePaise`, and its label says "Average".
6. **Drill down.** Every count and money cell carries a drill to R19 that
   returns exactly the bills behind it. A number that cannot be drilled is not
   on a report. Exceptions are named per report: cash drawer entries, payouts,
   account entries and cancelled lines drill to their own list instead.
7. **Checks.** Every report runs its checks from section 4 before it answers. A
   failed check never hides the report.
8. **Export.** `format=xlsx` returns the same envelope as a workbook, built from
   the same data, never queried twice (section 5).
9. **Format.** The API sends paise, basis points, `"YYYY-MM-DD"` dates and UTC
   instants. Screens and exports show ₹ with Indian grouping and two decimals,
   12-hour India time, and dates as 26 Sep 2026. Negative money shows a minus
   sign and the `mirch` colour.

## 2. The shared request

```
GET /api/v1/reports/v2/{name}?from=2026-09-26&to=2026-09-26&orderType=DINE_IN&format=json
```

| Parameter | Meaning |
|---|---|
| `from`, `to` | Business dates, `YYYY-MM-DD`, inclusive. R2 takes one `date` instead. R1 takes none: it is today. |
| Filters | Only those listed for that report in section 3 |
| `page`, `limit` | Only on R10, R15, R16 and R19, the reports that list records. The CONVENTIONS paging: default 50, maximum 200, clamped. |
| `format` | `json`, the default, or `xlsx` for the Excel file |

An unknown parameter is a 400, the same as every validator in this repo. A
filter value that is not a valid code or id is a 400. A filter that matches
nothing is an empty report, not an error.

The shared filter values:

| Filter | Values | Matches |
|---|---|---|
| `orderType` | `DINE_IN`, `TAKEAWAY`, `DELIVERY` | `bills.orderType` |
| `platform` | A platform code, `ZOMATO`, `SWIGGY` | `bills.platform.code` |
| `captainId` | A user id | `bills.captainId` |
| `table` | A table name | `bills.tableName` |
| `method` | A payment method code | any `bills.payments[].method` |
| `status` | `UNPAID`, `PAID`, `ON_ACCOUNT`, `VOIDED` | `bills.status`, or `isVoided: true` for `VOIDED` |
| `categoryName` | A category name | any `bills.lines[].categoryName` |
| `itemName` | An item name | any `bills.lines[].itemName` |
| `taxRateBps` | An integer | any `bills.taxBreakdown[].taxRateBps` |
| `discountReason` | A discount reason code | `bills.discount.reasonCode` |
| `accountId` | An account id | `bills.account.accountId` |
| `hour` | 0 to 23 | the India-time hour of `bills.billedAt` |
| `weekday` | 1 to 7, Monday first | the India-time weekday of `bills.businessDate` |
| `hasDiscount`, `hasCancellations` | `true` or `false` | a discount above zero; an order with a cancelled line |
| `billNumber` | An invoice number | `bills.billNumber` |
| `stationId` | A station id | R13's kitchen panel only: `kots.stationId` |

Only R19 accepts every filter. Each other report accepts the ones listed for it.

## 3. The shared response

Every report returns one envelope. R3 for the golden day, shortened:

```json
{
  "success": true,
  "data": {
    "report": "R3",
    "title": "Sales by Day",
    "filter": { "from": "2026-09-26", "to": "2026-09-26" },
    "filterSentence": "26 Sep 2026. Business day starts 5:00 AM. All order types. Voided bills left out.",
    "openDays": [],
    "columns": [
      { "key": "businessDate", "label": "Business date", "type": "date" },
      { "key": "billCount", "label": "Bills", "type": "count" },
      { "key": "covers", "label": "Covers", "type": "count" },
      { "key": "itemTotalInPaise", "label": "Item total", "type": "money" },
      { "key": "discountInPaise", "label": "Discount", "type": "money" },
      { "key": "netSalesInPaise", "label": "Net sales", "type": "money" },
      { "key": "gstInPaise", "label": "GST", "type": "money" },
      { "key": "roundOffInPaise", "label": "Round-off", "type": "money" },
      { "key": "billTotalInPaise", "label": "Bill total", "type": "money" },
      { "key": "averageBillInPaise", "label": "Average bill", "type": "money" },
      { "key": "averagePerCoverInPaise", "label": "Average per cover", "type": "money" }
    ],
    "rows": [
      {
        "businessDate": "2026-09-26", "billCount": 15, "covers": 27,
        "itemTotalInPaise": 931022, "discountInPaise": 42390, "netSalesInPaise": 888632,
        "gstInPaise": 38257, "roundOffInPaise": 11, "billTotalInPaise": 926900,
        "averageBillInPaise": 59242, "averagePerCoverInPaise": 26709,
        "drill": {
          "billCount": { "report": "R19", "query": { "from": "2026-09-26", "to": "2026-09-26" } },
          "billTotalInPaise": { "report": "R19", "query": { "from": "2026-09-26", "to": "2026-09-26" } }
        }
      }
    ],
    "totals": {
      "billCount": 15, "covers": 27, "itemTotalInPaise": 931022, "discountInPaise": 42390,
      "netSalesInPaise": 888632, "gstInPaise": 38257, "roundOffInPaise": 11, "billTotalInPaise": 926900,
      "averageBillInPaise": 59242, "averagePerCoverInPaise": 26709,
      "drill": { "billCount": { "report": "R19", "query": { "from": "2026-09-26", "to": "2026-09-26" } } }
    },
    "checks": [
      { "id": "C5.6", "severity": "ERROR", "passed": true, "message": "C5 Groups: the days add up to the range.", "expected": 926900, "actual": 926900, "difference": 0, "refs": [] }
    ],
    "generatedAt": "2026-09-27T04:00:00.000Z"
  }
}
```

**Column types.** Every cell is one of:

| `type` | Sent as | Shown as |
|---|---|---|
| `money` | Integer paise | ₹2,07,179.00 |
| `count` | Integer | 1,642 |
| `percent` | Integer basis points | 20.26% |
| `text` | String | As sent |
| `date` | `"YYYY-MM-DD"` business date | 26 Sep 2026, with the weekday where the report says so |
| `time` | UTC instant | 9:05 PM India time |
| `minutes` | Integer minutes | 52 min |
| `decimal2` | Integer hundredths | 2.50 |

**People's names.** A report groups people by their stored user id: `captainId`,
`discount.appliedBy`, `lines[].cancelledBy`, `voidedBy`, `noCharge.approvedBy`.
A captain's name is the `captainName` frozen on the bill. For the others no
name is frozen, so the definition returns the ids and the engine attaches each
person's current name in one step, `personNames(req, ids)`, as a label only:
never a grouping, never part of a figure. A definition never reads `users`
itself. See section 11.

**Labels.** Every `label` is a term from `docs/GLOSSARY.md`, held as a constant
in `server/services/reports/labels.js` and mirrored on the client. No definition
types a label by hand.

**Drill downs.** A row and the totals may carry `drill`, an object keyed by
column key: `{ report: "R19", query: { ...R19 filters } }`. The client opens
that report with exactly that query. Where a cell drills to something other
than R19, `report` names it, for example `"R17"`.

**Sections.** A report with more than one table, such as R2, R8 or R15, sends
`sections: [{ key, title, columns, rows, totals }]` instead of top-level
`columns`, `rows` and `totals`. A report with one table never sends `sections`.

**Paging.** A listing report adds `meta: { page, limit, total }` beside `data`,
as every list in this repo does. Its `totals` always cover every matching
record, never only the page.

**Open days.** `openDays` is every business date from `from` to `to` that has no
`dayclosures` record with `status: "CLOSED"`, in date order. A `REOPENED` date
is open.

**Checks.** Each check result has the shape `reconciliationService.js` already
returns: `{ id, severity, passed, message, expected, actual, difference, refs }`.
`id` names the check and, for C5, the grouping: `C5.1` categories to `C5.7` tax
rates. The client shows "All 6 checks passed" when every one passed, and every
failed message otherwise.

**The filter sentence.** Built in this order, each part ending in a full stop:

1. The range: "26 Sep 2026." for one date, "26 Sep 2026 to 27 Sep 2026." for more.
2. "Business day starts 5:00 AM.", from the setting.
3. One part per filter the report accepts, in the order of its filter list:
   the filter's plain name and value, "Order type: Dine-in.", "Captain: Khuman
   Singh.", or, when not given, its "all" form, "All order types.", "All
   captains.". A report states the "all" form only for the filters it lists as
   dimensions in section 6; R3's only dimension is order type.
4. "Voided bills left out.", except on R10, which lists them: "Voided bills
   included."

A name in the sentence, such as a captain's, is read from the most recent bill
that carries it, never from `users`.

## 4. The checks each report runs

| Report | Checks |
|---|---|
| R1 Today | C1, C3, C4 for today |
| R2 Day Close | C1, C3, C4, C6, C8, C9 for the date, and C12 when it is closed. P14 adds C2, C5.4, C5.7, C7, C10 and C11 to the day's set. |
| R3 Sales by Day | C1, C5.6, C8 |
| R4 Hours and Weekdays | C5.5 |
| R5 Payments | C3, C4 |
| R6 Platform Money | C11 |
| R7 Cash Till | C9 for each date |
| R8 GST | C1, C5.7, C6 |
| R9 Tally Export | C1, C5.7. The file refuses to build if any ERROR check fails. |
| R10 Invoice Register | C6 |
| R11 Menu Performance | C2, C5.1, C5.2, C7 |
| R12 Captains | C5.3 |
| R13 Tables and Table Time | C5.4 |
| R14 Discounts | C1, C2 |
| R15 Cancellations and Voids | C6, C7 |
| R16 No Charge | C7 |
| R17 On Hold Accounts | C10 |
| R18 Activity Log | None. It is M8's read, unchanged. |
| R19 Bill List | C1, C2, C4 for each bill shown |

Over a range, C1, C3, C4, C6 and C8 run for every day in it and return one
result each, listing every failing day or bill in `refs` (P14).

## 5. Export

`format=xlsx`:

1. Built on the server, by `server/services/reports/exportXlsx.js`, from the
   envelope the engine already built. Never queried a second time.
2. Four sheets: **Report**, the rows and totals, one sheet section per report
   section; **Filter**, the filter sentence and the open days; **Definitions**,
   each column used with its glossary meaning; **Checks**, every result.
3. Money as numbers in rupees with two decimals and the Indian number format
   `[>=10000000]##\,##\,##\,##0.00;[>=100000]##\,##\,##0.00;##,##0.00`, so the
   file adds up in Excel. Percent as a number with two decimals. Dates as Excel
   dates. Times as India time text.
4. File name `{restaurant}-{report}-{from}-{to}.xlsx`, every space and `/`
   replaced by `-`, for example `Cafezza-R3-2026-09-26-2026-09-26.xlsx`.
5. Content type
   `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, with a
   `Content-Disposition: attachment` naming the file.
6. A failed ERROR check still downloads, and the Report sheet's first line
   names the failed check. R9 is the one exception: it refuses with 422
   `CHECK_FAILED`, naming each failed check.
7. The library is `exceljs`, added in P14.

PDF and print come from the browser's print function with an A4 stylesheet,
built in P18. No PDF library on the server.

## 6. The reports

Every path is `GET /api/v1/reports/v2/{name}`. Roles are OWNER and MANAGER
unless a report says otherwise; no other role sees a report. In the tables,
"Reads" is the stored field each column adds up.

### R1 Today, `today`

No parameters: today's business date. Live, for the dashboard; P18 builds it.

| Key | Label | Type | Reads |
|---|---|---|---|
| `billTotalInPaise` | Bill total | money | `bills.grandTotalInPaise` |
| `netSalesInPaise` | Net sales | money | `bills.taxBreakdown[].taxableInPaise` |
| `billCount` | Bills | count | `bills` |
| `covers` | Covers | count | `bills.guestCount`, dine-in |
| `averagePerCoverInPaise` | Average per cover | money | dine-in net sales ÷ dine-in covers |
| `openTables` | Open tables | count | `orders` with status `OPEN` or `READY_TO_BILL` and a `tableId` |
| `openItemTotalInPaise` | Item total | money | those orders' live line totals |
| `unpaidCount`, `unpaidInPaise` | Unpaid | count, money | `bills` with status `UNPAID` |
| `lastWeekBillTotalInPaise` | Same weekday last week | money | the same weekday last week, bills with `billedAt` up to the same time of day |

Sections `money` (R2 section B so far), `topItems` (five by
`bills.lines[].quantity`), `alerts` (voids, No Charge, discounts over 2000 basis
points of item total, items cancelled after preparation, each with its record
id). Drill: tiles to R19 with `from` and `to` set to today.

P20B: the `tiles` section follows `settings.appearance.todayTiles`. Its columns
come in that order, and a tile not in the list is left out of the columns, the
row and its drill. The figures of the tiles shown are unchanged. A key in the
list is one of the ten above, each once; anything else is a 400 on
`appearance.todayTiles` listing the allowed keys.

### R2 Day Close, `day-close`

`?date=YYYY-MM-DD`. Returns `computeDayFigures` (M16 section 4) for an open day,
or the stored `dayclosures.snapshot` for a closed one, as sections:

| Section | Rows | Reads |
|---|---|---|
| `sales` (A) | One row per line: Bills, Covers, Item total, Discount, Net sales, CGST, SGST, GST, Round-off, Bill total, Average bill, Average per cover | `snapshot.sales` |
| `money` (B) | One row per method, then Money in hand, Platform money, one row per On Hold account, Unpaid, Total | `snapshot.money` |
| `collections` (C) | One row per collection: account, method, amount | `snapshot.collections` |
| `cash` (D) | Opening float, Cash from bills, Cash collections, Paid in, Paid out, Expected cash, Counted cash, Cash difference | `snapshot.cash`, `dayclosures.countedCashInPaise` |
| `orderTypes` (E) | One row per order type, delivery by platform | `snapshot.orderTypes` |
| `gst` (F) | One row per rate; the platform row is labelled "GST paid by platform, section 9(5)" | `snapshot.gst` |
| `controls` (G) | Discounts, No Charge, Items cancelled, Wasted value, Orders cancelled, Voided bills | `snapshot.controls` |
| `invoices` (H) | One row per invoice series | `snapshot.invoices` |

Each section has columns `line` (text) and `amountInPaise` (money) or `count`.
The blind count of M16 applies: a manager does not get Expected cash or Cash
difference unless `dayClose.showCashDifferenceToManager` is on. Drill: sales and
money rows to R19 for the date, a method to `method`, an account to
`accountId`; cash rows to the cash drawer for the date; controls to R14, R15 and
R16.

Example, the golden day after close, as the owner, sections A, B and D shortened:

```json
{
  "report": "R2", "title": "Day Close",
  "filter": { "date": "2026-09-26" },
  "filterSentence": "26 Sep 2026. Business day starts 5:00 AM. Voided bills left out.",
  "openDays": [],
  "sections": [
    { "key": "sales", "title": "Sales", "rows": [
      { "line": "Bills", "count": 15 }, { "line": "Covers", "count": 27 },
      { "line": "Item total", "amountInPaise": 931022 }, { "line": "Discount", "amountInPaise": 42390 },
      { "line": "Net sales", "amountInPaise": 888632 }, { "line": "CGST", "amountInPaise": 19131 },
      { "line": "SGST", "amountInPaise": 19126 }, { "line": "GST", "amountInPaise": 38257 },
      { "line": "Round-off", "amountInPaise": 11 }, { "line": "Bill total", "amountInPaise": 926900 },
      { "line": "Average bill", "amountInPaise": 59242 }, { "line": "Average per cover", "amountInPaise": 26709 } ] },
    { "key": "money", "title": "Where the bill total went", "rows": [
      { "line": "Cash", "amountInPaise": 175400 }, { "line": "Card", "amountInPaise": 148100 },
      { "line": "UPI", "amountInPaise": 147200 }, { "line": "Money in hand", "amountInPaise": 470700 },
      { "line": "Zomato Gold", "amountInPaise": 199800 }, { "line": "Dineout", "amountInPaise": 77800 },
      { "line": "EazyDiner", "amountInPaise": 0 }, { "line": "Zomato", "amountInPaise": 30500 },
      { "line": "Swiggy", "amountInPaise": 93000 }, { "line": "Platform money", "amountInPaise": 401100 },
      { "line": "On Hold: E-210 Office", "amountInPaise": 4700 }, { "line": "On Hold: W-330 Office", "amountInPaise": 50400 },
      { "line": "Unpaid", "amountInPaise": 0 }, { "line": "Total", "amountInPaise": 926900 } ] },
    { "key": "cash", "title": "Cash drawer", "rows": [
      { "line": "Opening float", "amountInPaise": 200000 }, { "line": "Cash from bills", "amountInPaise": 175400 },
      { "line": "Cash collections", "amountInPaise": 0 }, { "line": "Paid in", "amountInPaise": 0 },
      { "line": "Paid out", "amountInPaise": 35000 }, { "line": "Expected cash", "amountInPaise": 340400 },
      { "line": "Counted cash", "amountInPaise": 340000 }, { "line": "Cash difference", "amountInPaise": -400 } ] }
  ],
  "checks": [ { "id": "C9", "severity": "WARNING", "passed": false, "message": "C9 Cash: counted ₹3,400.00, expected ₹3,404.00. ₹4.00 short.", "expected": 340400, "actual": 340000, "difference": -400, "refs": [] } ]
}
```

### R3 Sales by Day, `sales-by-day`

`from`, `to`, `orderType`. One row per business date, every date present,
zeros where there were no bills. Dimension: order type.

| Key | Label | Type | Reads |
|---|---|---|---|
| `businessDate` | Business date | date | `bills.businessDate`, shown with the weekday |
| `billCount` | Bills | count | live bills |
| `covers` | Covers | count | `bills.guestCount`, dine-in |
| `itemTotalInPaise` | Item total | money | `bills.subtotalInPaise` |
| `discountInPaise` | Discount | money | `bills.discount.amountInPaise` |
| `netSalesInPaise` | Net sales | money | `bills.taxBreakdown[].taxableInPaise` |
| `gstInPaise` | GST | money | `bills.totalTaxInPaise` |
| `roundOffInPaise` | Round-off | money | `bills.roundOffInPaise` |
| `billTotalInPaise` | Bill total | money | `bills.grandTotalInPaise` |
| `averageBillInPaise` | Average bill | money | net sales ÷ bills |
| `averagePerCoverInPaise` | Average per cover | money | dine-in net sales ÷ dine-in covers |

Totals: sums, and the two averages from the totals. `compare=previous` adds
`previous`, the same envelope for the range of the same length ending the day
before `from`. Drill: every count and money cell to R19 for that date.

### R4 Hours and Weekdays, `hours`

`from`, `to`, `orderType`. Sections `byHour`, 24 rows, hour 0 to 23 by the
India-time hour of `bills.billedAt` through `DISPLAY_TIMEZONE`, with
`billCount` (Bills) and `netSalesInPaise` (Net sales); and `weekdayByHour`, 7
rows Monday first, each with `weekday` and 24 cells `h0InPaise` to `h23InPaise`
(Net sales). Every hour and weekday is present. Totals are sums. Drill: a cell
to R19 with `hour` and `weekday`.

### R5 Payments, `payments`

`from`, `to`. **OWNER only.** Sections `days` and `collections`. `days`: one
row per business date, by each payment's own `bills.payments[].businessDate` (a
null reads as the bill's). Columns: Business date; one money column per method, keyed by code, labelled with the frozen
`methodName`, for every active method and every method used in the range even if
now inactive, zeros where unused; Money in hand; Platform money; On Hold
(`bills.chargedToAccountInPaise` by `bills.businessDate`); Unpaid (bills with
status `UNPAID`, only on open days); Bill total. `collections`: one row per
`accountentries` entry of type `COLLECTION` in the range: Business date,
Account, Payment method, Collection. Totals are sums. Drill: a method cell to R19 with that date and
`method`; On Hold to R19 with `status=ON_ACCOUNT`.

Example, the golden day, one row:

```json
{
  "report": "R5", "title": "Payments",
  "filterSentence": "26 Sep 2026. Business day starts 5:00 AM. Voided bills left out.",
  "sections": [
    { "key": "days", "title": "Payments", "rows": [ {
      "businessDate": "2026-09-26",
      "CASH": 175400, "CARD": 148100, "UPI": 147200, "inHandInPaise": 470700,
      "ZOMATO_GOLD": 199800, "DINEOUT": 77800, "EAZYDINER": 0, "ZOMATO": 30500, "SWIGGY": 93000,
      "platformInPaise": 401100, "onHoldInPaise": 55100, "unpaidInPaise": 0, "billTotalInPaise": 926900 } ] },
    { "key": "collections", "title": "Collections", "rows": [], "totals": { "amountInPaise": 0 } }
  ]
}
```

B14's payment at 12:02 AM on 27 September counts on 26 September, by its own
business date.

### R6 Platform Money, `platform-money`

`from`, `to`, `method`. Section `payouts`: one row per live payout whose period
overlaps the range: Platform (`platformpayouts.methodName`), Period, Received
payout (`amountReceivedInPaise`), Expected payout and Payout difference (M17
section 6.4, from each covered payment's frozen `commissionBps`), Bills
(covered payments), and `rateNotSetCount`. Section `uncovered`: platform
payments in the range no live payout covers: bill number, date, platform order
ID, amount, commission or "rate not set". Rate-not-set payments are listed,
never estimated. Drill: a payout to R19 with `method` and its period.

### R7 Cash Till, `cash-till`

`from`, `to`. **OWNER only.** One row per business date: R2 section D's lines,
plus Closed by and Closed at. A closed date reads the stored close; an open date
shows expected cash so far and no count. Drill: a date to R2.

### R8 GST, `gst`

`from`, `to`. Sections: `byRate` (A), one row per rate from
`bills.taxBreakdown` of `NORMAL` bills: Net sales, CGST, SGST, GST; `platform`
(B), net sales of `PLATFORM_COLLECTS` bills by frozen `bills.platform.code`;
`notSales` (C), No Charge value (`orders.noCharge.valueInPaise`) and the
voided bill total, never added to A; `documents` (D), per invoice series: first,
last, issued, voided; `roundOff` (E), the total. Drill: a rate to R19 with
`taxRateBps`; a platform to R19 with `platform`; voided to R19 with
`status=VOIDED`.

### R9 Tally Export, `tally-export`

`from`, `to`. A file only: `format=xlsx` is the only format, and `json` is a 400.
Refuses with 422 `CHECK_FAILED` when an ERROR check fails, naming each. Two sheets
besides the four standard ones' Filter, Definitions and Checks:

**Sales by rate**: columns Tax rate, Net sales, CGST, SGST, Bill total; one row
per rate from `bills.taxBreakdown`, the 0% platform row labelled "Sales 0%";
then a Round-off row; then Total.

**Sales by payment method**: columns Tally code
(`bills.payments[].tallyLedgerCode`), Payment method (`methodName`), Net sales,
CGST, SGST, Bill total; one row per method code, plus an On Hold row with the
Tally code from `settings.reports.onHoldTallyCode` (none when null), plus Unpaid when any; then Total. Each bill's net sales, CGST
and SGST are divided across its payments, its account charge and any unpaid
part with `splitBillAcrossPayments` in `server/utils/tax.js`, by the largest
remainder method weighted by amount. Round-off stays on its own row. The two
sheets always show the same total net sales, CGST and SGST.

### R10 Invoice Register, `invoice-register`

`from`, `to`, `page`, `limit`. Every bill, voided included, ordered by series
then `billSequence`. A null `invoiceSeries` belongs to its `financialYear`
series. Columns: Invoice number (`billNumber`), Business date, Time issued
(`billedAt`), Order type, Table (`tableName`), Bill total, Status (Paid, On Hold,
Unpaid or Voided), Void reason (the reason's label and note). A missing number
between the first and last of a series is its own row, Status "Missing number".
Drill: a number to R19 with `billNumber`.

### R11 Menu Performance, `menu`

`from`, `to`, `orderType`, `categoryName`. Rows by `bills.lines[].categoryName`,
or by item within a category when `categoryName` is given. Dimension: order
type.

| Key | Label | Type | Reads |
|---|---|---|---|
| `name` | Category, or Item | text | `bills.lines[].categoryName` or `itemName`, frozen |
| `quantity` | Quantity sold | count | `bills.lines[].quantity` |
| `itemTotalInPaise` | Item total | money | `bills.lines[].lineTotalInPaise` |
| `discountInPaise` | Line discount share | money | `bills.lines[].discountShareInPaise` |
| `netSalesInPaise` | Line net sales | money | `bills.lines[].taxableInPaise` |
| `gstInPaise` | Line GST share | money | `bills.lines[].taxInPaise` |
| `shareBps` | Share of net sales | percent | row net sales ÷ total net sales |
| `rank` | Rank | count | by net sales |
| `cancelledQuantity` | Cancelled quantity | count | `orders.lines[]` with status `CANCELLED` and this frozen name |
| `wastedValueInPaise` | Wasted value | money | those with `wasPrepared: true`, at line total |

Lines on bills from before P03 have null shares and a null category. They are
counted in their own row, "Not recorded", with their quantity and item total
and null shares, never silently left out and never estimated. Shares add to
10000 basis points by the largest remainder method. Totals: sums; item total,
discount and net sales equal R3 for the same range. Drill: a row to R19 with
`categoryName` or `itemName`.

Example, the golden day by category, two rows and the totals:

```json
{
  "report": "R11", "title": "Menu Performance",
  "filterSentence": "26 Sep 2026. Business day starts 5:00 AM. All order types. Voided bills left out.",
  "rows": [
    { "name": "Pizza", "quantity": 5, "itemTotalInPaise": 181000, "discountInPaise": 922, "netSalesInPaise": 180078, "gstInPaise": 7104, "shareBps": 2026, "rank": 1 },
    { "name": "Cafezza Mains", "quantity": 4, "itemTotalInPaise": 170000, "discountInPaise": 4518, "netSalesInPaise": 165482, "gstInPaise": 8275, "shareBps": 1862, "rank": 2 }
  ],
  "totals": { "quantity": 36, "itemTotalInPaise": 931022, "discountInPaise": 42390, "netSalesInPaise": 888632, "gstInPaise": 38257, "shareBps": 10000 }
}
```

### R12 Captains, `captains`

`from`, `to`, `orderType`. One row per `bills.captainId`, named with the
`captainName` of the most recent bill in the range. Columns: Captain, Bills,
Covers, Net sales, Bill total, Average per cover, Average table time (minutes
from `orderOpenedAt` to `paidAt` on dine-in paid bills, a total divided by a
count), Discounts (count and total), Items cancelled (count and value, by
`orders.lines[].cancelledBy`). Totals equal R3. Drill: a row to R19 with
`captainId`.

### R13 Tables and Table Time, `tables`

`from`, `to`, `stationId`. Section `tables`: one row per `bills.tableName` on
dine-in bills: Table, Bills, Covers, Net sales, Turns per day (bills ÷ business
dates in the range, type `decimal2`), Average table time. Section
`kitchen`: per `kots.stationName`, Kitchen time (average minutes from
`kots.firedAt` to its lines' `readyAt`) and the five slowest items. Drill: a
table to R19 with `table`.

P16: the five slowest items are a third section, `slowestItems` (Station,
Item, Items made, Kitchen time), five per station, slowest first. The kitchen
section's columns are Station, Items made and Kitchen time. Average table time
and kitchen time are `decimal2`, see section 14.

### R14 Discounts, `discounts`

`from`, `to`, `discountReason`, `page`, `limit`. Sections: `byReason`
(`bills.discount.reasonCode`, with the label; count, Discount, average percent
off as total discount ÷ total item total); `byPerson`
(`bills.discount.appliedBy`, named through `personNames`; count, Discount,
highest first); `bills`:
Invoice number, Time issued, Table, Captain, Item total, Discount, Percent off,
Bill total, Discount reason and note, Discount funded by. Drill: a bill to R19
with `billNumber`, which shows its line shares.

### R15 Cancellations and Voids, `cancellations`

`from`, `to`, `page`, `limit`. From `orders` by the business date of the cancel
time, and `bills` by `businessDate`. Sections: `items`, each cancelled line not
part of a whole-order cancel: Time (`lines[].cancelledAt`), Table, Captain
(the order's `openedBy`, named from the order's bill when billed), Item,
Quantity, Line total, Stage ("Cancelled before preparation" or "Cancelled after
preparation", from `wasPrepared`), Cancel reason (`lines[].cancelReasonCode`
label and note), Cancelled by; `orders`, each whole-order cancel: Time, Table,
Line total of its live lines, Cancel reason (`orders.cancelReasonCode`; a line
cancelled with its order takes the order's code), Cancelled by; `voids`: Invoice
number, Bill total, Void reason, Voided by, Time; `summary`: by reason, by
person, by item; and the headline Wasted value. Drill: a void to R19 with
`billNumber`; an item to the order.

Example, the golden day:

```json
{
  "report": "R15", "title": "Cancellations and Voids",
  "filterSentence": "26 Sep 2026. Business day starts 5:00 AM. Voided bills left out.",
  "headline": { "wastedValueInPaise": 39000 },
  "sections": [
    { "key": "items", "rows": [
      { "itemName": "Thecha Paneer Chilli", "quantity": 1, "lineTotalInPaise": 39000, "stage": "AFTER_PREPARATION", "reason": "Guest changed the order", "tableName": "Table 11", "cancelledByName": "Khuman Singh" },
      { "itemName": "Cheesy Tornado", "quantity": 1, "lineTotalInPaise": 36000, "stage": "BEFORE_PREPARATION", "reason": "Wrong item entered", "tableName": "Table 11", "cancelledByName": "Khuman Singh" } ],
      "totals": { "quantity": 2, "lineTotalInPaise": 75000 } },
    { "key": "orders", "rows": [], "totals": { "count": 0, "lineTotalInPaise": 0 } },
    { "key": "voids", "rows": [
      { "billNumber": "CFA/C/22452", "billTotalInPaise": 34700, "reason": "Billed to the wrong table", "voidedByName": "Manager" } ],
      "totals": { "count": 1, "billTotalInPaise": 34700 } }
  ],
  "checks": [ { "id": "C6", "passed": true }, { "id": "C7", "passed": true } ]
}
```

`cancelledByName` and `voidedByName` come from `personNames`, from the stored
`lines[].cancelledBy`, `cancelledBy` and `voidedBy` ids.

### R16 No Charge, `no-charge`

`from`, `to`, `page`, `limit`. `orders` with status `NO_CHARGE`, by
`noCharge.businessDate`: Time (`noCharge.at`), Table, Items, No Charge value
(`noCharge.valueInPaise`, labelled "No Charge value, before GST"), Reason and
note, Requested by (`openedBy`), Approved by (`noCharge.approvedBy`). Totals:
count and value. Drill: a row to the order.

### R17 On Hold Accounts, `accounts`

`asOf` (a business date, default today), `accountId`, `from`, `to`. Section
`accounts`, every account as of `asOf`: Account, Opening balance, Charged,
Collected, Outstanding, Oldest unpaid bill (date and age in days), from
`accounts` and `accountentries`. Section `statement` when `accountId` is given:
the M16 statement. Drill: Charged to R19 with `accountId`.

### R18 Activity Log

M8 Audit Trail, as written: `GET /api/v1/audit` and `GET /api/v1/audit/summary`,
unchanged, with M8's own roles. Not under `/reports/v2`, and not through the
engine. P17 part A builds it.

### R19 Bill List, `bills`

Every filter in section 2, `page`, `limit`. The page every drill down opens.
Columns: Invoice number, Business date, Time issued (`billedAt`), Time paid
(`paidAt`), Table or order type, Captain, Covers, Item total, Discount, Net
sales, GST, Round-off, Bill total, Paid with (each payment's `methodName`), and
Status. Totals cover every matching bill, across pages. `status=VOIDED` lists
voided bills; otherwise voided bills are left out.

`GET /api/v1/reports/v2/bills/:billId` returns one bill in full: lines with
shares, payments with corrections, the discount with who applied it, the account
charge, void details, and a timeline from the order and the bill: opened, each
line added, each KOT fired, each line ready, served or cancelled, billed,
discounted, each payment, charged, voided, each with its time.

**Every drill down R19 must express**, checked report by report: a date or
range (`from`, `to`) for R2 to R5, R7, R8 and R10; `method` for R2 B, R5 and R6;
`status=ON_ACCOUNT`, `status=UNPAID`, `status=VOIDED` and `accountId` for R2,
R5, R8 and R17; `orderType` and `platform` for R2 E, R3 and R8 B; `taxRateBps`
for R2 F and R8 A; `hour` and `weekday` for R4; `categoryName` and `itemName`
for R11; `captainId` for R12; `table` for R13; `discountReason` and `billNumber`
for R14; `billNumber` for R10, R15 and R19 itself; `hasDiscount` and
`hasCancellations` for R2 G. Cash drawer lines, payouts, cancelled lines and No
Charge orders are not bills and open their own records instead.

## 7. Indexes

| Report | Main read | Index |
|---|---|---|
| R1 to R4, R8, R11, R12, R14, R19 | `bills` by date | `{ restaurantId, branchId, businessDate, isVoided }`, exists |
| R5, R6 | payments by their own business date | **new** `{ restaurantId, branchId, "payments.businessDate" }` on `bills` |
| R6 | payouts by method and period | `{ restaurantId, method, periodFrom, periodTo }`, exists |
| R10, C6 | a series in sequence order | **new** `{ restaurantId, branchId, invoiceSeries, billSequence }` on `bills` |
| R15, R2 G | lines by cancel time | **new** `{ restaurantId, branchId, "lines.cancelledAt" }` on `orders` |
| R15 | whole orders by cancel time | **new** `{ restaurantId, branchId, cancelledAt }` on `orders`, partial on `isCancelled: true` |
| R16 | No Charge orders by date | **new** `{ restaurantId, branchId, status, "noCharge.businessDate" }` on `orders` |
| R17 | entries by account and time | `{ restaurantId, accountId, at }`, exists |
| R2 C | collections by date | `{ restaurantId, branchId, businessDate, type }` on `accountentries`, exists |
| R7, open days | closes by date | `{ restaurantId, branchId, businessDate }` on `dayclosures`, exists |
| R13 kitchen | KOTs by station and time | `{ restaurantId, branchId, stationId, createdAt }`, exists |

P14 adds the five new ones. Each starts with `restaurantId`.

## 8. Permissions

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| R1 `today` | yes | yes | no | no | no | no |
| R2 `day-close` | yes | yes, blind count | no | no | no | no |
| R3 `sales-by-day` | yes | yes | no | no | no | no |
| R4 `hours` | yes | yes | no | no | no | no |
| R5 `payments` | yes | no | no | no | no | no |
| R6 `platform-money` | yes | yes | no | no | no | no |
| R7 `cash-till` | yes | no | no | no | no | no |
| R8 `gst` | yes | yes | no | no | no | no |
| R9 `tally-export` | yes | yes | no | no | no | no |
| R10 `invoice-register` | yes | yes | no | no | no | no |
| R11 `menu` | yes | yes | no | no | no | no |
| R12 `captains` | yes | yes | no | no | no | no |
| R13 `tables` | yes | yes | no | no | no | no |
| R14 `discounts` | yes | yes | no | no | no | no |
| R15 `cancellations` | yes | yes | no | no | no | no |
| R16 `no-charge` | yes | yes | no | no | no | no |
| R17 `accounts` | yes | yes | no | no | no | no |
| R18 M8 `audit` | as M8 | as M8 | no | no | no | no |
| R19 `bills`, `bills/:billId` | yes | yes | no | no | no | no |

## 9. Error codes added by M19

| Code | Status | When |
|---|---|---|
| `CHECK_FAILED` | 422 | The Tally export would be built while an ERROR check fails; `checks` lists each |

## 10. Decisions

**Every M19 report has its own path under `/reports/v2/`**, including R3, R4 and
R14, which REPORT-SPEC section 4 said would extend M6's paths. M6's
`sales-by-day`, `hourly` and `discounts` return a different shape that M6's
screens read, and those screens stay live until P18 replaces them. Extending in
place would have broken them; a second path leaves both working, and P18
retires the M6 endpoints together with the screens that use them.

## 11. Fields a report needs that are not stored

Listed rather than invented. None blocks a figure; each affects only a label.

| Need | Today | Effect |
|---|---|---|
| The name of whoever applied a discount, cancelled a line or an order, voided a bill, or approved a No Charge, as it was at the time | Only the user id is stored | Reports show the person's current name, through `personNames`. Renaming a user renames them on old reports. Freezing names would need new fields on `bills` and `orders`, a schema change to decide in its own prompt. |
| The captain of an order that was never billed (a cancelled order, a No Charge) | `orders.openedBy`, an id | Shown through `personNames` like the above |

## 12. Settled while building P14

`runReport` returns `{ envelope, meta, params }`; a paged report answers
`{ success, data: envelope, meta }`. A definition exports `id`, `name`,
`title`, `roles`, `schema`, `filters`, `dimensions`, `columns`, `query(req,
baseMatch, params, ctx)` and `checks(req, params, result, ctx)`, and may export
`includesVoided(params)` and `dateField`.

R19 is sorted by `billedAt`, then `billSequence`. Its `place` column shows the
table, or the platform and its order number, or the order type. Its `status`
column is in words: Paid, On Hold, Unpaid, Voided.

C10 is an ERROR when an entry's stored direction disagrees with its type, and
a WARNING when a balance is below zero. C11 adds the count of payments with no
commission rate to its message. C12 ignores a payment method row that is zero in
both the stored and the fresh figures, so adding or retiring a method after a
close does not count as a change.

The Excel number format for money is
`[>=10000000]##\,##\,##\,##0.00;[>=100000]##\,##\,##0.00;##,##0.00`.


## 13. Settled while building P15

R2's sections share three columns, `line` (Figure), `count` (Count) and
`amountInPaise` (Value), labels from GLOSSARY section 13. Two sections carry
more on each row: `orderTypes` adds `netSalesInPaise` and `covers`, `gst` adds
`cgstInPaise`, `sgstInPaise` and `gstInPaise`, and `invoices` rows are
`{ line, first, last, issued, voided, gaps }`. R2 also returns `isClosed`,
`status`, `figures` (the raw day figures, blind count applied) and `blockers`
beside its sections, so the Day Close screen can read one envelope. A closed
day's checks are its stored-day checks plus C12.

`splitBillAcrossPayments(bill)` in `server/utils/tax.js` returns one part per
payment, then `ON_HOLD` for `chargedToAccountInPaise`, then `UNPAID` for any
remainder, each `{ kind, method, methodName, tallyLedgerCode, amountInPaise,
netSalesInPaise, cgstInPaise, sgstInPaise }`. Net sales, CGST and SGST are each
split by the largest remainder method weighted by `amountInPaise`, and the
function throws if any figure does not add back exactly. A bill with no money
against it is one `UNPAID` part carrying all of it.

R9's On Hold row takes its Tally code from `settings.reports.onHoldTallyCode`
(P25 Part J). It was the constant `P03` before P25. `format=json`
or no format is a 400. The 422 `CHECK_FAILED` carries `checks`, the failed
checks in the envelope's check shape, and its message names each one.

An xlsx export of a report with sections writes them one under another on the
Report sheet, each with its title; R9 writes one sheet per section instead.

## 14. Settled while building P16

**R11.** With no `categoryName`, rows are categories, grouped by the frozen
`categoryId` and named from the most recent bill. With `categoryName`, rows are
items in that category, grouped by `menuItemId` and the frozen `variantName`,
named "Item (Variant)"; the first column's label is then Item, so a definition
may return its own `columns` and the engine uses them. A dish cancelled in the
range but not sold appears with 0 sold and its cancelled quantity. Cancelled
quantity counts every cancelled line, wasted value only those with
`wasPrepared: true`. C5.1 and C5.2 each compare item totals over every line,
then net sales over the lines with shares, against a whole read separately:
every bill's `subtotalInPaise`, and the net sales of bills whose lines all
carry shares. The contract's "items that sold nothing" option was not built:
it is not in this contract, and would be the one read of `menuitems`.

**R12.** Columns: Captain, Bills, Covers, Net sales, Bill total, Average per
cover (dine-in net sales ÷ covers, as R3), Average table time, Discounted bills,
Discount, Items cancelled (a count of quantity) and Cancelled value (their line
total, prepared or not). A bill with no `captainId` groups as "Not recorded".
A person who cancelled items but captained no bill in the range gets a row with
their current name from `personNames`.

**Averages of minutes.** The `minutes` type is whole minutes, so an average
cannot be one. Average table time and kitchen time are sent as `decimal2`,
integer hundredths, worked out to one decimal place: a total of whole minutes
divided by a count, after totalling. 60.5 minutes is sent as 6050. With nothing
to average the cell is `null`, never 0.

**R13.** C5.4 compares the dine-in tables' bill totals plus each other order
type's against every bill's bill total. The table's section is not shown: the
contract names no column for it, and the bill does not freeze it. Turns per day
rounds half up to hundredths.

Labels added to GLOSSARY section 13: Discounted bills, Cancelled value, Items
made.

## 15. Settled while building P17

**R18 is M8.** P17 asked for a thin R18 definition under the engine; this
contract's R18 entry says M8's own `GET /audit` and `GET /audit/summary`, not
under `/reports/v2` and not through the engine. The contract was followed: R18
is the M8 read, with M8's roles and manager restriction, and no envelope or
Excel file of its own.

**R14.** Sections `byReason` (in the order of the fixed reason list), `byPerson`
(by `discount.appliedBy`, highest first) and `bills`, which alone is paged; its
totals cover every bill. Percent off is `discount × 10000 ÷ item total`, rounded
half away from zero like `averagePaise`. The bill columns name the totals in
full: Item total before discount, Bill total after discount. Discount funded by
reads Restaurant or Platform.

**R15.** `items` is paged; the other sections are not. Each item row carries
`stage` as the code, as in the example above, and `stageLabel` in words, which
is the column shown. A reason reads "label: note" when there is a note. The
summary has three sections, `byReason`, `byPerson` and `byItem`, over every
cancelled line, including those cancelled with their order under the order's
reason. Wasted value counts lines with `wasPrepared: true` either way, and is
`headline.wastedValueInPaise`. An item or order drills to `{ report: "ORDER",
query: { orderId } }`.

**R16.** Columns Time, Table, Item (the order's live lines as text), No Charge
value before GST, No Charge reason, Requested by, Approved by; paged. Drills to
the order.

**R17.** `asOf` defaults to today's business date, and `from` and `to` to
`asOf`, through a `prepare(req, params)` hook the engine now calls before the
range check. Balances come from `accountService.listAccounts(req, { asOf })`,
which now also returns each account's opening, charged (net of reversals),
collected and adjusted amounts; `outstandingFor` takes `asOf` too. An inactive
account with nothing owed is left out. Oldest unpaid bill is two columns, the
date and Age in days.

Labels added to GLOSSARY section 13: Item total before discount, Bill total
after discount, No Charge value before GST, No Charge reason, Age in days.

## 16. Settled while building P18

**R1.** Sections `tiles` (one row, the contract's keys), `money` (each method,
each On Hold account, and Unpaid bill, with totals `amountInPaise`,
`inHandInPaise` and `platformInPaise`), `topItems` (five, quantity then name),
and `alerts` (Time, kind in words, the bill number, table or item, and Value;
`kindCode` carries the code). The envelope adds `date` and `asAt`. The day's
figures come from `computeDayFigures(req, date, { upTo: now })`: the new `upTo`
option replays the loaded records as they stood at that instant (a bill issued
later left out, a later payment, charge or void taken off), and Day Close and
R2 never pass it. `unpaidInPaise` is what is still owed on unpaid bills, the
same figure as R2's Unpaid line. A discount alert is one above 2000 basis points
of the bill's item total. R1 uses the engine's `prepare` hook to fix today's
business date.

**Drill targets.** A drill whose `report` is `ORDER` opens the order screen
`/orders/{orderId}`; any other report id opens that report's screen with the
query.

**Screens.** Every report except R18 and R19 renders through one page,
`/reports/{name}`. R18 is its own screen over `GET /audit`. The old M6 screens
for sales, tax, discounts, payments and today are gone; `/reports/sales` and
`/reports/tax` redirect to R3 and R8, and `/reports/discounts` and
`/reports/payments` are R14 and R5. The M6 endpoints stay.

## 17. P29 changes

Additive: no column is renamed and no figure moves, except where the cash
formula itself changed (M16 section 9.1).

**R15 Cancellations and Voids.**

1. An item removed from an unpaid bill (M3 section 16.8.1) is a row of `items`
   like any line cancelled on its own, with `stage` `REMOVED_FROM_BILL` and
   `stageLabel` "Removed from the bill before payment". Its wasted value still
   follows `wasPrepared`. It is never a row of `voids`, because no bill was
   voided.
2. A new section, `billChanges`, "Bills changed before payment": one row per
   revision whose time is in the range: Invoice number, Time, Change ("Removed"
   or "Added"), Items, Bill total before, Bill total after, Changed by, Approved
   by, and "After printing" (Yes or No). Totals: count, and the value removed
   (the sum of before minus after on `REMOVED` rows).
3. A new section, `paidBeforePrint`, "Bills paid before printing": Invoice
   number, Time issued, Bill total, for live bills of the range with
   `paymentBeforePrint` true. Totals: count and bill total.
4. R15 also runs C13.

**R2 Day Close.** `figures.controls` gains `billRevisions: { count,
removedValueInPaise, addedValueInPaise, afterPrintingCount }`, the revisions
made on that business date, shown as the controls line "Bills changed before
payment ({count})", value removed. Its cash section shows the cash book's lines
(M16 section 9): brought forward from, top-ups, expenses by category, cash taken
out, expected cash, counted cash, kept for tomorrow, taken out at close, and the
opening difference. It runs C13 and C14 for the day.

**R7 Cash Till.** The columns are, in order: Business date, Brought forward,
Opening float, Opening difference, Top-ups, Cash from bills, Cash collections,
Expenses, Cash taken out, Expected cash, Counted cash, Cash difference, Kept for
tomorrow, Taken out at close, Cash count, Closed by, Time. "Paid in" and "Paid
out" read Top-ups and Expenses, the same figures. A new section,
`expensesByCategory`, "Expenses by category": one row per category with a column
per business date and a total, and a totals row. Cash taken out is never an
expense here.

**R10 Invoice Register.** Each row gains `revision`, shown as "Revised" with the
count when above 0, and nothing otherwise. No row is added for a revision: a
revision uses no number.

## 18. Checks added by P29

**C13 Revision trail**, ERROR. For every live bill of the range with `revision`
above 0, the last entry of `revisions` has `newGrandTotalInPaise` equal to the
bill's `grandTotalInPaise`, and `revisions` has exactly `revision` entries. Run
by R2 (and Day Close), R10 and R15.

**C14 Brought forward**, WARNING. For every business date of the range whose
opening float was brought forward, the float equals the kept cash of the closed
day it came from. The message names both amounts and the note. Run by R2 (and
Day Close) and R7.

---

# M14 Online Ordering and Reservations

Owner: Rishi. Specified 2026-10-08, before any code, for P23. The data is in
DB-SCHEMA sections 26 to 28.

A guest orders takeaway or requests a table from the restaurant's own public
page. Every request waits for a staff member to accept it. Accepting a takeaway
creates an ordinary `TAKEAWAY` order. Seating a reservation creates an ordinary
`DINE_IN` order. Both go through the same `openOrder`, in
`services/orderOpenService.js`, that `POST /orders` uses, so nothing about numbering, snapshots, tax or tables is
written twice.

Not in M14 yet: the QR self-order at the table, delivery from the restaurant's
own page, and taking payment online.

## 1. Rules every M14 endpoint obeys

1. **Public endpoints** live under `/api/v1/public/:slug`. They take no token
   and set no cookie. They are mounted before the authenticated routes, and
   never behind `authenticate`.
2. The slug is resolved in exactly one place,
   `publicSiteService.resolveSlug`. It sets `req.restaurantId`, `req.branchId`
   and `req.publicSite`, and every later query is `scoped(req)` under the
   tenant guard. It is the only new `skipTenantGuard` use.
3. These all give the same 404 `NOT_FOUND` body: an unknown slug, an inactive
   branch, an inactive restaurant, and `settings.features.online` switched off.
   The body never tells an outsider which of them happened.
4. A public response is a whitelist of the fields named below. It never
   carries a user id, a staff name, a table, a staff note, or another guest's
   request.
5. Public routes are outside the general limiter. They have their own limits:
   reads 300 per 5 minutes per address; writes 6 per 15 minutes per address,
   and separately 6 per 15 minutes per phone (hashed).
6. **Staff endpoints** live under `/api/v1/online`, behind the normal chain,
   with `requireFeature('online')` after `tenant`.
7. Money is in paise. Times are UTC ISO strings. The page shows them in India
   time.

## 2. Public endpoints

### 2.1 `GET /api/v1/public/:slug`

```json
{
  "success": true,
  "data": {
    "restaurantName": "Cafezza",
    "wordmark": "Cafezza",
    "address": { "line1": "...", "city": "Gandhinagar" },
    "contactPhone": "9876543210",
    "logo": { "darkGround": "/api/v1/public/cafezza/logo/DARK_GROUND", "lightGround": null },
    "appearance": { "accentHex": "#49302D", "neutralTone": "WARM" },
    "hours": { "opensAtMinutes": 600, "closesAtMinutes": 1380 },
    "pageNote": "Pay at the counter when you collect.",
    "takeaway": { "enabled": true, "openNow": true, "pausedUntil": null, "earliestPickupAt": "2026-10-08T13:50:00Z" },
    "reservations": { "enabled": true, "maxPartySize": 10, "daysAhead": 14 }
  }
}
```

`GET /api/v1/public/:slug/logo/:slot` serves the logo bytes exactly like
`GET /restaurant/logo/:slot` (P22), with the hash as the ETag.

### 2.2 `GET /api/v1/public/:slug/menu`

The same categories and order as `GET /menu`, active and available only, with
each item reduced to:

```json
{ "id": "...", "name": "Masala Chai", "description": null, "priceInPaise": 9000,
  "variants": [{ "id": "...", "name": "Large", "priceInPaise": 12000 }],
  "addOns":   [{ "id": "...", "name": "Extra ginger", "priceInPaise": 1000 }] }
```

Unavailable variants and add-ons are left out. Prices are before GST, and the
page says so. `Cache-Control: public, max-age=30`.

### 2.3 `POST /api/v1/public/:slug/quote`

Body: `{ "lines": [ { "menuItemId", "variantId"?, "addOnIds"?, "quantity", "notes"? } ] }`,
1 to 30 lines, quantity 1 to 20.

Response: the lines as `buildLineSnapshots` prices them (`itemName`,
`variantName`, `unitPriceInPaise`, `addOns`, `quantity`, `lineTotalInPaise`),
and `estimate: { itemTotalInPaise, gstInPaise, roundOffInPaise, billTotalInPaise }`
from `computeBillTotals`. It writes nothing. 422 names any item that is
inactive or unavailable.

### 2.4 `POST /api/v1/public/:slug/orders`

```json
{
  "idempotencyKey": "b3f1c2d4-...",
  "customerName": "Rishi",
  "customerPhone": "9876543210",
  "pickup": "ASAP",
  "lines": [{ "menuItemId": "...", "quantity": 2 }],
  "note": "Less sugar please",
  "marketingConsent": false,
  "website": ""
}
```

| Field | Rule |
|---|---|
| `idempotencyKey` | A UUID made by the page. Repeating it returns the existing request with 200. |
| `customerName` | 1 to 60 characters, trimmed |
| `customerPhone` | An Indian mobile number, normalised to 10 digits |
| `pickup` | `"ASAP"`, or an ISO time on today's business date, at least `takeawayMinLeadMinutes` ahead and inside opening hours |
| `lines` | As in 2.3 |
| `note` | Up to 200 characters |
| `marketingConsent` | Boolean, default false. See DB-SCHEMA section 26. |
| `website` | The honeypot. Must be empty or absent, else 400. |

201:

```json
{ "id": "...", "reference": "W-42", "status": "WAITING", "statusToken": "k3J...",
  "pickupAt": "2026-10-08T14:00:00Z", "answerBy": "2026-10-08T13:45:00Z",
  "lines": [ ], "estimate": { } }
```

`statusToken` is returned once, here, and never again.

Errors: 400 `VALIDATION_FAILED`. 422 `ONLINE_CLOSED`, when takeaway is off,
paused or outside hours; the message is the sentence the page shows. 422
`TOO_MANY_OPEN_REQUESTS`, at 2 waiting orders for one phone. 422
`BUSINESS_RULE_VIOLATED`, naming an unavailable item. 429 `RATE_LIMITED`.

### 2.5 `GET /api/v1/public/:slug/orders/:id`

Header `X-Status-Token`. A missing or wrong token is 404, the same as an
unknown id.

```json
{ "reference": "W-42", "status": "ACCEPTED", "pickupAt": "...", "answerBy": "...",
  "lines": [ ], "estimate": { }, "declineReason": null, "orderNumber": 318 }
```

`declineReason` is the reason's guest-facing label only, never the staff
note. It does not return the phone number. `Cache-Control: no-store`.

### 2.6 `POST /api/v1/public/:slug/orders/:id/cancel`

Header `X-Status-Token`. Allowed only while `WAITING`, else 409
`REQUEST_ALREADY_DECIDED`. Sets `CANCELLED`.

### 2.7 `GET /api/v1/public/:slug/reservations/slots?date=YYYY-MM-DD&partySize=4`

The times a guest may request on that business date: every
`reservationSlotMinutes` step from opening until `reservationHoldMinutes`
before closing, later than now plus `takeawayMinLeadMinutes`. The date must
be within `reservationDaysAhead`. `partySize` is 1 to `reservationMaxPartySize`.

```json
{ "date": "2026-10-10", "slots": ["2026-10-10T13:30:00Z", "2026-10-10T14:00:00Z"] }
```

There is no automatic capacity in v1. Every request is confirmed by a person.

### 2.8 `POST /api/v1/public/:slug/reservations`

```json
{ "idempotencyKey": "...", "guestName": "Rishi", "guestPhone": "9876543210",
  "partySize": 4, "at": "2026-10-10T14:00:00Z", "note": "Birthday",
  "marketingConsent": true, "website": "" }
```

`at` must be one of the slots 2.7 would return. 201:
`{ id, reference: "R-17", status: "REQUESTED", statusToken, at, partySize, answerBy }`.
Errors as in 2.4. The open-request limit is 3 per phone.

### 2.9 `GET /api/v1/public/:slug/reservations/:id` and `POST .../:id/cancel`

As 2.5 and 2.6. The guest may cancel while `REQUESTED` or `CONFIRMED`, up to
`at`.

## 3. Staff endpoints

### 3.1 `GET /api/v1/online/inbox`

The poll behind the alert. Cheap: two counts and two `findOne`s on indexed
fields.

```json
{ "waitingOrders": 2, "waitingReservations": 1,
  "oldestWaitingAt": "...", "oldestAnswerBy": "...", "latestRequestAt": "...",
  "latest": { "kind": "ONLINE_ORDER", "reference": "W-42", "itemCount": 3,
              "pickupAt": "...", "partySize": null, "at": null },
  "pausedUntil": null }
```

Roles: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`.

### 3.2 Online orders

| Endpoint | Body | Roles |
|---|---|---|
| `GET /online/orders?status=&date=&page=&limit=` | | OWNER, MANAGER, CASHIER, WAITER |
| `GET /online/orders/:id` | | same |
| `POST /online/orders/:id/accept` | `{ pickupAt?, fireNow = true, acceptChangedPrices = false }` | OWNER, MANAGER, CASHIER |
| `POST /online/orders/:id/decline` | `{ reasonCode, note? }` | OWNER, MANAGER, CASHIER |

The staff view of an online order carries every stored field except
`statusTokenHash`, plus the derived `status` (with `EXPIRED`), and
`decidedByName` resolved on read.

Accept response 200: `{ onlineOrder, order, kots }`. Errors:

- 409 `REQUEST_ALREADY_DECIDED`, with `currentStatus` beside the message.
- 422 `ONLINE_ORDER_CHANGED`, with
  `changes: [{ itemName, variantName, wasInPaise, nowInPaise }]` or
  `[{ itemName, unavailable: true }]`. Prices only are overridable, with
  `acceptChangedPrices`. Unavailability never is.
- A moved `pickupAt` must be later than now and inside opening hours, else 400.

Decline reason codes, from `server/config/onlineReasons.js`:

| Code | Staff label | Guest label |
|---|---|---|
| `ITEM_UNAVAILABLE` | An item is not available | Something you ordered is not available right now |
| `TOO_BUSY` | Too busy right now | The cafe is too busy to take this right now |
| `CLOSING_SOON` | Closing soon | The cafe is closing soon |
| `FULLY_BOOKED` | No table free then | There is no table free at that time |
| `SUSPECTED_FAKE` | Looks like a fake request | The cafe could not confirm this |
| `OTHER` | Other (note required) | The cafe could not take this |

The same list serves bookings. The staff screens leave `FULLY_BOOKED` off a
takeaway and `ITEM_UNAVAILABLE` off a booking.

### 3.3 Reservations

| Endpoint | Body | Roles |
|---|---|---|
| `GET /online/reservations?date=&status=` | | OWNER, MANAGER, CASHIER, WAITER |
| `GET /online/reservations/:id` | | same |
| `POST /online/reservations` | `{ guestName, guestPhone, partySize, at, note?, tableId? }`, `source: PHONE`, created `CONFIRMED` | OWNER, MANAGER, CASHIER |
| `POST /online/reservations/:id/confirm` | `{ at?, tableId? }` | OWNER, MANAGER, CASHIER |
| `POST /online/reservations/:id/decline` | `{ reasonCode, note? }` | OWNER, MANAGER, CASHIER |
| `POST /online/reservations/:id/seat` | `{ tableId, guestCount }` | OWNER, MANAGER, CASHIER, WAITER |
| `POST /online/reservations/:id/no-show` | | OWNER, MANAGER, CASHIER |
| `POST /online/reservations/:id/cancel` | `{ note }` | OWNER, MANAGER, CASHIER |

- Confirm with a table: another `CONFIRMED` reservation on that table whose
  time is within `reservationHoldMinutes` either side gives 409
  `RESERVATION_CLASH`, with `clashes: [{ reference, at }]`.
- Seat opens a `DINE_IN` order through `openOrder`, with
  `origin: { kind: "RESERVATION", id, reference }`. Every rule of 12.1
  applies, including `TABLE_OCCUPIED` with `existingOrderId`. Response:
  `{ reservation, order }`.
- No-show is allowed from 15 minutes after `at`. Before that it is 422.
- Every transition out of a decided status is 409 `REQUEST_ALREADY_DECIDED`.

### 3.4 Pausing takeaway

| Endpoint | Body | Roles |
|---|---|---|
| `POST /online/pause` | `{ minutes: 15 \| 30 \| 60 \| 120 }` or `{ untilClose: true }` | OWNER, MANAGER, CASHIER |
| `POST /online/resume` | | OWNER, MANAGER, CASHIER |

Both write `branches.online.pausedUntil` and `pausedBy`. Reservations are never
paused.

### 3.5 The page address

`PATCH /api/v1/online/site`, OWNER only: `{ publicSlug }`. 3 to 40 characters,
lowercase letters, digits and single dashes, not starting or ending with a
dash. These are reserved: `api`, `admin`, `login`, `r`, `static`, `assets`,
`www`. 409 `DUPLICATE` if another branch anywhere has it. `null` takes the page
down.

### 3.6 Additions to existing endpoints

- `GET /auth/me` gains `online: { enabled, takeawayEnabled,
  reservationsEnabled, alertRoles, publicSlug, pausedUntil }`.
- `GET /settings` and `PATCH /settings` gain the `online` group (DB-SCHEMA
  section 17), and `features.online`. Owner only, as every setting is, and
  audited as `SETTINGS_CHANGED`.
- `GET /tables` occupancy gains `upcomingReservation`
  (`{ id, reference, at, partySize, guestName }` or null). It is set for a table
  with no occupying order and a `CONFIRMED` reservation on it starting within
  the next `reservationHoldMinutes`.
- Every order response gains `origin` (`{ kind, id, reference, pickupAt }` or
  null), and every bill response the same `origin`, frozen at bill time.

## Permission summary for M14

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| `/public/*` | no token | | | | | |
| GET inbox, lists, one | yes | yes | yes | yes | no | no |
| Accept, decline an order | yes | yes | yes | no | no | no |
| Phone booking, confirm, decline, no-show, cancel | yes | yes | yes | no | no | no |
| Seat a reservation | yes | yes | yes | yes | no | no |
| Pause, resume | yes | yes | yes | no | no | no |
| PATCH `/online/site`, settings `online` | yes | no | no | no | no | no |

## Error codes added by M14

```
ONLINE_CLOSED             422  takeaway or reservations off, paused, or outside hours
TOO_MANY_OPEN_REQUESTS    422  this phone already has the most open requests allowed
REQUEST_ALREADY_DECIDED   409  the request is no longer waiting; currentStatus beside the message
ONLINE_ORDER_CHANGED      422  a price or availability changed since the guest's quote; changes beside the message
RESERVATION_CLASH         409  the table has another confirmed booking inside the hold window; clashes beside the message
```

## Decisions made for M14

| Decision | Reason |
|---|---|
| Every request waits for a person to accept it | It is the protection against fake orders without an SMS provider, and a cafe already confirms phone orders this way. |
| Accept creates the order, and snapshots prices then | CLAUDE.md copies prices when the order is created. The guest's quote is a display record, and a change between quote and accept is shown, never absorbed silently. |
| One shared `openOrder`, in `services/orderOpenService.js` | A second way of creating an order would drift from the first. |
| Expiry is derived on read | The server has no scheduler, and adding one for this would be the only one. |
| The slug lives on the branch | An online page is one outlet's: its address, its hours, its pause. `branchId` is already on every record. |
| No capacity engine in v1 | A person confirms every booking, and Caffeza's room is still TO CONFIRM. A rule that refused bookings automatically would be wrong more often than a manager. |
| Public routes are outside the general limiter | Guests on mobile networks share addresses with strangers, and must never use up the cafe's own staff budget. |
| No audit lines for accept and decline | They are not money events. The request records who decided and when. The order and bill that follow carry their usual audit trail. |

## Settled while building P23

**The accept path claims, then releases.** It is not one transaction. Opening
an order and firing it are not session-aware, and threading a session through
both would have changed M2's two busiest paths for one caller. Instead the
request is claimed with a write filtered on `status: WAITING` and
`answerBy > now`, so exactly one person wins. If the quote check or the order
fails, the claim is put back to `WAITING`. Once the order exists it is never
undone. A failed fire is reported as `fireError` beside `{ onlineOrder, order,
kots }`, and the order can be sent from its own screen. A test removes the
status filter and watches the two-cashier test fail.

**`GET /public/:slug`, the fields as built.** `takeaway` also carries
`latestPickupAt` (closing time) and `message`, the sentence the page shows when
takeaway is closed or paused. `hours` also carries `todayOpensAt` and
`todayClosesAt`. `appearance` is `{ accent, accentNight, neutralTone, brandHex,
onBrandHex }`, as `/auth/me` resolves them. `consentText` is the offers sentence
with the restaurant's name filled in. The page draws the wordmark, not the logo
image, because only `BrandLogo` draws an image, and it reads the device's saved
brand.

**Bookings.** Seating is allowed from `REQUESTED` (not expired) as well as
`CONFIRMED`, so a guest who walks in before anyone confirmed is not turned
away. Confirm also changes the time or table of a `CONFIRMED` booking. A phone
booking may be for any later time, not only an offered slot. The floor's
`upcomingReservation` runs from 15 minutes before now, for guests running late,
to `reservationHoldMinutes` ahead.

**Limits.** Placing has a third limiter, per phone number hashed, 6 per 15
minutes, across addresses.

**Not built.** The QR code for the page address, which needs a client library
nobody has chosen yet; the link has a Copy button. Hindi and Gujarati on the
public page.


## 4. Advance payment (P24)

Specified 2026-10-08, before code. Razorpay, through the cafe's own account and
Payment Links. The data is in DB-SCHEMA section 29.

### 4.1 Connecting the cafe's Razorpay account

| Endpoint | Body | Roles |
|---|---|---|
| `GET /api/v1/settings/payments/gateway` | | OWNER |
| `PUT /api/v1/settings/payments/gateway` | `{ keyId, keySecret, webhookSecret, reason }` | OWNER |
| `DELETE /api/v1/settings/payments/gateway` | `{ reason }` | OWNER |

`GET` returns `{ connected, provider: "RAZORPAY", keyId, mode, connectedAt,
webhookUrl }`. `mode` is `TEST` for a `rzp_test_` key and `LIVE` for `rzp_live_`.
`webhookUrl` is `{origin}/api/v1/public/{slug}/payments/webhook`, the address
the owner pastes into Razorpay's dashboard for the `payment_link.paid` event.
Secrets are never returned.

`PUT` checks the keys by asking Razorpay for one payment link. If Razorpay
refuses them, the answer is 422 `PAYMENT_GATEWAY_ERROR`, "Razorpay did not
accept these keys." Without `PAYMENT_SECRETS_KEY` on the server, the answer is
422 `PAYMENT_GATEWAY_NOT_CONNECTED`, "Online payment is not set up on this
server." On success the secrets are stored encrypted, and the payment method
`ONLINE` ("Paid online", `IN_HAND`) is created if missing. Audit:
`PAYMENT_GATEWAY_CONNECTED`, `PAYMENT_GATEWAY_DISCONNECTED`, with the key id
and mode, never a secret.

Disconnecting does not touch payments already taken: their refunds still go
through. It stops new ones.

### 4.2 Settings

`settings.online` gains (DB-SCHEMA section 28):

| Field | Default | Meaning |
|---|---|---|
| `takeawayPrepay` | `false` | Takeaway is paid in full online before the cafe sees it |
| `depositPerPersonInPaise` | `0` | A booking's deposit per person. 0 means no deposit. |
| `depositRefundCutoffMinutes` | `120` | A guest cancelling at least this long before the booking is refunded |
| `paymentWindowMinutes` | `15` | How long a payment link stays open |

`takeawayPrepay` and a deposit take effect only while a gateway is connected.
While none is connected, the page takes requests without payment, as in P23.

### 4.3 Placing, with payment

`POST /public/:slug/orders` and `POST /public/:slug/reservations` keep their
bodies. When payment applies:

- The request is stored `AWAITING_PAYMENT`, with no `answerBy` yet.
- A Razorpay payment link is created for the takeaway's estimate, or for the
  deposit (`partySize × depositPerPersonInPaise`). It has `reference_id` set
  to our request id, `expire_by` set to now plus `paymentWindowMinutes`, and
  `callback_url` set to the guest's status page.
- 201 adds `payment: { status: "CREATED", amountInPaise, payUrl, expiresAt }`.
  The page sends the guest to `payUrl`.

Errors: 502 `PAYMENT_GATEWAY_ERROR` when Razorpay cannot create the link. The
request is then stored `PAYMENT_FAILED`, and the guest can try again.

An `AWAITING_PAYMENT` request is invisible to every staff read except its own
id. It counts towards the open-request limit per phone. It reads as
`PAYMENT_EXPIRED` once its link has expired.

### 4.4 Confirming a payment

Three ways in. Each ends with the same idempotent `confirmPaid` in
`onlinePaymentService.js`:

1. **The return.** `POST /public/:slug/orders/:id/payment-return`, and
   `.../reservations/:id/payment-return`, with the status token and body
   `{ razorpay_payment_id, razorpay_payment_link_id,
   razorpay_payment_link_reference_id, razorpay_payment_link_status,
   razorpay_signature }`, exactly as Razorpay appends them to `callback_url`.
   The signature is HMAC-SHA256 of
   `link_id|reference_id|status|payment_id` with the key secret.
2. **The webhook.** `POST /public/:slug/payments/webhook`, with Razorpay's raw
   body and `X-Razorpay-Signature`, an HMAC-SHA256 of the raw body with the
   webhook secret. A bad signature gets 400. A good one for an event other than
   `payment_link.paid` gets 200 and does nothing.
3. **The read-back.** When the guest's status page is read, and on each staff
   inbox read, an `AWAITING_PAYMENT` request asks Razorpay for its link, at most
   once every 10 seconds.

`confirmPaid` reads the link back from Razorpay and counts the payment only
when the status is `paid` and the amount paid equals ours. It then moves the
request to `WAITING` (takeaway) or `REQUESTED` (booking), and starts
`answerBy`. A second confirmation changes nothing.

The guest's status read adds
`payment: { status, amountInPaise, paidAt, refundedInPaise, refundStatus, payUrl }`.
`payUrl` is present only while the payment is `CREATED`.

### 4.5 Refunds

Full refund, automatically, through `POST /v1/payments/:id/refund`, when a paid
takeaway is declined, expires, or is cancelled by the guest; and when a paid
booking is declined, expires, is cancelled by staff, or is cancelled by the
guest at least `depositRefundCutoffMinutes` before `at`. The guest is told on
the status page.

Forfeited, not refunded: a guest cancelling a booking after the cutoff (the
page says so before they confirm), and a no-show.

Expiry has no scheduler. Each staff inbox read sweeps up to 10 paid requests
past `answerBy` into `EXPIRED`, and refunds them.

A refund Razorpay refuses leaves the payment `REFUND_FAILED`. The inbox shows
it, and an OWNER or MANAGER retries with
`POST /api/v1/online/payments/:id/refund`.

### 4.6 The advance on the bill

An accepted paid takeaway, or a seated booking with a deposit, opens an order
whose `advancePaymentId` names the `onlinepayments` record.

`GET /bills/:billId` adds
`advance: { paymentId, amountInPaise, appliedInPaise, available }` when the
order has one.

`POST /api/v1/bills/:billId/apply-advance`, OWNER, MANAGER or CASHIER, no body:

1. The same day-lock and void checks as a payment.
2. Adds a bill payment of method `ONLINE` for the smaller of the advance and
   what is still due, with `receivedAt` and `businessDate` now, and
   `reference` set to the Razorpay payment id.
3. Marks the advance applied. Anything left over is refunded at once, and the
   response says so.
4. Settles the bill exactly as a payment does when it reaches the total.

Response: the bill, plus `advanceRefundedInPaise`.

While an advance is unapplied, `POST /bills/:billId/payments` is 422
`ADVANCE_NOT_APPLIED`: "This order was paid online. Apply the online advance
first." `ONLINE` can never be chosen by hand: 422
`PAYMENT_METHOD_NOT_ALLOWED`.

### 4.7 What staff see

Online orders and bookings in staff responses add
`payment: { status, amountInPaise, paidAt, refundedInPaise }` or null. The inbox
adds `refundFailures`, a count of payments in `REFUND_FAILED`. The guest's
`declineReason` is unchanged.

## 5. Dish photos (P24)

DB-SCHEMA section 30.

| Endpoint | Body | Roles |
|---|---|---|
| `PUT /api/v1/menu-items/:itemId/photo` | `{ image }`, a base64 data URL | OWNER, MANAGER |
| `DELETE /api/v1/menu-items/:itemId/photo` | | OWNER, MANAGER |
| `GET /api/v1/menu-items/:itemId/photo` | | all six |
| `GET /api/v1/public/:slug/photos/:itemId` | | no token |

The image must be PNG, WebP or JPEG, read from its own bytes, never SVG. It
must be at most 300 KB, at most 2000 pixels on each side, and at least 320 on
the shorter side. The screen resizes to 1200 pixels and WebP before upload.
The body limit on this route is 450 KB, parsed after the role check. The
response is the item with
`photo: { hash, width, height, url }`.

Every menu item response adds `photo` (null when none). The public menu adds
`photoUrl` per item, `/api/v1/public/{slug}/photos/{itemId}?v={hash}`, served
with `Cache-Control: public, max-age=31536000, immutable` and the hash as the
ETag. Uploading or removing a photo writes no audit line: it is a picture, not
a price.

## 6. Error codes added by P24

```
PAYMENT_GATEWAY_NOT_CONNECTED   422  no gateway, or no PAYMENT_SECRETS_KEY on the server
PAYMENT_GATEWAY_ERROR           502  Razorpay refused or could not be reached; the message says which
ADVANCE_NOT_APPLIED             422  a bill with an unapplied online advance takes another payment
```

## 7. Permission summary for P24

| Endpoint | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| Gateway GET, PUT, DELETE | yes | no | no | no | no | no |
| Apply advance | yes | yes | yes | no | no | no |
| Retry a refund | yes | yes | no | no | no | no |
| Photo PUT, DELETE | yes | yes | no | no | no | no |
| Photo GET | yes | yes | yes | yes | yes | yes |
| Public payment return, webhook, photo | no token | | | | | |

---

# M21 Integrations

Owner: Arya. Specified in P25 Part A, built in Parts G to L.

**M21 is a product module, not a client module.** It connects any restaurant
to the partners it already uses: delivery platforms (order channels), card
machines (payment terminals) and an accountant's Tally (accounting). Nothing in
it names a restaurant.

Three areas share one foundation:

| Area | Providers | What it does |
|---|---|---|
| Order channels | `SWIGGY`, `ZOMATO`, `SANDBOX_PLATFORM` | Receives platform orders, accepts or rejects them, and bills them on pickup |
| Payment terminals | `PINE_LABS` | Sends a bill amount to the card machine and records the approved payment |
| Accounting | `TALLY` | Turns each closed day into Tally vouchers, as a file or through a bridge |

## 1. Rules every M21 endpoint and job obeys

1. **Every record has a `restaurantId`.** A webhook and a bridge call carry no
   user; each finds its restaurant only through its connection or bridge
   record, found by the SHA-256 of a random key. Those two lookups, and the job
   runner's claim of the next due job across restaurants, are the three M21
   uses of `skipTenantGuard`, and the tripwire test counts them. Everything a
   claimed job then does runs scoped to the job's own restaurant.
2. **Partner credentials are encrypted at rest** with `encryptJson` in
   `server/utils/secretBox.js`, under `INTEGRATION_SECRETS_KEY`. They are never
   returned by any endpoint, and never written to a log line, an error message,
   an audit line, an event line or a test fixture. A response shows only the
   last four characters of each secret field, as `credentialHints`.
3. **A webhook is verified, stored, then processed by a job.** The reply goes
   back within a second; nothing slow runs inside it.
4. **Outgoing partner calls are queued** in `integrationjobs`, so a slow partner
   never holds up a cashier. The one exception is accepting a platform order,
   which must succeed on the platform before anything is created here, and runs
   inline with a short timeout.
5. **Provider rules live only in the provider registry**,
   `server/services/integrations/providers.js`. No `if (provider === 'SWIGGY')`
   anywhere else.
6. **A real Swiggy or Zomato adapter is written only from that platform's own
   document**, kept outside git in `partner-docs/`. Without one, the provider is
   `WAITING_FOR_PARTNER` and cannot be activated.
7. **Version 1 runs one server instance.** The job loop and the webhook
   dedupe assume it; DEPLOYMENT.md already says to run one.
8. Money is whole paise everywhere, including Pine Labs amounts and Tally's
   rupee text, which is written from paise by integer arithmetic.

## 2. Secrets

`server/utils/secretBox.js`, built in P24 for Razorpay, gains
`encryptJson(value)` and `decryptJson(box)`: AES-256-GCM, a fresh 12-byte IV
each time, the 16-byte tag stored beside the ciphertext, and a `keyId` on each
box, the first 8 hex characters of the SHA-256 of the key, so a box sealed under
another key is recognised and refused rather than mis-decrypted.

```json
{ "keyId": "3f9a01c2", "iv": "…", "tag": "…", "ciphertext": "…" }
```

**`INTEGRATION_SECRETS_KEY`**: 32 random bytes, base64, read only in
`config/env.js`. It is a separate key from P24's `PAYMENT_SECRETS_KEY`, so
rotating one never touches the other's records.

1. Required in production. Startup fails with "INTEGRATION_SECRETS_KEY must be
   set in production. Make one with: openssl rand -base64 32".
2. In development and test, when absent, a fixed development key is used and a
   warning is logged once. Never in production.
3. Losing it makes every saved partner credential unreadable; each must be
   entered again.

## 3. Connections

One `integrationconnections` record per restaurant, branch and provider
(DB-SCHEMA section 32).

### 3.1 `GET /api/v1/integrations`

Roles: OWNER, MANAGER. Every provider in the registry, with this branch's
connection or null:

```json
{
  "success": true,
  "data": [
    {
      "provider": "PINE_LABS", "kind": "PAYMENT_TERMINAL", "name": "Pine Labs",
      "availability": "READY",
      "credentialFields": ["merchantId", "securityToken"],
      "connection": {
        "id": "6610…", "environment": "UAT", "status": "ACTIVE",
        "credentialHints": { "merchantId": "4521", "securityToken": "7Q2X" },
        "config": { "baseUrl": "https://www.plutuscloudserviceuat.in:8201", "terminals": [ { "name": "Counter", "clientId": "1234" } ] },
        "hasWebhook": false,
        "lastSuccessAt": "…", "lastErrorAt": null, "lastError": null
      }
    },
    { "provider": "SWIGGY", "kind": "ORDER_CHANNEL", "name": "Swiggy", "availability": "WAITING_FOR_PARTNER",
      "unavailableReason": "Swiggy has not approved this integration yet, so live orders cannot be received. Use the Sandbox platform to practise.",
      "credentialFields": [], "connection": null }
  ]
}
```

`SANDBOX_PLATFORM` is left out of the list when `NODE_ENV` is `production`.

### 3.2 `PUT /api/v1/integrations/:provider`

Roles: OWNER. Creates or updates this branch's connection.

```json
{ "environment": "UAT", "credentials": { "merchantId": "…", "securityToken": "…" }, "config": { "…": "…" } }
```

1. `config` is checked against the provider's own config schema; `credentials`
   against its credential schema. 400 with `fields` on either.
2. A credential field sent as `""` or left out keeps the stored value. Sending a
   new value replaces it and writes `INTEGRATION_CREDENTIALS_CHANGED` with the
   field names only.
3. A new connection starts `DRAFT` and writes `INTEGRATION_CONNECTED`. For an
   order channel or Pine Labs it also makes a webhook key and returns the full
   address **once**, as `webhookUrl`, beside the connection.
4. `SANDBOX_PLATFORM` in production is 422 `BUSINESS_RULE_VIOLATED`.
5. Saving the first connection of a restaurant also creates its integration
   user (section 6).

Response 200 (201 when created): the connection as in 3.1.

### 3.3 Test, pause, resume, a new webhook address, events

| Method and path | Roles | What it does |
|---|---|---|
| `POST /integrations/:provider/test` | OWNER | Calls the adapter's `testConnection`. Success sets `lastSuccessAt`, and moves `DRAFT` or `ERROR` to `ACTIVE`. Failure sets `lastErrorAt` and `lastError` and answers 422 `INTEGRATION_TEST_FAILED` with that plain sentence. A `WAITING_FOR_PARTNER` provider is 422 `PARTNER_SPEC_MISSING`. |
| `POST /integrations/:provider/pause` | OWNER | `ACTIVE` to `PAUSED`. A paused order channel rejects nothing and accepts nothing: its webhooks are stored as `IGNORED`. `INTEGRATION_PAUSED`. |
| `POST /integrations/:provider/resume` | OWNER | `PAUSED` to `ACTIVE`. `INTEGRATION_RESUMED`. |
| `POST /integrations/:provider/webhook-key` | OWNER | A new random key; the old address stops working at once. Returns `{ webhookUrl }`, once. |
| `GET /integrations/:provider/events?outcome&page&limit` | OWNER, MANAGER | `integrationevents`, newest first, paged. Already redacted when stored. |

A connection that is not `ACTIVE` does nothing: no webhook is processed, no
job runs, no platform order is accepted, no terminal payment starts (422
`INTEGRATION_NOT_ACTIVE`).

## 4. Webhooks

```
POST /api/v1/hooks/:provider/:webhookKey
```

1. Parsed with `express.raw`, limit 256 KB, before the JSON parser, so the exact
   bytes are available to check a signature.
2. No sign-in and no tenant middleware. The connection is found by the SHA-256
   of the key and the provider. An unknown key, or a provider that does not
   match, is 404 with no detail.
3. Its own rate limiter, per key: 120 requests a minute.
4. The adapter's `verifyWebhook({ rawBody, headers, connection })` runs first.
   False is 401 and one `REJECTED` event, and nothing else.
5. A verified request is stored as an `IN` event, parsed into normalised
   events, and each is handed to a job. The reply is 200 `{ "received": true }`
   within a second.
6. A connection that is `PAUSED` stores the event as `IGNORED` and answers 200.

Pine Labs' postback uses the same route (section 7.4).

## 5. Jobs and alerts

`integrationjobs` (DB-SCHEMA section 34) holds every outgoing call and every
webhook event to process. `server/services/integrations/jobRunner.js`:

1. `runDueJobs({ limit })` claims due jobs one at a time with a
   `findOneAndUpdate` on `status: QUEUED, runAfter <= now` that sets `RUNNING`
   and `lockedUntil`, so two runners never run one job. A `RUNNING` job whose
   `lockedUntil` has passed is claimable again.
2. Retries wait 30 seconds, 2 minutes, 10 minutes, 30 minutes, then 2 hours.
   After `maxAttempts` (default 6) the job is `DEAD` and raises an alert.
3. A `dedupeKey` already used by a job is not queued twice (unique index).
4. `startJobLoop()` runs `runDueJobs` every 5 seconds. `server.js` starts it
   outside tests only; tests call `runDueJobs` directly.

### 5.1 Alerts

```
GET  /api/v1/integrations/alerts
POST /api/v1/integrations/alerts/acknowledge
```

Roles: OWNER, MANAGER. Alerts are **derived on read** from the records that
cause them, never stored separately:

| Kind | From | Sentence |
|---|---|---|
| `JOB_DEAD` | A `DEAD` job | "Swiggy did not answer after 6 tries: mark food ready for order 249377796192385." |
| `PLATFORM_ACCEPT_FAILED` | A platform order `FAILED` | "Accepted on Swiggy but not created here. Enter it by hand." |
| `PLATFORM_AMOUNT_MISMATCH` | A platform order with `amountMismatch` | "Zomato order … : the platform charged ₹305.00, our bill says ₹310.00." |
| `PLATFORM_CANCELLED_CLOSED_DAY` | A platform order `NEEDS_ATTENTION` for `DAY_CLOSED` | "Zomato cancelled an order on 26 Sep, a closed day. Reopen it to void the bill." |
| `TERMINAL_UNKNOWN` | A terminal transaction `UNKNOWN` | "The card machine approved ₹500.00 for bill …, but ₹295.00 was asked for. Check the machine's slip." |
| `TALLY_FAILED` | A Tally export `FAILED`, `PARTIAL` or `UNKNOWN` | "Tally refused 2 vouchers for 26 Sep: …" |

Each `{ kind, id, at, provider, sentence, link }`. `POST .../acknowledge`
`{ kind, id }` sets `acknowledgedAt` and `acknowledgedBy` on the source record;
an acknowledged alert is no longer listed. The same alerts appear in R1 Today's
alerts section, kind `INTEGRATION`.

Settled while building Part L: a dead bridge job is left out, because its Tally
export already raises `TALLY_FAILED`. In R1, an integration row has `detail`
(the sentence), no amount, and `drill.detail` `{ report: 'LINK', query: { to } }`,
a path inside the app. A `link` is one of `/settings/integrations/:provider`,
`/online?platformOrder=:id`, `/bills/:billId` or `/settings/tally`.

## 6. Acting without a signed-in person

`server/services/integrations/systemActor.js`, `asIntegration(restaurantId,
branchId, provider)`, returns a request-like context `{ restaurantId, branchId,
user: { id, role }, currentRestaurant }` that every service accepts.

It acts as the restaurant's **integration user**, one per restaurant, created
when the first connection is saved: name like "Swiggy (automatic)" for the
provider that first needed it, role `CASHIER`, `isSystem: true`, a phone value
`system:<restaurantId>` that no sign-in form can type, and a random password
hash nobody knows. **It cannot sign in**: `authService` refuses any user with
`isSystem: true` with the same `InvalidCredentialsError` as an unknown phone,
and refuses a refresh or PIN for one. `GET /users` and every staff list leave
system users out.

## 7. Order channels

### 7.1 The adapter

`server/services/integrations/channels/adapter.js` documents the interface:
`capabilities`, `verifyWebhook`, `parseWebhook`, `acceptOrder`, `rejectOrder`,
`markFoodReady`, `setItemAvailability`, `setStoreStatus`, `pushMenu` (optional),
`testConnection`. Three adapters: `SANDBOX_PLATFORM`, complete; `SWIGGY` and
`ZOMATO`, complete only from the platform's own document, otherwise
`WAITING_FOR_PARTNER` with every method throwing `PartnerSpecMissingError`.

The sandbox signs webhooks with HMAC-SHA256 of the raw body under its
`webhookSecret` credential, in the header `x-sandbox-signature` as lowercase
hex. Its config `actsAs` is `ZOMATO` or `SWIGGY`: the platform its orders are
billed as, so the existing platform rules apply unchanged. Its outgoing calls
write `OUT` events and succeed, unless its config `failCalls` lists the call to
fail.

The normalised order and events are in P25 Part H2, and DB-SCHEMA section 36.

Order channel config: `autoAccept` (false), `autoFire` (true),
`defaultPrepMinutes` (20, 5 to 120), `packagingItemId` (null), and for the
sandbox `actsAs` and `failCalls`.

### 7.2 Item mapping

| Method and path | Roles |
|---|---|
| `GET /integrations/:provider/item-mappings?page&limit` | OWNER, MANAGER |
| `GET /integrations/:provider/item-mappings/unmapped` | OWNER, MANAGER. Every external item seen in an order with no mapping, newest first, with its last name and the count of orders it was in. |
| `PUT /integrations/:provider/item-mappings` | OWNER, MANAGER. `{ externalItemId, externalVariantId?, menuItemId, variantId?, addOnMap? }`. Creates or replaces the mapping for that external pair. The menu item, variant and add-ons must be this restaurant's: 422 otherwise. |
| `DELETE /integrations/:provider/item-mappings/:mappingId` | OWNER, MANAGER. A mapping is configuration, like a recipe, and is removed outright. |
| `POST /integrations/:provider/item-mappings/import` | OWNER, MANAGER. `{ csv }`, columns `external_item_id,external_variant_id,menu_item,size`, read with the menu import's CSV parser, matched by item name and size. A dry run unless `apply: true`. |

### 7.3 Platform orders

| Method and path | Roles | What it does |
|---|---|---|
| `GET /platform-orders?status&date&page&limit` | OWNER, MANAGER, CASHIER | Newest first |
| `GET /platform-orders/:id` | OWNER, MANAGER, CASHIER | One, with `history` and `attentionReasons` |
| `POST /platform-orders/:id/accept` | OWNER, MANAGER, CASHIER | `{ prepMinutes? }`, 5 to 120, default the connection's. Refused 422 while any attention reason other than `CASH_ON_DELIVERY` and `RESTAURANT_DELIVERY` remains; those two need `acknowledgeHandling: true`. |
| `POST /platform-orders/:id/reject` | OWNER, MANAGER, CASHIER | `{ reasonCode, note? }` from `platformRejectReasons.js`. Writes `PLATFORM_ORDER_REJECTED`. |
| `POST /platform-orders/:id/handed-over` | OWNER, MANAGER, CASHIER | Staff record the rider's pickup when the platform has not sent it; same effect as the platform's `ORDER_PICKED_UP`. |
| `POST /integrations/:provider/store-status` | OWNER, MANAGER | `{ open }`. Queues `setStoreStatus`. |
| `POST /integrations/:provider/menu-push` | OWNER, MANAGER | Only when the adapter has `menuPush`; 422 otherwise. Queues `pushMenu` with availability, never prices unless the adapter's document requires them. |

Settled while building P25 Part H: `openOrder` and `fireOrder` take no session
(P23 recorded the same), so accepting is not one transaction. It claims the
platform order with a status-filtered write, calls the platform, then creates
and fires; a refusal from the platform puts the claim back, and a failure
after the platform said yes leaves the order `FAILED` with an alert. Before
the platform is called, the lines are checked against our menu, so a dish
switched off here is refused with a plain message instead of accepted and
then failed. The platform's cancel cancels each live line with its own
answer: made when the kitchen had it ready, not made when it was still
cooking, nothing to answer when it was never sent.

Accept, in this order:

1. Call `acceptOrder` inline, timeout 8 seconds. A failure creates nothing here,
   keeps the platform order `RECEIVED` or `NEEDS_ATTENTION`, and answers 502
   `PARTNER_CALL_FAILED` with the plain reason.
2. Then, in one transaction, create a `DELIVERY` order through
   `orderOpenService.openOrder` (moved out of the controller in P23, which is
   P25's G7), with `platform: { code, name, orderId }` from the connection's
   platform, so the existing one-live-order-per-platform-number guard applies,
   the tax treatment from `settings.delivery`, `origin: { kind:
   'PLATFORM_ORDER', id, reference }`, and the integration user as `openedBy`.
3. Each line is built from its mapping by `buildLineSnapshots` with a price
   override for this path only: the platform's `unitPriceInPaise` is frozen on
   the line, with `priceSource: 'PLATFORM'`. Every other line is `MENU`.
4. A packaging charge is one line of the connection's `packagingItemId` at the
   platform's price.
5. With `autoFire`, fire to the stations at once.
6. If step 2 fails after the platform accepted: status `FAILED`, an alert, and
   the order's details kept on screen to enter by hand.

On pickup (`ORDER_PICKED_UP` or handed over), as the integration user:
`createBill`; a merchant discount through `applyDiscount`, reason
`MERCHANT_PROMO`, funded by the restaurant (a platform-funded discount never
goes on our bill); then one payment through `recordPayment` with the active
method whose `platformCode` matches. A difference between our bill total and
the platform's `totalInPaise` minus `platformDiscountInPaise` larger than the
round-off still bills, and sets `amountMismatch`.

On `ORDER_CANCELLED` from the platform: not yet fired, the order is cancelled
with `PLATFORM_CANCELLED`; fired, cancelled with `wasPrepared: true` for lines
the kitchen marked ready and false otherwise; billed, the bill is voided with
`PLATFORM_CANCELLED`. On a closed business date nothing changes: the platform
order becomes `NEEDS_ATTENTION` with `DAY_CLOSED` and an alert.

When every line of an accepted order is ready in the kitchen, `markFoodReady` is
queued. When an item or variant's availability changes, `setItemAvailability`
is queued for every `ACTIVE` channel where it is mapped, once per channel.

P29: `markFoodReady` is queued with `runAfter` 60 seconds ahead, so a wrong tick
undone in the kitchen within the minute never reaches the platform (M2 section
13.5). Jobs gain the status `CANCELLED`, set only by that undo, which also
releases the job's `dedupeKey`. A cancelled job is never run.

### 7.4 On the incoming requests screen

Platform orders join P23's inbox, alert, chime, spoken line and banner; nothing
is copied. `GET /online/inbox` gains `waitingPlatformOrders` and its `latest`
can be `{ kind: "PLATFORM_ORDER", provider, reference, itemCount, acceptBy }`.
The inbox and its alert are on when `features.online` is on **or** any order
channel connection is `ACTIVE`; `GET /auth/me`'s `online` block gains
`platformChannels: ["SANDBOX_PLATFORM"]`, the active order channels.

## 8. Payment terminals: Pine Labs

Credentials: `merchantId`, `securityToken`. Config: `baseUrl` (required; the UAT
address is the default only in `UAT`), `paths: { upload, status, cancel }`, each
required with no code default, `storeId`, `terminals: [{ name, clientId }]` (at
least one), `autoCancelMinutes` (5), `postbackEnabled` (false).

| Method and path | Roles | What it does |
|---|---|---|
| `POST /bills/:billId/terminal-payments` | OWNER, MANAGER, CASHIER, and WAITER under M3 section 16.2 | `{ method, amountInPaise, terminalClientId }`. The method must be linked to `PINE_LABS`, active, and pass every rule a hand payment passes; the amount must fit the bill. Uploads with UploadBilledTransaction and answers 201 with the transaction, `WAITING`, and its `ptrid`. |
| `GET /terminal-payments/:id` | same | The transaction. When `WAITING` and not checked in the last 3 seconds, calls GetStatus first. |
| `POST /terminal-payments/:id/cancel` | same | CancelTransaction. `CANCELLED` once Pine Labs confirms; an approval that arrives first wins. |
| `POST /hooks/PINE_LABS/:webhookKey` | none, the key | Postback, when `postbackEnabled`. A hint only: it triggers GetStatus, never records anything itself. |

`transactionNumber` is the bill number with everything but letters and digits
removed; `sequenceNumber` counts every attempt on that bill from 1, so a retry
after a decline is a new sequence. The pair is unique per connection.

When GetStatus reports approval, in one transaction: the transaction moves to
`APPROVED` only if it is not already, and the payment is recorded through
`recordPayment` with `reference` the RRN and `terminal: { provider, ptrid, rrn,
approvalCode, tid, paymentMode }`. `terminaltransactions.paymentId` is unique,
so one approval is never two payments. An approved amount different from the
one asked for records nothing, sets `UNKNOWN`, and raises an alert.

A job checks every `WAITING` transaction every 30 seconds until it finishes, or
until `autoCancelMinutes` plus 5 minutes pass, when it becomes `EXPIRED` after a
final check.

## 9. Accounting: Tally

### 9.1 Connection

No secrets. Config: `version` (`TALLY_PRIME` or `TALLY_ERP9`), `companyName`,
`granularity` (`DAILY_SUMMARY` default, or `PER_BILL`), `voucherTypes` (`sales`,
`receipt`, `payment`, `journal`, defaulting to the same words), `ledgers` (9.2),
`exportPayouts` (false), `delivery` (`FILE` or `BRIDGE`).

### 9.2 Ledger mapping

`config.ledgers`:

```json
{
  "salesByRate": { "500": "Sales @ 5%" },
  "platformSales": "Sales, aggregator, section 9(5)",
  "cgst": "Output CGST", "sgst": "Output SGST", "roundOff": "Round Off",
  "paymentMethods": { "CASH": "Cash", "CARD": "Card Settlement", "UPI": "UPI Collections", "SWIGGY": "Swiggy Receivable", "ONLINE": "Razorpay" },
  "onHold": { "mode": "ONE", "ledger": "Sundry Debtors - On Hold", "byAccount": {} },
  "paidOut": "Petty Expenses", "paidIn": "Petty Cash Received",
  "bank": "Bank", "commissionByMethod": { "SWIGGY": "Swiggy Commission" },
  "parentGroups": { "sales": "Sales Accounts", "tax": "Duties & Taxes", "payment": "Current Assets", "onHold": "Sundry Debtors", "expense": "Indirect Expenses", "income": "Indirect Incomes" }
}
```

`onHold.mode` is `ONE` (one combined ledger) or `PER_ACCOUNT` (`byAccount` keyed
by account id). Before any export, every head with an amount on that date must
have a ledger: 422 `TALLY_MAPPING_INCOMPLETE` listing each missing head.

P29 adds, every one optional:

| Key | Meaning |
|---|---|
| `expenseByCategory` | `{ [categoryCode]: ledger }`. An expense goes to its category's ledger, or to `paidOut` when its category has none. |
| `topUpBySource` | `{ OWNER, BANK, CHANGE, OTHER }` to a ledger. A top-up goes to its source's ledger, or to `paidIn`. |
| `ownerDrawings` | The owner's drawings ledger, a new head. Cash taken out to the owner, during the day or at close, goes here. |
| `cashTakenOutOther` | Cash taken out with destination `OTHER`. A new head. |

Cash taken out to the bank, during the day or at close, is a **contra** entry,
`Cash` credit against the `bank` ledger debit, never an expense, with the new
voucher type `voucherTypes.contra`, default "Contra". Cash taken out to the
owner is a payment voucher, owner's drawings debit, Cash credit. A cash check
and a brought-forward float move no money and make no voucher. Every voucher
still balances to the paisa.

### 9.3 Endpoints

| Method and path | Roles | What it does |
|---|---|---|
| `GET /integrations/tally/days?from&to` | OWNER, MANAGER | One row per business date: `closed`, and the latest export's status |
| `POST /integrations/tally/exports` | OWNER, MANAGER | `{ from, to }`, at most 31 dates. Builds one export per **closed** date. An open date is 422 `DAY_NOT_CLOSED`; a date already `POSTED` or `DOWNLOADED` is 409 `TALLY_ALREADY_EXPORTED`. |
| `GET /integrations/tally/exports/:id/file` | OWNER, MANAGER | The XML as `application/xml`, `attachment`. Marks `DOWNLOADED`. |
| `POST /integrations/tally/exports/:id/send` | OWNER, MANAGER | Queues `POST_VOUCHERS` for the bridge. `QUEUED`. Needs a paired bridge: 422 otherwise. |
| `POST /integrations/tally/exports/:id/redo` | OWNER | `{ confirmation }`, exactly "I have deleted the vouchers for 26 Sep 2026 from Tally." with that date. Marks the old export `STALE` and builds a new one. `TALLY_EXPORT_REDONE`. |
| `GET /integrations/tally/ledger-masters/file` | OWNER | An XML of plain ledgers under the parent group chosen per head. GST details on tax ledgers are set by the accountant in Tally. |
| `POST /integrations/tally/bridges/pairing-code` | OWNER | `{ name }`. Returns an 8-character code, valid 10 minutes, once. |
| `GET /integrations/tally/bridges` | OWNER, MANAGER | Each bridge with `lastSeenAt`, `tallyVersionSeen`, `companiesSeen`, revoked or not. Never the token. |
| `POST /integrations/tally/bridges/:id/revoke` | OWNER | `TALLY_BRIDGE_REVOKED` |

Reopening a day marks every export of that date `STALE`. A posted export moving
to `POSTED` writes `TALLY_EXPORT_POSTED`.

Settled while building Part J:

1. A date is held, and refused with 409, while its latest export is
   `DOWNLOADED`, `QUEUED`, `POSTED`, `PARTIAL` or `UNKNOWN`. The contract named
   two of these. The other three may also have put vouchers into Tally. A
   `BUILT` or `FAILED` export never reached Tally, so a new export replaces it,
   and the old one becomes `STALE`.
2. `POST /exports` checks every date before writing anything: open days, held
   dates, then the ledger mapping. `missing` lists every head missing on any
   date.
3. The daily summary has one round-off line, the net across its bills. The
   golden day shows 0.11, not 1.87 credited and 1.76 debited.
4. Voucher numbers: per bill, the invoice number. Otherwise `ERP-<date>-S` for
   sales, `-R1`… for collections, `-P1`… for paid out and paid in, and `-T1`…
   for payouts. A paid in uses the receipt voucher type.
5. A payout credits the platform's receivable with the gross of the payments
   it covers, because that is what the sales vouchers debited. It debits the
   bank with the amount received, and commission with the difference. It is
   exported on its `receivedOn` date.
6. `GET /days` takes at most 92 dates.
7. The ledger masters use Tally's own group names where the owner chose none:
   Sales Accounts, Duties & Taxes, Current Assets, Sundry Debtors, Indirect
   Expenses, Indirect Incomes, and Bank Accounts. Round-off sits under
   Indirect Expenses.
8. `send` is built with the bridge in Part K.

### 9.4 The bridge's own routes

Authenticated by `Authorization: Bearer <bridge token>`, through a small
middleware used only by these routes, with its own rate limiter (60 a minute
per token). The token is never stored; its SHA-256 is. It is not a user
session and opens nothing else.

| Method and path | What it does |
|---|---|
| `POST /api/v1/tally-bridge/pair` | `{ code, machineName }`, no token. A valid unused code gives `{ token, bridgeId, serverName }` once. `TALLY_BRIDGE_PAIRED`. A wrong, used or expired code is 401 `PAIRING_CODE_INVALID`, the same answer for each. |
| `GET /api/v1/tally-bridge/jobs/next` | The next job for this bridge's connection: `{ jobId, type, xml?, companyName }`, `type` one of `POST_VOUCHERS`, `FETCH_LEDGERS`, `PING`; or 204 when there is none. Updates `lastSeenAt`. |
| `POST /api/v1/tally-bridge/jobs/:jobId/result` | `{ ok, httpStatus, body, tallyVersion?, companies? }`, body up to 5 MB. The server parses Tally's answer (P25 Part J5). |

A revoked or unknown token is 401 `BRIDGE_TOKEN_INVALID` everywhere.

Posting checks first: a `FETCH_LEDGERS` result newer than the mapping must list
every mapped ledger, or the post is refused with the missing names.

Settled while building Part K:

1. `send` takes a `BUILT` or `FAILED` export. It queues `FETCH_LEDGERS` and
   then `POST_VOUCHERS`, each tried once. The check is on the ledgers that
   export actually uses, compared without regard to case, as Tally compares
   names. When a fresh list already lacks one, `send` itself is 422
   `TALLY_MAPPING_INCOMPLETE`, with `missing` like `"Swiggy (not in Tally)"`.
   When the list is fresh only by the time of the post, the post is never
   handed to the bridge, and the export becomes `FAILED` with the names in
   `lineErrors`. No fresh list at all is refused the same way.
2. The result body also takes `reached` (default true). The bridge sends false
   when Tally refused the connection, so nothing reached it, and the export is
   `FAILED`. A timeout is `reached` with no `httpStatus`, so the export is
   `UNKNOWN`: Tally may have taken it.
3. A bridge job is locked for 10 minutes. A `PING` or `FETCH_LEDGERS` whose
   lock runs out may be offered again. A `POST_VOUCHERS` never is: its export
   becomes `UNKNOWN`, and its job `DEAD`.
4. Pairing queues a `PING`, so the open companies show at once. The bridge
   list gives `state`: `PENDING` (a code not yet used), `EXPIRED`, `ACTIVE` or
   `REVOKED`. It also gives `ledgerCount`, never the hashes.
5. Pairing has its own limiter, 20 per 15 minutes per address. The bridge
   routes' limiter counts per token, before the token is checked.
6. Testing a Tally connection with `delivery: BRIDGE` needs a paired bridge.
7. The ledger list request is Tally's documented collection export with inline
   TDL (`TALLYREQUEST` EXPORT, `TYPE` COLLECTION, a `COLLECTION` of `TYPE`
   Ledger with `NATIVEMETHOD` Name). The answer is read as each
   `<LEDGER NAME="…">`. Tally's help page for it describes Tally.ERP 9. Part
   K's manual check confirms TallyPrime, and records any difference in
   `profiles.js`.

## Permission summary for M21

| Action | OWNER | MANAGER | CASHIER | WAITER | KITCHEN | STOREKEEPER |
|---|---|---|---|---|---|---|
| GET /integrations, events, alerts | yes | yes | no | no | no | no |
| PUT /integrations/:provider, test, pause, resume, webhook-key | yes | no | no | no | no | no |
| Acknowledge an alert | yes | yes | no | no | no | no |
| Item mappings, store status, menu push | yes | yes | no | no | no | no |
| Platform orders: list, read, accept, reject, handed over | yes | yes | yes | no | no | no |
| Terminal payments | yes | yes | yes | when both billing settings | no | no |
| Tally days, exports, file, send, bridges list | yes | yes | no | no | no | no |
| Tally redo, ledger masters file, pairing code, revoke | yes | no | no | no | no | no |

Webhooks and the bridge routes have no user. They are checked by their own keys
and tokens.

## Error codes added by M21

| Code | Status | When |
|---|---|---|
| `PARTNER_SPEC_MISSING` | 422 | The provider is waiting for the partner's approval and document |
| `INTEGRATION_NOT_ACTIVE` | 422 | The connection is missing, a draft, paused or in error |
| `INTEGRATION_TEST_FAILED` | 422 | Test connection failed; the message is the plain reason |
| `PARTNER_CALL_FAILED` | 502 | A call to the partner failed or timed out while a person waited |
| `TERMINAL_REQUIRED` | 422 | A method linked to a card machine was recorded by hand without a manager's bypass |
| `TALLY_MAPPING_INCOMPLETE` | 422 | A head with an amount has no ledger; `missing` lists them |
| `TALLY_ALREADY_EXPORTED` | 409 | The date was posted or downloaded already; redo needs the owner's confirmation |
| `DAY_NOT_CLOSED` | 422 | Only closed days are exported |
| `PAIRING_CODE_INVALID` | 401 | A pairing code is wrong, used or expired |
| `BRIDGE_TOKEN_INVALID` | 401 | A bridge token is unknown or revoked |

## Settled while specifying P25

1. **G1 reuses P24's `secretBox.js`**, adding `encryptJson` and `decryptJson`
   beside `sealSecret` and `openSecret`, under its own key
   `INTEGRATION_SECRETS_KEY`.
2. **G7 is already done.** P23 moved order creation into
   `services/orderOpenService.js` `openOrder`; the order channel uses it.
3. The integration user's role is `CASHIER` with `isSystem: true`, and it is
   refused at sign-in.
4. Alerts are derived on read from their source records, with an
   `acknowledgedAt` on each, rather than stored in a collection of their own.
5. The sandbox carries `actsAs`, the platform it bills as, because orders and
   payment methods only know `ZOMATO` and `SWIGGY`.
6. A Tally pairing code is held on a pending `tallybridges` row, not a separate
   collection.
7. The device storage key stays `caffeza.device`. It is not seen by anyone, and
   renaming it would forget every device's printer and station.

---

# M22 Customers (P27)

A customer is one phone number at one restaurant: the guest's name, visits and
offers consent. It is built from orders; nothing else creates one.

## 1. Taking the guest's details

`POST /api/v1/orders` (12.1): a `DINE_IN` order also takes `customerName` (1 to
`CUSTOMER_NAME_MAX_LENGTH`) and `customerPhone` (an Indian mobile, normalised to
10 digits), both optional, as `TAKEAWAY` and `DELIVERY` already do. Every order
type takes `offersConsent` (boolean, optional). `offersConsent: true` without a
`customerPhone` is 400.

Every order opened with a phone, by staff or through `openOrder` from an
accepted online order or a seated booking, records a visit after the order is
written. A failure to record it never fails the order; it is logged without
the phone.

Recording a visit: the customer with that phone is found or created; `name`
takes the order's name when one is given; `firstVisitAt` is set once,
`lastVisitAt` and `lastOrderId` every time, `visitCount` goes up by one. When
consent is given (`offersConsent: true` from staff, source `STAFF`, the current
text version from `config/consentText.js`; or a guest's own from the page,
source `ONLINE`, with the version they saw), `offers` becomes given and an
entry is added to `offersHistory`. No tick never withdraws consent.

## 2. Endpoints

| Method and path | Roles | What it does |
|---|---|---|
| `GET /customers?page&limit&offers=true` | OWNER, MANAGER | Newest `lastVisitAt` first. `offers=true` only those who agreed. |
| `POST /customers/search` | OWNER, MANAGER | `{ query, offers? }`, 2 to 40 characters: a name (case-insensitive, escaped) or 3 or more digits matched against the end of the phone. Up to 50, newest visit first. A POST so a phone never sits in a URL. |
| `GET /customers/:customerId` | OWNER, MANAGER | The customer, and up to 50 recent orders with that phone: `{ orderId, orderNumber, orderType, tableName, openedAt, status, bill: { billId, billNumber, grandTotalInPaise } \| null }`, the live bill if any. `totalSpentInPaise` adds up those bills. |
| `PATCH /customers/:customerId` | OWNER, MANAGER | `{ name?, offersConsent?, reason? }`. `offersConsent: false` withdraws, `true` records consent given at the counter; each adds to `offersHistory` with source `STAFF` and `by`. `reason` is required with `offersConsent`. |
| `GET /customers/export` | OWNER | A CSV file of the customers who agreed to offers: Name, Mobile number, Visits, Last visit, Agreed on, Consent text version. Writes `CUSTOMERS_EXPORTED`, entity `SETTINGS`, with the count only. |

A customer is shown as `{ id, name, phone, visitCount, firstVisitAt,
lastVisitAt, offers: { given, textVersion, at, source }, offersHistory }`.

## 3. Rules

1. A phone is never in a URL, a log line or an audit line.
2. 404 for another restaurant's customer.
3. Customers are never deleted by these endpoints. A guest who asks to be
   forgotten is a manual request to the owner, outside this prompt.

## Error codes

None new: 400 `VALIDATION_FAILED`, 403, 404 as usual.


# P28 Manager approval by PIN

Extends the approval P25 Part E built for cancelling after billing (M3 16.4)
and P26 used for reopening a bill (M3 16.7) to the other sensitive actions. The
prompt is `docs/prompts/P28-manager-approval-by-pin.md`.

## 1. The approval

```json
"approval": { "approverId": "652c…", "pin": "1234" }
```

`approverId` is an active OWNER or MANAGER of the caller's restaurant, from
`GET /users/approvers`. `pin` is 4 to 6 digits, checked by `verifyPin`, which
issues no session and locks after five wrong tries. One function,
`approvalService.approverFor`, decides every approval. An OWNER or MANAGER
approves themselves and their `approval` is ignored. A missing approval, an
unknown or inactive approver, and an approver who is not an owner or manager
are 403 with the same message, "A manager has to approve this. Pick their name
and type their PIN." A wrong PIN, and an approver with no PIN, are 401
`INVALID_PIN`, indistinguishable, as M0-D. A locked PIN is 429 `PIN_LOCKED`.
This is how P25 Part E already answers.

## 2. `settings.approvals`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `approvals.lineCancel` | Boolean | true | A CASHIER or WAITER cancelling a line that was made (READY or SERVED, or cancelled with `wasPrepared: true`; before P42 every sent line) needs an approval |
| `approvals.paidIn` | Boolean | true | A CASHIER's `PAID_IN` needs an approval |
| `approvals.managerTasks` | Boolean | true | A CASHIER may void a bill, cancel a whole order, give No Charge and record a `PAID_OUT` with an approval. Off: OWNER and MANAGER only, as before P28. |

Read and written through `GET` and `PATCH /settings`, OWNER to change, audited
as `SETTINGS_CHANGED`. `GET /auth/me` gains `approvals`, all three fields.

## 3. Endpoints that take `approval`

Every one takes `approval` as an optional field beside its existing body.

| Endpoint | Roles before P28 | Roles from P28 | Needs an approval when |
|---|---|---|---|
| `POST /orders/:orderId/lines/:lineId/cancel` (12.6) | OWNER, MANAGER, CASHIER, WAITER | the same | The caller is a CASHIER or WAITER, the line was made (READY or SERVED, or `wasPrepared: true`; P42, every sent line before it), and `lineCancel` is on |
| `POST /cash-movements` (M16) | `PAID_OUT` OWNER, MANAGER; others also CASHIER | the same, plus a CASHIER's `PAID_OUT` | A CASHIER's `PAID_IN` with `paidIn` on; a CASHIER's `PAID_OUT` always (refused when `managerTasks` is off). `OPENING_FLOAT` never. |
| `POST /bills/:billId/void` (14.6) | OWNER, MANAGER | plus CASHIER | A CASHIER, always; refused when `managerTasks` is off |
| `POST /orders/:orderId/cancel` (12.10) | OWNER, MANAGER | plus CASHIER | A CASHIER, always; refused when `managerTasks` is off |
| `POST /orders/:orderId/no-charge` (M16 1) | OWNER, MANAGER | plus CASHIER | A CASHIER, always; refused when `managerTasks` is off |

A CASHIER refused because `managerTasks` is off gets the 403 these endpoints
gave before P28. A WAITER is refused the last three as before.

## 4. What is stored

The person who acted is stored as before (`cancelledBy`, `voidedBy`, `by`).
The approver is stored beside it, null when the actor approved themselves:

| Record | Field |
|---|---|
| Order line | `cancelApprovedBy` |
| Order | `cancelApprovedBy` |
| Bill | `voidApprovedBy` |
| Cash movement | `approvedBy` |
| Order, No Charge | `noCharge.approvedBy`, which already exists: the approver when a cashier asked, the actor otherwise |

`BILL_VOIDED`, `ORDER_CANCELLED`, `NO_CHARGE_GIVEN`, `CASH_PAID_OUT` and
`LINE_CANCELLED_AFTER_PREP` add `details.approvedBy` when someone else
approved. Two new audit actions:

| Action | Entity | Written when | MANAGER may read |
|---|---|---|---|
| `LINE_CANCELLED_APPROVED` | `ORDER` | A line is cancelled with someone else's approval and was not prepared (a prepared one writes `LINE_CANCELLED_AFTER_PREP`) | Yes |
| `CASH_PAID_IN` | `CASH` | A paid in is recorded with someone else's approval | No |

## 5. PINs

`PATCH /users/:userId/pin` (M0-D) is unchanged; the Staff screen now calls it.
Its audit reason becomes "PIN set." `GET /users/approvers` gains `hasPin`
(boolean): `{ id, name, role, hasPin }`.

## Error codes

None new.

# P29 Bill revisions, ready means served, print first, kitchen undo, the cash book

The prompt is `docs/prompts/P29-bill-edits-ready-means-served-print-first-kitchen-undo-cash-book.md`.
Each part is specified in the module it belongs to:

| Part | Where |
|---|---|
| B Revising an unpaid bill | M3 section 16.8; M2 sections 12.4, 12.5 and 12.10 |
| C Ready means served | M2 sections 12.7 and 13 |
| D Print before payment | M3 section 16.9 |
| E Undo in the kitchen | M2 section 13.5; M21 section 7.3 |
| F The cash book | M16 section 9; M21 section 9.2 |
| Settings | M7, "Settings added by P29" |
| Audit actions | M8 section 2 |
| Reports and checks | M19 sections 17 and 18 |

## Error codes

| Code | Status | When |
|---|---|---|
| `BILL_NOT_REVISABLE` | 422 | `remove-lines` on a bill that has money on it, is On Hold, waits on the card machine, is a platform bill, or has revisions switched off. The message says which. |
| `WAITING_FOR_KITCHEN` | 422 | A payment, advance, card machine payment or account charge on a bill whose order has items not yet ready |
| `ORDER_ALREADY_BILLED` | 422 | Undoing ready in the kitchen on an order with a live bill |

# P30 Keeping the free server awake

Render's free plan stops the server after 15 minutes without a request and
takes about a minute to wake. P30 adds a cheap address for pingers, a record of
every start, and the screens' calm handling of a cold start. None of it is a
restaurant's data, and none of it is a bill, an order or a payment.

## 1. `GET /api/v1/wake`

No sign-in, no tenant, no role. Public on purpose: it returns nothing private.

```json
{ "success": true, "data": { "ok": true, "startedAt": "2026-10-10T02:59:40.000Z", "uptimeSeconds": 731 } }
```

1. Touches no database, so it answers while the database is down.
2. Its own limiter: 60 requests a minute per address, a 429 `RATE_LIMITED`
   after that. It is never counted by the general, sign-in or refresh limiters.
   It is the one limiter that also runs under `NODE_ENV=test`, so its limit can
   be tested.
3. Logged at `debug`, so it never reaches a production log, which logs `info`
   and above. A failure is still logged as one.
4. `Cache-Control: no-store`. A cached answer would not keep the server awake.

`startedAt` is when this server process started, in UTC.

## 2. `GET /api/v1/health`

Unchanged, and additive: gains `startedAt` beside the existing
`uptimeSeconds`, and `Cache-Control: no-store`.

## 3. `GET /api/v1/system/starts?days=7`

OWNER only. `days` 1 to 60, default 7. Reads `serverstarts` (DB-SCHEMA
section 44), which belongs to the server rather than to a restaurant, so every
owner reads the same starts. The restaurant only supplies its business day
start and its opening hours, to group and judge them.

```json
{
  "success": true,
  "data": {
    "days": [
      {
        "businessDate": "2026-10-10",
        "starts": 1,
        "startsInWorkingHours": 0,
        "longestGapMinutes": null
      }
    ],
    "starts": [
      { "id": "...", "startedAt": "2026-10-10T02:59:40.000Z", "businessDate": "2026-10-10", "release": "7126e3a", "reason": "DEPLOY", "inWorkingHours": false }
    ],
    "workingHours": { "opensAtMinutes": 600, "closesAtMinutes": 1380, "fromOnlineSettings": true },
    "sleptInWorkingHours": ["2026-10-09"]
  }
}
```

1. `days`: one row per business date in the range, newest first, by
   `businessDateFor` with the restaurant's business day start, including days
   with no start. `longestGapMinutes` is the longest gap between two starts on
   that date, whole minutes, null with fewer than two.
2. `starts`: every start in the range, newest first.
3. `reason`: `FIRST` (no start recorded before it), `DEPLOY` (its release
   differs from the previous start's) or `RESTART` (the same release: a wake
   from sleep, or a crash).
4. Working hours are `settings.online.opensAtMinutes` to `closesAtMinutes`
   while the online page is switched on (`settings.features.online`); while it
   is off those times are only a default nobody chose, and every hour counts
   as working (`fromOnlineSettings: false`).
5. `inWorkingHours` and `startsInWorkingHours` count only `RESTART` starts
   inside working hours: a deploy is not a sleep.
6. `sleptInWorkingHours`: business dates with more than 2 such starts, newest
   first. The Server card in Settings names them.

P54 adds `GET /api/v1/system/backups` beside this one: see "P54 Constant
backups".

## 4. `GET /api/v1/auth/me` additions

`online` gains `opensAtMinutes` and `closesAtMinutes`, so every role's screen
can keep its heartbeat (below) inside working hours. Additive.

## 5. What the screens do (client only)

1. A heartbeat: while signed in, one timer for the whole app calls `/wake`
   every 5 minutes, only while the tab is visible, and only within working
   hours (section 3 point 4) plus 30 minutes either side. A failed ping is
   ignored.
2. A cold start: a 502, 503 or 504, an HTML page where JSON was expected, or
   a request that times out or never reaches the server. A GET is retried
   after 3, 6, 12, 20 and 30 seconds, about 70 seconds in all, with a bar at
   the top: "Starting the server. This takes about a minute the first time in
   the morning." A POST, PUT, PATCH or DELETE is **never** retried: it may have
   reached the server, and a second try could make a second bill or record a
   payment twice. It fails with the client-only code `SERVER_NOT_CONFIRMED`,
   "The server was starting and we could not confirm this went through. Check
   the bill before trying again." Any other status, 400 to 499 included, is
   never retried.
3. On first load, before the sign-in screen, the app calls `/wake` once; if
   no answer comes in 2 seconds it shows the same bar and keeps trying until
   one does.

## Error codes

No new server error code. `SERVER_NOT_CONFIRMED` exists only in the client.

---

# P33 The live channel

A WebSocket that tells a signed-in screen *something changed, read again*.
It is a fast path over the polling, never instead of it. It adds no
collection, no field and no business rule.

## 1. The rule: it carries no data

A message names what changed and nothing else:

```json
{ "topic": "kots", "restaurantId": "6ac7de4c44e45400c1058e99", "branchId": "6ac7de4c44e45400c1058e9a" }
```

`branchId` is null when the write that caused it did not carry one. The
client's only reaction is to invalidate the matching React Query keys, which
makes the ordinary authenticated HTTP read that exists today. A topic name is
not tenant data, and every read behind it is still scoped, permission-checked
and authenticated. A dropped message costs at most one poll interval.

## 2. Topics

| Topic | Sent after a write to | Screens that read again |
|---|---|---|
| `kots` | `kots` | Kitchen display |
| `tables` | `orders`, `bills`, `tables` | Floor view, dashboard |
| `online` | `onlineorders`, `reservations`, `platformorders` | Online alerts, inbox, bookings |
| `platform-orders` | `platformorders` | Platform orders section |
| `print-queue` | `bills` | Captain bill printer |

A write inside a transaction is announced only once the transaction has
committed; one that rolls back is never announced. Announcements for one
restaurant and topic within 250 milliseconds are sent as one. An announcement
can never fail the write it follows: an error is logged and dropped.

## 3. Connecting

Socket.IO 4, WebSocket transport only, at the path `/api/v1/live`, on the
origin `GET /api/v1/auth/me` names (section 6). On Vercel the page and the
API share an address through a rewrite, and that rewrite does not carry a
WebSocket, so a screen served by Vercel connects to the server's own address.
Cross-origin connections are allowed from `CLIENT_ORIGIN` only.

The handshake sends `{ token }` as Socket.IO's `auth`: the access token, never
the refresh cookie. The server then makes exactly the checks `authenticate`
makes, in the same order:

1. The token verifies, and its claims are complete.
2. The user exists in the token's restaurant and is active.
3. The token was not issued at or before `passwordChangedAt`, whole seconds,
   fail closed.
4. The restaurant exists and is active.

Then:

5. The socket joins the rooms for the restaurant and the branch **in the
   verified token**. Nothing the client sends names a room.
6. The connection is closed when the access token expires. The client
   connects again with its next token.
7. A user may hold at most 5 connections; a sixth is refused.

A refused handshake gets Socket.IO's `connect_error`, with the message
`UNAUTHENTICATED`, `TOKEN_EXPIRED` or `TOO_MANY_CONNECTIONS`.

A socket is not an API call: neither the general limiter nor the per-user
limiter counts it.

## 4. The heartbeat

The server sends `heartbeat` to every socket every 20 seconds, after checking
again that the user and restaurant are active and the password has not
changed since the token; if not, it closes the socket instead. The client
treats 30 seconds without a heartbeat as a dead connection.

## 5. What the screens do (client only)

1. One connection per signed-in device, opened by the app shell, beside
   `src/api`. Components never open one.
2. Every screen that reads one of the five topics keeps its poll interval
   (kitchen 10 seconds, floor 15, captain bill printer 5, and so on) and polls
   at **60 seconds** only while the connection is open and its last heartbeat
   is under 30 seconds old. The moment either stops being true the screen goes
   straight back to its own interval, and reads its topics once at once.
3. On a message, the matching keys are invalidated. Data is never set from a
   message.
4. Nothing on screen shows the connection: no banner, no indicator.

## 6. `GET /api/v1/auth/me` addition

```json
"live": { "enabled": true, "origin": "https://zchaat-pos-api.onrender.com" }
```

`enabled` is false when the server runs with `LIVE_CHANNEL=off`; screens then
poll exactly as before P33. `origin` is `LIVE_ORIGIN`, else the host's own
address (`RENDER_EXTERNAL_URL`, which Render sets), else null, meaning the
page's own address. Additive.

## 7. Switching it off

`LIVE_CHANNEL=off` and a restart: no socket is opened, nothing is announced,
and every screen polls at its own interval. This is the rollback.

## Error codes

No new HTTP error code.

# P36 One kitchen ticket per table

Asked for by Arya on 2026-10-11. `docs/prompts/P36-one-kitchen-ticket-per-table.md`.
Additive: a ticket written before P36 reads and behaves exactly as before.

## 1. The setting

`settings.kitchen.oneTicketPerOrder`, Boolean, default `true`, on `GET` and
`PATCH /settings` in the existing `kitchen` group (M7), OWNER to change, with the
usual reason and audit line. Off, firing is exactly M18 section 2 (P05).

## 2. Firing (changes M2 12.8 and M18 section 2)

With the setting on, `POST /orders/:orderId/fire`:

1. Routes every pending line to its station exactly as M18 section 2 steps 1
   to 4.
2. When the order already has a ticket (its most recent by `firedAt`), adds the
   lines to it: each new ticket line carries `stationId`, `stationName`,
   `firedAt` and `round`, the ticket's `rounds` goes up by one and its
   `lastFiredAt` is now. No new `kotNumber` is reserved.
3. When it has none, makes one ticket, numbered as before, `rounds: 1`. Its own
   `stationId` and `stationName` are the station every line went to, or null
   when the lines went to more than one.
4. Every order line fired points its `kotId` at that ticket. Same transaction,
   same version check, same stock deduction, once per line.

The response is unchanged in shape: `{ kot, kots: [kot], order }`, plus
`round`, the round number just sent.

With the setting off, a fire still writes `stationId`, `stationName`,
`firedAt` and `round: 1` on each new ticket line, so every ticket reads the
same way.

## 3. Reading tickets (changes M2 13.1 and M18 section 3)

A ticket line's **station** is its own `stationId` and `stationName`, or the
ticket's when the line has none (a ticket from before P36). A line's **sent
time** is its own `firedAt`, or the ticket's. Every ticket in a response
carries each line's station, sent time and `round` filled in that way, the
ticket's `rounds` (1 when absent) and `lastFiredAt` (its `firedAt` when absent).

`GET /kots?stationId=` returns the tickets with at least one line at that
station. `none` returns the tickets with a line that has no station. The status
filter is unchanged: it reads the whole ticket; a screen showing one station
works out that station's part itself.

## 4. Marking ready and undoing, for one station

`PATCH /kots/:kotId/ready` and `POST /kots/:kotId/undo-ready` take an optional
query `stationId`: only the lines at that station are marked, or taken back.
Without it, every line, as before. A `stationId` that no line has is 422
`BUSINESS_RULE_VIOLATED`, "Nothing on this ticket is for that station." The
one-line endpoints are unchanged.

## 5. The printed ticket (changes M18 3.1)

`GET /kots/:kotId/ticket` takes an optional `round` (a whole number, 1 or more)
and an optional `stationId`:

1. With `round`, only that round's lines print, and the time beside the KOT
   number is that round's sent time. The KOT line reads `KOT 12  ROUND 2` for any
   round after the first.
2. With `stationId`, only that station's lines print, under that station's name.
3. With neither, every line prints, as before.
4. A round or station with no line on the ticket is 422 `BUSINESS_RULE_VIOLATED`.

## 6. Reports

R13's kitchen section and its slowest items group by each line's station, and
measure from each line's sent time to its `readyAt`. A round is counted in the
range by its own sent time. The `stationId` filter matches a line's station. On
a ticket with one round, every figure is what it was.

The bill timeline (R10) shows one "Sent to the kitchen" event per round:
`KOT 12`, then `KOT 12, round 2`.

## Error codes

None new.

---

# P39 A captain cannot change a printed bill

`docs/prompts/P39-captain-locked-after-print.md`. Changes the permissions of
M3 16.4, 16.6, 16.8.1 and 16.8.2 for one role. No new endpoint, field or code.

A `WAITER` is refused, with 403 `FORBIDDEN` and the message "This bill has
been printed. Only the counter or a manager can change it now.", when the
bill's `printCount` is above 0, on:

| Endpoint | When |
|---|---|
| `POST /bills/:billId/remove-lines` | always, a `preview` included |
| `POST /orders/:orderId/lines` | when the order has a live bill, so the lines would revise it |
| `POST /bills/:billId/cancel-lines` | always, a `preview` included |
| `POST /bills/:billId/reopen` | always |

A manager's `approval` does not lift it. It is checked after the bill is
found and before any other rule about it, so a captain never learns more about
a printed bill than that it is printed. Before the first print, and for
`OWNER`, `MANAGER` and `CASHIER` always, everything is as before.

## Error codes

None new.

---

# P40 A manager's PIN to add to a printed bill

`docs/prompts/P40-pin-to-change-a-printed-bill.md`. Changes M2 12.4 and M3
16.8.2. No new endpoint or code; one new optional body field.

`POST /orders/:orderId/lines` takes an optional `approval: { approverId, pin }`,
the P28 shape. When the order has a live bill that the lines would revise
(16.8.2) and that bill's `printCount` is above 0, the caller is a `CASHIER`, and
`approvals.revisePrintedBill` is on, the approval is required and checked by
the P28 rules: missing, or not an active owner or manager here, is 403
`FORBIDDEN` "A manager has to approve this. Pick their name and type their
PIN."; a wrong PIN is 401 from `verifyPin`. An `OWNER` or `MANAGER` approves
their own. In every other case `approval` is accepted and ignored.

Checked in this order: P39's captain refusal, `DAY_CLOSED`, `BILL_NOT_REVISABLE`,
then the approval, all before anything is written.

The revision of kind `ADDED` stores `approvedBy` (null when the actor approved
themselves), and `BILL_REVISED` carries it in `details.approvedBy`, as a removal
does (16.8.1 steps 4 and 5).

## Error codes

None new.

---

# P41 Kitchen recall, undo after Send, the floor as tiles

`docs/prompts/P41-kitchen-recall-undo-send-floor-tiles.md`. One new endpoint,
one new query parameter, one new reason code, one new audit action. The
kitchen text and the floor are client only.

## 1. `GET /kots?sort=recent`

See 13.1. Any other value of `sort` is 400.

## 2. Undo a Send

```
POST /api/v1/orders/:orderId/undo-send
{ "version": 7 }
```

Roles: OWNER, MANAGER, CASHIER, WAITER, the same as firing (12.8).

The **last Send** is the order's sent lines (`FIRED`, `READY` or `SERVED`)
whose `firedAt` is the latest `firedAt` on the order. Lines cancelled since are
left out of it.

Refused, in this order:

1. The order belongs to another restaurant, or does not exist: 404.
2. The order is not `OPEN`: 422, as 12.4.
3. The order has a live bill: 422 `BUSINESS_RULE_VIOLATED`, "This table has a
   bill. Change the items from the bill."
4. Nothing has been sent: 422 `BUSINESS_RULE_VIOLATED`, "Nothing has been sent
   to the kitchen yet."
5. The last Send is more than 60 seconds old (`UNDO_SEND_WINDOW_MS`, a server
   constant): 422 `BUSINESS_RULE_VIOLATED`, "Too late to undo. Cancel the dishes
   instead."
6. Any line of the last Send is `READY` or `SERVED`: 422
   `BUSINESS_RULE_VIOLATED`, "The kitchen has already marked some of these
   ready. Cancel them instead."
7. `version` is stale: 409 `VERSION_CONFLICT`.

What happens, in **one transaction**:

1. Each line of the last Send is cancelled through `cancelLineInSession`, with
   `reasonCode: SENT_BY_MISTAKE`, no note, `wasPrepared: false` and no
   approval. Its kitchen ticket line becomes `CANCELLED`, and with inventory on
   its deducted stock comes back.
2. For each, a new `PENDING` line is pushed with a new id and the same
   `menuItemId`, `itemName`, `variantId`, `variantName`, `unitPriceInPaise`,
   `taxRateBps`, `menuTaxRateBps`, `quantity`, `addOns`, `notes`,
   `priceSource`, `categoryId` and `categoryName`, `addedBy` the caller and
   `addedAt` now. The order is `OPEN` with `readyToBillAt` null.
3. `KOT_SEND_UNDONE` is written, entity `ORDER`, `entityLabel` "Order
   {orderNumber}", `reason` the item names, `details: { lineIds, itemNames,
   kotIds, tableName }`. A MANAGER may read it.

Response 200: the order, as `GET /orders/:orderId`.

## 3. Reason code

`LINE_CANCEL_REASONS` gains `SENT_BY_MISTAKE`, "Sent to the kitchen by
mistake", appended before `OTHER`, server and client.

## Error codes

None new.

---

# P42 Changing a dish after it is sent

`docs/prompts/P42-edit-a-sent-kot-and-a-kitchen-only-screen.md`. One new
endpoint, two narrowed rules, one new field. No new error code.

## 1. Who needs a PIN to cancel a sent line (changes 12.6 and P28 section 3)

`approvals.lineCancel` applies to a line that was **made**: `READY` or
`SERVED`, or any sent line cancelled with `wasPrepared: true`. A `FIRED` line
cancelled with `wasPrepared: false` needs no approval from OWNER, MANAGER,
CASHIER or WAITER. `wasPrepared` is still required for every sent line, as
12.6 says; the order screen sends `false` for a `FIRED` line unless the person
ticks "Already made by the kitchen", and `true` for a `READY` or `SERVED` one.

## 2. 12.6a Lower the quantity of a sent line

```
POST /api/v1/orders/:orderId/lines/:lineId/reduce
{ "version": 7, "quantity": 2, "reasonCode": "MODIFICATION", "note": null,
  "wasPrepared": false, "approval": { "approverId": "...", "pin": "2468" } }
```

Roles: OWNER, MANAGER, CASHIER, WAITER. `quantity` a whole number, at least 1
and below the line's quantity. `reasonCode`, `note`, `wasPrepared` and
`approval` follow 12.6 exactly, for the part being taken off.

Refused: the order not open, or with a live bill, as 12.6; the line `PENDING`
(422, "Change the quantity of a dish not sent yet with its stepper."),
`CANCELLED` (422), or `quantity` not below its quantity (400).

In **one transaction**:

1. The line's `quantity` becomes `quantity`.
2. A new line is pushed with a new id, the line's snapshot, `status`, `kotId`,
   `firedAt`, `readyAt` and `servedAt`, and `quantity` the difference.
3. Its kitchen ticket line takes the new `quantity` and `changedAt` now, and a
   ticket line for the difference is pushed beside it (same station, round
   and sent time, pointing at the new line).
4. The new line is cancelled through `cancelLineInSession` with the request's
   reason, `wasPrepared` and approval, so its ticket line is `CANCELLED`, a made
   one writes `LINE_CANCELLED_AFTER_PREP`, and an approved one
   `LINE_CANCELLED_APPROVED`.
5. With inventory on and `wasPrepared: false`, the difference's share of what
   was deducted for the line comes back as `CANCELLATION_RETURN` movements
   on the line, keyed `{lineId}:{ingredientId}:CANCELLATION_RETURN:{newLineId}`.

Response 200: the order.

## 3. Stock returned on a cancel

`returnStockForCancelledLine` returns, per ingredient, what was deducted for
the line less what has already come back for it. A line never reduced returns
exactly what it did before.

## 4. `kots.lines[].changedAt`

Date or null, default null. Set when a sent line's quantity or note changes.
The kitchen screen shows "Changed" on such a line.

## Error codes

None new.

---

# P43 Other, with the mode of payment

`docs/prompts/P43-other-payment-mode.md`. No new endpoint, field or code.

`POST /bills/:billId/payments` (14.5) with `method: "OTHER"` requires
`reference`, the mode of payment, 1 to 100 characters after trimming; without
it, 422 `BUSINESS_RULE_VIOLATED`, "Say how it was paid, for example Cheque."
Checked after the method rules, so a restaurant with `OTHER` switched off still
answers `PAYMENT_METHOD_NOT_ALLOWED`. Every other method's `reference` stays
optional.

## Error codes

None new.

---

# P44 The Day End summary, and the day-end message by email

`docs/prompts/P44-day-end-summary-and-email.md`. Two new endpoints, one new
setting, one new closure field, one new error code.

## 1. `GET /day-close/:businessDate/message`

Roles: OWNER, MANAGER. Response `{ businessDate, subject, text }`: the message
of the prompt's section B. `subject` is "{restaurant name} day end, {d}-{Month}-{yyyy}".
For a caller who may not see the drawer total (the blind count: `seesCash`, as
`GET /day-close/:businessDate`), the two cash-in-hand lines read "—".

## 2. `POST /day-close/:businessDate/email`

Roles: OWNER, MANAGER. No body. Sends the full message (cash lines included)
to `settings.reports.dayEndEmails`, and nowhere else. Response
`{ sentTo: [addresses] }`.

Refused: no addresses, 422 `BUSINESS_RULE_VIOLATED` "Add an email address for
the day-end report in Settings first."; `RESEND_API_KEY` not set, 422
`BUSINESS_RULE_VIOLATED` "Email is not set up on the server."; Resend refusing
or unreachable, 502 `EMAIL_SEND_FAILED` with Resend's own message.

## 3. Sent at Day Close

`POST /day-close` (M16) sends the message after the close is saved, when
addresses and the key are set. The closure records `dayEndEmail: { sentAt,
to, error }`; `error` is Resend's message when it failed, and the close stands
either way. `GET /day-close/:businessDate` returns `dayEndEmail` on a closed day.

## 4. `settings.reports.dayEndEmails`

List of up to 5 email addresses, default `[]`, stored lowercased, duplicates
refused. OWNER through `PATCH /settings`, audited as `SETTINGS_CHANGED`.

## 5. Environment

`RESEND_API_KEY` (optional; without it nothing is emailed), `DAY_END_EMAIL_FROM`
(default `Restaurant ERP <onboarding@resend.dev>`), `RESEND_API_BASE` (default
`https://api.resend.com`; tests point it at a fake).

## Error codes

`EMAIL_SEND_FAILED` 502.

---

# P46 Open item

`docs/prompts/P46-open-item.md`. New fields only; no new endpoint or code.

## 1. Menu items (M1)

`POST /menu-items` and `PATCH /menu-items/:itemId` take `isOpenItem` (boolean,
default false), OWNER and MANAGER as for the rest of the item. Every read of an
item returns it. `priceInPaise` is still required (0 is allowed) and is not used
for an open item.

## 2. Order lines (M2 12.1 and 12.4)

A line request may carry `openItem: { name, priceInPaise }`: `name` trimmed, 1
to 80 characters; `priceInPaise` an integer from 1 to the money ceiling.

- The menu item is an open item and `openItem` is missing: 422
  `BUSINESS_RULE_VIOLATED`, "Type the dish's name and price."
- The menu item is not an open item and `openItem` is sent: 422, "Only an open
  item takes a typed name and price."
- An open item with `variantId` or `addOnIds`: 422, "An open item has no sizes
  or extras."

The line freezes `itemName` = the typed name, `unitPriceInPaise` = the typed
price, `taxRateBps` = the item's, the item's category, and `isOpenItem: true`.

## 3. Bills (M3)

`bills.lines[].isOpenItem`, copied from the order line. The receipt, the
invoice and every report read the frozen name and price, as for any line.

## 4. Where open items never appear

`GET /public/:slug/menu` and the public quote leave them out, and a public
request naming one is refused as a dish not on the menu. The M21 item mapping
lists, unmatched list and CSV import leave them out.

## 5. R11

The by-item grouping adds the typed name for open items, so each shows under
its own name.

## Error codes

None new.

---

# P47 Other modes

`docs/prompts/P47-other-modes.md`. One new setting; no new endpoint or code.

`settings.payments.otherModes`: list of strings, default `["Swiggy Dineout",
"Zomato Dineout", "EazyDiner", "Cheque", "Bank transfer", "Coupon"]`. At most
12; each trimmed, 1 to 40 characters; no two the same ignoring case. A PATCH
replaces the list. OWNER through `PATCH /settings`, audited as
`SETTINGS_CHANGED`. `GET /auth/me` gains `payments: { otherModes }`.

The modes are offered by the payment panel only. 14.5's rule is unchanged: an
`OTHER` payment needs a `reference`, any text; it need not be on the list.

## Error codes

None new.

---

# P48 PetPooja's way

`docs/prompts/P48-petpooja-floor-recall-change-counter.md`. Two additions.

## 1. `GET /bills?number=12`

`number`, a whole number from 1: the bills whose `billSequence` is that
number, in any series, newest first. With the other filters as before.

## 1a. `GET /tables/:tableId/history`

Roles: OWNER, MANAGER, CASHIER, WAITER. Read-only. The table's orders opened on
today's business date (or `?date=YYYY-MM-DD`), newest first:

```json
{ "tableName": "Table 5", "businessDate": "2026-10-14", "orders": [
  { "orderId": "...", "orderNumber": 12, "status": "BILLED", "openedAt": "...",
    "openedByName": "Shivam", "guestCount": 3,
    "sends": [ { "firedAt": "...", "kotNumbers": [41], "sentByName": "Shivam",
      "lines": [ { "itemName": "Pani Puri", "variantName": null, "quantity": 2,
        "addOnNames": [], "status": "SERVED" } ] } ],
    "notSent": [ { "itemName": "...", "quantity": 1 } ],
    "cancelled": [ { "itemName": "...", "quantity": 1, "at": "...", "byName": "Govind",
      "reason": "Guest changed the order", "wasPrepared": false } ],
    "bill": { "billId": "...", "billNumber": "2026-27/000012", "status": "PAID",
      "grandTotalInPaise": 42000 } } ] }
```

A send is the order's lines that share one `firedAt`. Names are attached when
read, as labels only (P13's rule). 404 for another restaurant's table.

## 2. Typed extras on a line (M2 12.1 and 12.4)

A line request may carry `extras: [{ name, priceInPaise }]`, at most 5: `name`
trimmed, 1 to 40 characters; `priceInPaise` an integer from 1 to the money
ceiling. Each is frozen into the line's `addOns` as `{ addOnId: null, name,
priceInPaise }`, after the menu's add-ons, and is taxed at the line's rate. A
public request with extras is refused as the open item is (P46).
`orders.lines[].addOns[].addOnId` may be null from P48.

## Error codes

None new.

---

# P49 Removing a dish before it is sent

`docs/prompts/P49-remove-before-sending.md`. One new endpoint.

```
DELETE /api/v1/orders/:orderId/lines/:lineId?version=7
```

Roles: OWNER, MANAGER, CASHIER, WAITER. Only a `PENDING` line: otherwise 422
`BUSINESS_RULE_VIOLATED`, "This dish has been sent to the kitchen. Use Change."
An order with a live bill: 422, "This table has a bill. Change the items from
the bill." `version` is required; a stale one is 409 `VERSION_CONFLICT`.

The line is removed from `orders.lines` (a `$pull` through the version). No
reason, no cancelled line, no audit line, no stock movement: it never reached
the kitchen. Response 200: the order.

This is the "unfired draft order line" CONVENTIONS section 3 names as the one
kind of thing DELETE is for. A sent line is never deleted.

## Error codes

None new.

# P50 Closing a table opened by mistake

`docs/prompts/P50-close-a-table-opened-by-mistake.md`. One new endpoint.

```
POST /api/v1/orders/:orderId/close
{ "version": 7 }
```

Roles: OWNER, MANAGER, CASHIER, WAITER. The order must be `OPEN` with no
`billId`, and no line may ever have reached the kitchen: every line `PENDING`
with no `firedAt`, or cancelled without one. Otherwise 422
`BUSINESS_RULE_VIOLATED`, "Dishes have been sent to the kitchen. Ask a manager
to cancel the order." `version` is required; a stale one is 409
`VERSION_CONFLICT`.

The unsent lines are pulled, as P49 removes a line, and the order is set
`CANCELLED`, `isCancelled: true`, `cancelledAt`, `cancelledBy`,
`cancelReasonCode: "OPENED_BY_MISTAKE"`, in one versioned write. The table is
free. No audit line, no stock movement, no kitchen ticket change: nothing was
ever sent. Response 200: the order.

`OPENED_BY_MISTAKE` is written only here. `POST /orders/:orderId/cancel` does
not accept it. R15's cancelled orders and Day Close's "Orders cancelled" leave
these orders out.

## Error codes

None new.

# P37 M21 WhatsApp: the connection, templates and the receipt

`docs/prompts/P37-whatsapp-foundation-and-the-receipt.md`. Additive. Built and
tested against a fake Meta; Z Chaat has no WhatsApp Business Account connected
yet.

## 1. The provider

`WHATSAPP`, kind `MESSAGING`, in the M21 registry. Meta's Cloud API, called
directly, on each restaurant's own WhatsApp Business Account (WABA).

Credentials, sealed under `INTEGRATION_SECRETS_KEY`, shown only as their last
four characters, never logged, returned or audited: `phoneNumberId`, `wabaId`,
`accessToken`, `webhookVerifyToken` (our own string, at least 16 characters),
`appSecret`.

Config: `sendBillOnPayment` (default false), `defaultLanguage` (default `en`),
`senderDisplayName` (or null), and `apiBaseUrl` (default
`https://graph.facebook.com/v21.0`; https always, plain http only to this
machine outside production, for the fake in tests).

`POST /integrations/WHATSAPP/test` reads the number back from Meta
(`GET {apiBaseUrl}/{phoneNumberId}`) and passes only when Meta answers with
that id and the number is on the Cloud API (`platform_type: CLOUD_API`). The
message names the business and its quality rating. Success switches the
connection on, as every provider's test does.

## 2. Templates

A template is a record with a state (DB-SCHEMA section 54), never a string in
the code.

### 2.1 List

```
GET /api/v1/integrations/whatsapp/templates
```

OWNER, MANAGER. Every template of this branch, oldest first, each with
`categoryChanged: true` when Meta approved it in another category than we
asked for (`approvedCategory` differs from `category`); the screen warns on it.

### 2.2 Add

```
POST /api/v1/integrations/whatsapp/templates
{ "key": "BILL_RECEIPT", "metaName": "bill_receipt", "category": "UTILITY",
  "language": "en", "bodyText": "Thanks for visiting {{1}}! ...",
  "variables": ["restaurantName", "billNumber", "billTotal"],
  "example": ["Z Chaat", "2026-27/000148", "₹795.00"], "submit": true }
```

OWNER. `key` is ours, unique per branch, capitals and underscores. `metaName`
is lowercase letters, digits and underscores, as Meta requires. `variables`
names what fills `{{1}}`, `{{2}}` and so on, in order, and must have one entry
per numbered variable in `bodyText`, as must `example`. With `submit: true`
(the default) the template is sent to Meta for review and takes the state Meta
answers, normally `PENDING`. With `submit: false` it is linked to a template
already made by hand in Meta's own screens, and read back at the next sync. A
connection that is not on is 422 `MESSAGING_NOT_CONNECTED`. No template
designer.

### 2.3 Sync

```
POST /api/v1/integrations/whatsapp/templates/sync
```

OWNER, MANAGER. Reads every template from Meta and updates the matching
records (by `metaName` and `language`): `status`, `approvedCategory`,
`rejectionReason`, `lastSyncedAt`. A Meta template with no record is left
alone. Returns the list as 2.1.

## 3. Sending

One way in, `sendTemplate` in `services/integrations/messaging/whatsappService.js`,
which in this order:

1. Finds this branch's WhatsApp connection: not `ACTIVE` is 422
   `MESSAGING_NOT_CONNECTED`.
2. Finds the template by `key`: not `APPROVED` is 422 `TEMPLATE_NOT_APPROVED`.
   Refused, never queued.
3. Finds the guest, by mobile, at this restaurant. A marketing template
   (`approvedCategory: MARKETING`) to a guest without live offers consent is
   422 `GUEST_OPTED_OUT`. A utility template is never consent-gated: a guest who
   opted out of offers still gets their bill. A guest whose number Meta said is
   not on WhatsApp is skipped, `skipped: "UNREACHABLE"`; one with no record at
   this restaurant, `skipped: "NO_CUSTOMER"`.
4. Queues the send as an integration job with the idempotency key as its
   `dedupeKey`, on the existing unique index `{ restaurantId, dedupeKey }`: the
   same key again queues nothing and answers `duplicate: true`.

The job carries the guest's id, never the number; the number is read when the
job runs. The job checks the connection is on and the template still
`APPROVED`, calls `POST {apiBaseUrl}/{phoneNumberId}/messages`, stores the
message id Meta returns on the job's `result`, and writes an event line through
`redactForLog`. A network or 5xx failure retries on the M21 ladder (30 s, 2 min,
10 min, 30 min, 2 h, then DEAD). A 4xx from Meta is final: the event is FAILED,
the job ends with `result.failed`, and it is never retried.

## 4. The receipt

When a bill's status becomes `PAID`, after the write commits (never inside a
transaction that could still roll back), and only when: the WhatsApp
connection is on with `sendBillOnPayment`, the order has a customer mobile,
the bill is not a platform order's, and the template `BILL_RECEIPT` is
`APPROVED`. Its variables come from `buildInvoiceData` and nothing is computed:
`restaurantName` (the restaurant's name), `billNumber`, and `billTotal` (the bill
total through `paiseToRupees` with the rupee sign, like `₹795.00`). The
idempotency key is `bill:<billId>:receipt`, so a bill sends at most one
receipt however often it is saved. A failure to queue is logged and swallowed:
it never fails the payment. A No Charge order has no bill, and a voided bill is
never paid, so neither sends.

## 5. The webhook

```
GET  /api/v1/hooks/WHATSAPP/:webhookKey?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
POST /api/v1/hooks/WHATSAPP/:webhookKey
```

The GET is Meta's subscription handshake: with `hub.mode=subscribe` and the
connection's `webhookVerifyToken`, it answers 200 with `hub.challenge` as plain
text; anything else is 403. The POST is verified with `appSecret` against
`X-Hub-Signature-256` over the raw body (mounted before the JSON parser, as
every M21 hook is), stored, then processed by a job; a duplicate changes
nothing.

1. **Delivery receipts.** `sent`, `delivered`, `read` and `failed` are recorded
   against the job that sent the message (`result.deliveryStatus`,
   `result.deliveryAt`). A `failed` that says the number is not on WhatsApp
   (Meta's error 131026) marks the guest unreachable, and nothing more is sent
   to them.
2. **STOP.** A guest replying STOP, UNSUBSCRIBE or STOP PROMOTIONS, or Meta's own
   marketing opt-out preference, withdraws their offers consent at once through
   `customerService`: `offers.given: false`, with an `offersHistory` entry of
   source `ONLINE` and the reason "Replied STOP on WhatsApp". They are told once,
   inside the free service window, that offers stop and bills continue. Their
   receipts continue. A number with no guest record changes nothing and is not
   answered.

## Error codes

`TEMPLATE_NOT_APPROVED` 422, `MESSAGING_NOT_CONNECTED` 422, `GUEST_OPTED_OUT`
422. CONVENTIONS section 3.

# P51 The WhatsApp assistant

`docs/prompts/P51-whatsapp-assistant.md`. Additive. Depends on P37.

## 1. The AI providers

New M21 provider kind `AI_ASSISTANT`, three providers, set up like every M21
provider (`PUT /integrations/:provider`, `POST .../test`, pause, resume):

| Provider | Credentials (sealed) | Config |
|---|---|---|
| `GEMINI` | `apiKey` | `model` (default `gemini-2.5-flash`), `apiBaseUrl` (default `https://generativelanguage.googleapis.com/v1beta`) |
| `ANTHROPIC` | `apiKey` | `model` (default `claude-haiku-5-5`), `apiBaseUrl` (default `https://api.anthropic.com`) |
| `GROQ` | `apiKey` | `model` (default `openai/gpt-oss-120b`), `apiBaseUrl` (default `https://api.groq.com/openai/v1`) |

https always; plain http only to this machine outside production, for the fake
in tests. The key travels in a header, never in an address. The test asks the
model for one word and passes only when it answers. When more than one is on,
the assistant uses `ANTHROPIC`, then `GROQ`, then `GEMINI`. None has a webhook.
Groq was added at Arya's request; its OpenAI-shaped API takes `tools` and
answers `tool_calls`, and a gpt-oss model is asked for low reasoning effort,
because its thinking counts against the reply's length. The free tiers of
Gemini and Groq are for testing, and the sheet says so.

## 2. Settings

`settings.assistant` on `GET` and `PATCH /settings`, OWNER, audited:
`enabled` (false), `bookingsEnabled` (true), `greeting` (null, up to 300
characters), `handoffHours` (null, up to 120 characters, like "between 11 am and
10 pm"), `dailyAiLimit` (500, 0 to 5,000).

## 3. What a guest's message does

The P37 webhook now stores every text, button reply and list reply from a guest
as an `INBOUND_MESSAGE` event, processed by a job; the exact STOP keywords keep
their P37 path. A number with no guest record at this restaurant gets one
(`customers.source: WHATSAPP`, no visit yet), so the assistant can answer it.

For each message, in order:

1. The conversation is found or opened, the message kept as a turn, and
   `lastInboundAt` set: the 24-hour window is open.
2. A conversation waiting for, or with, a person (`NEEDS_STAFF`, `STAFF`): the
   assistant is quiet.
3. The assistant off: nothing is sent, and the chat waits in Chats for a
   person. No AI connection on, or the day's `dailyAiLimit` used: the **fixed
   menu**, three buttons (Book a table, Opening hours, Talk to us), answered
   without a model. Built differently from the plan, which sent the fixed menu
   with the assistant off too: an owner who switches the assistant off expects
   it to say nothing.
4. Otherwise the model, with the system prompt (P51 section 11), the last 12
   turns and the tools (P51 section 9), up to 4 rounds of tool calls.
5. **The reply check.** Every rupee amount, time, link and reference in the reply
   must appear in this message's tool results, the facts block or the guest's
   words; a claim that messages are stopped needs a successful `stop_messages`;
   at most 900 characters. A failing reply goes back to the model once, then the
   guest is told the team will reply and the chat is handed to staff.
6. The reply is sent as a free-form message, with up to three reply buttons when
   the model offered choices, through P37's job runner.

A guest who stopped all messages (`whatsappStoppedAt`) and writes again gets an
answer to what they asked, inside the window they opened, and nothing else.

## 4. Stopping messages

`stop_messages`, called by the model, or the STOP keywords:

| Scope | Effect |
|---|---|
| `OFFERS` | Offers consent withdrawn (`customerService.withdrawOffersFromMessage`, source `ONLINE`). Bills and booking messages still go. |
| `ALL` | As `OFFERS`, and `customers.whatsappStoppedAt` set: `sendTemplate` and every job skip this guest, bills included, `skipped: "STOPPED"`. Cleared only by staff, on the chat. |

## 5. Bookings on WhatsApp

`request_booking` runs `reservationService.request` exactly as the public page
does, with `source: WHATSAPP`, the guest's own number, and an idempotency key
of the conversation and the slot. It waits for staff to confirm. When staff
confirm or decline a `WHATSAPP` booking, the guest is told: inside their
24-hour window as a free-form message, else through the utility templates
`BOOKING_CONFIRMED` (`reference`, `date`, `time`, `partySize`) and
`BOOKING_DECLINED` (`reference`, `reason`), when approved. A failure to tell
them never fails the confirm.

## 6. The staff inbox

OWNER, MANAGER, CASHIER. No phone number in any address or answer.

```
GET  /api/v1/chats                     the chats needing a person first, then by last message
GET  /api/v1/chats/:chatId             its turns, the guest's first name, their upcoming bookings
POST /api/v1/chats/:chatId/reply       { text }: sent inside the 24-hour window; outside it, 422
POST /api/v1/chats/:chatId/hand-back   to the assistant
POST /api/v1/chats/:chatId/done        closed, until the guest writes again
POST /api/v1/chats/:chatId/clear-stop  { reason }: the guest asked to get messages again
```

A chat in the list: `{ id, status, guestFirstName, lastMessageAt, lastText,
windowOpen, handoffReason, stoppedAll }`. `GET /online/inbox` gains
`waitingChats` (chats needing a person) and `latestChatAt`, and the online
alert counts them for OWNER, MANAGER and CASHIER. The inbox answers while
online orders are on, a delivery platform is on, or, from P51, the WhatsApp
connection is on, so a chat rings the till with the online page off.
`GET /auth/me` `online` gains `chats`: whether the WhatsApp connection is on.
A change to a chat is announced on the live channel's `online` topic, so the
inbox and the Chats screen read again at once.

## Error codes

None new. A staff reply outside the window is 422 `BUSINESS_RULE_VIOLATED`.

# P54 Constant backups

`docs/prompts/P54-constant-backups.md` (written as P44). Additive. Beside P30's
`GET /api/v1/system/starts`, and like it about the server, not a restaurant.

## 1. `GET /api/v1/system/backups`

OWNER only; 403 for every other role. No query. Reads `backupruns` and
`backupstate` (DB-SCHEMA section 56) and returns nothing about any restaurant.

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "lastSnapshot": { "at": "2026-10-14T06:00:12Z", "status": "OK", "bytes": 1840221 },
    "lastJournalFlush": { "at": "2026-10-14T09:55:03Z", "eventCount": 214 },
    "behindSeconds": 41,
    "gapSince": null,
    "failuresLast7Days": 0,
    "database": { "bytes": 18874368, "limitBytes": 536870912 },
    "fullCopies": "EVERY_6_HOURS",
    "storage": { "estimatedBytes": 126877696, "freeBytes": 10000000000, "last30DaysBytes": 9437184 },
    "state": "OK"
  }
}
```

1. `lastSnapshot`: the newest snapshot run, whatever its status; `at` is when it
   finished, or started while running. `null` before the first.
2. `lastJournalFlush`: the newest `OK` diary upload. `null` before the first.
3. `behindSeconds`: seconds since the oldest change waiting to be uploaded; 0
   when nothing waits. `null` when backups are off.
4. `state`:
   1. `OFF`: backups are not enabled.
   2. `FAILING`: the newest run of either kind failed, or `gapSince` is set.
   3. `LATE`: a change has waited more than 15 minutes, or there is no `OK`
      snapshot in the last 7 hours (25 hours when `fullCopies` is `DAILY`) and
      none is running.
   4. `OK`: otherwise.
5. `database.limitBytes`: 512 MB, Atlas M0's limit, a named constant that
   changes if the tier does.
6. `fullCopies`: `EVERY_6_HOURS` or `DAILY`, from the slow-down rule.
7. `storage.estimatedBytes`: the server key cannot list the bucket, so this is
   counted from our own records: `OK` runs still inside each folder's keep time
   (11 days for `snapshots/6h/`, 91 for `snapshots/daily/`), plus every monthly
   copy and diary file ever uploaded (`backupstate.storage.foreverBytes`).
   `freeBytes` is Backblaze's free 10 GB. `last30DaysBytes` is what the
   monthly copies and the diary added in the last 30 days, for the card's
   "lasts about N years".

## 2. R1 Today

When `state` is `LATE` or `FAILING`, R1 Today's `alerts` gain one row for the
OWNER only: kind `Backup`, the sentence "Backups have stopped since 9:55 AM."
(the last good diary upload or copy, India time), and a link to `/settings`.
No other role sees it, and R1's figures and checks do not change.

## 3. Built differently from the prompt

1. The daily copy is the first full copy of each backup day, which starts at
   5:30 AM India time, and the monthly copy is the first of each month.
   Render's free server sleeps from about 2:30 AM to 8:30 AM, so a copy
   scheduled for exactly 5:30 AM would never run; the first copy after it,
   at wake-up, takes its place.
2. Each upload is one PutObject from a temp file, with `Content-MD5`, and the
   SDK's checksums set to `WHEN_REQUIRED`: Backblaze B2 rejects the newer
   default checksum headers, and a file of this size never needs multipart.
3. A gap is also written to the bucket (DB-SCHEMA section 56), so a restore
   from an empty database still refuses a time inside it.
4. The tools read with the drill key from `BACKUP_DRILL_KEY_ID` and
   `BACKUP_DRILL_SECRET`, which the server never needs.
5. After a failed full copy the next waits 2 minutes, then 10, then 30, then
   every hour, until one succeeds (`SNAPSHOT_RETRY_MS`). Every try reads the
   whole database against Atlas M0's weekly read limit, and the first live
   deploy, with a wrong secret, tried once a minute. Added 2026-10-15.

# P55 The owner's dashboard

`docs/prompts/P55-owner-dashboard.md`. No new endpoint and no change to any. The
owner's dashboard, `/owner`, reads three existing reports for today's business date:
`GET /reports/v2/today` (R1: its `money` section and `extra.asAt`),
`GET /reports/v2/day-close?date=` (R2: `sales`, `orderTypes`, `controls`,
`money`, `checks`, `openDays`), and `GET /reports/v2/hours?from=&to=` (R4: `byHour`).


# P56 A note for every dish, the guest before the first KOT, whole voids

`docs/prompts/P56-order-note-guest-before-kot-whole-voids.md`. Two new endpoints
and one changed meaning.

## 1. `PATCH /api/v1/orders/:orderId/kitchen-note`

```
{ "version": 7, "kitchenNote": "Less spicy, Jain" }
```

Roles: OWNER, MANAGER, CASHIER, WAITER. `kitchenNote` is a string of 1 to 200
characters after trimming, or `null` to clear it; an empty string is stored as
`null`. The order must be `OPEN` or `READY_TO_BILL`, otherwise 422
`BUSINESS_RULE_VIOLATED`, "This order is closed, so its note cannot change."
`version` is required; a stale one is 409 `VERSION_CONFLICT`.

The order's `kitchenNote` is set in one versioned write, then every kitchen
ticket of the order gets the same `kitchenNote`. Not audited. Response 200: the
order.

`POST /orders/:orderId/fire` writes the order's `kitchenNote` onto a ticket it
makes, and onto the ticket a new round is added to (P36). `GET /kots` and
`GET /kots/:kotId` return `kitchenNote` on every ticket, `null` when none.
`GET /kots/:kotId/ticket` prints it under the destination line:

```
FOR ALL ITEMS: Less spicy, Jain
```

wrapped to the ticket's width.

## 2. `PATCH /api/v1/orders/:orderId/customer`

```
{ "version": 7, "customerName": "Meera Joshi", "customerPhone": "9825012345", "offersConsent": true }
```

Roles: OWNER, MANAGER, CASHIER, WAITER. Each field is optional and validated as
on `POST /orders` (section 12.1); at least one of `customerName` and
`customerPhone` is required, and `offersConsent: true` needs `customerPhone`,
otherwise 400. An order with a bill is 422 `BUSINESS_RULE_VIOLATED`, "This
order has a bill, so the guest's details are on it already."; any other order
not `OPEN` is 422, "This order is closed, so the guest's details cannot
change." A stale `version` is 409.

`customerPhone` on an order that already has a different one is 422
`BUSINESS_RULE_VIOLATED`, "This order already has the guest's mobile." The same
number again changes nothing. When the order had no mobile and now has one, the
visit is recorded exactly as `POST /orders` records it (M22), with the consent
when `offersConsent` is true; a failure to record it never fails the request.
Response 200: the order.

The order screen asks for these on a dine-in order's first Send, so seating a
table (`POST /orders` from the floor) no longer sends them. `POST /orders`
still accepts them.

## 3. Bills voided to change items

A bill voided inside `POST /bills/:billId/cancel-lines` (M3 16.4) or
`POST /bills/:billId/reopen` (P26) carries `isVoidedToChangeItems: true`.
Every other void leaves it `false`, and so does cancel-lines when it cancels
every item, because the whole order goes with the bill. A whole-order cancel of
an order reopened from a bill sets that bill's mark back to `false`.

Left out of, wherever `isVoided` is true and `isVoidedToChangeItems` is true:

| Where | What changes |
|---|---|
| `GET /bills` | With `includeVoided=true`, these bills are not listed and not in `meta.totals.voidedCount`. With `number=`, they are found as before. |
| `GET /bills/summary` | `voidedCount` and `voidedInPaise` |
| R19 Bill List | `status=VOIDED` matches only bills not voided to change items, unless `billNumber` is given, so the invoice register's drill still opens one |
| R15 | `voids` section |
| R1 Today | `VOID` alerts |
| R2 and Day Close | `controls.voidedBills` |
| GST report | Not sales, Voided bills |

Unchanged, and still counting every voided bill: R10 Invoice Register, R2's
invoice series, the GST report's documents issued, every check C1 to C14, and
Tally. Bills voided before P56 have no mark and are counted as before, so a
closed day's snapshot never changes.

## 4. R15 and the day's controls without single-item cancels

R15 `cancellations` returns the sections `orders` (paged; `meta.total` counts
orders), `voids`, `paidBeforePrint`, `byReason`, `byPerson` and `byItem`. There
is no `items` and no `billChanges` section. The three summaries and
`headline.wastedValueInPaise` add up only the lines of orders cancelled as a
whole in the range. The report's default `columns` are the orders section's.

R2 `day-close`'s `controls` section has no `Items cancelled`, `Wasted value` or
`Bills changed before payment` line. `GET /day-close/:date` and the closure's
snapshot still carry `figures.controls.cancelledItems` and `billRevisions`
exactly as before, so C12 and every check read the same figures; the Day Close
screen, the Day End page and the printed Day Close stop showing them.

## Error codes

None new.

# P57 The bill in one place

Asked for by Rishi, 2026-10-17. The prompt is `docs/prompts/P57-bill-in-one-place.md`.

## 1. `POST /bills` takes a discount and a preview

```
POST /api/v1/bills
```

```json
{
  "orderId": "652f...",
  "version": 9,
  "discount": { "kind": "PERCENT", "rateBps": 1000, "reasonCode": "REGULAR_GUEST", "note": null },
  "preview": true
}
```

Both new fields are optional; without them the endpoint is exactly M3 14.1.

`discount` is the body of `POST /bills/:billId/discount` (14.4): `kind`
`FLAT` with `valueInPaise`, or `PERCENT` with `rateBps`, `reasonCode`, `note`
(required for `OTHER`) and `fundedBy` (default `RESTAURANT`; `PLATFORM` only for
a platform reason). It is applied to the new bill inside the creating
transaction, stored exactly as 14.4 stores it, with `appliedBy` the caller, and
writes the same `DISCOUNT_APPLIED` audit line once the transaction commits.

- 403 `FORBIDDEN` when the caller may not give that discount
  (`billPermissionService.assertCanDiscount`, as 14.4): a captain never; a
  cashier only a platform discount, and only when
  `discounts.cashierMayApplyPlatformDiscounts` is on.
- 422 `BUSINESS_RULE_VIOLATED` when a flat discount is more than the item total.
- 422 `BUSINESS_RULE_VIOLATED`, "This order carries its last bill's discount.
  Change it on the new bill.", on an order with `reopenedFromBillId` (P26).

`preview: true` runs the whole creation, discount included, inside its
transaction and rolls it back. Nothing is written: no bill, no bill number used
(the counter is untouched), no change to the order or its version, no audit
line, no live-channel announcement. Response 200:

```json
{ "preview": true, "billNumber": null, "subtotalInPaise": 42000, "discount": { "amountInPaise": 4200 }, "taxBreakdown": [], "roundOffInPaise": 0, "grandTotalInPaise": 39700, "lines": [] }
```

the bill as it would be, every figure from `utils/tax.js` as on a real bill,
with `billNumber` null and no `id`. Every refusal a real creation makes (order
not ready, stale version, closed day, wrong restaurant, a captain not allowed to
bill) a preview makes too.

## 2. Roles

Unchanged from 14.1 and P25 Part D for creating; `discount` adds 14.4's rule.

## Error codes

None new.

# P58 One kitchen ticket per Send, not per station

Asked for by Arya on 2026-10-17. `docs/prompts/P58-one-ticket-per-send.md`.
Additive: with the new setting at its default, every endpoint behaves exactly
as before.

## 1. The setting

`settings.kitchen.splitTicketsByStation`, Boolean, default `true`, on `GET` and
`PATCH /settings` in the `kitchen` group (M7), OWNER to change, with the usual
reason and audit line. `GET /auth/me` `kitchen` gains `splitTicketsByStation`
beside `readyMeansServed`.

## 2. Firing (changes M18 section 2 and P36 section 2)

With the setting off, `POST /orders/:orderId/fire`:

1. Routes every pending line to its station exactly as M18 section 2, and each
   ticket line freezes `stationId` and `stationName` as P36 says.
2. With `kitchen.oneTicketPerOrder` off, makes one new ticket for the Send,
   holding every pending line, with a newly reserved `kotNumber`. A later Send
   makes another ticket with the next number.
3. With `kitchen.oneTicketPerOrder` on, adds to the order's one ticket as P36.
4. The ticket's own `stationId` and `stationName` are null, even when every
   line went to one station. The printed ticket's heading is therefore
   `KITCHEN` (M18 3.1).

The response shape is unchanged: `{ kot, kots: [kot], order, round }`.

With the setting on, firing is exactly as before.

## 3. Reading, marking ready, printing, reports

Unchanged. A screen that shows whole tickets reads them without `stationId`,
marks them ready without it, and prints them without it (P36 sections 3 to 5).
R13 still groups by each line's own station.

## Error codes

None new.

# P59 A captain's bill prints once, and the guest count moves to the first Send

Asked for by Rishi on 2026-10-21. `docs/prompts/P59-print-once-guests-before-kot.md`.
No new field and no new endpoint; two endpoints take one more optional field.

## 1. One print per request (changes M3 16.3)

Z Chaat's live bills showed many captain bills with `printCount` 2 or 3, the
second print recorded 1 to 4 seconds after the first. The 2026-10-19 lock stops
two tabs of one browser profile only; a second profile (the silent-printing
launcher's beside an everyday Chrome window) or a second till device with
"Print bills sent by captains" on printed the same request again.

`POST /bills/:billId/print-request`: while an earlier request is still waiting
(`lastPrintedAt` is null or before `printRequestedAt`), the request changes
nothing and answers 200 with the bill, so a second tap by the captain is not a
second print. Otherwise as before.

`POST /bills/:billId/printed` takes an optional body:

```json
{ "forRequestAt": "2026-10-20T16:38:03.539Z" }
```

With it, the print is recorded in one conditional write that matches only when
`printRequestedAt` equals `forRequestAt` and the bill has not been printed since
(`lastPrintedAt` null or before it). When nothing matches, another device has
taken that request: 409 `DUPLICATE`, "Another device has printed this bill.",
and nothing changes. Without it, as before.

The counter device reads the bill's invoice data first (so the print says
Duplicate only when it is one), then calls `printed` with `forRequestAt`, and
prints only when that answers 200. Exactly one device prints each request,
whatever the number of devices, profiles or tabs. If the browser then fails to
print, the bill counts as printed; the cashier prints it from the bill screen.

The captain's bill screen shows "Sent to the counter" in place of Print at
counter while their request is waiting.

## 2. The guest count is asked with the guest's details (changes 12.1, P19 and P56)

Tapping a free table opens its order at once, with no guest count. A table with
a booking soon still offers to seat the booking first.

`PATCH /orders/:orderId/customer` (P56 section 2) also takes `guestCount`, an
integer 1 to 100, on a `DINE_IN` order only; on any other order it is 400. At
least one of `customerName`, `customerPhone` and `guestCount` is required. The
same rules on bills and closed orders apply. A new count replaces the old one
until the order is billed.

`settings.floor.requireGuestCount` moves from opening to the first Send:
`POST /orders` no longer refuses a dine-in order without `guestCount`, and
`POST /orders/:orderId/fire` refuses a `DINE_IN` order whose `guestCount` is
null and none of whose lines was ever sent, with 400 `VALIDATION_FAILED`,
`fields.guestCount`, "How many guests? Enter the number before sending to the
kitchen." A later Send is never refused for it.

The order screen's Guest details sheet, on a table's first Send, asks "How many
guests?" first, then the name and mobile. With `requireGuestCount` off the count
is optional and Skip sends without anything.

## Error codes

None new.

# P60 Bill without KOT

Asked for by Rishi on 2026-10-21. `docs/prompts/P60-bill-without-kot.md`.
DB-SCHEMA section 59. One endpoint takes one more optional field.

## 1. `POST /bills` with `withoutKot`

```json
{ "orderId": "652f...", "version": 4, "withoutKot": true }
```

`withoutKot: true` may sit beside `discount` and `preview` (P57). Roles:
OWNER, MANAGER, CASHIER; a WAITER sending it is 403 FORBIDDEN, "Only the counter
can bill without sending to the kitchen."

Inside the bill's own transaction, before the bill is made:

1. The order must be `DINE_IN` or `TAKEAWAY` with no platform; otherwise 422
   `BUSINESS_RULE_VIOLATED`, "Only a table or a takeaway can be billed without
   a KOT."
2. An order already `READY_TO_BILL` is billed as without the field.
3. Otherwise the order must be `OPEN`, every live line not sent (`PENDING`) or
   served, and at least one not sent. A line with the kitchen (`FIRED` or
   `READY`) is 422, "Some dishes are with the kitchen. Bill once they are
   served."
4. With `settings.floor.requireGuestCount` on, a dine-in order without
   `guestCount` is 400 `VALIDATION_FAILED`, as the first Send is (P59).
5. Every not-sent line becomes `SERVED`, with `servedAt` now and
   `billedWithoutKot: true`; `firedAt` and `kotId` stay null. The order becomes
   `READY_TO_BILL` in the same versioned write, so `version` must be current;
   a stale one is 409 `VERSION_CONFLICT`.
6. With inventory on, stock is deducted for those lines exactly as a Send
   deducts it (M4), keyed on the line, so it is never deducted twice.

No KOT is made, nothing reaches the kitchen screen or a kitchen printer, and
R13 counts none of these dishes. The bill is then made exactly as P57 makes it,
and each bill line carries `billedWithoutKot`. A preview rolls all of it back.

After this, the order is an ordinary billed order: removing a dish, cancelling
after billing, reopening and paying all work as before, and a dish billed
without a KOT counts as served (made) for those rules.

## 2. The order screen

For OWNER, MANAGER and CASHIER, an open table or takeaway order with dishes not
yet sent, and none with the kitchen, shows **Bill without KOT** beside Send.
It opens the Bill box (P57) for the order, with the discount, the totals from a
preview, Save and Save & Print. A table's first time asks the Guest details
sheet first, as the first Send does.

## Error codes

None new.

# P61 A simple Day Close

Asked for by Rishi on 2026-10-21. `docs/prompts/P61-simple-day-close.md`.
No new field and no new endpoint. Changes M16 section 6.

## 1. Orders nothing was sent from close themselves

Live Z Chaat on 2026-10-21: Day Close was refused for an order on Table 4 with
no dishes and nothing sent, opened by a tap on the floor. Since P59 a tap opens
a free table at once, so a stray tap or a table opened and left leaves an open
order with nothing in the kitchen.

An order of the business date that is `OPEN`, has no bill, and none of whose
lines was ever sent (every line `PENDING` or `CANCELLED`, none with `firedAt`)
is no longer an `OPEN_ORDER` blocker. `GET /day-close/:businessDate` lists them
apart, as `closesOnClose: [{ orderId, orderNumber, tableName, orderType,
dishesNotSent }]`, `dishesNotSent` the count of not-sent lines.

`POST /day-close` closes each of them first, inside its own transaction,
exactly as P50's Close table does: the not-sent lines are removed, and the order
becomes `CANCELLED` with `cancelReasonCode: ORDER_OPENED_BY_MISTAKE`, by the
person closing the day. No audit line, and they count nowhere (P50). An order
with any dish sent is still a blocker.

## 2. The cashier closes the day

`POST /day-close`, `GET /day-close/:businessDate`, `GET
/day-close/:businessDate/message`, `POST /day-close/:businessDate/email` and
`GET /day-close/:businessDate/print` are open to OWNER, MANAGER and CASHIER.
The count is blind for a cashier always: expected cash and the difference are
never shown to one. `GET /day-close` (the history) and reopening are unchanged.

## 3. The Day End screen

One screen, in this order: the day's bill total and bills, with money by
payment method; **Before you close**, listing only what stops the close, each
with Open (an open order also with **Cancel order**, which opens the order
screen with the manager's whole-order cancel, 12.7, and comes back to Day End;
it stays in the cancellations report), and the not-sent orders that will close
themselves; **Cash in the
drawer**, one amount (or Count by notes); **Close the day**. Keeping cash for
tomorrow and taking the rest out are optional, behind "Taking cash out of the
drawer?"; without them the whole count stays in the drawer as tomorrow's float.
A note is asked only when the server says the count needs one. The day's full
figures, the cash flow and the day-end message stay below, under "Day's
details". The cashier's menu gains Day End.

## Error codes

None new.

---

# P62. The cafe box, the cloud mirror and the network

Built 2026-10-21. Design: `docs/REPLICATION.md`. Every route below exists on
every deployment; what it does depends on `DEPLOYMENT_ROLE`.

## 1. Writes refused by role

Before any route, `middleware/writerGate.js`:

| When | Status | `error.code` | Message (shown to the person) |
|---|---|---|---|
| MIRROR, not promoted, any write outside the allowlist | 503 | `MIRROR_READ_ONLY` | "This is the read-only copy in the cloud. Changes are made on the cafe's own server." |
| BOX that stood down (a higher epoch exists) | 503 | `WRITER_FENCED` | "This server has handed over to the cloud copy. Sign in at the cloud address the manager gives you." |
| BOX whose clock is behind its newest record | 503 | `CLOCK_BEHIND` | "The cafe server's clock is behind the last sale, so nothing can be saved until it is set right. ..." |

The mirror's allowlist is exactly `MIRROR_WRITE_ALLOWLIST`: `POST /auth/login`,
`/auth/refresh`, `/auth/logout`, `/public/:slug/quote`, the six public intake
routes of section 3, `/public/:slug/payments/webhook`, `/hooks/:provider/:webhookKey`,
and the four `/replication/*` routes. A box always answers sign-in and
`/network/report`. These three 503s are the only 5xx whose message reaches the
client.

## 2. Replication (mirror only; 404 elsewhere)

Body: canonical EJSON. Header `X-Replication-Signature: sha256=<hex HMAC of the
body under REPLICATION_SECRET>`; a bad one is `401 REPLICATION_SIGNATURE`.

| Route | Body | 200 `data` | Other answers |
|---|---|---|---|
| `POST /replication/batches` | `{ restaurantId, epoch, entries: [{ seq, epoch, coll, documentId, op, doc, capturedAt }] }` | `{ appliedThrough, applied, skipped, gap, position }` | `409 REPLICATION_GAP { expectedSeq, gotSeq }`, `409 STALE_EPOCH { currentEpoch, sentEpoch }` |
| `POST /replication/intake/claim` | `{ restaurantIds, limit }` (1 to 100, default 20) | `{ items: [intake item] }`, oldest first, each held 2 minutes | |
| `POST /replication/intake/result` | `{ restaurantId, intakeId, status: APPLIED or REJECTED, reasonCode, reasonMessage, result, statusToken }` | `{ recorded }` | |
| `POST /replication/reconcile` | `{ restaurantId, businessDate }` | `{ collections: { <name>: { count, sha256 } }, bills, businessDate }` | |

## 3. Intake on the public routes

On a read-only mirror, these answer `202` and store an intake item instead of
acting: `POST /public/:slug/orders`, `/reservations` (each with
`data.intake = { id, status: 'RECEIVED', secret }`, the secret only on the
first delivery), `/orders/:id/cancel`, `/reservations/:id/cancel`,
`/orders/:id/payment-return`, `/reservations/:id/payment-return`. A new order or
booking is refused with `ONLINE_CLOSED` while the box has not checked in for 5
minutes. `POST /public/:slug/payments/webhook` and `POST /hooks/:provider/:key`
verify the signature as before, store, and answer as before.

`GET /public/:slug/intake/:id?secret=<secret>` (mirror only) gives
`{ id, status, reasonCode, reasonMessage, result, statusToken }`. `result` is
`{ onlineOrderId, reference }` or `{ reservationId, reference }`. The status
token is given once, then null. Wrong secret: 404.

## 4. The network

| Route | Who | Answer |
|---|---|---|
| `GET /network/ping` | anyone, no database | `{ ok: true }`, `no-store`. Devices time it every 5 s |
| `GET /network/setup` | anyone | `{ role, boxUrl, localNameUrl, wifiName }`. Never a password |
| `POST /network/report` | any signed-in role | body `{ deviceId (8-64), deviceName?, page?, pingsMs: [ms or null] (max 30), effectiveType?, downlinkMbps? }`; `data { bars, word }`. Kept in memory only |
| `GET /network/self` | any signed-in role | `{ role, serverTime, writer { epoch, fenced, readOnly, promoted }, clock { refusing }, sync }`. For roles other than OWNER and MANAGER, `sync` is `{ state, entriesWaiting }` only, and `NOT_SYNCED` reads as `WAITING` |
| `GET /network/status` | OWNER, MANAGER | `self` plus `box` (the server's WiFi: `ssid`, `signalPercent`, `signal { bars, word }`, `wired`, `addresses`, `canChange`), `boxUrl`, `localNameUrl`, `staffWifi { ssid, password }`, `devices [{ deviceId, name, userName, role, address, bars, word, medianMs, jitterMs, lossPercent, connected, secondsSinceSeen }]` |
| `GET /network/wifi/networks` | OWNER, box only | `{ networks: [{ ssid, signalPercent, secured, inUse }] }` |
| `POST /network/wifi/connect` | OWNER, box only | body `{ ssid (1-32), password (0-63) }`; `data { box }`. `422 WIFI_CONTROL_OFF` unless `BOX_WIFI_CONTROL=on`; `422 WIFI_CHANGE_FAILED` when the join failed (the box stays where it was). Audited `BOX_WIFI_CHANGED`, never with the password |
| `PUT /network/staff-wifi` | OWNER, MANAGER | body as above; saved in a file on the box, never in the database |

`sync.state`: `SYNCED`, `WAITING` (entries waiting, under 3 hours), `NOT_SYNCED`
(3 hours or more), `LOCAL_ONLY` (no mirror configured); on a mirror `MIRROR` or
`GAP` with `figuresAsOf`, `ageSeconds`, `stale` (over 15 minutes).

Strength (`bars`, `word`) from the median of the last 12 pings and the share
unanswered: Excellent ≤ 40 ms and none lost; Good ≤ 100 ms and ≤ 5 %; Fair
≤ 250 ms and ≤ 15 %; Weak otherwise; No connection when none answered.

# P63. Two-way sync

Spec 2026-10-21, `docs/prompts/P63-two-way-sync.md`, design `docs/REPLICATION.md`
section 13. Everything here applies only while `SYNC_MODE=TWO_WAY`; with the
default `ONE_WAY`, P62 is unchanged.

## 1. Replication (cloud, `TWO_WAY`; signed as P62 section 2)

| Route | Body | 200 `data` | Other answers |
|---|---|---|---|
| `POST /replication/pull` | `{ restaurantId, afterSeq (int >= 0), limit (1-500, default 200) }` | `{ entries: [{ seq, coll, documentId, op, doc, capturedAt }], newestSeq }`, oldest first, seq contiguous from `afterSeq + 1` | |
| `POST /replication/batches` | P62's body plus `seenPeerSeq` (int >= 0, how far the box has pulled) | `{ appliedThrough, applied, skipped, conflicts, gap, position }` | `409 REPLICATION_GAP` as P62. Epochs are not compared while `TWO_WAY` |

On a box or a mirror `/replication/pull` is 404.

## 2. Numbers on the cloud

While `TWO_WAY` the cloud issues bill numbers from its own series (`2026-27/W00001`,
or the prefix plus `W`), with `invoiceSeries` `2026-27/W` (or prefix plus `W`) and
`billSequence` 900,000,000 plus the number; and order, KOT, online order and
booking numbers from 900001. The box's numbers are unchanged.

## 3. Day Close

`POST /day-close`, `POST /day-close/:date/reopen` on the cloud while `TWO_WAY`:
`422 CLOSE_ON_CAFE_PC`, "Close the day on the cafe PC. The website and the PC
share the day, and only the PC closes it." Reads are unchanged.

## 4. Sync

| Route | Who | Answer |
|---|---|---|
| `GET /sync/status` | OWNER, MANAGER | `{ mode, node (BOX or CLOUD), peerUrl (box only), pushed { shippedSeq, newestSeq, waiting }, pulled { seq, at }, lastError, lastErrorAt, conflictsUnseen }` |
| `GET /sync/conflicts?seen=true|false&page&limit` | OWNER, MANAGER | paged list, newest first: `{ id, coll, documentId, kind (EDITED_BOTH, SAME_SLOT, DELETED_HERE), title, detail, fields, keptFrom (BOX or CLOUD), detectedOn, detectedAt, seenAt, seenByName, link }` |
| `POST /sync/conflicts/:conflictId/seen` | OWNER, MANAGER | body `{}`; `data` the conflict with `seenAt` and `seenBy` |

`GET /auth/me` gains `sync: { mode, server, conflictsUnseen }`: `server` is the
answering server's `DEPLOYMENT_ROLE` (`CLOUD` is the website; the P62 connection
bar and banner show only off it), and `conflictsUnseen` is for OWNER and MANAGER
(null for other roles).

# P64 Invoice themes, and what prints on a bill

Spec 2026-10-25, `docs/prompts/P64-invoice-themes-and-print-fields.md`. Changes
M3 section 16.1 (the invoice read), M2 12.x (order lines), M1 (menu items), M7
(settings), M0 2.2 (`PATCH /restaurant`) and M20 P22 (logo slots). No figure
moves: `utils/tax.js`, `computeBillTotals` and the invoice series are untouched.

## 1. HSN and SAC codes

`POST` and `PATCH /menu-items` take `hsnCode`: a string of 4 to 8 digits after
trimming, or null (`""` is stored as null). Anything else is 400.

`settings.invoice.defaultSacCode`, a string of 4 to 8 digits, default `"996331"`
(restaurant service). It may be sent on its own: the mode, prefix and starting
number rule (send all three together) is about those three only.

When a line is added to an order, its `hsnCode` is frozen from the item's own
code, else the restaurant's `defaultSacCode` at that moment. The bill line copies
it. A line or bill line from before P64 has `hsnCode: null`; it is never filled
in later, and prints blank. Changing an item's code changes only lines added
afterwards.

## 2. `settings.invoiceLayout` (OWNER, through `PATCH /settings`)

```json
{
  "invoiceLayout": {
    "theme": "CLASSIC",
    "useBrandAccent": false,
    "show": {
      "time": true, "captain": true, "cashier": false, "covers": true, "table": true,
      "orderType": true, "customerName": false, "customerMobileMasked": false,
      "itemNote": false, "hsn": false, "paymentBreakdown": true, "onHoldOutstanding": false,
      "amountInWords": false, "declaration": false, "signatureLine": false, "reviewQr": true,
      "pan": true, "msme": true, "terms": true, "copyMarking": false
    },
    "thermalShow": {
      "time": true, "cashier": true, "covers": false, "table": true, "orderType": true,
      "customerName": true, "customerMobileMasked": true, "itemNote": false,
      "paymentBreakdown": true, "onHoldOutstanding": false, "amountInWords": false, "reviewQr": true
    }
  }
}
```

- `theme`: `CLASSIC`, `GST_DETAILED`, `MODERN`, `COMPACT`. Anything else is 400.
- Every field has a default, so a restaurant written before P64 reads back the
  whole group. The defaults print exactly what CLASSIC and the thermal bill
  printed before P64.
- `useBrandAccent: true` draws the accent the restaurant chose on Appearance
  (M7 P20A). It is checked again with `utils/colour.js` `checkAccent` when it is
  switched on; a colour that fails is 422 `BUSINESS_RULE_VIOLATED` with the
  rule's sentence. No colour is stored in this group.
- The mandatory core of a tax invoice (CGST Rule 46) is not a switch: the
  supplier's name, address and GSTIN, TAX INVOICE, the invoice number and its
  date, each line's value, each rate's taxable value, CGST and SGST, and the
  bill total print on every theme with every switch off. The GSTIN still follows
  `receipt.showGstin`, which is the restaurant's own declaration that it has one
  to print; the date prints even when `show.time` is off, without the time.
- `settings.receipt.showGstin`, `showFssai` and `showServerName` stay where
  they are and are read by every theme and the thermal bill. `show.captain`
  only adds a second choice for the full page: a captain prints there when both
  are on.
- Each changed field is one `SETTINGS_CHANGED` line, as every setting is.

`settings.receipt.termsText`: up to 600 characters, `""` and null both clear it,
the M7 rule for the receipt text fields.

## 3. The restaurant's PAN and Udyam number

`PATCH /restaurant` takes `panNumber` (`AAAAA9999A`, uppercased) and
`msmeNumber` (an Udyam number, `UDYAM-GJ-01-0012345`, uppercased); null clears
either. Both are returned with the restaurant.

## 4. The signature image (changes M20 P22)

A third slot, `SIGNATURE`, beside `LIGHT_GROUND` and `DARK_GROUND`, through the
same three endpoints with every rule P22 settled: PNG, WebP or JPEG read from
the file's own bytes, SVG refused, 200 KB, 128 to 1024 pixels a side, the bytes
`select: false`, audited as `BRAND_LOGO_SET` and `BRAND_LOGO_REMOVED` with
`slot: "SIGNATURE"`. `GET /auth/me` `appearance.logos` is unchanged and does not
list it. It prints above the signature line.

## 5. The invoice read gains (M3 16.1)

```json
{
  "restaurant": { "…": "…", "panNumber": null, "msmeNumber": null, "termsText": null },
  "lines": [ { "…": "…", "hsnCode": "996331", "notes": "Less spicy" } ],
  "itemRows": [ { "…": "…", "hsnCode": "996331", "notes": ["Less spicy"] } ],
  "billTotalInWords": "Rupees Five Hundred Ten Only",
  "onHoldOutstandingInPaise": null,
  "signature": null,
  "layout": {
    "theme": "CLASSIC", "accent": null,
    "show": { "…": "…" }, "thermalShow": { "…": "…" }
  }
}
```

- `hsnCode` is the frozen code, or null. `itemRows` keep lines with different
  codes apart.
- `notes` is the order line's note, read from the order the bill belongs to;
  an item row lists each line's note once.
- `billTotalInWords` is written by `paiseToIndianWords` in `utils/money.js`,
  the one place a number is spelled, in the Indian system (lakh, crore).
- `onHoldOutstandingInPaise` is the account's outstanding now, from
  `accountService.outstandingFor`, on an On Hold bill only; null otherwise.
- `signature` is `{ hash, contentType }` when the slot is set, else null. The
  client reads the bytes from `GET /restaurant/logo/SIGNATURE`.
- `layout` is `settings.invoiceLayout` with `accent` resolved: the Appearance
  accent when `useBrandAccent` is on, else null.

`renderReceipt` (the receipt text endpoint, M3 15) is unchanged.

## 6. The themes, on the client

`client/src/features/printing/themes/` holds one file per theme, registered in
`themes/index.js`, each `{ id, title, paper, styles, render(data, options) }`.
`render` is a pure function of the invoice data: it queries nothing and
computes no amount. `CLASSIC` is the full-page invoice as it printed before P64.

| Theme | What it is |
|---|---|
| `CLASSIC` | The P25 full-page invoice |
| `GST_DETAILED` | An HSN column, a rate summary (taxable value, CGST and SGST rate and amount per slab), the amount in words, the declaration and a signature line |
| `MODERN` | CLASSIC with an accent band and lighter rules |
| `COMPACT` | A5 first, tighter leading, the same content |

Choosing a theme on the screen proposes its usual switches (GST_DETAILED turns
on `hsn`, `amountInWords`, `declaration`, `signatureLine` and `copyMarking`); the
owner may change any of them before saving.

The copy marking (CGST Rule 48(2), a supply of services in duplicate) prints
"ORIGINAL FOR RECIPIENT" by default and "DUPLICATE FOR SUPPLIER" when the
supplier's copy is chosen at print time; it is on the full page only, never on
the roll.

The screen is `/settings/invoice-layout`, OWNER only, with three tabs:
Invoice settings (the full-page theme and its switches), Print settings (the
paper the preview is drawn on, and the copy), Thermal settings (`thermalShow`).
Each previews a real bill without saving, and saves through `PATCH /settings`
with a reason.

## Error codes

None new.
