# Deployment

How the system runs for Caffeza, and how to keep it running.
Decision: the Node server runs in the cloud, next to a separate Atlas cluster for Caffeza.
Prompt P12 does the code side of this. Everything else here is done by hand, once, and then kept up.

---

## 1. The shape

One Node service serves both the API and the built React screens, from one web address.
The database is a MongoDB Atlas cluster used only by Caffeza.
Every device in the cafe opens the same https address in Chrome.
Bills and KOTs print from the devices in the cafe, because a cloud server cannot reach a printer on the cafe's network.
The cafe has a backup internet line, because billing now needs the internet.

```
Captain phones ─┐
Station tablets ├─ cafe WiFi ─ router (broadband + 4G backup) ─ internet ─ https://caffeza.<domain> ─ Node service ─ Atlas cluster
Cashier PC ─────┘                                                                                       (same region)
   └─ bill printer (USB or network)
```

Why one address for both screens and API:
The login cookie only travels to the address that set it, and CORS allows exactly one origin.
One address removes both problems.
P12 makes Express serve `client/dist` in production to get there.

---

## 2. Choosing a host

P12 made the app ready for any host that runs a container or a Node service. Arya picks the host and records the choice in the decision log.
Any host is fine if it meets all of these:

| Need | Why |
|---|---|
| An always-on service, not serverless functions | The rate limiter keeps its counts in memory, the database connection stays open, and a till cannot wait for a cold start. Serverless platforms like Vercel functions do not fit this server as it is written. |
| The same region as the Atlas cluster, in India if possible | One bill can mean ten or more database queries. Distance between server and database is paid on every one. |
| A fixed outbound IP address | So Atlas network access can allow that one address and nothing else |
| https with a custom domain | The login cookie is `Secure`, so it only works over https |
| Automatic restart after a crash | Nobody is watching at 9 PM on a Saturday |
| Environment variables stored in the host's settings | Secrets never live in a file in the repo |
| Searchable logs kept for at least 7 days | To find out what happened last night |

If a host cannot give a fixed outbound address, stop and decide together before continuing.
Opening Atlas to every address is not an acceptable workaround.

Check each candidate's current regions, prices and outbound IP options on its own website before choosing.

**Fill this in once the host is chosen:**

| Item | Value |
|---|---|
| Host | |
| Region | |
| How a deploy happens | |
| How the release step (`npm run db:indexes`) runs before traffic moves | |
| Where the logs are | |
| Fixed outbound address, allowed in Atlas | |

---

## 3. Atlas setup, done once by hand

1. Create a new Atlas project called "Caffeza". Keep it separate from the project holding the demo restaurants.
2. Create the production cluster on a paid tier that includes automatic backups. Turn backups on.
3. Put it in the same region as the server.
4. Create one database user for the app, with read and write on the Caffeza database only. No admin rights.
5. Under Network Access, allow only the server's fixed outbound address.
6. Create a second, separate cluster for staging. A free tier is acceptable for staging only, because it holds no real bills.
7. Turn on two-factor sign-in for everyone with access to the Atlas account.
8. Set Atlas alerts for high connections, low disk and a replica set member going down, sent to both developers.
9. Write down the backup frequency and how long backups are kept, from the tier you chose. Put it in the decision log.

Never run `npm run seed:demo` against either Caffeza cluster.
The script already refuses to run unless `NODE_ENV` is development or test, and refuses any host but localhost unless it is listed in `SEED_DEMO_ALLOWED_HOSTS`.

---

## 4. Environments

| Environment | Server | Database | Used for |
|---|---|---|---|
| Local | Your laptop, `npm run dev` | A local MongoDB running as a single-node replica set, or the staging cluster | Building features. Tests use `mongodb-memory-server`. |
| Staging | The host | Atlas staging cluster | Checking a release, showing the client, training staff |
| Production | The host | Atlas production cluster | Real bills only |

