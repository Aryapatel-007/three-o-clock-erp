# Staff setup: connecting a device to the cafe system

For everyone who takes orders, bills, cooks or manages. Print section 1 and
keep it by the till. The same card, with QR codes, prints from any device:
open the system and go to **More, Connect a device**, or open `/connect`.

---

## 1. The card by the till

```
 ┌───────────────────────────────────────────────────────────┐
 │  CAFE SYSTEM: HOW TO CONNECT                               │
 │                                                            │
 │  1. Join the WiFi:   Cafe Staff          (scan QR 1)       │
 │                                                            │
 │  2. Open:            http://192.168.1.10 (scan QR 2)       │
 │     or:              http://cafe-server.local              │
 │                                                            │
 │  3. Sign in with your phone number and password.           │
 │                                                            │
 │  "Cannot reach server"? You are on the wrong WiFi.         │
 │  Go back to step 1.                                        │
 └───────────────────────────────────────────────────────────┘
```

The real WiFi name and address are on the printed card from `/connect`. The
two above are the defaults the box is installed with
(`docs/DEPLOYMENT.md` section 17).

---

## 2. Why the WiFi matters

The whole system (orders, kitchen tickets, bills, the cash book) runs on a
small computer in the cafe, **the cafe server**. Every tablet, till and kitchen
screen talks to it over the cafe's WiFi.

- **The cafe's internet going down does not stop anything.** Orders, KOTs,
  bills and printing carry on. Only online orders, Swiggy and Zomato wait.
- **A device on the wrong WiFi, or on mobile data, cannot reach the server**,
  so nothing it does is saved. That is the one mistake this page exists for.

```
   Tablets, tills, kitchen screens ── cafe WiFi ── Cafe server ── internet ── cloud copy
                                     (must)                     (nice to have)
```

---

## 3. Connect a new device, step by step

Do this once per device. It takes two minutes.

### Android tablet or phone (Chrome)

1. **Settings, WiFi.** Tap the staff WiFi (or scan QR 1 on the card with the camera).
2. On a phone, **turn off mobile data** while on shift, so the phone does not
   leave the WiFi when the signal dips.
3. Open **Chrome**. In the address bar type the address from the card exactly,
   for example `http://192.168.1.10`. Do not search for it.
4. Sign in.
5. Chrome menu **⋮**, **Add to Home screen**. From now on, open the system from
   that icon.

### iPad or iPhone (Safari)

1. **Settings, Wi-Fi**, choose the staff WiFi (or scan QR 1 with the Camera).
2. Open **Safari**, type the address from the card.
3. Sign in.
4. The **share** button, **Add to Home Screen**.

### Windows or Mac computer (the till)

1. Join the staff WiFi, or plug in the network cable.
2. Open **Chrome** (or Edge), type the address from the card, sign in.
3. Chrome **⋮**, **Cast, save and share**, **Install page as app**, or bookmark it.
4. Set the printer on **More, This device**, as before.

### Give the device a name

On **More, Network and devices** (owner and manager), scroll to **This
device's name** and type something the manager will recognise: "Counter till",
"Captain tab 2", "Kitchen screen". The device list on the dashboard shows it.

---

## 4. Reading the bars at the top of every screen

Every screen shows four bars at the top right. They are **this device's
connection to the cafe server**, measured every 5 seconds.

| What you see | What it means | What to do |
|---|---|---|
| 4 bars, Excellent | Fast and steady | Nothing |
| 3 bars, Good | Fine for service | Nothing |
| 2 bars, Fair | Slow or dropping now and then | Move closer to the router, or tell the manager |
| 1 bar, Weak | Taps may be slow or fail | Move closer; the manager checks the device list |
| Reconnecting | One or two checks missed | Wait a few seconds |
| **Cannot reach server** (red banner) | Nothing you tap is saved | Follow the banner: check the WiFi name, then open the address |

Tap the bars to see the details: milliseconds to the server and how many
checks were lost.

**Two different things, never mixed up:**

- "Cannot reach server" (red) is about **this device**. Service is stopped on it.
- "12 waiting to upload" (amber) is about **the internet**. Service is fine;
  the cafe server sends them to the cloud when the internet is back.
  Only the owner and manager ever see a red message about the cloud.

