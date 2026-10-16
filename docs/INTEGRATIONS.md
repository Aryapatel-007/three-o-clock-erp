# Integrations

How to connect a restaurant to Swiggy, Zomato, a Pine Labs card machine and
Tally. Written for whoever sets up a restaurant. Built in P25 as module M21.
The contract is API-CONTRACT M21, the collections are DB-SCHEMA sections 32
to 39, and the words are GLOSSARY section 16.

Everything is set up in the app under **Set up, Integrations**
(`/settings/integrations`). The owner changes connections. A manager can read
them, see alerts and export to Tally.

Before any of this, the server needs `INTEGRATION_SECRETS_KEY` (see
`docs/DEPLOYMENT.md`). Every partner credential is sealed with it, and is never
shown again. A screen shows only its last four characters.

---

## 1. Swiggy and Zomato

### 1.1 Getting the integration

Neither platform lets a restaurant send orders to its own software without
approval. There are two ways in:

1. **Directly.** Apply to the platform's partner programme as a POS provider.
   They send an integration document and test credentials once they approve.
2. **Through a middleman.** An aggregator such as UrbanPiper or Petpooja's
   connector is already approved and passes orders on. That needs an adapter
   written against the middleman's own document instead.

Ask them for:
- the integration document, with every endpoint, field and status code;
- test credentials and a test store;
- how they sign their webhooks, and what address they post to;
- what they need from us to go live: certification, a test run, a form.

### 1.2 Their document stays out of git

The repository is public. A partner's document is confidential under their
agreement.

- Save it in `partner-docs/<platform>/` at the repository root. That folder is
  in `.gitignore`.
- Never copy text, field lists or examples from it into code comments, tests,
  docs or commit messages.
- The adapter in `server/services/integrations/channels/` is written from the
  document. Until then the provider is **Waiting for partner approval**, and
  nothing guesses an endpoint, a field name or a status code.

### 1.3 Practise with the sandbox platform first

The **Sandbox platform** behaves like a delivery platform, so staff can learn
the incoming orders screen before a real platform is connected. It never runs
in production.

1. Integrations, Sandbox platform: choose **Bills as** Zomato or Swiggy, set a
   signing secret of 16 characters or more, save, then **Test connection**.
2. Send a sample order from a terminal:
   ```
   npm run sandbox:order -- --restaurant <restaurant id> --file setup/sandbox-orders/simple-prepaid.json
   ```
   The other two samples are `unmapped-item.json` and
   `discount-and-packaging.json`.
3. The order appears on **Online** with its platform, number and a countdown.
   Accept it with a preparation time, or reject it with a reason.

### 1.4 Connecting a real platform, once its adapter exists

1. Integrations, the platform: enter the credentials, save, **Test connection**.
2. Give the platform the **webhook address**. It is shown once, when it is
   made. **Make a new address** stops the old one at once.
3. **Item mapping** (`/settings/integrations/<PLATFORM>/mapping`): match every
   platform item to a dish and size. An order with an unmatched item waits for
   a person. A long list can go in one call, as a CSV of
   `external_item_id,external_variant_id,menu_item,size`, through
   `POST /integrations/<PLATFORM>/item-mappings/import` (a dry run unless
   `apply: true`). The screen has no upload for it yet.
4. Check the platform's payment method exists in Settings, Payment methods, of
   kind Platform, with the platform code. Otherwise its bills stay unpaid and
   an alert says so.
5. Watch the **event log** on the platform's sheet for the first few orders.

---

## 2. Pine Labs card machine

Built from Pine Labs' public cloud integration page
(developer.pinelabs.com, "in-store cloud integration"), read on 8 October 2026.

### 2.1 What to ask Pine Labs for

- **Merchant ID** and **Security Token** (secrets, sealed when saved);
- **Store ID**, if they use one;
- each machine's **Client ID**, with a name the cashier will recognise;
- the **test (UAT) address**, and the **production address**;
- the integration document, for the three **URL paths**: sending an amount,
  reading its result, and cancelling it.