Environment variables for staging and production:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` in both |
| `PORT` | Whatever the host tells you |
| `MONGO_URI` | The cluster's connection string. A secret. |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48`. Different in every environment. |
| `JWT_REFRESH_SECRET` | A second, different value from the same command |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | As in `.env.example` |
| `BCRYPT_ROUNDS` | As in `.env.example` |
| `CLIENT_ORIGIN` | The exact https address, like `https://caffeza.<domain>`, with no trailing slash |
| `INTEGRATION_SECRETS_KEY` | P25. `openssl rand -base64 32`. Different in every environment. **Required**: the server refuses to start without it. Encrypts every partner credential (Pine Labs, Swiggy, Zomato). Losing this key makes every saved partner credential unreadable, and they must be entered again. |
| `PAYMENT_SECRETS_KEY` | P24. `openssl rand -base64 32`. Different in every environment. Encrypts each restaurant's Razorpay secrets. Optional: without it, connecting a gateway is refused. Losing it means every restaurant connects Razorpay again. |
| `RESEND_API_KEY` | P44. The Resend API key, for the day-end email. Optional: without it nothing is emailed and the Day End page says so. A secret: set it in Render's dashboard, never in a file in git. |
| `DAY_END_EMAIL_FROM` | P44. Who the day-end email is from. Default `Restaurant ERP <onboarding@resend.dev>`, which delivers only to the Resend account's own address; once a domain is verified in Resend, an address at it, e.g. `Z Chaat <reports@zchaat.in>`. |
| `LOGIN_RATE_LIMIT_WINDOW_MINUTES`, `LOGIN_RATE_LIMIT_MAX_ATTEMPTS` | As in `.env.example` |
| `DISPLAY_TIMEZONE` | `Asia/Kolkata` |
| `TRUST_PROXY` | Added by P01. Set to what the host's documentation says for its proxy. |
| `SEED_DEMO_ALLOWED_HOSTS`, `DEMO_PASSWORD` | Not set, ever, in staging or production |

---

## 5. Domain and https

Buy one domain for the product.
Give each client a subdomain: `caffeza.<domain>` for production and `caffeza-staging.<domain>` for staging.
Point them at the host, and let the host issue the certificates.
`CLIENT_ORIGIN` must match the address exactly.

---

## 6. Every deploy

Deploy outside service hours only: after the last bill has been paid, or before 10:00 AM.
Never during service.

One service serves both the screens and the API from one address (P12). In
production it serves the built client from `client/dist`, and it refuses to
start if that build is missing or a declared index is missing.

1. On `main`: `npm ci`, then `npm test`, `npm run lint` and `npm run build` all pass.
2. Note the commit being deployed: `git rev-parse --short HEAD`. Set it on the host as `RELEASE_VERSION`.
3. Deploy to staging first. With the container, build it from this commit (section 13).
4. **Release step**, before traffic moves to the new version: `npm run db:indexes` against staging's database. Every deploy, not only the first. It only adds missing indexes and never drops one.
5. Start the new version. The server refuses to start if the client is not built or an index is missing, and the logs say which.
6. `npm run smoke -- --url https://caffeza-staging.<domain>`. Every line must pass, and the health line must show the commit from step 2.
7. On staging: sign in, open a table, send a KOT, bill it, pay it, open Day Close. Staging bills are fine.
   `npm run e2e:cloud` does the same through the screens. **It must only ever
   point at a separate staging database, never production**: it creates a real
   bill. It refuses to start unless `E2E_CLOUD_DATABASE` is set and is exactly
   the database name in `MONGO_URI`, and it refuses unless the owner login in
   `E2E_CLOUD_OWNER_PHONE` belongs to the restaurant named in
   `E2E_CLOUD_RESTAURANT`. Set these only on a developer machine, never on the
   host.
8. Deploy the same commit to production: the release step against production's database, then start.
9. `npm run smoke -- --url https://<production address>`. It only reads and never signs in, so it is safe against production.
10. On production: sign in, open the menu, open a report. **Do not create a bill in production to test.** Every production bill takes a real GST invoice number that can never be reused.
11. Add a line to `docs/PROJECT-STATE.md`: what was deployed, when, by whom.

**Rolling back:**
Redeploy the previous version.
This only works if the database change in the new version was additive, meaning new fields with defaults and nothing renamed or removed.
Every prompt that changes a schema must say whether its change is additive.
If it is not, the prompt must include its own rollback steps.

---

## 7. First production setup, done once

