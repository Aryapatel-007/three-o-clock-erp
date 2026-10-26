# RUNBOOK: the cafe server, when something is wrong

P62. Numbered steps a tired manager can follow at 9pm. Every command runs on
the cafe server (the box) unless a step says "on the cloud". To get a command
line on the box: plug a keyboard and screen into it, or from the office PC
`ssh cafe-admin@cafe-server.local`.

**Who to call when the box will not come up:** _TO FILL (P62 section 15
question 6): name and phone number._ Second: _TO FILL._

The quick health check, for any of the sections below:

```
bash /opt/cafe-pos/box/check-box.sh
```

---

## 1. Every device says "Cannot reach server"

The tablets cannot reach the box. The internet does not matter here.

1. Is the **box** on? Its light is on. If not, press its power button once.
2. Is the **router** on? Its lights are on. If not, check the plug and the UPS.
3. Is the **UPS** beeping? The power is off. Service runs on battery for about
   15 minutes; the box shuts itself down cleanly before the battery is empty.
4. Wait two minutes after power comes back. The box starts by itself and the
   tablets reconnect by themselves. Nothing needs to be typed.
5. Still nothing after 5 minutes: run the health check. Each line says what to
   fix. `sudo systemctl restart cafe-pos` restarts the server; it takes 10 seconds.
6. Still nothing: call the number at the top. If the box is dead and service
   must go on, section 6 makes the cloud copy the server.

Only **one** device says it? It is on the wrong WiFi: `docs/STAFF-SETUP.md`
section 6.

---

## 2. The database must be a replica set

The server refuses to start, with "The database is not a replica set", when
MongoDB was started without `replication.replSetName`. Bills need a
transaction, which a standalone cannot run.

1. `sudo nano /etc/mongod.conf`. Under `replication:` there must be `replSetName: rs0`.
   Compare with `box/mongo/mongod.conf`.
2. `sudo systemctl restart mongod`
3. Once only, on a box that never had it:
   `mongosh "mongodb://127.0.0.1:27017/?directConnection=true" --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"`
4. `MONGO_URI` in `/opt/cafe-pos/.env` ends in `?replicaSet=rs0&authSource=admin`.
5. `sudo systemctl restart cafe-pos`

---

## 3. Compass: looking at the data, and the rare repair

Compass is a window into the database, not the server. A write from Compass
skips every rule the application enforces: the tenant guard, the money
arithmetic, the invoice counter and the audit log.

- **Day to day: `cafe_compass`, read only.** This is the one saved in Compass.
  Connection string, from a PC on the cafe LAN:
  `mongodb://cafe_compass:<password>@192.168.1.10:27017/restaurant-erp?authSource=admin&directConnection=true`
  (`directConnection=true`: the replica set's member is named 127.0.0.1, which
  only means something on the box itself.)
- **A deliberate repair: `cafe_repair`, read and write.** Never saved in
  Compass; typed in for the repair and the connection deleted after. Before
  anything is changed, write in the session log in `docs/PROJECT-STATE.md`
  what will change and why; after, what changed. The changelog ships the
  repair to the cloud like any other change.
- The passwords are in `/root/cafe-pos-credentials.txt` on the box, made once
  by the install, and in the owner's password manager.

---

## 4. "Saving paused: server clock is wrong"

The box's clock is behind its newest sale, usually after a power cut with a
dead clock battery. Writing now would date bills on the wrong day, so the
server refuses every write until the clock is right. Reading still works.

1. `date` shows the box's time. Compare with your phone.
2. **With internet:** `sudo systemctl restart chrony`, wait 30 seconds, run
   `date` again. NTP sets it.
3. **Without internet:** set it by hand from your phone's time, in India time:
   `sudo timedatectl set-ntp false && sudo date -s "2026-10-21 21:05:00" && sudo hwclock --systohc && sudo timedatectl set-ntp true`
4. Within a minute the till saves again by itself. No restart is needed.
5. Replace the clock battery (a CR2032 coin cell on most mini PCs) at the next
   quiet day. Until then, step 2 or 3 after every power cut.

Never set the clock **forward** past the real time to "get it working": every
bill made then would carry that date.

---

## 5. "12 waiting to upload" or "Not synced for 3 hours"

