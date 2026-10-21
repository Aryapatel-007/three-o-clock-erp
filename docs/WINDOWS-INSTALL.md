# Installing Cafe POS on the cafe's Windows PC

P62. For a Windows 10 or 11 PC that will be the cafe's server: the till, and
the computer every tablet and kitchen screen talks to over the WiFi. For a
dedicated Ubuntu mini PC, use `docs/DEPLOYMENT.md` section 17 instead.

---

## 1. Make the package (on your own computer)

```
bash box/windows/make-package.sh
```

It makes `release/CafePOS.zip` from the last commit: the code, the built
screens and the installer. No passwords or keys are inside it. Copy it to a pen
drive, or send it to yourself.

## 2. Install (on the cafe PC, once)

1. Copy `CafePOS.zip` to the PC and **extract it to `C:\`**, so you have
   `C:\CafePOS`.
2. The PC must be **on the internet** for this first setup (it downloads
   Node.js, MongoDB and the app's packages, about 400 MB).
3. Double-click **`Install Cafe POS`** in `C:\CafePOS`. Click **Yes** when
   Windows asks for permission.
4. Answer four questions: cafe name, owner name, owner mobile number, owner
   password. Use letters and numbers in the password, no quote marks.
5. Say **Y** to "Load the sample Z Chaat menu and 12 starter tables?" for a
   ready-to-try system, or **N** to start empty.
6. It ends with "All done" and the address for tablets, for example
   `http://192.168.1.20`.

Takes about 10 minutes. It is safe to run again if anything stops halfway.

## 3. Every day

- **On the cafe PC:** double-click **Cafe POS** on the desktop. If the server
  is not running yet it starts it, then it opens the screens.
- **The server starts by itself** whenever the PC is switched on, before anyone
  logs in, and restarts itself if it ever stops. Tablets work even if nobody
  clicks the icon.
- **Tablets and phones:** join the same WiFi as the PC and open the address.
  **Cafe POS - Connect a device** on the desktop opens the card with the QR
  codes; print it for the counter (`docs/STAFF-SETUP.md`).

## 4. What it set up

| What | Where |
|---|---|
| The app and its settings | `C:\CafePOS`, settings in `C:\CafePOS\.env` (private: it holds the keys) |
| MongoDB | Windows service "MongoDB", single-node replica set `rs0`, on this PC only (127.0.0.1) |
| The server | Task Scheduler, "CafePOS Server": at start-up, as SYSTEM, restarts every minute if it stops |
| Hourly snapshots | Task Scheduler, "CafePOS Snapshot": `C:\CafePOS\data\snapshots` (24 hourly, 31 daily, 12 monthly) |
| Updates | Task Scheduler, "CafePOS Update": every 15 minutes, acting only from 4 to 5 AM (section 6) |
| The database files | MongoDB's own data folder, by default `C:\Program Files\MongoDB\Server\<version>\data`. Not inside `C:\CafePOS` |
| Logs | `C:\CafePOS\data\logs\server.log` and `snapshot.log` |
| Firewall | Rule "Cafe POS": the app's port (80, or 8080 if 80 was taken) open to the network |
| Desktop | "Cafe POS" and "Cafe POS - Connect a device", for every user |

## 5. Keep the PC a good server

- **Power:** Settings, System, Power: **Sleep: Never** when plugged in. A
  sleeping PC is a server no tablet can reach. Put the PC and the router on the
  **UPS**.
- **After a power cut:** in the PC's BIOS, set "Restore on AC power loss" to
  **On**, so it starts by itself when power returns.
- **Windows Update:** set active hours to cover service, so it never restarts
  mid-rush.
- **The address:** on the router, reserve this PC's address (DHCP reservation),
  so the address on the card never changes. If the PC moves to another WiFi,
  the address is worked out again by itself; reprint the card from
  "Connect a device".

## 5a. Bringing the live cafe's setup onto the PC (a trial)

For a trial beside the live cloud system: the PC gets the cafe's menu, dish
photos, tables and floor plan, stations, settings, logo and colours, payment
methods and, if you choose, the staff with the passwords and PINs they know.
It gets no orders, bills, guests or money, and it writes **nothing** back to the
live database: the cloud keeps billing as before, and the PC's trial bills stay
on the PC.

Left out on purpose, so a trial bill can never pass for a real one: the invoice
series (the PC numbers its own, `2026-27/000001` on), the GSTIN, the day-end
email addresses, the online page and the payment gateway. A card machine link
comes off. Put a GSTIN in only when the PC goes live for real.

1. **Install** (section 2) and answer **N** to the sample menu: the copy goes
   into an empty restaurant only. Name the cafe, say, `Z Chaat (trial)`.
2. **On your own computer**, which can reach the live database:

   ```
   SOURCE_MONGO_URI="mongodb+srv://..." npm run copy:menu -- --source "Z Chaat" --export zchaat-setup.json --with-staff
   ```

   Leave out `--with-staff` to bring no staff (add them on the PC's Staff
   screen). With it, the file holds password and PIN hashes: move it by pen
   drive, not chat, and delete it from both computers once copied. The live
   database's address never goes onto the PC.
