# P64 Invoice themes, and what prints on a bill

Model: Opus, high. Owner: Rishi (M3, M7, M20). Depends on: P57, P59, P60.

Asked for by Rishi on 2026-10-24, from MyBillBook's Invoice Settings page:
themes, a custom theme with a chosen colour, and the theme switches (party
balance on the invoice, item description, alternate unit, phone number, time,
price history, free item quantity).

Read before starting: `docs/API-CONTRACT.md` M3 section 16 (the invoice read),
`docs/DB-SCHEMA.md` section 1 (`settings`), `docs/DESIGN-SYSTEM.md`,
`client/src/features/printing/invoiceHtml.js`.

## 1. What is true today

1. Two layouts exist, both in `client/src/features/printing/invoiceHtml.js`:
   `invoiceHtml` (A4 and A5) and `thermalBillHtml` (80 mm and 58 mm). Both are
   laid out from one payload, `GET /bills/:billId/invoice`, so they can never
   print different amounts. Keep that property. It is the whole reason the
   file is written the way it is.
2. There is no theme choice. The only per-restaurant difference is the logo,
   the header lines, the footer text and the GSTIN and FSSAI switches in
   `settings.receipt`, plus the per-device printer, width, edge margin and text
   size in `client/src/features/printing/printers.js`.
3. Printing happens in the browser. The server never talks to a printer, and
   `invoiceHtml.js` is the one file the design guard lets draw an `<img>`.
4. There is no HSN or SAC code anywhere in the project. A CA-grade invoice and
   a GSTR-1 HSN summary both need one. P65 depends on this prompt for it.

## 2. What a restaurant actually needs, and what it does not

MyBillBook is a general GST billing app for traders. Three of its switches have
no meaning on a restaurant bill, and this prompt refuses them rather than
building something that reads as a mistake later:

| Theirs | Why not |
|---|---|
| Alternate unit in invoice | A bill line is a dish at a price. M4 has base units for stock; they never reach a bill line, and putting them there would invite a report to add up grams of paneer as sales. |
| Free item quantity | Wholesale "buy 10 get 1". A free dish here is No Charge (M16) or a discount (M3), both of which already have a reason and an approver. A second, unreasoned path to free food is the exact hole BUILD-PLAN section 7 names. |
| Price history | That is M8. `MENU_PRICE_CHANGED` is already written and read on the activity log. It does not belong on a tax invoice. |

"Show party balance in invoice" does have a real equivalent: an On Hold
account's outstanding, which `accountService.outstandingFor` already adds up
from the ledger. Build that one, under its own words.

The festive skins (Navratri, Diwali, Rath Yatra, and the rest) are not built.
A thermal head prints one colour of dot at 203 dpi, so a skin is invisible on
the bill that nine guests in ten are handed; on A4 it is decoration on a tax
document. If an owner asks for one, it is a second image slot beside
`brandLogos`, which is an additive change of about ten lines, and it gets its
own small prompt with an owner asking for it. Do not build thirty skins nobody
asked for.

## 3. What to build

A. **Spec first**, before any code, as every module does: the P64 sections of
   `docs/API-CONTRACT.md` (M7 settings, and M3 section 16 gaining `hsnCode` and
   `onHoldOutstandingInPaise`), `docs/DB-SCHEMA.md` (section 1 `settings`,
   section 6 `menuitems`, section 12 `bills.lines`), `docs/GLOSSARY.md` section
   48 for the printed words, and the rows in `docs/prompts/README.md` and
   `docs/CAFFEZA-BUILD-PLAN.md` section 3.

B. **HSN and SAC, frozen like every other price fact.**
   - `menuitems.hsnCode`, a trimmed string, default null, 4 to 8 characters.
   - `settings.invoice.defaultSacCode`, default `996331`, the SAC for
     restaurant service. An item with no code of its own prints the default.
   - The code is copied onto the order line when the line is added, beside
     `categoryName` and `taxRateBps`, and frozen onto the bill line from there.
     Never read live at print time. CLAUDE.md, the non-negotiable rules.
   - A bill printed before P64 has no code on its lines; that column is blank,
     never back-filled, never guessed. Same rule as P03's line shares.

