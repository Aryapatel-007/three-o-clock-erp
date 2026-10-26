# Three O'Clock: handoff

Written 2026-10-26 by Rishi with Claude Code, finishing the handoff that
Arya's session of the same day (`session_01Wn3rJBpJWpbYgTQ5aTAKfL`) began but
did not push. Read this, then `docs/PROJECT-STATE.md`, on any laptop before
carrying on. Update it as tasks close.

---

## 1. Where things stand

- This repository, `Aryapatel-007/three-o-clock-erp` (private), was started
  again on 2026-10-26 from Z Chaat's code: one codebase for the website
  (`DEPLOYMENT_ROLE=CLOUD`) and the cafe PC (`BOX`), with two-way sync. The
  product is named **Dakaar**.
- Three O'Clock's menu is the 18 October one from the cafe's own site:
  139 dishes, 33 categories (`setup/threeoclock-menu.csv`).
- Nothing reaches Z Chaat: every address in this repository names
  `three-o-clock-erp-api.onrender.com`, `three-o-clock-erp.vercel.app` or
  `three-o-clock-erp-test.onrender.com`. **None of the three exists yet.**
  Arya's session checked: the local `.env` is the PC's own database, with no
  `MIRROR_URL`; no Vercel project is linked; the GitHub repository has no
  secrets, webhooks, deploy keys or deployments.
- Nothing is in the cloud for Three O'Clock: no Atlas cluster, no Render
  service, no Vercel project, no restaurant record.

## 2. On any laptop, first

Pull every repository the work touches (clone any that is missing):

```
git -C <folder> pull --ff-only
```

| Repository | What it is |
|---|---|
| `Aryapatel-007/three-o-clock-erp` | This one: Three O'Clock, website and cafe PC |
| `Aryapatel-007/Caffeza` | Z Chaat's live website. Do not change it for Three O'Clock |
| `riship-17/Cafezza-Offline` | Z Chaat's offline code, the source this repository was made from |
| `dakaar` (Arya's, separate) | See section 7, item 3 |

Then, in this repository: `npm ci`, and copy `.env.example` to `.env` if
there is none. The `.env` is never committed.

On Rishi's Mac, 2026-10-26: all three pulled. Rishi's four commits on the old
history are on the local branch `backup/three-oclock-before-restart-2026-10-26`
(not pushed); the old P57 mkcert files are in the untracked `certs/`, which
holds a private key: never commit it.

## 3. Secrets: where they go, and what to share in a chat

**Never paste a secret into a chat, a commit, a doc or an issue.** That means:
the Atlas connection string (it holds the password), the JWT secrets, the two
encryption keys, `REPLICATION_SECRET`, `RESEND_API_KEY`, any Backblaze key,
any password or PIN.

| Secret | Where it goes |
|---|---|
| Atlas `MONGO_URI` | Render's dashboard, Environment. On a laptop, only in the terminal for one command, like `MONGO_URI="..." npm run db:indexes` |
| JWT secrets, `PAYMENT_SECRETS_KEY`, `INTEGRATION_SECRETS_KEY` | Render generates them (`render.yaml`, `generateValue`). Copy the two encryption keys to the cafe PC's `.env` later, for two-way sync |
| `REPLICATION_SECRET` | Made with `openssl rand -base64 48`; the same value in Render and the PC's `C:\Dakaar\.env` |
| The owner's password | Typed at the terminal when a script asks |

**Safe to share with Claude in a chat**, and all that is needed:

- the Render service's address, like `https://three-o-clock-erp-api.onrender.com`;
- the Vercel project's address and name;
- the Atlas project and cluster name, its region, and the database name (not the connection string);
- the Three O'Clock details in section 6.

When Claude needs to run something against Atlas, put the connection string in
your own terminal (`export MONGO_URI="..."`) and tell Claude it is set; do not
type it into the chat.

## 4. What to do on Atlas, Render and Vercel

Do them in this order. The free plans are fine to start; DEPLOYMENT.md
section 14 says what the free plan costs in waiting.

### 4.1 Atlas

1. New project, **Three O'Clock**. Keep it apart from Z Chaat's.
2. Create a cluster: M0 (free) to start, **AWS Singapore (ap-southeast-1)**,
   the same region as Render. M10 when real bills start, for backups.
3. Database Access: one user with **readWrite** on the database
   `restaurant-erp` only. A long generated password.
4. Network Access: `0.0.0.0/0`. Render's free plan has no fixed address, so
   the password is the only lock.
5. Connect, Drivers: copy the `mongodb+srv://...` string and add
   `/restaurant-erp` before the `?`. Keep it to yourself (section 3).
6. From this repository, once, before Render's first start (the server refuses
   to start while an index is missing):
   ```
   MONGO_URI="<the string>" npm run db:indexes
   ```