The internet line is down or the cloud copy is unreachable. **Service is
fine.** The box keeps everything and sends it when the line is back, oldest
first, with nothing skipped.

1. Check the 4G or broadband router has signal and data.
2. `npm run replication -- status` in `/opt/cafe-pos` shows how many are waiting
   and the last error.
3. "the changelog has a gap": section 7.

---

## 6. The box is dead: making the cloud copy the server (promotion)

Only when the box cannot be brought back during service. It is a decision a
person makes, never automatic: two servers writing at once would issue the same
GST invoice number twice.

1. Make sure the box is really off and will stay off: unplug it. If it comes
   back by itself later it will see it was replaced and stand down, but do not
   rely on that during service.
2. **On the cloud** (a laptop with the mirror's `.env`, or the host's shell):
   `npm run replication -- promote`
   It prints, for each restaurant, **the last change the cloud has and the time
   the box made it**. Anything the box did after that time is not in the cloud.
   Write that time down.
3. Run it again with the word: `npm run replication -- promote --confirm PROMOTE`
4. Restart the cloud server so every screen sees it is now the writer within
   10 seconds.
5. Every device: open the cloud address (on the setup card's back, _TO FILL_)
   and sign in again. Sessions do not carry across.
6. Check the last few bills before the time in step 2 against the paper copies
   in the drawer. Re-enter by hand anything missing, as new bills.
7. Online orders and partner webhooks waiting in intake are now applied by the
   cloud itself.

---

## 7. Back to the box after a promotion (demotion)

After service, with the box repaired or replaced.

1. **Rebuild the box from the cloud:** on the box, stop the server
   (`sudo systemctl stop cafe-pos`), then restore the cloud's data:
   `mongodump --uri="<cloud MONGO_URI>" --gzip --archive=/tmp/cloud.gz` and
   `mongorestore --uri="mongodb://cafe_admin:<password>@127.0.0.1:27017/?authSource=admin&directConnection=true" --gzip --archive=/tmp/cloud.gz --drop`
2. **On the cloud:** `npm run replication -- demote --confirm DEMOTE`. It prints
   the epoch the box must take.
3. **On the box:** `npm run replication -- adopt-epoch --epoch <that number> --confirm ADOPT`.
   It marks the box's changes from before the rebuild as superseded (the
   restore replaced them) and prints one `reset-cursor` line per restaurant.
4. **On the cloud:** run each `reset-cursor` line it printed.
5. **On the box:** `npm run replication -- baseline --confirm BASELINE`, then
   `sudo systemctl start cafe-pos`. The box writes again and ships everything.
6. Every device back to the box's address; sign in again.

**A gap in the changelog** ("the changelog has a gap", "STOPPED AT A GAP"): an
entry is missing on the box, which only a manual repair can cause. The copy
stops there and waits. Run step 5's baseline on the box: every document is
captured again and the cloud catches up. Then reconciliation (next) proves it.

**"Cloud copy differs"**: the half-hourly reconciliation found a difference.
The box is the truth. Run the baseline (step 5 above, without the others) and
the next check clears it. If it comes back, someone is writing to the cloud
copy directly: check who has its credentials.

---

## 8. Restoring the box from its own snapshot

When the box's disk is damaged but the box works, or a repair went wrong.

1. `npm run snapshot:local -- list` shows what is kept.
2. `sudo systemctl stop cafe-pos`
3. `mongorestore --uri="mongodb://cafe_admin:<password>@127.0.0.1:27017/?authSource=admin&directConnection=true" --oplogReplay --gzip --archive=/var/lib/cafe-pos/snapshots/hourly/<newest>.archive.gz --drop`
   **Always `--oplogReplay`.** Without it a bill can come back without its payment.
4. `npm run replication -- baseline --confirm BASELINE`
5. `sudo systemctl start cafe-pos`
6. Anything after the snapshot's time is in the cloud copy (section 5's status
   shows how far it got) or on paper.

Off-site restores from Backblaze are `docs/DEPLOYMENT.md` section 8.7.

---

## 9. Sessions after any of this

Sign-ins are each server's own (`refreshtokens` never ship). After a
promotion, a demotion or a restore, everyone signs in again. That is expected.