### 2.2 Setting it up

1. Integrations, Pine Labs: environment **Test (UAT)** first. Enter the
   address, the three paths, the Store ID and each machine. Save, then
   **Test connection**.
2. Settings, Payment methods: link **Card** and **UPI** to the card machine,
   each with its payment mode.
3. Each till tablet chooses its machine on **This device**.
4. Take a test payment in UAT on each machine: approved, declined, cancelled
   at the counter, and left to expire. Check each against the machine's slip.
5. Switch the environment to **Live**, with the production address and
   credentials, and test again with a small real payment.

With `settings.payments.requireTerminalForLinkedMethods` on (the default),
Card and UPI can only be taken through the machine. An owner or manager can
record one by hand, with a reason, when the machine is down. It is on the
audit trail as `TERMINAL_BYPASSED`.

### 2.3 What Pine Labs' public page does not say

These are not guessed. Each is a setting, or handled safely, until Pine Labs'
own document says otherwise:

1. **The URL paths** of the three calls: kept in the connection's settings.
2. **The production address**: a setting.
3. **Cancel's exact fields**: we send what the status call sends, plus the
   amount.
4. **The codes for declined and for still waiting.** Only 0 (approved) and 1008
   (voided) are public. A non-zero answer whose message says declined, failed
   or rejected is taken as declined. Anything else waits, and expires after
   the machine's own cancel time plus 5 minutes. Nothing is ever taken as
   approved unless the code is 0 and the approved amount is there.
5. **Postbacks are not signed.** A postback only makes the server ask Pine
   Labs again. It is never believed on its own.

---

## 3. Tally

Closed days only. Each becomes vouchers built from the figures frozen on its
bills, so the export always agrees with the day's reports.

### 3.1 Choosing how vouchers reach Tally

- **As a file to import**: download the day's file and import it in Tally.
  Nothing to install.
- **Through a Tally bridge**: a small program on the computer that runs Tally,
  `tools/tally-bridge/`, posts each day straight into Tally when someone
  presses **Send to Tally**.

Set it in Integrations, Tally: the **Tally version** (TallyPrime or
Tally.ERP 9), the **company name exactly as in Tally**, one sales voucher a day
or one per bill, and how vouchers reach Tally.

### 3.2 Ledger mapping

On the Tally page (`/settings/tally`), choose a Tally ledger for every head:
sales at each GST rate on the menu, sales where the platform pays GST, CGST
output, SGST output, round-off, each payment method, On Hold (one ledger, or
one per account), paid out and paid in, and, when payouts are exported, the
bank and each platform's commission.

An export refuses a day while a head with an amount has no ledger, and names
each one. **Download the ledger list** gives an XML of every mapped ledger
under its parent group, to import into Tally once. The accountant sets the GST
details on the tax ledgers in Tally.

### 3.3 Importing a file

TallyPrime:
1. Open the company.
2. First time only: Import, Masters, and choose the ledger list file.
3. Import, Transactions, and choose the day's file.
4. Check the Day Book for that date against the day's report.

Tally.ERP 9:
1. Open the company.
2. First time only: Gateway of Tally, Import of Data, Masters, the ledger list.
3. Gateway of Tally, Import of Data, Vouchers, the day's file.
4. Check the Day Book for that date against the day's report.

### 3.4 Installing and pairing the bridge

The bridge needs Node.js 20 or newer on the accountant's computer, and Tally's
HTTP server switched on. `tools/tally-bridge/README.md` is written for the
accountant and has the exact Tally setting for each version.

1. The owner, on the Tally page: **Pair a new bridge**, with the computer's
   name. The code works once, for 10 minutes.