3. **On the cafe PC**, copy the file to `C:\CafePOS`, then in an Administrator
   PowerShell inside `C:\CafePOS`, with the owner phone you gave the installer:

   ```
   npm run copy:menu -- --from-file zchaat-setup.json --target-phone 9XXXXXXXXX
   npm run copy:menu -- --from-file zchaat-setup.json --target-phone 9XXXXXXXXX --apply
   ```

   The first only shows what it would copy. Staff whose phone is already used on
   the PC (the owner you typed) are skipped and named.
4. Reload the screens. The menu, floor, logo and colours are the live cafe's.

## 5b. Giving the cafe all its data: an exact copy of the cloud

For handing the cafe the offline system with everything it has on the cloud:
every order, bill, guest, closed day, setting, the logo, the GSTIN and every
login, with their own ids. The next bill on the PC continues the cloud's
invoice series. The cloud is only read, never changed.

**The one rule:** from the moment the copy is taken, the cafe must take no more
bills on the cloud. A bill made there afterwards is not on the PC, and the next
bill on each would get the same number. So take the copy at closing time, or
just before handing over, and stop using the cloud's address after it.

1. **On your own computer** (needs the MongoDB Database Tools):

   ```
   SOURCE_MONGO_URI='mongodb+srv://USER:PASSWORD@cluster0.onbbqdp.mongodb.net/restaurant-erp' bash box/export-cloud.sh
   ```

   It writes `release/cafe-data-<date>.archive.gz`. It leaves out only the
   cloud's sign-in sessions and its backup bookkeeping. The file holds password
   hashes and guests' phone numbers: move it by **pen drive**, and delete it
   from both computers once loaded.
2. **On the cafe PC**, after **Install Cafe POS** (any cafe name and owner: the
   copy replaces them), put the file in `C:\CafePOS` and double-click
   **Load cafe data**. Type `LOAD` when asked. It stops the server, keeps a
   snapshot of what was there (`data\snapshots\before-load-*.archive.gz`),
   loads the copy, checks every document went in, builds the indexes and starts
   the server again. If the copy does not load completely, it puts back what was
   there before.
3. Everyone signs in with the **phone and password they use on the cloud**.

To load a newer copy later (a re-take just before handover), run steps 1 and 2
again: the newest `.archive.gz` in `C:\CafePOS` is the one loaded.

## 5c. Two-way sync: the PC and the website both take bills (P63)

The website keeps working as it does, the PC works on the cafe WiFi, and each
gets the other's orders and bills within a second or two while the internet is
up. Without internet the PC carries on alone and catches up when the line comes
back; the website carries on too. Design: `docs/REPLICATION.md` section 13.

While it is on:

- **Bills on the website use their own series**, `2026-27/W00001`, so a bill
  made on each side can never get the same number. The PC carries on the
  existing series. Orders and KOTs made on the website are numbered from
  900001. Ask the CA to confirm the W series before it is used for real.
- **Day Close is done on the PC only.** The website refuses it.
- **Sync conflicts.** When both change the same thing before they can tell
  each other (dishes added to one table on both, the same table opened on both,
  one order billed on both), both versions are kept where they can be and the
  owner and manager see a count in the top bar and a list under **Sync**, each
  saying what was kept and linking to the order or bill to fix.

To switch it on (both sides start from the same data: load the exact copy of
section 5b first):

1. Pick a secret, the same on both: `openssl rand -base64 48`.
2. **Website server** (Render): set `SYNC_MODE=TWO_WAY` and
   `REPLICATION_SECRET=<the secret>`, then deploy. `docs/DEPLOYMENT.md` section 19.
3. **Cafe PC**: in `C:\CafePOS\.env` (Notepad as Administrator) set
   `SYNC_MODE=TWO_WAY`, `MIRROR_URL=https://<the website server's address>` (no
   slash at the end) and `REPLICATION_SECRET=<the secret>`. Restart the server:
   double-click **Install Cafe POS** again, or restart the PC.
4. Owner on the PC: **Sync** in the menu says "In step" within a minute.

The PC syncs every `SYNC_EVERY_SECONDS` (60) inside `SYNC_HOURS` (08:30-02:30
India time), and at night only when it has something to send, so Render's free
server sleeps. Using the live website as the fallback, step by step, and what
to do when the PC has a problem: `docs/DEPLOYMENT.md` section 19.

To switch it off: `SYNC_MODE=ONE_WAY` on both. Website bills keep their W
numbers, which stay valid in their own series.

### After moving the cafe from the website to the PC

A browser keeps each device's settings and sign-in per address, so every
device starts empty on the PC's address. Once, on each:

1. **Counter computer:** open the till only with **Cafe POS - Till (prints
   without asking)** on the desktop, never the website's launcher. Sign in,
   open **This device**, choose the printer (Thermal 80 mm), the print width
   and edge margin, and switch on **Print bills sent by captains**. Without
   that switch, a captain's **Print at counter** waits, and after 30 seconds
   the captain's phone says so.