### 4.2 Render

1. Sign in to the new workspace for Three O'Clock (not Z Chaat's).
2. Connect GitHub and give Render access to `Aryapatel-007/three-o-clock-erp`.
   It is private and on **Arya's** GitHub account, so Render's GitHub app has
   to be installed on Arya's account (Rishi has push, not admin, and cannot do
   it): either Arya signs in to Render with her GitHub, or she approves the
   install request Render sends when Rishi picks her account.
3. **New, Blueprint**, choose `Aryapatel-007/three-o-clock-erp`, branch `main`.
   Render reads `render.yaml` and creates `three-o-clock-erp-api` (free,
   Singapore, Docker).
4. It asks for the values marked `sync: false`:
   - `MONGO_URI`: paste the Atlas string.
   - `RESEND_API_KEY`: leave empty until a day-end email is wanted.
   - `BACKUP_ENABLED`: `off`. Leave every other `BACKUP_*` empty.
5. Apply. Wait for **Live**, then open
   `https://three-o-clock-erp-api.onrender.com/api/v1/health`: it should say
   the database is connected.
6. **If Render gives a different address** (the name was taken), tell Claude
   the address: it is named in `vercel.json`, `client/vercel.json`,
   `box/windows/install.ps1` and `.github/workflows/keep-awake.yml`, and all
   four must change together.
7. Two-way sync with the cafe PC is later (DEPLOYMENT.md section 19):
   `SYNC_MODE=TWO_WAY` and `REPLICATION_SECRET` are added then, not now.

### 4.3 Vercel

1. Add New, Project, import `Aryapatel-007/three-o-clock-erp`.
2. Project name **`three-o-clock-erp`**, so the address is
   `three-o-clock-erp.vercel.app`. Root directory: the repository root
   (the root `vercel.json` sets the install, the build and `client/dist`).
3. No environment variables. Deploy.
4. Open the address: the sign-in screen should show, and `/api/v1/health`
   through it should answer from Render.

### 4.4 Then

Send Claude the three non-secret facts: the Render address, the Vercel
address, and the Atlas cluster's name and region. Claude then (with
`MONGO_URI` set in your terminal) provisions Three O'Clock, applies
`setup/threeoclock.json` and imports the menu, each as a dry run first. The
owner's password is typed by you at the terminal.

## 5. The cafe PC

Later, once the website works: install Dakaar on the cafe's PC
(`docs/WINDOWS-INSTALL.md`), load the data, and switch on two-way sync
(DEPLOYMENT.md section 19.3). The installer already points the PC at
`https://three-o-clock-erp-api.onrender.com`. Updates come from this
repository's releases, signed with the key on Arya's computer
(`~/.dakaar/three-o-clock-release-signing-key.pem`), so Arya publishes them.

## 6. Details to get from Three O'Clock

Every `TO CONFIRM` in `setup/threeoclock.json` and
`docs/clients/threeoclock/PROFILE.md`. Before the first real bill:

- legal name (the franchisee's company), GSTIN, FSSAI licence number, pincode;
- the invoice prefix and starting number (set on cutover day only);
- how many tables inside and outside, their names and seats;
- staff: name, role and phone for each person, the owner's first;
- payment methods they take, and which delivery platforms;
- opening hours, packaging charge, the bill's header line and footer;
- GST rate confirmed by their CA (5% assumed), and platform GST under 9(5);
- which drinks take which toppings.

## 7. Open tasks

1. ~~**Tables.**~~ Done 2026-10-26: `setup:restaurant` takes a list of
   table groups again, as the old Three O'Clock repository did (one group still
   works, so Z Chaat's file is unchanged). Tested in `setupScripts.test.js`.
2. **Atlas: done 2026-10-26.** Cluster `cluster0.eugepku` (organisation
   Restuarent, project 3-o-clock, `6adf5f88eff64c0f9514a0d7`), database
   `restaurant-erp`, user `aryapatel7899_db_user`; the string is in Rishi's
   Mac's `.env`. Indexes built (52 collections, 246). "Three O'Clock Cafe"
   provisioned with its owner on **9000004001** (a placeholder phone, as on
   18 October; a phone cannot be changed in the app, so if the real owner's
   number is wanted, change it before staff use the system). The owner's
   password was chosen by Rishi and shared in a chat: change it before go-live.
   `setup/threeoclock.json` and the menu applied: 18 tables (Indoor 10,
   Outdoor 8), 3 stations, Cash, Card and UPI, both logos, the settings,
   33 categories and 139 dishes; a second plan of each finds nothing to do.
   Not sent, still TO CONFIRM: legal name, GSTIN, FSSAI, pincode, accounts,
   staff. No bill made.
   **Vercel: done 2026-10-26** from Rishi's Mac: project `three-o-clock-erp`
   in Rishi's team (`rishis-projects-56712387`), live at
   https://three-o-clock-erp.vercel.app, a production build. It was deployed
   from a clean `git archive` of `main` so no `.env` was uploaded; it is not
   connected to GitHub yet, so a push does not deploy it. To deploy again:
   `git archive HEAD | tar -x -C <empty folder>`, then in that folder
   `vercel link --yes --project three-o-clock-erp --scope rishis-projects-56712387`
   and `vercel deploy --prod --yes`. Never `vercel deploy` from the working
   folder: the CLI does not read `.gitignore` and would upload `.env`.
   **Render: live 2026-10-26**, `https://three-o-clock-erp-api.onrender.com`,
   set up by Rishi (the repository is public from 2026-10-26, so no GitHub
   app on Arya's account was needed). `PAYMENT_SECRETS_KEY` removed on purpose:
   no online payment yet; the server treats it as optional and only refuses to
   connect Razorpay. If it is added later, the cafe PC needs the same value for
   two-way sync. Checked through https://three-o-clock-erp.vercel.app: health
   with the database connected, release `49f92e6`; the owner signs in, the
   refresh cookie works, 18 tables, 3 stations, 33 categories; in a browser at
   phone width the floor shows Indoor and Outdoor, stays signed in after a
   reload, no page errors. No bill made.
   That `.env` is otherwise still the old cafe server's (`NODE_ENV=production`,
   https on 8443): fine for scripts, not for `npm run dev`.
3. **The `dakaar` repository** still has Z Chaat's addresses: its cafe-PC
   installer would sync to Z Chaat's live server and its `vercel.json` points
   at Z Chaat's API. Arya's session asked whether to clear them; not answered.
4. **The `Restuarent` repository** on Arya's laptop has uncommitted doc
   changes; Arya's session meant to ask about them.
5. **Backups:** the Sunday practice-restore workflow fails until this
   repository has its backup secrets (DEPLOYMENT.md section 8.6).
6. **Keep awake:** `.github/workflows/keep-awake.yml` and the outside pingers,
   once Render exists (DEPLOYMENT.md section 14), unless the PC's sync keeps it awake.
7. The old local database on Rishi's Mac (`127.0.0.1:27017`) holds a test
   "Three O'Clock Cafe" from 18 October with seven logins and a test bill;
   it is not the cloud and can be left or dropped.