2. On the accountant's computer: `node bridge.js pair <code> --server <the app's address>`.
3. `node bridge.js check` lists the companies open in Tally.
4. `node bridge.js run`, or **start-bridge.cmd** on Windows. Leave it open.
5. Integrations, Tally: **Test connection**. The days then appear.

Before posting, the bridge reads the company's ledger list, and nothing is
posted while a ledger the day uses is missing from it. **Switch off** a bridge
the moment its computer is lost or replaced.

### 3.5 Never post a day twice

A day that was downloaded, sent, posted, partly posted, or whose answer is not
known is held. To export it again:
1. **Delete that day's vouchers in Tally first.**
2. The owner presses **Export again** and types the exact sentence, like
   "I have deleted the vouchers for 26 Sep 2026 from Tally."

Reopening a day in Day Close marks its exports stale. Close it again, then
export it again. Importing a file by hand **and** sending it through the bridge
counts the day twice: the app cannot see a file imported by hand.

### 3.6 The manual check still owed (P25 Part K5)

Not yet done, because it needs Tally installed:
1. TallyPrime in Educational mode, a test company, its HTTP server on.
2. A staging restaurant with closed days on the 1st and 2nd of a month.
3. Import the ledger list, export both days, post them through the bridge, and
   compare every amount in Tally's Day Book with R2 and R9.
4. The same with Tally.ERP 9.
5. Save each version's real answers, with made-up names, as fixtures in
   `server/tests/fixtures/tally/`, and record any difference between the
   versions in `server/services/integrations/tally/profiles.js`.

---

## 3A. WhatsApp (P37)

Each restaurant sends from its own WhatsApp Business number, on Meta's Cloud
API directly. There is no platform fee and no middleman: the restaurant pays
Meta per message, on its own Meta invoice, and nothing reaches our accounts.

### 3A.1 Getting a WhatsApp Business Account

1. A Meta Business account for the restaurant, verified with its business
   documents (business.facebook.com, Business settings, Security centre).
2. A Meta developer app of type Business, with the WhatsApp product added.
3. A phone number for WhatsApp that is not already on the WhatsApp app (a
   number on the phone app must be deleted from it first), registered in the
   app's WhatsApp, API setup.
4. A permanent access token: a System user in Business settings, given the
   app and the WhatsApp Business Account, with `whatsapp_business_messaging`
   and `whatsapp_business_management`. A temporary token from API setup lasts
   24 hours and is for trying things only.
5. From API setup, the **Phone number ID** and the **WhatsApp Business
   Account ID**; from the app's Basic settings, the **App secret**.
6. A payment method on the WhatsApp Business Account in Meta, or nothing but
   the free service-window replies can be sent.

### 3A.2 Connecting it

Integrations, WhatsApp. Type the phone number ID, the account ID, the access
token, the app secret, and a webhook verify token of our own: any string of 16
characters or more, kept the same in Meta. Save, then **Test connection**: it
reads the number back from Meta, and passes only when the number is on the
Cloud API. The sheet shows the webhook address once.

In the Meta app, WhatsApp, Configuration: set the callback address to that
webhook address, the verify token to the same string, and subscribe to the
**messages** field. Meta checks the address with a GET at that moment; it
passes only when the verify token matches.

### 3A.3 Templates

A message to a guest who has not written to the restaurant in the last 24
hours must be a template Meta has approved. On the WhatsApp sheet, **Add a
template** starts from the Bill receipt (`BILL_RECEIPT`, a utility template):
adapt the wording, keep `{{1}}` (the restaurant's name), `{{2}}` (the bill
number) and `{{3}}` (the bill total), and send it to Meta, or link one already
made in Meta's own WhatsApp Manager. Review takes from minutes to a few days;
**Read from Meta** fetches the state. A bill is sent only once its template is
Approved, and only with **Send the bill on WhatsApp** switched on.

What gets a template rejected or moved to marketing:

1. Promotional words in a utility template: an offer, a discount, "visit us
   again for 10% off". Meta approves it as **marketing**, which costs about
   seven times as much and needs offers consent. The sheet warns when Meta's
   category differs from the one asked for; costs follow Meta's.
2. Variables at the very start or end of the text, two variables side by side,
   or more variables than words around them.
3. A variable whose example looks unlike real data, or no example.
4. Spelling and grammar mistakes, emojis Meta counts as promotional, or a link
   shortener.
5. The same text as a template already rejected.

### 3A.4 Quality rating

Meta scores each number Green, Yellow or Red from how guests react: blocks,
reports, and "not interested" taps. A falling rating lowers how many guests the
number may message in a day, and a Red one can be suspended. The receipt is
utility and expected, so it rarely hurts the rating; P52's offers are where a
rating is lost, which is why they need consent and a frequency cap. The test
shows the current rating.

### 3A.5 Stop

A guest replying STOP, UNSUBSCRIBE or STOP PROMOTIONS, or using Meta's own
"Stop promotions", has their offers consent withdrawn at once, with a history
entry on the Customers screen, and is told once. Their bills still come.

## 3B. The WhatsApp assistant (P51)

The assistant answers guests who write to the restaurant's WhatsApp number:
the menu, the hours, table bookings, their booking or takeaway, and stopping
messages. Anything else goes to **Chats** (`/online/chats`) for a person. It
needs WhatsApp connected (section 3A) and one AI key.

### 3B.1 The AI key

On Integrations, under AI assistant, connect one of:

| Provider | For | Where the key comes from |
|---|---|---|
| Anthropic | Real guests. A paid key is not used for training by default. | console.anthropic.com, API keys. Model `claude-haiku-5-5`. |
| Groq | Testing only, on its free tier, which has a small daily limit | console.groq.com, API keys. Model `openai/gpt-oss-120b`. |
| Gemini | Testing only, on its free tier: guests' messages may be used by Google | aistudio.google.com, Get API key. Model `gemini-2.5-flash`. |

The sheet says the same about the free tiers. With more than one on, the
assistant uses Anthropic, then Groq, then Gemini. A key is typed into the sheet
by the owner, sealed, and shown only as its last four characters; never paste
one into a chat, a document or the repository. **Test connection** asks the
model for one word.

### 3B.2 Switching it on

Settings, Assistant: **Answer guests on WhatsApp**, and **Take table bookings
on WhatsApp** (a booking waits for staff to confirm, like one from the page).
The greeting and "When a person replies" are optional. **AI replies a day, at
most** (500) keeps a free key inside its limit: after it, and whenever no AI key
is on, guests get three fixed buttons (Book a table, Opening hours, Talk to
us). With the assistant off nothing is sent, and every message waits in Chats.

### 3B.3 Booking templates

Inside the 24 hours after the guest last wrote, a confirmed or declined booking
is told as a plain message. After that it needs two utility templates, added on
the WhatsApp sheet like the Bill receipt: **Booking confirmed**
(`BOOKING_CONFIRMED`: reference, date, time, party size) and **Booking
declined** (`BOOKING_DECLINED`: reference, reason). Without them, a guest whose
window has closed is not told; staff call.

### 3B.4 Stopping

The keywords in section 3A.5 still work without the AI. Anything else that
means stop ("pls stop", "not interested", "band karo", "મેસેજ ના કરશો") the
assistant understands: offers stop, and bills still come, unless the guest
plainly asks to stop everything or to remove their number. Then nothing more is
sent, bills included, until staff turn messages back on from the chat, at the
guest's request.

### 3B.5 Before changing the prompt

`npm run assistant:eval` sends about 80 labelled guest messages to the real
model with the real prompt, using a key from the root `.env` (`GROQ_API_KEY`,
`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`; git-ignored). The bar: no clear stop
missed, nothing that is not a stop taken as one, and 95% right. Run it before
and after any change to `services/chatbot/systemPrompt.js` or the tools, and
write the numbers into PROJECT-STATE. On Groq's free tier a full run takes
about 20 minutes and can reach the daily token limit; `-- --from <id>` resumes.

---

## 4. What is built and what is waiting

| Part | Built | Waiting for |
|---|---|---|
| Foundation | Sealed credentials, connections, event log (180 days), job runner with retries, webhooks, the integration user | Nothing |
| Sandbox platform | Complete: orders, accept, reject, ready, pickup, cancel, availability | Nothing. Never in production. |
| Swiggy | Connection screen, mapping, the whole order flow behind the adapter | Swiggy's approval and document. Waiting for partner approval. |
| Zomato | The same | Zomato's approval and document. Waiting for partner approval. |
| Pine Labs | Send an amount, read the result, cancel, expiry, one payment per approval, the bypass | Pine Labs' document: the paths, the production address, Cancel's fields, the declined and waiting codes (section 2.3) |
| Tally file | Vouchers per day or per bill, the ledger list, held days, export again | The manual check in section 3.6 |
| Tally bridge | Pairing, posting, ledger check, lost posts held as not known, switch off | The same manual check. Its ledger and company list request follows Tally's help page for Tally.ERP 9, and is unconfirmed on TallyPrime. |
| WhatsApp | Connection and test, templates with their approval state, the bill sent when paid, delivery receipts, STOP | A real WhatsApp Business Account: a receipt to a staff number, its delivery receipt, and STOP, checked on it (P37 section 15) |
| WhatsApp assistant | Anthropic, Groq and Gemini keys, answers from the restaurant's data, bookings, stop in any words, Chats, booking messages | The same WhatsApp account, a paid AI key, and a real guest's chat checked on it (P51 section 16) |
| Alerts | Dead jobs, failed accepts, amount mismatches, closed-day cancellations, unknown card payments, Tally failures, on the Integrations page and in Today | Nothing |

---

## 5. Z Chaat checklist

Every answer here is `TO CONFIRM`. The profile is
`docs/archive/zchaat/PROFILE.md`.

| Item | Answer |
|---|---|
| Which delivery platforms they use: Swiggy, Zomato, others | `TO CONFIRM` |
| Direct partner integration, a middleman, or keep entering platform orders by hand | `TO CONFIRM` |
| The platforms' payment methods in Settings, with platform codes | `TO CONFIRM` |
| Item mapping for each platform's menu | `TO CONFIRM` |
| Whether Card and UPI go through a Pine Labs machine | `TO CONFIRM` |
| Pine Labs Merchant ID, Security Token, Store ID | `TO CONFIRM` |
| Each machine's Client ID and name | `TO CONFIRM` |
| Pine Labs UAT address, production address and the three paths | `TO CONFIRM` |
| A UAT test on each machine: approved, declined, cancelled, expired | `TO CONFIRM` |
| Tally version, TallyPrime or Tally.ERP 9 | `TO CONFIRM` |
| The company name exactly as in Tally | `TO CONFIRM` |
| One sales voucher a day, or one per bill | `TO CONFIRM` |
| Ledger names for every head in section 3.2, from their accountant | `TO CONFIRM` |
| File import, or the bridge on the accountant's computer | `TO CONFIRM` |
| If the bridge: the computer's name, Node.js installed, Tally's HTTP server on | `TO CONFIRM` |
| The manual check in section 3.6, on their version | `TO CONFIRM` |
| WhatsApp Business Account: verified Meta business, app, number on the Cloud API | `TO CONFIRM` |
| Phone number ID, account ID, permanent token, app secret, entered by the owner | `TO CONFIRM` |
| The Bill receipt template approved, as utility | `TO CONFIRM` |
| A receipt to a staff member's own number, delivered, and a second payment sending nothing | `TO CONFIRM` |
| STOP from that number: consent withdrawn on the Customers screen | `TO CONFIRM` |
| The assistant: a paid AI key (Anthropic) entered by the owner, the assistant switched on in Settings | `TO CONFIRM` |
| The Booking confirmed and Booking declined templates approved, as utility | `TO CONFIRM` |
| A staff member books a table on WhatsApp, the booking is confirmed on Bookings, and they are told | `TO CONFIRM` |
| "Not interested" from that number: offers stop, and the next bill still comes | `TO CONFIRM` |