1. Atlas production cluster ready, section 3.
2. First deploy, section 6.
3. `npm run db:indexes`.
4. `npm run provision:restaurant` with Caffeza's details. The owner's password is prompted for, never typed into a file.
5. The Caffeza setup and menu import from P11, each as a dry run first, read in full, then with `--apply`. See `setup/README.md`.

   ```
   npm run setup:restaurant -- --config setup/threeoclock.json --owner-phone <owner phone>
   npm run setup:restaurant -- --config setup/threeoclock.json --owner-phone <owner phone> --apply
   npm run import:menu -- --file setup/threeoclock-menu.csv --addons setup/threeoclock-addons.csv --config setup/threeoclock.json --owner-phone <owner phone>
   npm run import:menu -- --file setup/threeoclock-menu.csv --addons setup/threeoclock-addons.csv --config setup/threeoclock.json --owner-phone <owner phone> --apply
   ```

   Each asks for the owner's password at the terminal. New staff passwords are printed once; hand them over privately. Fill in every `TO CONFIRM` value in `setup/threeoclock.json` before the production run.
6. Settings: GSTIN, FSSAI number, receipt header lines, business day start.
7. The owner checks every menu item and price on staging before the same import runs on production.
8. On cutover day only: set the invoice prefix and starting number. See `docs/GO-LIVE.md`.

---

## 8. Backups and the restore drill

Atlas's free tier, M0, has no backups at all, so the server backs the database
up itself (P54, `docs/prompts/P54-constant-backups.md`), to Backblaze B2, for
nothing.

### 8.1 What is backed up, and for how long

Every collection except `refreshtokens`, the sessions: after a restore
everyone signs in again, and old sessions must never come back to life.

| What | How often | Kept |
|---|---|---|
| The change diary: every change, in files of 5 minutes | Every 5 minutes, sooner when busy | **Forever** |
| A monthly full copy: the first copy of each month | Once a month | **Forever** |
| A daily full copy: the first copy of each day from 5:30 AM | Once a day | 90 days |
| 6-hourly full copies: 5:30 AM, 11:30 AM, 5:30 PM, 11:30 PM | Every 6 hours | 10 days |

At most about 5 minutes of changes can be lost, and any moment since backups
began can be rebuilt: the monthly copy before it, plus the diary up to that
minute. The daily and 6-hour copies only make a recent restore faster.

Everything is encrypted (AES-256-GCM) before it leaves the server. Render's
free server sleeps from about 2:30 AM to 8:30 AM, so the 5:30 AM copy is taken
when it wakes, and the first copy of each day is the daily one.

### 8.2 Backblaze, once

1. Sign up at backblaze.com for B2 Cloud Storage. **Do not add a card**: with
   none on the account, Backblaze has nothing to charge.
2. **Create a bucket**: **Private**, with **Object Lock enabled** (it can only
   be turned on when the bucket is created) and a default retention of
   **Governance, 10 days**. Note its endpoint (like
   `s3.us-west-004.backblazeb2.com`) and region (`us-west-004`).
3. **The server key** (Application Keys, Add a New Application Key): this
   bucket only, Type of Access **Write Only**. It goes on Render.
4. **The drill key**: this bucket only, **Read Only**. It goes on GitHub and
   on the developer machine that restores. Never on Render.
5. **Lifecycle rules** (the bucket's Lifecycle Settings, custom rules), these
   two and **no others**:

   | Prefix | Hide after | Delete after hiding |
   |---|---|---|
   | `snapshots/6h/` | 10 days | 1 day |
   | `snapshots/daily/` | 90 days | 1 day |

   **No rule** for `snapshots/monthly/` or `journal/`: a file with no rule is
   kept forever. **Never** add a rule for those two, and **never** a rule with
   an empty prefix, which would cover the whole bucket and delete the diary.

Why this is safe: the server key can write but never delete, so stolen server
settings cannot wipe the backups; and Object Lock stops anyone, even with a
stolen key, from deleting a backup in its first 10 days, which is longer than
the week between practice restores that would notice.

### 8.3 The limits

| Limit | What fills it | What happens |
|---|---|---|
| Backblaze's free 10 GB | The diary and the monthly copies, for good; the daily and 6-hour copies, rolling | The card shows the storage used and how long the 10 GB lasts at this rate, and turns red at 7 GB. Then either pay Backblaze for what is past 10 GB (well under a rupee a GB a month at Backblaze's price), or shorten the daily copies' 90 days. **Never** shorten the diary or the monthly copies. |
| Atlas M0's 10 GB read a week, and 100 operations a second | Every full copy reads the whole database | Past 4 GB a week (the last copy's size × 28), full copies drop to once a day; back to every 6 hours under 3 GB. The card says so. The diary keeps saving every change either way. |
| Atlas M0's 512 MB | The database itself | The card warns at 70%: plan a bigger Atlas tier or an archive before 512 MB, when Atlas stops writes. |
| Render's 512 MB of memory | Changes waiting while uploads fail | The diary keeps at most 20 MB waiting; past that it stops, records a gap, and takes a full copy once storage works again. |

