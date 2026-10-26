# CONVENTIONS

Naming, formats, and habits. Decided once so we never argue about them again.

If two modules end up looking different, it is because this file was not followed.

Last updated: [DATE] by [NAME]

---

## 1. Repo layout

```
/
  CLAUDE.md
  .gitignore
  .env.example
  README.md
  /docs
    BUILD-PLAN.md
    PROJECT-STATE.md
    API-CONTRACT.md
    DB-SCHEMA.md
    CONVENTIONS.md
  /server
    server.js
    /config
    /models          one file per collection
    /routes          one file per module
    /controllers     one file per module
    /services        business logic that is too big for a controller
    /middleware      auth, tenant filter, permission check, error handler
    /validators      input validation schemas
    /utils
  /client
    /src
      /api           one file per module, all fetch calls live here
      /components    shared components only
      /features      one folder per module
      /hooks
      /context
      /utils
      App.jsx
      main.jsx
```

No business logic in a route file. Routes wire a URL to a controller and nothing else.

No fetch calls scattered inside React components. They live in `/src/api`.

---

## 2. Naming

| Thing | Style | Example |
|-------|-------|---------|
| Folder | lowercase, dashes | `menu-management` |
| Server file | camelCase | `orderController.js` |
| React component file | PascalCase | `OrderCard.jsx` |
| React component | PascalCase | `OrderCard` |
| Variable and function | camelCase | `calculateBillTotal` |
| Constant | UPPER_SNAKE | `MAX_ITEMS_PER_ORDER` |
| Mongo collection | lowercase plural | `orders`, `menuitems` |
| Mongoose model | PascalCase singular | `Order`, `MenuItem` |
| Database field | camelCase | `restaurantId`, `createdAt` |
| Foreign key field | name plus Id | `restaurantId`, `menuItemId` |
| URL path | lowercase plural, dashes | `/api/v1/menu-items` |
| Environment variable | UPPER_SNAKE | `MONGO_URI` |
| Git branch | type slash module slash short-description | `feat/m2/create-order` |

Money field names always end in `Paise`. For example `priceInPaise`, `totalInPaise`.

Basis-point field names always end in `Bps`. For example `taxRateBps`,
`discountRateBps`.

This makes it impossible to look at a number in the code and wonder what unit it is in.

One name per quantity, across every module. A field copied from one collection
to another keeps its name. M2 shipped an order line calling its tax rate
`taxRateBasisPoints` while the menu item it was copied from called the same
number `taxRateBps`, and M3 would have had to read both. Renamed 2026-08-30.

Boolean field names read as a statement. `isAvailable`, `isVoided`, `isActive`. Not `available` or `status`.

---

## 3. API shape

All routes start with `/api/v1`.

Version it from day one. Adding `v2` later is easy. Adding a version to a live unversioned API is not.

### Method meanings

| Method | Use |
|--------|-----|
| GET | Read. Never changes anything. |
| POST | Create a new thing. |
| PATCH | Change part of an existing thing. |
| PUT | Not used. We always use PATCH. |
| DELETE | Only for things that are genuinely disposable, like an unfired draft order line. Never for a bill, order, or stock entry. |

### URL rules

Plural nouns. `/menu-items`, not `/menu-item`.

The ID goes in the path. `/api/v1/orders/:orderId`.

Actions that are not simple create, read, or update get a sub-path.

```
POST   /api/v1/orders/:orderId/fire
POST   /api/v1/bills/:billId/void
PATCH  /api/v1/menu-items/:itemId/availability
```

Never put a `restaurantId` in a URL. The server gets it from the token.

Never put personal data in a URL. No phone numbers, no names, no employee IDs in a query string.

### Response envelope

Every response, success or failure, has the same outer shape.

Success:

```json
{
  "success": true,
  "data": { }
}
```

A list response puts the array in `data` and paging info beside it:

```json
{
  "success": true,
  "data": [ ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 213
  }
}
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Price must be a whole number of paise.",
    "fields": {
      "priceInPaise": "Must be an integer greater than zero."
    }
  }
}
```

`fields` is only present on validation errors. `message` is safe to show a user. It never contains a stack trace or a database error.

### Status codes

| Code | When |
|------|------|
| 200 | Read or update worked |
| 201 | Something was created |
| 400 | Input was bad |
| 401 | No valid token, or the token expired |
| 403 | Valid token, but this role is not allowed to do this |
| 404 | Not found, or it belongs to another restaurant |
| 409 | Conflict. For example a duplicate name, or an order already fired |
| 422 | Input was well formed but broke a business rule |
| 429 | Too many requests |
| 500 | Our fault |
| 502 | An outside service we depend on failed. Only the payment gateway, from P24. |

Note on 404. If a record belongs to a different restaurant, return 404, not 403. A 403 confirms the record exists, which is an information leak.

