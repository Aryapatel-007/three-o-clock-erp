# Restaurant ERP


## Cafezza-Offline: the box in the cafe (P62)

This repository is the local-first build: the same product, able to run on a
small server **inside the cafe** so billing, KOTs and printing never wait on
the internet, with Atlas as a read-only cloud mirror, backup, and the intake
for online orders and partner webhooks.

- How it works: [`docs/REPLICATION.md`](docs/REPLICATION.md)
- **Windows cafe PC:** `bash box/windows/make-package.sh` makes `release/CafePOS.zip`; on the PC, extract to `C:\CafePOS` and double-click **Install Cafe POS**. [`docs/WINDOWS-INSTALL.md`](docs/WINDOWS-INSTALL.md)
- Ubuntu mini PC: `sudo LAN_IP=192.168.1.10 bash box/install-ubuntu.sh`, then [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) sections 17 and 18
- **Staff: connecting a tablet, which WiFi, which link:** [`docs/STAFF-SETUP.md`](docs/STAFF-SETUP.md), or open `/connect` on the system
- When something is wrong: [`docs/RUNBOOK.md`](docs/RUNBOOK.md)

`DEPLOYMENT_ROLE` picks the role: `CLOUD` (default, unchanged), `BOX` or `MIRROR`.

A multi-tenant SaaS restaurant ERP for independent restaurants in Ahmedabad.
MongoDB, Express, React, Node. The API is REST.

Start here: [`docs/PROJECT-STATE.md`](docs/PROJECT-STATE.md). It says where the
project actually stands. Read it before writing anything, and update it before
you stop.

| Document | What it is for |
|----------|----------------|
| [`docs/PROJECT-STATE.md`](docs/PROJECT-STATE.md) | Current status, decisions, open questions, known problems |
| [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) | Scope, security requirements, the problems teams like ours miss |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Folder layout, naming, response envelope, error codes, middleware order |
| [`docs/CAFFEZA-BUILD-PLAN.md`](docs/CAFFEZA-BUILD-PLAN.md) | The Caffeza go-live plan: modules, prompts, owners, order |
| [`docs/CURRENT-STATE-AUDIT.md`](docs/CURRENT-STATE-AUDIT.md) | What exists in the code today, and what Caffeza still needs |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | One meaning for every word used in reports |
| [`docs/REPORT-SPEC.md`](docs/REPORT-SPEC.md) | Every report, column by column |
| [`docs/RECONCILIATION-RULES.md`](docs/RECONCILIATION-RULES.md) | The balance checks every report must pass |
| [`docs/TEST-DATA.md`](docs/TEST-DATA.md) | The golden day every report test reproduces |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Cloud server and Atlas, backups, the cafe setup |
| [`docs/GO-LIVE.md`](docs/GO-LIVE.md) | Gates, training, pilot days, cutover |
| [`docs/prompts/`](docs/prompts/) | The build prompts, P00 to P21, run in order |
| [`docs/clients/zchaat/PROFILE.md`](docs/clients/zchaat/PROFILE.md) | The live client's real setup: tax, invoice series, tables, staff, payment methods, and what is still to confirm |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | Connecting Swiggy, Zomato, a Pine Labs card machine and Tally: what to ask for, how to set each up, what is still waiting |

## Running it

Node 20.19 or newer.

```bash
npm install
cp .env.example .env    # then fill in real values
npm run dev             # server on :5000, client on :5173
```

The server validates every environment variable at boot. If one is missing or
malformed it prints exactly which, and exits. It will not start half configured,
and it will not listen before the database is up.

Check it is alive:

```bash
curl http://localhost:5000/api/v1/health
```

## Running tests

```bash
cp .env.example .env
cp server/.env.test.example server/.env.test
npm test
```

The server validates `.env` at boot, tests included, and rejects the
placeholder JWT secrets. Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` to two
different values from `openssl rand -base64 48` first. Tests run against an
in-memory MongoDB, not a real cluster.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Server and client together |
| `npm run dev:server` | Server only, with reload |
| `npm run dev:client` | Client only |
| `npm test` | Server test suite |
| `npm run lint` | ESLint across both workspaces |
| `npm run build` | Production client build |

## The rules that are not negotiable

These are set out in full in `docs/BUILD-PLAN.md` section 6. The short version:

- Every record has a `restaurantId`. Every query filters by it. Build filters
  with `scoped(req)`, and every model applies `tenantGuardPlugin` so a query
  that forgets throws instead of leaking.
- All money is a whole number of paise. Never a decimal, never a float.
  Arithmetic lives in `server/utils/money.js` and nowhere else.
- Permissions are checked on the server for every endpoint. Hiding a button in
  React is a hint, not security.
- A record belonging to another restaurant returns 404, never 403. A 403
  confirms the record exists.
- Nothing is hard deleted. It is voided, with a reason and the user who did it.
- Timestamps are stored in UTC and converted only for display.
- Secrets live in `.env`, which is gitignored. A committed secret is rotated,
  not just deleted from the next commit.