---

## 5. Changing the cafe WiFi (owner and manager)

### Where to see which WiFi the system runs on

- The **owner's dashboard** has a **Network** card: the WiFi the system runs
  on, the server's signal, how many devices are connected and which is weakest.
- **More, Network and devices** shows everything: the server's WiFi and
  signal, the addresses staff open, **every connected device with its
  strength**, and the cloud copy.

### Moving the system to a new WiFi

Do this outside service. Every device has to move with the server.

1. **Recommended: put the server on a cable** to the router. A cable cannot
   join the wrong WiFi, and the router can change its WiFi name or password
   without the server noticing. Then only the tablets move.
2. If the server is on WiFi: owner signs in, **Network and devices**, **Change
   WiFi**. Pick the new network, type its password, tick "I will move every
   device", and press the button. If the password is wrong the server stays on
   the old WiFi.
3. On **every** tablet, till and kitchen screen: join the new WiFi (section 3).
   On a new router the server usually gets a **new address**. The server works
   it out by itself: open `/connect` on the server (or Network and devices)
   to see the new address and QR code. Nothing needs to be edited.
4. **Edit staff WiFi** on the same page, so the card has the new password,
   then **print a new card** from `/connect`: the address on it may have changed.
5. Check the device list: every device should come back with bars within a
   minute.

**Change WiFi is switched off until the box is set up for it.** On the box:

```
sudo cp box/polkit/50-cafe-wifi.rules /etc/polkit-1/rules.d/
sudo sed -i 's/^BOX_WIFI_CONTROL=off/BOX_WIFI_CONTROL=on/' /opt/cafe-pos/.env
sudo systemctl restart cafe-pos
```

### If the router itself is replaced

The server's fixed address is a reservation on the router
(`docs/DEPLOYMENT.md` section 17.3). A new router needs the same reservation,
or the address on the card changes. Give the new router the same WiFi name and
password as the old one and nothing else changes for staff.

---

## 6. When something is wrong

| Problem | Most likely | Fix |
|---|---|---|
| One device says "Cannot reach server" | It is on the wrong WiFi, or mobile data | Settings, WiFi, the staff WiFi; then the address |
| **Every** device says it | The server or router is off | Check both have power (they are on the UPS); `docs/RUNBOOK.md` section 1 |
| The address does not open, WiFi is right | Typed wrong, or `.local` on an old Android | Use the number address, `http://192.168.1.10` |
| "Saving paused: server clock is wrong" | The server's clock went back after a power cut | Manager: `docs/RUNBOOK.md` section 4 |
| "This server has handed over" | The cloud copy was made the main server on purpose | Use the cloud address the manager gives; `docs/RUNBOOK.md` section 6 |
| Signed out on every reload | The page was opened as `https://` on the box | Open `http://`, exactly as on the card |
| Weak bars on one table | WiFi does not reach that corner | Move the router, or add a second access point with the **same** WiFi name |

---

## 7. हिंदी में (short version in Hindi)

1. टैबलेट/फ़ोन को **कैफ़े स्टाफ़ WiFi** से जोड़ें (कार्ड पर QR 1)। फ़ोन में मोबाइल डेटा बंद रखें।
2. Chrome/Safari खोलें और कार्ड पर लिखा पता **बिल्कुल वैसा ही** टाइप करें, जैसे `http://192.168.1.10` (या QR 2 स्कैन करें)।
3. अपने फ़ोन नंबर और पासवर्ड से साइन इन करें। फिर "Add to Home screen" करें।
4. ऊपर दाईं ओर की **डंडियाँ (bars)** बताती हैं कि आपका टैबलेट सर्वर से कितनी अच्छी तरह जुड़ा है।
5. लाल पट्टी **"Cannot reach server"** दिखे तो आप गलत WiFi पर हैं: स्टेप 1 फिर से करें। तब तक कुछ भी सेव नहीं होता।
6. पीली **"waiting to upload"** का मतलब है इंटरनेट बंद है। काम चलता रहेगा, चिंता की बात नहीं।