### 8.4 The encryption key

1. `npm run backup:key` in your own terminal prints a new key, once.
2. Save it in Render's environment as `BACKUP_ENCRYPTION_KEY`, **and** in a
   password manager. If it is lost, every backup is unreadable.
3. If it ever leaks: make a new one, put it in Render, and a full copy is
   taken with it at the next 6-hour slot (or redeploy for one at once).
4. **Keep every old key for good**, with the date it was retired: the diary
   and the monthly copies made with it are kept forever. Each file's header
   names its key's id, so the restore tool picks the right one from
   `BACKUP_ENCRYPTION_KEY` and `BACKUP_OLD_KEYS` (retired keys, comma
   separated, for restoring only).

### 8.5 Render

In the service's Environment, typed by hand (`render.yaml` lists them with
`sync: false`): `BACKUP_ENCRYPTION_KEY`, `BACKUP_S3_ENDPOINT`
(`https://s3.us-west-004.backblazeb2.com`), `BACKUP_S3_REGION`,
`BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID` and `BACKUP_S3_SECRET` (the server
key). Then `BACKUP_ENABLED=on`, Save and deploy. With `on` and any of those
missing, the server refuses to start and names what is missing, so set them
all first.

Before the first deploy with P54, run `npm run db:indexes` against the live
database: the server refuses to start while `backupruns`' indexes are missing.

Then, in Settings, Server, Backups: within a few minutes, "Backed up just
now. Full copy at ...".

### 8.6 GitHub: the weekly practice restore

`.github/workflows/backup-drill.yml` runs every Sunday at 6:00 AM India time.
In the repository's Settings, Secrets and variables, Actions:

1. Secrets: `BACKUP_DRILL_KEY_ID`, `BACKUP_DRILL_SECRET` (the drill key),
   `BACKUP_ENCRYPTION_KEY`, and `BACKUP_OLD_KEYS` once a key has been retired.
2. Variables: `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`.
3. Actions tab, Practice restore, Run workflow, once by hand. It restores the
   newest moment into a throwaway database on GitHub's machine and checks the
   counts, the invoice series and C12. A failure emails the repository owner.

GitHub turns off scheduled workflows in a public repository after 60 days with
no commits: if the repository goes quiet, turn it back on there.

### 8.7 Restoring for real

Never restore into the live database: the tool refuses to.

1. Make a new, empty cluster in Atlas (the free tier allows one per project,
   so it may need a new project), and allow your machine in its Network Access.
2. On a developer machine with the drill key and every encryption key in
   `.env`: `npm run backup:list` to see what there is.
3. `npm run backup:restore -- --at "2026-10-14 15:30" --to "<the new cluster's URI>"`
   (India time; `--at latest` for the newest moment). It refuses a target
   with any document in it, the live database, and a time inside a gap, and
   names the nearest times that work.
4. `npm run backup:verify -- --uri "<the same URI>" --expect <the report file it printed>`.
5. Change `MONGO_URI` on Render to the new cluster, Save and deploy.
6. Check `/api/v1/health`, then open a closed day's R2 report: C12 must pass.
   Everyone signs in again.

### 8.8 Atlas M0's 512 MB

The card's database figure is the last full copy's data plus indexes. At 70%
it warns. At 512 MB Atlas stops writes, which stops billing. Plan a paid tier
or an archive of old years well before then.

### 8.9 What this does not cover

1. A mistake inside the 5 minutes before the last diary upload.
2. A lost encryption key: every file made with it is unreadable. Keep it in a
   password manager, and keep every old one.
3. Changes made while the diary could not keep its place, shown as a gap: the
   full copy taken straight after covers everything from then on. After a long
   sleep of the server this can happen if Atlas's oplog has moved on; nothing
   is lost if nothing changed, and the card says so plainly either way.

---

## 9. Monitoring

1. An outside uptime monitor calls `/api/v1/health` every minute, and alerts both developers' phones when it fails twice in a row.
2. The host's logs are searched for errors every morning during the first month.
3. Atlas alerts from section 3.
4. Every morning: was yesterday closed? An unclosed day usually means something went wrong at the till.

---

## 10. In the cafe