C. **One settings group, `settings.invoiceLayout`**, every field with a default
   so no restaurant needs a migration (M7's property):
   - `theme`: `CLASSIC` (default), `GST_DETAILED`, `MODERN`, `COMPACT`.
   - `useBrandAccent`: false. True draws the accent the restaurant already
     chose on the Appearance page. It goes through `utils/colour.js`, which
     already refuses a colour that fails contrast or reads as a state colour.
     No second colour picker, and no raw hex anywhere but that file.
   - `show`: a flat object of booleans, each naming something the payload
     already carries or that B adds: `time`, `captain`, `cashier`, `covers`,
     `table`, `orderType`, `customerName`, `customerMobileMasked`, `itemNote`,
     `hsn`, `paymentBreakdown`, `onHoldOutstanding`, `amountInWords`,
     `declaration`, `signatureLine`, `reviewQr`.
   - `thermalShow`: the subset that applies to a roll. `settings.receipt`'s
     existing `showGstin`, `showFssai` and `showServerName` stay where they
     are and are read, not duplicated. One name per quantity.

D. **The mandatory core.** A switch may never remove what Rule 46 of the CGST
   Rules requires from a tax invoice: the supplier's name, address and GSTIN,
   the words TAX INVOICE, the invoice number and its date, each line's taxable
   value, the rate and amount of CGST and SGST, and the total. Those are not in
   `show` at all, and a test renders every theme with every switch off and
   fails if any of them is missing. This is the one part of P64 that is a
   safety rule rather than a preference.

E. **The four themes, as four pure functions of one payload.**
   `client/src/features/printing/themes/` holds one file per theme, each
   exporting `{ id, title, paper: ['A4','A5'], styles, render(data, options) }`,
   registered in `themes/index.js`. None of them queries anything, and none
   computes an amount: every figure still comes from the payload, through
   `moneyText`. `invoiceHtml` as it stands today becomes `CLASSIC`, unchanged,
   so a restaurant that never opens the page prints exactly what it printed
   yesterday.
   - `GST_DETAILED` is the one that earns its place: an HSN column, a rate-wise
     tax summary with taxable value, CGST and SGST per slab, the amount in
     words, the declaration and a signature line. This is the invoice a CA asks
     for, and P65 assumes it exists.
   - `MODERN` is `CLASSIC` with the accent band and a lighter rule weight.
   - `COMPACT` is A5-first, tighter leading, the same content.
   The thermal bill stays one layout and gains `thermalShow` only. It is the
   bill Z Chaat's guests know, and P25 and the 2026-10-09 decisions measured it
   on real paper.

F. **The screens, three of them.** Rishi's own MyBillBook account, seen on
   2026-10-24, splits this three ways, and the split is better than one page
   because it follows the three things being set up: **Invoice settings** is
   the full-page document a guest is emailed or handed, **Print settings** is
   the paper and theme for a printer, and **Thermal settings** is the roll. The
   code already has that seam — `invoiceHtml`, the paper sizes in
   `printers.js`, and `thermalBillHtml` — so the screens follow it rather than
   cutting across it.

   All three sit under `/settings/invoice-layout`, OWNER only, as tabs of one
   page modelled on Appearance and for the same reason: the live preview needs
   width the settings form does not have. Each previews a real bill through
   `ReceiptPreviewPage`'s existing path, switching theme, paper and switches
   without saving, and saves through `PATCH /settings` with a reason, audited
   as `SETTINGS_CHANGED` like everything else. The per-device choices (printer,
   width, edge margin, text size) stay on This device, where they belong: they
   are that counter's printer, not the restaurant's.

G. **Four small things from their sample invoice**, each additive and each
   worth having on a document a CA or a company guest will keep:
   - **A signature image.** A second slot beside `brandLogos`, with the exact
     rules P22 settled for a logo: PNG, WebP or JPEG read from the file's own
     bytes, SVG always refused, the bytes `select: false` so they never ride
     along with `GET /settings` or the restaurant document `authenticate`
     loads on every request. It prints above the existing signature line.
   - **The amount in words**, already in `show` under `amountInWords`. It is
     written by one helper beside `paiseToWholeRupeesText` in `money.js`,
     never by a theme, so four themes cannot spell a number four ways.
   - **Terms and conditions**, a text block in `settings.receipt` beside the
     footer, with the same empty-string-is-null rule M7 settled for the three
     fields already there.
   - **PAN, and MSME or Udyam number**, two optional fields on the restaurant
     beside the GSTIN and FSSAI it already prints, shown under `show`.

   - **The copy marking.** Checked against CBIC's own text of CGST Rule 48 on
     2026-10-24, because a first draft of this prompt got it wrong and called
     it a goods-only rule. It is not. Rule 48(1) puts a supply of **goods** in
     triplicate (ORIGINAL FOR RECIPIENT, DUPLICATE FOR TRANSPORTER, TRIPLICATE
     FOR SUPPLIER); Rule 48(2) puts a supply of **services** in duplicate,
     marked ORIGINAL FOR RECIPIENT and DUPLICATE FOR SUPPLIER. A restaurant
     serving food is supplying a service, so the duplicate pair is the one
     that applies. The full-page themes carry the marking, defaulting to
     ORIGINAL FOR RECIPIENT, with the supplier's copy available from the same
     screen. The thermal roll is left alone: it is one physical copy handed
     over a counter, and nobody prints a second for the file.

## 4. Tests

Server: `hsnCode` is copied onto an order line at add time and frozen onto the
bill line; an item with no code gets the restaurant's default SAC; changing an
item's code afterwards does not change a bill already issued; `invoiceLayout`
reads back complete on a restaurant document written before P64; an invalid
theme is a 400 and a failing accent colour a 422.

Client: a guard test renders the golden day's bill B07 through all four themes
and asserts every money figure on each is identical, so no theme can disagree
with another; every theme with every switch off still prints the mandatory
core; the thermal bill's rendered output is byte for byte what it is today when
`thermalShow` is left at its defaults, so P64 cannot quietly change the bill in
the cafe.

Browser: the owner switches theme, sees the preview change, saves, and the next
print uses it.

## 5. What this does not do

It does not touch `server/utils/tax.js`, `computeBillTotals`, the invoice series
or any figure. It is a layout prompt. A change that needs a figure to move is
not part of it, and `settings.tax.pricingMode` is still waiting on a CA, which
is what P65 is for.