### Error codes

Use a fixed string. Never let the frontend read the message text to decide what happened.

```
UNAUTHENTICATED
TOKEN_EXPIRED
FORBIDDEN
NOT_FOUND
VALIDATION_FAILED
DUPLICATE
BUSINESS_RULE_VIOLATED
RATE_LIMITED
INTERNAL_ERROR
```

Modules may add their own, in the same shape. For example `ORDER_ALREADY_FIRED`, `INSUFFICIENT_STOCK`.

Added by P02:

```
FEATURE_DISABLED         403  the feature is switched off in settings.features
INVOICE_START_TOO_LOW    422  a new prefix series would reuse a sequence this financial year
INVOICE_SERIES_STARTED   422  a prefix that has issued bills would be restarted
INVOICE_SERIES_LOCKED    422  switching back to financial-year numbering mid-year
```

Added by P07:

```
PAYMENT_METHOD_NOT_ALLOWED  422  the method is inactive, not allowed for the order type, or the wrong platform
ACCOUNT_BALANCE_EXCEEDED    422  a collection or downward adjustment larger than what the account owes
PAYOUT_PERIOD_OVERLAP       409  two live payouts for one method would cover the same business date
DAY_NOT_READY               422  Day Close is blocked; details.blockers lists every reason
DAY_CLOSED                  409  a write would change a closed business date
```

Added by P13, built in P15:

```
CHECK_FAILED                422  the Tally export would be built while an ERROR check fails
```

Added by P23 (M14):

```
ONLINE_CLOSED               422  takeaway or bookings off, paused, or outside hours
TOO_MANY_OPEN_REQUESTS      422  this phone already has the most open requests allowed
REQUEST_ALREADY_DECIDED     409  the request is no longer waiting
ONLINE_ORDER_CHANGED        422  a price or availability changed since the guest's quote
RESERVATION_CLASH           409  the table has another confirmed booking inside the hold window
```

Added by P24:

```
PAYMENT_GATEWAY_NOT_CONNECTED   422  no gateway, or no PAYMENT_SECRETS_KEY on the server
PAYMENT_GATEWAY_ERROR           502  Razorpay refused or could not be reached
ADVANCE_NOT_APPLIED             422  a bill with an unapplied online advance takes another payment
```

502 joins the status table for P24 only: the payment gateway, not our server,
failed.

Added by P25:

```
CASH_COUNT_MISMATCH        422  a count by notes and a total sent beside it disagree
TERMINAL_REQUIRED          422  a method linked to a card machine recorded by hand without a manager's bypass
PARTNER_SPEC_MISSING       422  the partner has not approved the integration, so its adapter has no document
INTEGRATION_NOT_ACTIVE     422  the partner connection is missing, a draft, paused or in error
INTEGRATION_TEST_FAILED    422  test connection failed; the message is the plain reason
PARTNER_CALL_FAILED        502  a partner call failed or timed out while a person waited
TALLY_MAPPING_INCOMPLETE   422  a head with an amount has no Tally ledger
TALLY_ALREADY_EXPORTED     409  the date was posted or downloaded already
DAY_NOT_CLOSED             422  only closed days are exported to Tally
PAIRING_CODE_INVALID       401  a Tally bridge pairing code is wrong, used or expired
BRIDGE_TOKEN_INVALID       401  a Tally bridge token is unknown or revoked
```

From P25, 502 also covers a partner in M21: Swiggy, Zomato or Pine Labs.

Added by P29:

```
BILL_NOT_REVISABLE         422  removing an item from a bill that cannot be revised; the message says why
WAITING_FOR_KITCHEN        422  money taken on a bill whose order has items not yet ready
ORDER_ALREADY_BILLED       422  undoing ready in the kitchen on an order that has a live bill
```

Added by P37:

```
TEMPLATE_NOT_APPROVED      422  a WhatsApp send against a template Meta has not approved
MESSAGING_NOT_CONNECTED    422  the restaurant's WhatsApp connection is missing or not on
GUEST_OPTED_OUT            422  a marketing message to a guest without live offers consent
```

Added by P44:

```
EMAIL_SEND_FAILED          502  Resend refused or could not be reached
```

Added by P63:

```
CLOSE_ON_CAFE_PC           422  Day Close on the cloud while two-way sync is on
```

### Paging

Every list endpoint takes `?page=1&limit=50`.

Default limit is 50. Maximum limit is 200. A request over the maximum gets clamped, not rejected.

---

## 4. Fields every collection has

These are on every single collection. No exceptions.

| Field | Type | Notes |
|-------|------|-------|
| `_id` | ObjectId | Mongo default |
| `restaurantId` | ObjectId | Indexed. Every query filters by it. |
| `createdAt` | Date | UTC. Set by Mongoose timestamps. |
| `updatedAt` | Date | UTC. Set by Mongoose timestamps. |