**Internet.**
The main broadband line, plus a router with a 4G or 5G SIM that takes over on its own when the main line drops.
Test it during setup by unplugging the main line in the middle of a test bill.

**Power.**
A UPS for the router and the cashier computer.
Billing stops if either one loses power.

**Devices.**

| Device | Setup |
|---|---|
| Cashier computer | Chrome, opening the production address, with silent printing |
| Captain phones or tablets | Chrome, with the address added to the home screen |
| Station tablets | Chrome, left on the kitchen screen for their station |

**Silent printing on the cashier computer.**
Set the bill printer as the computer's default printer, with the right paper width.
Start Chrome with the `--kiosk-printing` flag, so a bill prints the moment it is sent, with no dialog.
On Windows, make a desktop shortcut whose target is:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://caffeza.<domain>
```

Staff open Chrome only through that shortcut.
Paper width, 80 mm or 58 mm: `TO CONFIRM` from their printer model.
If stations want paper KOTs, the station tablet gets the same setup with its own printer. P05 covers this.

**The thermal printer.**
On This device, choose the printer's roll: Thermal, 80 mm (a Rugtek RP326, for one) or Thermal, 58 mm. A bill is laid out at the width the print head reaches, 72 mm or 48 mm.

Paper length, also on This device, is "As long as the bill" by default: the page is exactly the bill, so Chrome's preview shows only the bill and the printer cuts after it. If a printer then prints blank paper above the bill, its driver has no paper of that size and centres the page; choose "The printer's roll" instead, and set the driver:

1. Paper size: the roll, for example "80 x 3276 mm" or "58 x 3276 mm", never A4. On Windows, Printers, the printer, Printing preferences; on a Mac, Printers & Scanners and the paper size in Chrome's print dialog.
2. Blank space at the end: compress or skip it, and cut after the document, where the driver offers it.
3. Print density or darkness: raise it if the bill prints light. Thermal paper also prints faint when it is old or kept in heat.

If the right-hand edge of the bill is cut off on paper, first check the driver's paper size is the 80 mm roll, not 58 mm or A4. On the 80 mm roll, This device's Print width lays the bill out 78 mm wide by default (from 2026-10-10), or 72 mm, the usual head width. If the right side is cut at 78 mm, choose 72 mm. If the last letters are still cut, choose Edge margin, 2 mm each side, on This device. Bill text size, also there, makes the text smaller or larger without changing the layout.

---

## 11. When something breaks during service

| What staff see | First step | If that does not fix it |
|---|---|---|
| Nothing loads, and other websites do not load either | The router should already have switched to 4G. Restart the router. | A phone hotspot for the cashier computer. Then the paper fallback below. |
| Nothing loads, but other websites work | Call a developer. The uptime alert has probably already fired. | Paper fallback |
| One device keeps getting signed out | Check it is using the https address, and that its date and time are correct | Clear the site's data in Chrome and sign in again |
| The bill does not print | Check the paper and the default printer | Reprint from the bill's page |

**The paper fallback.**
Write orders on a numbered paper KOT pad.
Once the system is back, enter each table's order and bill it.
The bill carries the time it was entered, not the time the food was served, and its business date is still correct as long as it is entered before 5:00 AM.
`TO CONFIRM` this procedure with the owner before go-live.

**Support.**
A card at the counter with both developers' phone numbers, and who to call first on which days.
`TO CONFIRM` who is on call.

---

## 12. Security

1. Two-factor sign-in on the host, Atlas, the domain registrar and GitHub, for everyone.
2. Secrets live only in the host's environment settings. Every environment has its own.
3. If anyone with access leaves, rotate every secret they could have seen.
4. Only Arya and Rishi can deploy.

---

## 13. Deploying with the container

The `Dockerfile` at the repo root is the deploy unit for any host that runs
containers. It holds no secret: every variable comes from the host at run time.

**Build** (from the repo root, at the commit being deployed):

```
docker build -t caffeza:$(git rev-parse --short HEAD) .
```

The build stage runs `npm ci` and `npm run build`. The run stage is Node 20
slim with production dependencies only, the server, the setup files and
`client/dist`, running as the non-root `node` user, started with `npm start`.

The server compresses its own answers with the `compression` package (P31,
2026-10-10), so it needs no proxy in front of it to do that. Render's edge
compresses as well; what it does with an answer that is already compressed is
in `docs/PERFORMANCE-BASELINE.md`, P31 section 4.

**Environment variables to set on the host** (section 4 has the details):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | What the host routes to, default 5000 |
| `MONGO_URI` | The environment's own Atlas cluster |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Two different values from `openssl rand -base64 48` |
| `CLIENT_ORIGIN` | Exactly the address people open, for example `https://caffeza-staging.<domain>` |
| `TRUST_PROXY` | Per the host's documentation, usually `1`. Never `true`. |
| `RELEASE_VERSION` | The commit being deployed |
| `INTEGRATION_SECRETS_KEY` | `openssl rand -base64 32`, kept with the other secrets. Required. Losing it means re-entering every partner credential. |
| `PAYMENT_SECRETS_KEY` | `openssl rand -base64 32`, kept with the other secrets. Never change it once restaurants have connected Razorpay. |
| `BCRYPT_ROUNDS`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `LOGIN_RATE_LIMIT_*`, `DISPLAY_TIMEZONE` | As in `.env.example` |

