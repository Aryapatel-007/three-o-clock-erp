# Prompts

Run in order. One prompt per session. Each file names its model at the top.
The full table, with dependencies and owners, is in
`docs/CAFFEZA-BUILD-PLAN.md` section 3.

| Prompt | Title | Status |
|---|---|---|
| P00 | Adopt the Caffeza docs | Done |
| P01 | Production safety | Done |
| P02 | Settings: feature switches and invoice series | Done |
| P03 | Bill snapshots and line shares | Done |
| P04 | Cancel reasons and variant check | Done |
| P05 | Kitchen stations and printing | Done |
| P06 | Delivery and platform orders | Done |
| P07 | Settlement spec | Done |
| P08 | Payment methods, discount reasons and No Charge | Done |
| P09 | On Hold accounts and platform payouts | Done |
| P10 | Cash drawer and Day Close | Done |
| P11 | Caffeza setup and menu import | Done |
| P12 | Cloud deployment | Done |
| P13 | Reports spec | Done |
| P14 | Report engine | Done |
| P15 | Daily, money and GST reports | Done |
| P16 | Menu, captain and table reports | Done |
| P17 | Audit trail and control reports | Done |
| P18 | Report screens and Today | Done |
| P19 | Floor plan | Done |
| P20A | New look, part 1: foundation and service screens | Done |
| P20B | New look, part 2: back office and customisation | Done |
| P21 | Golden day, end to end | Done |
| P22 | Cafezza brand and professional finish | Done |
| P23 | Online takeaway orders and table reservations | Built, Arya's read outstanding |
| P24 | Advance payment, dish photos and the new public page | Built, Arya's read outstanding |
| P25 | Z Chaat, the cashier, and integrations | Done. Arya's read of M21 outstanding. |
| P26 | Adding items after serving and after billing | Done. Arya's read outstanding. |
| P27 | Customers: guest details at the table, for CRM | Done. Arya's read outstanding. |
| P28 | A manager's PIN for cancels, voids and cash | Done 2026-10-09. Arya's read outstanding. |
| P29 | Bill edits without voids, ready means served, print before payment, undo in the kitchen, and a clear cash book | Done 2026-10-10. Rishi's read outstanding. |
| P30 | Performance baseline and hosting | Done 2026-10-10. Stays on Render's free plan, by Rishi's choice. |
| P31 | Compression and request latency | Done 2026-10-10. |
| P32 | The client's weight | Done 2026-10-10. Not yet checked on a device at Z Chaat. |
| P33 | The live channel | Done 2026-10-10, on Render's free plan by Rishi's choice. Not yet checked on two real tablets. |
| P30 (keep awake) | Keep the free server awake | Done 2026-10-10. Its prompt is numbered P30 too, written the same day as the row above; see the decision log. The three pingers still need setting up by hand, DEPLOYMENT.md section 14. Rishi's read outstanding. |
| P34 | Set a new password from the sign-in screen | Done and deployed 2026-10-11. Arya's read outstanding. |
| P35 | The same dish once on the bill, and each drink its own dish | Done, deployed and run on Z Chaat 2026-10-11. Rishi's read outstanding. |
| P36 | One kitchen ticket per table | Done 2026-10-11. Rishi's read outstanding. |
| P37 | WhatsApp: the connection, templates, and the receipt | Built and deployed 2026-10-11 against a fake Meta; the check on Z Chaat's real WhatsApp Business Account is owed. Rishi's read outstanding. |
| P38 | The public page as a street-food signboard, the booking advance, the kitchen's ready switch | Done and deployed 2026-10-12. Arya's read outstanding. |
| P39 | A captain cannot change a printed bill | Built 2026-10-12. Arya's read outstanding. |
| P40 | A manager's PIN to add to a printed bill | Built 2026-10-13. Arya's read outstanding. |
| P41 | Kitchen text on one line, Recall, Undo after Send, the floor as tiles | Built 2026-10-13. Arya's read outstanding. |
| P42 | Changing a dish after it is sent; the kitchen login sees only tickets | Built 2026-10-13. Arya's read outstanding. |
| P43 | Other, with the mode of payment | Built 2026-10-13. Arya's read outstanding. |
| P44 | The Day End summary, and the day-end message by email | Built 2026-10-14. Arya's read outstanding. |
| P45 | A loud bell on the kitchen screen for a new KOT | Built 2026-10-14. Arya's read outstanding. |
| P46 | Open item: a dish whose name and price are typed when ordering | Built 2026-10-14. Arya's read outstanding. |
| P47 | Other modes: Swiggy, Zomato and EazyDiner one tap away, kept in Settings | Built 2026-10-14. Arya's read outstanding. |
| P48 | PetPooja's way: the floor, Recall, change, typed extras, the counter screen, a test site | Built 2026-10-14. Arya's read outstanding. |
| P49 | Before a dish is sent, the captain changes it freely | Built 2026-10-14. Arya's read outstanding. |
| P50 | Close a table opened by mistake | Built 2026-10-14. Arya's read outstanding. |
| P51 | The WhatsApp assistant: questions, table bookings, and stop | Built 2026-10-12 against a fake Meta and a fake model; the eval run on Groq. Numbered P39 when written; merged with Rishi's P38 to P50 on 2026-10-15. Waits for P37's real WhatsApp account and a paid AI key. Rishi's read outstanding. |
| P52 | Campaigns: offers and new dishes | Written by Arya, not saved here yet; comes after P37 has run on a real WhatsApp account. Numbered P38 in P37's prompt. |
| P53 | Attribution and campaign reporting | Not written yet. Numbered P39 in P37's prompt. |
| P54 | Constant backups | Done, waiting for Arya to switch on: the storage secret, then the practice restore. Written as P44. |
| P55 | The owner's dashboard, beside the ERP | Built 2026-10-15. Written as P51 and renumbered on merging Arya's P51 to P54. Arya's read outstanding. |
| P56 | A note for every dish, the guest's details before the first KOT, and only whole voids in the void lists | Built 2026-10-15. Arya's read outstanding. |
| P57 | The bill in one place: review, discount, then Save or Save & Print | Built 2026-10-17. Arya's read outstanding. |
| P58 | One kitchen ticket per Send, not per station | Built and deployed 2026-10-17. Z Chaat's owner switches it off in Settings, Kitchen, after the deploy. Rishi's read outstanding. |
| P59 | A captain's bill prints once, and the guest count moves to the first Send | Built 2026-10-21. Arya's read outstanding. |
| P60 | Bill without KOT | Built 2026-10-21. Arya's read outstanding. |
| P61 | A simple Day Close | Built 2026-10-21. Arya's read outstanding. |
| P64 | Invoice themes, and what prints on a bill | Built 2026-10-25, not deployed. Arya's read outstanding. |
| P65 | The CA's month, sent by itself | Built 2026-10-25, not deployed. Arya's read outstanding. |

Prompt files that do not exist yet are added as they are written.