Anything that can be turned off rather than deleted also has:

| Field | Type | Notes |
|-------|------|-------|
| `isActive` | Boolean | Default true. |

Anything that can be voided or cancelled also has:

| Field | Type | Notes |
|-------|------|-------|
| `isVoided` | Boolean | Default false |
| `voidedAt` | Date | UTC |
| `voidedBy` | ObjectId | Links to users |
| `voidReason` | String | Required when voiding |

### Indexes

Every collection has a compound index starting with `restaurantId`.

For example, orders is indexed on `{ restaurantId: 1, createdAt: -1 }`.

An index that does not start with `restaurantId` is almost always a mistake.

Indexes are built by `npm run db:indexes`, on every deploy. In production the server refuses to start while any declared index is missing. A new model file is added to `server/models/index.js`, and a test enforces it. Indexes are never dropped by a script.

---

## 5. Money

Stored as a whole integer number of paise. Always.

One hundred rupees is `10000`.

Never store a decimal. Never store a float. Never store a string.

All arithmetic on money happens in paise, as integers.

Conversion to rupees happens in one shared display helper on the frontend, and nowhere else.

Percentages, such as a GST rate, are stored as an integer in basis points. Five percent is `500`. Eighteen percent is `1800`.

This avoids `0.05` and `0.18` floating point problems entirely.

---

## 6. Dates and time

Stored in UTC. Always. Mongo does this by default if you pass a real `Date` object.

Displayed in India Standard Time, which is UTC plus five hours thirty minutes.

Conversion happens in one shared helper on the frontend. Not in individual components.

Never store a date as a string.

Never build a date from `new Date("2026-01-15")` without a timezone, because that is parsed differently in different places.

The business day is not the calendar day. Until we decide the rule, do not write any code that assumes a day starts at midnight. This is an open question in PROJECT-STATE.md.

---

## 7. Validation

Server-side validation is mandatory on every endpoint. Frontend validation is a convenience for the user, nothing more.

Use one validation library across the whole server. Zod.

Validation runs in middleware, before the controller. A controller can assume its input is already clean.

Rules that apply everywhere:

Trim every string before validating.

Reject empty strings where a value is required. `""` is not a value.

Every money field must be an integer, zero or greater, and below a sane ceiling.

Every quantity must be a number greater than zero.

Every ID must be a valid Mongo ObjectId before it touches the database.

Never trust an enum from the client. Check it against the allowed list.

---

## 8. Middleware order

The order matters. This is the order on every protected route.

```
1. rate limiter
2. authenticate       reads the token, attaches req.user
3. tenant             attaches req.restaurantId from the token, never from the body
4. permission         checks req.user.role against what this route needs
5. validate           checks the body against the Zod schema
6. controller
7. error handler      last, catches everything
```

No controller reads the token directly. It reads `req.user` and `req.restaurantId`.

---

## 9. Git

Commit directly to `main`. No feature branches.
One prompt is one commit, or a few small ones.

Commit messages. One line, present tense, says what changed.

```
add order fire endpoint
fix gst rounding on split lines
```

Do not commit `.env`, `node_modules`, or a build folder.

Pull before you start. Push when you stop.

One module, one owner, one branch at a time. Two people do not edit the same module.

---

## 10. React

Function components only. No class components.

One folder per module inside `/features`.

Server state comes through the API files in `/src/api`. Components do not call `fetch` themselves.

A component that is over roughly two hundred lines should be split.

Never decide permissions in React. Hide a button if you like, but the server is what actually stops the action.

Loading and error states are required on every screen that calls the API. A screen that shows nothing while loading looks broken during a Friday rush.

---

## 11. Environment variables

Every variable used anywhere is listed in `.env.example` with a fake value.

If you add a variable, add it to `.env.example` in the same commit, and tell the other developer.

The server refuses to start if a required variable is missing. Fail loudly at boot, not quietly at 9pm.

`TRUST_PROXY` must be set explicitly in production. Never `true`.

---

## 12. Logging

Log to the console on the server. Structured, not free text.

Never log a password, a token, a phone number, or an employee name.

Every error log includes the `restaurantId` and the route, so a problem can be traced to one tenant.

The client never receives a stack trace.

---

## 13. Testing minimum

We are not aiming for full coverage. We are aiming to not get burned.

Every module must have a written manual test for these three things, done before the module is called done:

Call the endpoint with no token. It must fail with 401.

Call the endpoint with a valid token from the wrong role. It must fail with 403.

Call the endpoint with a valid token from restaurant A, using a record ID that belongs to restaurant B. It must fail with 404.

Money and GST calculation logic gets real automated tests. That is the one place where a quiet bug costs a client money.