**Release step**, before traffic moves: run `npm run db:indexes` in a one-off
container from the same image with the same variables, for example
`docker run --rm --env-file <host env> caffeza:<commit> npm run db:indexes`.
The image does not run it on start: indexes are never built under live traffic.

**Health check:** the image declares one that calls `GET /api/v1/health` every
30 seconds. Point the host's own health check and the uptime monitor at the
same address.

Run one instance only. The rate limiter keeps its counts in memory.

---

## 14. Vercel for the screens, Render's free plan for the server

Decided 2026-10-09 at Rishi's request. The server is the same Docker image as
section 13, described in `render.yaml`; the screens are a prebuilt Vite build on
Vercel. `client/vercel.json` forwards every `/api/...` request to Render and
every other path to `index.html`, so to the browser the app and the API are one
address: the sign-in cookie, the CSRF header and CORS work as they do locally.

| Part | Where | Address |
|---|---|---|
| Screens | Vercel project `zchaat-pos` (Arya's projects) | https://zchaat-pos.vercel.app |
| Server | Render service `zchaat-pos-api`, free plan, Singapore | https://zchaat-pos-api.onrender.com |
| Database | Atlas `cluster0.dkcsfcz`, database `restaurant-erp` | the same one the local app uses |

**Render, once:** New, Blueprint, choose `Aryapatel-007/Caffeza`. Render reads
`render.yaml`, generates the two JWT secrets and the two encryption keys, and
asks for `MONGO_URI`: paste it from your own `.env`. The free plan has no
pre-deploy step, so run `npm run db:indexes` from a developer machine whenever a
change adds an index; the server refuses to start while one is missing.

**Atlas, once:** Network Access must allow Render. The free plan has no fixed
outgoing address, so the entry is `0.0.0.0/0`; the database password is then
the only lock, so keep it long and rotate it if it was ever shared.

**Vercel, every deploy:** a push to `main` deploys the screens on its own
(from 2026-10-11). The root `vercel.json` tells Vercel's build to install with
`npm ci`, so the pinned versions in the root `package-lock.json` are used, to
build with `npm run build`, and to serve `client/dist`. It carries the same
`/api` forwarding to Render as `client/vercel.json`; **change both together**.
Without the root file Vercel looked for `dist` at the top of the repo and failed
every push.

By hand, when needed (a deploy without a push, or a rollback to this machine's
build), from `client/`:

```
vercel build --prod
vercel deploy --prebuilt --prod
```

On a machine that has never deployed, once: `npx vercel login`, then from
`client/` `npx vercel link --yes --project zchaat-pos --scope aryas-projects-0d1567ce`
and `npx vercel pull --yes --environment=production`. They write `client/.vercel/`
and `client/.env.local` (a Vercel token), both git-ignored.

Every push to `main` also rebuilds and restarts the server on Render, a docs
change included, which pauses the screens for about a minute. Push during
service only when it has to be now.

**What the free plan costs.** The server sleeps after 15 minutes with no
request and takes about a minute to wake, so the first screen after a quiet
spell waits. Asleep, it runs no background jobs (partner retries, card machine
checks). The login limits are counted in memory and reset when it sleeps. For
a restaurant in service, move to a paid instance; nothing else changes.

**Staying on the free plan.** P30 (2026-10-10) proposed Render's Starter plan
and Rishi chose to stay on free. The wait above is the price of that choice:
the first screen of the morning, and the first after any quiet fifteen minutes,
waits for the server to start. `docs/PERFORMANCE-BASELINE.md` section 1 has the
command to measure it before opening. To change, set `plan: starter` in
`render.yaml` and push; the Blueprint applies it.

### Keeping the free server awake

Added by P30 (keep awake), at no cost.

**Why.** Render's free plan stops the server after 15 minutes without a
request, and waking it takes about a minute: the first person to open the app
after a quiet spell waits, or used to see an error. Render gives each account
750 free hours a month, shared by every free service on the account, and when
they run out every one of them stops until the next month. So the server is
kept awake only during working hours, plus a margin, never around the clock.

**The hours budget.**

| Pattern | Hours a day | Hours in a 31-day month | Fits in 750? |
|---|---|---|---|
| Always on | 24 | 744 | Only just, and leaves nothing for any other free service |
| 8:30 AM to 2:30 AM, the default | 18 | about 560 | Yes, with room |
| Z Chaat's real hours plus 30 minutes either side | to confirm | keep under 700 | Change the windows below once confirmed |

Every pinger below uses the same window. Change all three together.

**cron-job.org, the main pinger.**
1. Sign up at https://cron-job.org (free).
2. Create a cronjob. Title: Z Chaat keep awake.
3. URL: `https://zchaat-pos-api.onrender.com/api/v1/wake`.
4. Schedule: every 10 minutes, hours 8 AM to 2 AM. Time zone: Asia/Kolkata.
5. Under notifications, turn on "notify me when it fails".
6. Save, then run it once by hand and check it says 200.

**StatusCake, the second pinger and the alarm.**
1. Sign up for the free plan at https://www.statuscake.com.
2. Add an uptime test: URL `https://zchaat-pos-api.onrender.com/api/v1/health`, check every 5 minutes.
3. Add a contact group with an email address, and attach it to the test, so a
   real outage sends an email.
4. StatusCake checks around the clock, so on its own it keeps the server awake
   all 744 hours of a month. Either pause the test outside working hours, or
   accept those hours if this is the only free service on the Render account.
5. Not UptimeRobot: its free plan is now for personal, non-commercial use only,
   and Z Chaat is a business.

**GitHub Actions, the backup.** `.github/workflows/keep-awake.yml` calls the
wake address every 10 minutes from 8:30 AM to 2:30 AM India time.
1. In GitHub, Settings, Secrets and variables, Actions, Variables, add the
   repository variable `KEEP_AWAKE_URL` =
   `https://zchaat-pos-api.onrender.com/api/v1/wake`.
2. In the Actions tab, open "Keep the server awake" and run it once by hand.
3. Check the Actions tab once a week. GitHub may delay or skip scheduled runs,
   and turns a public repository's schedules off after 60 days with no commits.

**The heartbeat.** Every screen that is open, visible and signed in calls the
wake address every 5 minutes within working hours plus 30 minutes either side
(the online page's opening hours while it is switched on, otherwise every
hour). The counter computer left open on the bills screen keeps the server
awake on its own.

**When it is asleep anyway.** The screens wait calmly: a read is tried again
after 3, 6, 12, 20 and 30 seconds under a bar saying "Starting the server", and
loads by itself; a write is never sent twice, and the bar says to check the
bill before trying again.

**How to tell it works.** Settings, Server (owner only): how many times the
server started today and on each of the last 7 days, and a plain warning naming
any day it went to sleep during working hours. A deploy is a start too, but
never counts as a sleep. Render's logs show each start as well.

**What this does not fix.** Render says the free plan is not for production,
and the server is small. Anything due while it sleeps waits until it wakes:
platform webhooks, the background job runner, card machine checks. The day Z
Chaat pays, move to Render's cheapest paid plan and switch the three pingers
off; the heartbeat then costs nothing and can stay.

### The live channel (P33)

The server also runs a WebSocket, Socket.IO at `/api/v1/live`, that tells open
screens *something changed, read again*. It carries no data; the polling is
still the safety net. New server dependency `socket.io`, new client
dependency `socket.io-client`.

- **Where screens connect.** Vercel's rewrite of `/api` does not carry a
  WebSocket, so screens on `zchaat-pos.vercel.app` open the channel on the
  server's own address. `GET /auth/me` tells them which: `LIVE_ORIGIN` if set,
  else `RENDER_EXTERNAL_URL`, which Render sets by itself. Nothing to set on
  Render. The server accepts the connection from `CLIENT_ORIGIN` only.
- **Switching it off.** `LIVE_CHANNEL=off` on Render, then Save and deploy.
  No socket, nothing announced, every screen polls exactly as before P33.
  This is the rollback if anything misbehaves during service.
- **One instance.** The channel lives in the one server process. A second
  instance would need a shared adapter (Redis, for one), or an announcement on
  one instance would never reach screens connected to the other. Add it the
  day there is a second instance, not before.
- **On the free plan.** A sleeping server drops every socket; screens then poll
  at their own interval until it wakes and they reconnect. Nothing is lost.

---

## 15. The server and the database are in different regions

Found by P30 on 2026-10-10, by reading the cluster's own node tags.

| Part | Region |
|---|---|
| Render service `zchaat-pos-api` | Singapore |
| Atlas `cluster0.dkcsfcz` | AWS `ap-south-1`, Mumbai |

Every query crosses Singapore to Mumbai and back. `authenticate` makes two
before any route runs, and a bill makes ten or more, so the distance is paid
many times on every tap. Section 2 of this file already asks for the server
and the database in one region. The Singapore to Mumbai round trip was not
measured, because nothing of ours in Singapore can time it without a code
change; it is the figure to take first, for example from a one-off Render
shell with `mongosh` and `db.runCommand({ ping: 1 })` timed in a loop.

Render has no India region, so there are two ways to put them together, and
choosing between them is a decision for Rishi and Arya, not a session:

1. **Move the database to Singapore** (AWS `ap-southeast-1`), next to the
   server. The restaurant is then about as far from the data as it is from the
   server today. This is what P30 assumed.
2. **Move the server to a host with a Mumbai region**, next to the database,
   which is also closer to Gandhinagar. This reopens the host choice of
   section 2 and section 14.

Moving the database is a migration, not a setting, and Z Chaat has live bills.
How it is done depends on the cluster's tier, which is read in Atlas under the
cluster's name:

- A dedicated cluster (M10 or larger) can change region from the Atlas
  screen; Atlas moves it node by node.
- A free or shared cluster cannot change region. A new cluster is made in
  Singapore, the data copied with `mongodump` and `mongorestore`, and
  `MONGO_URI` changed on Render and in each developer's `.env`.

Either way, the move happens outside service hours, after Z Chaat's last bill
and before anyone opens a screen:

1. Take a backup first (section 8), and check it restores.
2. Do the move, or make the new cluster and restore into it.
3. Run `npm run db:indexes` against the new cluster before any traffic reaches
   it. The server refuses to start while an index is missing.
4. Allow Render in the new cluster's Network Access (section 14).
5. Change `MONGO_URI` on Render if the address changed, let it restart, and
   check `GET /api/v1/health` reports the database connected.
6. Open one screen, read the floor and a closed day's report, and compare a
   day's totals with the old cluster's before switching anything else off.

## 16. The test site (P48 Part I)

A second copy of the app where staff practise, at
`https://zchaat-pos-test.onrender.com`, with its own database,
`restaurant-erp-test` on the same Atlas cluster. Nothing there touches a real
bill or a real invoice number. One Render service serves both the screens and
the API: the Dockerfile builds the client and the server serves it, so there is
no second Vercel project.

**What is in it.** On 2026-10-14 the test database got its indexes
(`npm run db:indexes` with `MONGO_URI` pointing at it) and a copy of Z Chaat's
setup only: the restaurant, branch, staff logins (same phones and passwords),
categories, menu, tables, stations and payment methods. No orders, bills,
guests or activity log. It is renamed "Z Chaat (TEST)", its day-end email list
is empty (so it never emails the real inbox) and it has no payment gateway.

**Creating the service (once, in Render's dashboard).**
1. New, Blueprint, this repository; Blueprint path `render.test.yaml`.
2. `MONGO_URI`: the same as the live one with the database name changed from
   `/restaurant-erp` to `/restaurant-erp-test`. Check it twice: the live
   database name here would make the test site a second live till.
3. Apply. The first build takes several minutes. Open
   `https://zchaat-pos-test.onrender.com` and sign in with any Z Chaat login.

It deploys every push to `main`, like the live server, and sleeps when idle on
the free plan: the first screen after a sleep waits about a minute.

**Starting it fresh.** Delete the test database's orders, bills, kitchen
tickets, customers, audit lines and counters (scoped to the TEST restaurant),
never the live one's.