2. **Kitchen tablets:** open the PC's address, sign in, and in **This device**
   choose the station, auto-print of KOTs and sound again.
3. **Captains' phones:** open the PC's address and sign in. A phone cannot
   print to the bill printer itself; **Print at counter** is how a captain prints.
4. **Day-end email:** copy `RESEND_API_KEY` from Render's Environment into
   `C:\CafePOS\.env` by hand, then restart the server. Without it Day Close
   works and sends no email. It needs the internet at closing.
5. **Guests' online link:** keep giving the website's link (`.../r/<address>`).
   The PC's Settings show its own address, which opens only inside the cafe.

Copy buttons on a tablet use an older way of copying, since the PC is plain
`http`; if a tablet still refuses, select the text and copy it by hand.

### Later: the PC becomes the real till

Sending the PC's data to the same Atlas is only safe once the PC is the **only**
machine that bills, or two machines would issue the same invoice numbers. That
switch is `docs/DEPLOYMENT.md` sections 17.5 and 18: billing stops on the cloud
at a quiet hour, the PC takes all the data, the Render server becomes the
read-only mirror on the same Atlas, and the PC sends it every change within
seconds whenever the internet is up.

## 6. Updating to a new version

New versions install themselves at night. Nobody at the cafe does anything.

### How it works

1. A developer commits and pushes, then publishes a release:
   `bash box/windows/make-package.sh --publish`. That builds `CafePOS.zip`,
   signs a `manifest.json` (version, build time, the zip's checksum) with the
   release key, and puts both on a GitHub release of `riship-17/Cafezza-Offline`.
2. On the cafe PC, the **CafePOS Update** task runs every 15 minutes. It does
   anything only inside `UPDATE_WINDOW` (4 to 5 AM by default, the PC's own
   clock), and only when GitHub has a newer version than the one running.
3. It downloads the manifest and refuses it unless it is signed by the key in
   `box\windows\release-public-key.pem` of the version already on the PC. It
   refuses a version built earlier than the running one. Then it downloads the
   zip and refuses it unless it matches the signed checksum.
4. It takes a database snapshot, stops the server, moves the running version to
   `data\updates\previous`, puts the new one in place, runs `npm ci` and builds
   the indexes, starts the server, and waits up to 2 minutes for `/health` to
   say it is the new version with its database connected.
5. If anything fails after the server stopped, it puts the previous version
   back, with its own packages, and starts it again. The new one is kept in
   `data\updates\failed` to look at. The database is never touched: schema
   changes are additive, so the old version reads it.

`.env` and `data` (the snapshots, the logs, the network notes) never move. The
database is MongoDB's own and is not in `C:\CafePOS` at all.

### Setting it up

- **The token.** The repository is private, so the PC needs a read-only
  GitHub token: a fine-grained token for `riship-17/Cafezza-Offline` only, with
  Contents: Read-only. Put it in `C:\CafePOS\.env` by hand, as
  `UPDATE_TOKEN=github_pat_...` (Notepad, run as Administrator). Until then,
  updates are off and the nightly task does nothing.
- **The release key.** Made once with `node box/windows/release.mjs keygen`.
  The private half is `~/.cafepos/release-signing-key.pem` on the developer's
  computer. Back it up; a developer without it cannot publish. If it is lost, a
  new key needs every cafe PC updated once by hand (below).
- **Settings in `.env`:** `UPDATE_AUTO=off` stops it; `UPDATE_WINDOW=03:30-04:30`
  moves it (it may cross midnight, as in `23:30-01:00`).

### When a person has to do it

`make-package.sh --publish` marks a release **manual** when `install.ps1`
changed since the last release, because new scheduled tasks or settings need
the installer. Add `--manual "the reason"` for anything else the PC cannot do by
itself, like a one-off data migration (`npm run migrate:...`). The PCs see a
manual release, write why in `data\logs\update.log`, and leave it for a person.

By hand: copy the new `CafePOS.zip` over `C:\CafePOS` outside service, and
double-click **Install Cafe POS**. Your `.env` and `data` are not in the zip.

### Commands, in an Administrator PowerShell inside `C:\CafePOS`

```
node box\windows\update.mjs check      is there a newer version? changes nothing
node box\windows\update.mjs now        install it now, outside service
node box\windows\update.mjs rollback   back to the version before; run again to undo
```

What happened: `data\logs\update.log`, and `data\updates\status.json` for the
last attempt.

## 7. When something is wrong

- **The icon says the server did not start:** wait a minute after switching on
  and try again. Then open `C:\CafePOS\data\logs\server.log`; the last lines say
  why. "not a replica set": run Install Cafe POS again.
- **Tablets cannot open the address, the PC can:** the tablet is on another
  WiFi, or the address changed. Open "Cafe POS - Connect a device" on the PC
  for the current address.
- **"Saving paused: server clock is wrong":** set the PC's clock right
  (Settings, Time, Sync now). `docs/RUNBOOK.md` section 4.
- Everything else: `docs/RUNBOOK.md`. Its commands are the same on Windows,
  run in PowerShell inside `C:\CafePOS` (for example `npm run replication -- status`).
