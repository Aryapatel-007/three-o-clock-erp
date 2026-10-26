# Design System

This is version 2, in force from P20A and P20B. Version 1 is archived in `docs/archive/DESIGN-SYSTEM-V1.md`.
What every screen looks like, and why.

Read this before building or changing any screen.
If two screens look different, it is because this file was not followed.

---

## 1. The brief

**Who uses it.**
Captains on phones, walking between tables.
Station cooks reading a tablet on a hot, bright or dim counter.
A cashier at a computer with a queue in front of them.
A manager closing the day at midnight.
An owner reading reports on a phone the next morning.

**What it replaces.**
Caffeza's current POS: a brown header, orange and red table tiles, grey tables when free, and reports that disagree with each other.
Its staff already read table state by colour. That habit is worth keeping.

**What the client asked for.**
As simple as what they have, reports that cannot be wrong, and a look they can make their own.

**The one idea.**
During service, the thing that matters is time: which table has waited longest, which ticket is late.
In the back office, the thing that matters is proof: do the numbers balance.
So each kind of screen has exactly one bold element.
On service screens it is the **time edge**. On report screens it is the **balance seal**.
Everything else stays quiet so those two can be read at a glance.

---

## 2. What version 1 got right, and keeps

These rules carry over unchanged, and still apply:

1. Colour that means something is never used for decoration.
2. Every number is set in IBM Plex Mono. Prices line up, and numbers have their own voice.
3. Exactly one primary action on a screen at a time, and it may change with the screen's state.
4. Confirmations state the consequence with real numbers, never "Are you sure?"
5. The numeric keypad for every amount and quantity. Never the phone keyboard for money.
6. Slide-over sheets for editing one record, never a blocking modal.
7. Lists for anything staff scan. Tiles only for things staff tap.
8. Every state carries an icon, a colour and a word together. Colour is never the only signal.
9. No charting library. Single-series charts in one colour, with a table twin for every chart.
10. Zeros, not gaps.
11. Buttons say the action. Success messages repeat the button's verb.
12. 48px minimum tap targets, visible focus, reduced motion respected.

## 3. What changes, and why

| Version 1 | Version 2 | Why |
|---|---|---|
| One light theme | A day theme and a night theme | Station screens sit in dim kitchens, and a white screen at night is glare |
| One surface colour | Ground, surface and sunken | Table tiles and tickets need to read as objects you can tap |
| Three functional colours | Six state colours, each with a word and an icon | The floor alone has five states: free, open, served, bill printed, late |
| The rotated availability stamp as the signature | The time edge on service screens, and the balance seal on reports | A signature should carry information. Rotation carried none. |
| Fixed colours | A brand accent the owner chooses, with state colours fixed | The client asked for a look they can make their own, and meaning must not change between restaurants |
| IBM Plex Sans | Anek, with Gujarati and Devanagari siblings | One family that can carry the Gujarati labels already on the billing screen, with a width axis used for real jobs |
| Uppercase section headings | Sentence case everywhere | Uppercase is slower to read, and it is the most common tell of a template |
| Token names `paper`, `ink`, `chana`, `mirch`, `patta` | Names that say the job: `ground`, `ink`, `accent`, `open`, `bill` | A new developer should know what a token is for from its name |

---

## 4. Colour

### 4a. Neutrals

| Token | Day | Night | Used for |
|---|---|---|---|
| `ground` | `#F2F4F3` | `#0F1715` | The page behind everything |
| `surface` | `#FFFFFF` | `#17211E` | Tiles, tickets, sheets, table rows, inputs |
| `sunken` | `#E7ECEA` | `#0B1210` | Table headers, input wells, the keypad display |
| `ink` | `#1B2623` | `#E4ECE8` | Primary text and icons |
| `muted` | `#53615C` | `#98A9A2` | Secondary text, input borders, disabled text |
| `line` | `#C9D2CE` | `#2B3733` | Dividers only. Never text, never an input border. |

The neutrals lean faintly green-grey. Not cream, not pure grey.
It is a working surface, like a steel counter under cool light.

Measured contrast, day: `ink` on `surface` 15.6, `muted` on `surface` 6.5, `muted` on `sunken` 5.4.
Night: `ink` on `surface` 13.7, `muted` on `surface` 6.7.
Every text pair passes WCAG AA at 4.5 or more.

**The warm set (P22).** The cool set above is every restaurant's default. A restaurant may choose warm instead, `settings.appearance.neutralTone: WARM`. It is Cafezza's printed menu translated into the product: cream cards on linen become white surfaces on a warm linen ground, with espresso ink.

| Token | Warm day | Warm night |
|---|---|---|
| `ground` | `#EFE9E1` | `#1A1310` |
| `surface` | `#FFFFFF` | `#241B17` |
| `sunken` | `#E9E2D8` | `#140E0C` |
| `ink` | `#2E201B` | `#F3E8DC` |
| `muted` | `#625147` | `#B9A699` |
| `line` | `#D5CABD` | `#3A2E28` |

Shadow and scrim follow the cool recipe, made from warm `ink` by day and pure black by night. Text on a night button is warm night `ground`.

Day `surface` stays pure white, not menu cream. A cream surface lowers the contrast of the amber `open` tint against it, so a free table drifts toward looking open. The warmth comes from the ground, ink, muted text and lines instead.

Measured from the constants in `server/utils/colour.js`, P22:

| Pair | Warm day | Cool day | Warm night | Cool night | Minimum |
|---|---|---|---|---|---|
| `ink` on `surface` | 15.69 | 15.58 | 13.97 | 13.72 | 4.5 |
| `ink` on `ground` | 13.01 | 14.10 | 15.19 | 15.14 | 4.5 |
| `muted` on `surface` | 7.53 | 6.50 | 7.22 | 6.70 | 4.5 |
| `muted` on `sunken` | 5.86 | 5.44 | 8.18 | 7.70 | 4.5 |
| `muted` on `ground` | 6.25 | 5.88 | 7.84 | 7.40 | 4.5 |
| Each state edge on `surface` | 6.69 to 8.04 | the same | 7.39 to 10.16 | 7.22 to 9.93 | 3 |
| Each state tint on `surface` | 1.19 to 1.33 | the same | 1.06 to 1.23 | 1.03 to 1.20 | no lower than cool |

Every preset and Cafezza's accent reads at 5.53 or more on warm day `ground`, and every night value at 4.56 or more on warm night `ground`. A test fails if any pair drops below its minimum, and another if `index.css` and the constants disagree.

Printing keeps the cool day set. Paper stays plain.

### 4b. State colours

Fixed. **No theme and no owner setting can change them**, so "bill printed" looks the same in every restaurant and every year.

| Token | Means | Day tint | Day text and edge | Night tint | Night text and edge | Icon | Word |
|---|---|---|---|---|---|---|---|
| `open` | A table or order is in progress. Also used for a caution. | `#FBEAC4` | `#7A4F00` | `#3A2B0C` | `#F2C25B` | Filled dot | Open |
| `served` | Food is out. The table is eating. | `#D2ECE5` | `#16614F` | `#11322B` | `#6FD0BC` | Plate | Served |
| `bill` | A bill is printed and waiting to be paid | `#F5D8E5` | `#922457` | `#3A1526` | `#F28FBB` | Receipt | Bill printed |
| `alert` | Late, destructive, failed, out of stock | `#F8DCD5` | `#A8321C` | `#3D1610` | `#FF8B73` | Triangle | Late, Void, Out of stock |
| `ok` | Done, paid, available, balanced | `#D6EADC` | `#256640` | `#112F1E` | `#7BD69C` | Tick | Paid, Available, Balanced |

A free table has no state colour at all: `surface` with a `line` border and the word Free. Absence of colour means absence of activity.

Familiar to Caffeza's staff by design: their free tables are grey, open ones orange, and printed bills red. Ours: no colour, amber, and raspberry.
Raspberry, not red, for a printed bill, because a printed bill is normal. Red is kept for things that are wrong or late.

**How a state is drawn.**
A tint fill alone is too faint to rely on: tint against surface is only about 1.3 to 1.

So every stateful element has three things:
a 3px edge in the state's text colour, at 6.7 to 8 to 1 against `surface`,
the state's icon,
and the state's word in the state's text colour on its tint, at 5.2 to 6.1 to 1.

### 4c. The accent

The brand colour. Used for exactly three things:
the one primary action button,
the keyboard focus ring,
and links.

Nothing else. Not headers, not backgrounds, not chart marks.

Six presets. Every one passes the same rules an owner's own colour must pass, below: white text on the accent at 6.7 to 11.4, and the accent on day `ground` at 6.0 to 10.3.

| Preset | Day | Night, for text, focus and button fill | Hue |
|---|---|---|---|
| Ocean, the default | `#1C5C86` | `#2985C2` | 204 degrees |
| Indigo | `#3446A8` | `#6B7BD1` | 231 degrees |
| Plum | `#6A3878` | `#A666B8` | 287 degrees |
| Olive | `#4F6328` | `#6E8A38` | 80 degrees |
| Espresso | `#55473F` | `#927A6D` | 22 degrees, at 15% saturation |
| Graphite | `#343B41` | `#71818E` | 208 degrees, at 11% saturation |

On a night button, the text is night `ground`, at 4.5 to 1 or more on every night value above.
Each night value is what `nightVariant` in section 13 produces, so presets and custom colours follow one rule.
P20A replaced the first draft's night values with the code's: five moved by one in a channel, Plum's green by two and Graphite's channels by up to three. `nightVariant` steps HSL lightness up by 0.01 from the colour's own and rounds each channel to a whole number, and the draft had rounded differently.

Espresso is the coffee-house brown. It is kept under 25% saturation, so it can never be read as the amber of an open table.
An earlier draft used a pine green and a roast brown. Both failed the rule below: pine sat within 2 degrees of the `served` teal, and roast between `alert` and `open`. A primary button must never look like a state.

An owner may also enter their own brand colour. It is accepted only if:
white text on it is at least 4.5 to 1,
it is at least 3 to 1 against `ground`,
and its hue is at least 30 degrees from every state colour's hue, unless its saturation is under 25%.
Otherwise the settings screen says why, and suggests the nearest preset.
The night variant of a custom colour is worked out by raising its lightness until it reaches 4.5 to 1 against night `ground`.

There is no amber, teal, raspberry, red or green preset, because each would collide with a state.

P22: an accent is checked against day `ground` in both tones, and its night variant is raised until it reads on both night grounds, so switching the tone can never break a saved accent. No preset's night value moved. White text at 4.5 to 1 already rules out any colour that would clear 3 to 1 on cool day `ground` and miss it on warm; the check is there so the rule does not depend on that arithmetic staying true.

### 4d. The brand pair

Two tokens, fixed per restaurant from its logo and not chosen as a look: `brand`, the logo's own background colour, and `on-brand`, text on it. `settings.appearance.brandHex` and `onBrandHex`, both or neither, and `on-brand` on `brand` at 4.5 to 1 or more.

They have exactly two uses:

1. The sign-in brand panel.
2. The plate behind a logo shown on the other ground: a logo made for dark grounds, shown on a day screen, sits on a `brand` plate with an 8px radius.

Nowhere else. Not buttons, not headers, not tiles, not the background of a service screen. A test fails if `bg-brand` or `text-on-brand` appears outside `BrandLogo` and `LoginPage`.

`brand` is the exact logo background, not the adjusted accent, so a logo with its own solid background blends into the panel with no visible edge. Without a brand pair the sign-in screen looks as it did before P22, and a plate falls back to day `ink`.

---

## 5. Type

### 5a. Families

**Anek, for every word.**
Designed by Ek Type in Mumbai, with sibling families for Latin, Gujarati and Devanagari that share proportions, so an English label and its Gujarati partner sit together as one voice.
Variable weight and variable width. The width axis has real jobs here, listed in 5c.
Self-hosted through `@fontsource`, like Plex since P12.

**IBM Plex Mono, for every number.** Kept from version 1, for the reasons version 1 gave.

The test stays the same: is it a number? Plex Mono. Otherwise Anek.

### 5b. The scale

Built on a 4px rhythm. Sizes in pixels, at the default text size.

| Style | Family | Size and line | Weight | Width | For |
|---|---|---|---|---|---|
| `title` | Anek | 24 / 32 | 640 | 100 | Screen titles |
| `heading` | Anek | 18 / 24 | 600 | 100 | Section headings |
| `body` | Anek | 16 / 24 | 440 | 100 | Item names, general text |
| `label` | Anek | 14 / 20 | 540 | 100 | Form labels, buttons in dense places, chips |
| `button` | Anek | 16 / 20 | 600 | 100 | Buttons |
| `caption` | Anek | 13 / 18 | 440 | 100 | Secondary text |
| `tile-name` | Anek | 22 / 26 | 660 | 112 | Table names on the floor, read across a room |
| `ticket-item` | Anek | 15 / 20 | 560 | 88 | Items on a kitchen ticket, on one line (P41) |
| `dense` | Anek | 14 / 20 | 460 | 82 | Report table text |
| `num` | Plex Mono | 15 / 20 | 500 | | Numbers in rows |
| `num-tile` | Plex Mono | 20 / 24 | 600 | | Amounts on tiles |
| `num-hero` | Plex Mono | 44 / 52 | 600 | | A bill total, the keypad display, a report's headline figure |
| `num-meta` | Plex Mono | 13 / 18 | 450 | | Times, counts, small figures |

`tabular-nums` on columns of numbers that line up. Not on a standalone hero figure.

### 5c. What the width axis is for

| Width | Where | Why |
|---|---|---|
| 82, condensed | Report tables | More columns fit on a phone before scrolling, without shrinking the text |
| 92 | Kitchen ticket items | Long dish names fit one line more often at a large size |
| 100 | Everything else | |
| 112, expanded | Table names on the floor | Short names like "T 14" read from three metres away |

### 5d. Second language

Fixed action words on service screens can carry a second line in Gujarati or Hindi: Pay, Print bill, Send to kitchen, Cancel, Done, and the state words.
Set in Anek Gujarati or Anek Devanagari, at the `caption` size, under the English, in `muted`.
Never item names. Never anything a person typed. Never a whole-app translation.
One `Bilingual` component and one labels file per language, replacing version 1's two per-module copies.

---

## 6. Space, shape and depth

**Spacing**: 4, 8, 12, 16, 24, 32, 48. Nothing in between.

**Corners by role, never one radius for everything**:

| Element | Radius |
|---|---|
| Table tiles and tickets | 10px |
| Buttons and inputs | 8px |
| State chips | Fully round |
| Sheets | 16px on the edge that enters the screen |
| Report table rows | Square |

**Depth**:
Tiles and tickets sit on `ground` with a 1px `line` border and no shadow.
Only things that float above the page cast a shadow: sheets, menus and toasts, with `0 12px 32px` in `ink` at 18% in day, 50% in night.
No translucency, no blur, no gradients. Surfaces are flat and opaque, as in version 1.

---

## 7. The two signature elements

### 7a. The time edge

A 4px bar along the bottom edge of anything that is waiting: a table tile, a kitchen ticket, a row in the billing strip.

1. It fills from left to right with the time elapsed, against that thing's target:
   a table against `settings.floor.longOpenMinutes`,
   a ticket against its station's target time,
   a printed bill against 10 minutes.
2. Until the target, it is drawn in the item's state colour.
3. At the target it turns `alert`, stays full, and the word "Late" with its icon appears beside the time.
4. It updates once a minute. It never pulses, glows or animates on its own.
5. Beside it, the elapsed time in `num-meta`: "34 min".

Nothing else on a service screen is allowed to be as loud as a late time edge.

```
┌─────────────────────┐
│ T 14          ● Open│
│ 3 guests            │
│ ₹1,240       34 min │
│█████████████░░░░░░░░│  ← time edge, amber, 34 of 90 minutes
└─────────────────────┘
```

### 7b. The balance seal

At the top of every report, above everything the report shows.

When every check passes:
a tick in `ok`, then "Balanced", then "All 6 checks passed for 26 Sep 2026" in `muted`.

When a check fails:
the triangle in `alert`, then "Does not balance", then the check's own message, then "Show the bills".

When only a warning is raised, such as a cash difference:
the `open` dot, then "Balanced, with 1 note", then the warning's message.

It is quiet when it passes and impossible to miss when it fails.
It sits in its own `surface` block with a 3px edge on the left in its state colour.
It is the reason the owner trusts the page, so it is the first thing on the page.

```
┃ ✓ Balanced
┃   All 6 checks passed for 26 Sep 2026
```

---

## 8. Layout

### 8a. Service screens: floor, order, bill, kitchen

**Phone, under 600px.** One column. A bottom bar with the role's four or five main places. The primary action pinned to the bottom, full width, above the bar, where the thumb is.

**Tablet and computer, 600px and over.** A 76px rail on the left with the same places. Content in the middle. On the order and bill screens, a right column for the order summary, with the primary action at its foot.

```
Phone                      Tablet and computer
┌──────────────────┐       ┌────┬──────────────────────────┬──────────────┐
│ Floor     ☾  ⋯   │       │ ◉  │ Floor                    │              │
├──────────────────┤       │Flr │ Billing  T18 ₹462  T5 ₹483│              │
│ Billing          │       │ ◎  ├──────────────────────────┤  (order      │
│ T18 ₹462  T5 ₹483│       │Ord │ Cafe                     │   summary    │
├──────────────────┤       │ ◎  │ ┌────┐ ┌────┐ ┌────┐     │   on the     │
│ Cafe             │       │Kit │ │T 1 │ │T 2 │ │T 3 │     │   order      │
│ ┌──────┐┌──────┐ │       │ ◎  │ └────┘ └────┘ └────┘     │   screen)    │
│ │ T 1  ││ T 2  │ │       │Bil │ ┌────┐ ┌────┐            │              │
│ └──────┘└──────┘ │       │ ◎  │ │T 4 │ │T 5 │            │              │
│                  │       │Mor │ └────┘ └────┘            │ [ Primary ]  │
├──────────────────┤       └────┴──────────────────────────┴──────────────┘
│[ Primary action ]│
│ Floor Orders ... │
└──────────────────┘
```

Left-aligned throughout. Nothing centred except the keypad digits and the hero total.

### 8b. Kitchen station

Day theme by default, like every screen. A station tablet on a dim counter can choose Night on This device. (Changed 2 October 2026 at the owner's request; the first draft opened the kitchen in Night.)
Tickets in columns, oldest on the left, late ones moved to the front.
Each ticket: station and KOT number, table or platform, time edge at the bottom, items in `ticket-item`, notes and add-ons indented.
One tap on an item marks it ready. One tap on the ticket's footer marks the whole ticket ready.

```
┌──────────────────┐ ┌──────────────────┐
│ KOT 412  T 14    │ │ KOT 415  SWIGGY  │
│ Khuman Singh     │ │ 249377796192385  │
│ 3 guests         │ │                  │
├──────────────────┤ ├──────────────────┤
│ 1  Creamy Pesto  │ │ 1  Half & Half   │
│    Pasta         │ │    Pizza         │
│ 2  Cheesy Tornado│ │ 1  Ferrero Shake │
│    + Extra cheese│ │                  │
├──────────────────┤ ├──────────────────┤
│ 12 min   Ready ✓ │ │ ⚠ Late  19 min   │
│████████░░░░░░░░░░│ │██████████████████│
└──────────────────┘ └──────────────────┘
```


### 8c. Back office: reports, settings, menu, staff

A top bar with the restaurant's wordmark and the signed-in person. Content left-aligned, up to 1200px wide.
Reports: the balance seal, then the filter sentence, then the filters, then sections.
Report tables use the `dense` style, with the first column fixed when the table scrolls sideways.

```
┌──────────────────────────────────────────────────────┐
│ Cafezza                                  Arya  ▾     │
├──────────────────────────────────────────────────────┤
│ Sales by Day                                         │
│ ┃ ✓ Balanced                                         │
│ ┃   All 3 checks passed                              │
│ 20 Sep to 26 Sep 2026. Business day starts 5:00 AM.  │
│ [This week ▾] [All order types ▾]   Excel   Print    │
│                                                      │
│ ▁▂▅▃▆▇█  net sales by day                            │
│                                                      │
│ Date        Bills  Covers  Net sales     Bill total  │
│ Sat 26 Sep     15      27  ₹8,886.32     ₹9,269.00   │
│ ...                                                  │
│ Total         ...                                    │
└──────────────────────────────────────────────────────┘
```

---

## 9. Components

Every one lives in `client/src/components/ui/` and reads only tokens. A raw hex in a component is a bug, as in version 1.

| Component | Job | Notes |
|---|---|---|
| `AppShell` | Rail or bottom bar, top bar, content | Chooses phone or wide layout by width, never by device type |
| `Button` | Actions | Kinds: primary in `accent`, secondary with `ink` border, quiet text-only, danger in `alert`. One primary per screen. |
| `StateChip` | Any state | Takes a state and a word. Draws tint, edge, icon and word. Replaces `StatusBadge` and the availability stamp. |
| `TimeEdge` | The time edge | Takes start time, target minutes and state |
| `TableTile` | One table on the floor | Name in `tile-name`, guests, amount in `num-tile`, state chip, time edge. The whole tile is the tap target. |
| `TicketCard` | One kitchen ticket | As in 8b |
| `BalanceSeal` | Report checks | As in 7b |
| `FilterSentence` | The report's scope in words | `caption` in `muted`, under the seal |
| `Money` | Shows paise as rupees | Plex Mono, Indian grouping, two decimals, minus sign and `alert` when negative. The only place a component formats money. |
| `NumericKeypad` | Amount and quantity entry | Kept from version 1, restyled. Display in `num-hero` on `sunken`. |
| `ReasonPicker` | Reason buttons | Kept from P04, restyled |
| `Sheet` | Editing one record | From the right on wide screens, from the bottom on phones |
| `DataTable` | Report tables | `dense` text, sticky first column, totals row with a 2px `ink` rule above it |
| `StatTile` | One headline figure | Figure in `num-hero`, label in `label`, optional comparison in `caption` |
| `EmptyState`, `ErrorState` | Nothing to show, or a failure | Say what to do next. Errors never apologise and are never vague. |
| `Bilingual` | Second-language line | As in 5d |

Icons are a small set of inline SVGs in `components/ui/icons/`, drawn at 20px on a 2px stroke: dot, plate, receipt, triangle, tick, clock, and the navigation set. No icon package.

---

## 10. Motion

Motion only answers something a person did, and only to show what changed.

1. A sheet slides in, 180ms.
2. A new kitchen ticket slides into its column, 160ms.
3. A table tile's state colour changes over 200ms when its state changes.
4. When a payment completes, the bill total settles from 104% to 100% over 160ms, and the Paid chip appears. This is the one moment of celebration in the product, because a paid bill is the moment a sale is done.

Nothing loops. Nothing moves on page load.
Under `prefers-reduced-motion`, every one of these becomes an instant change.

---

## 11. Making it theirs

### 11a. Restaurant settings, owner only

New settings group `settings.appearance`, audited like every setting:

| Field | Default | Meaning |
|---|---|---|
| `accentPreset` | `OCEAN` | One of the six presets, or `CUSTOM` |
| `accentHex` | null | Used when the preset is `CUSTOM`, validated as in 4c |
| `wordmark` | null | The name in the top bar. Null means the restaurant's name. |
| `secondLanguage` | `NONE` | `NONE`, `GUJARATI` or `HINDI`. The restaurant's default. |
| `todayTiles` | Every R1 tile in its contract order | Which tiles the Today screen shows, and in what order |
| `neutralTone` | `COOL` | `COOL` or `WARM`, section 4a. P22. |
| `brandHex` | null | The logo's background, section 4d. P22. |
| `onBrandHex` | null | Text on `brandHex`, section 4d. P22. |

The logo (P22) is not a setting: it is stored on the restaurant, outside `settings`, so an image never travels with `GET /settings` or lands in a settings audit line. Two optional slots:

| Slot | Artwork | Shown on |
|---|---|---|
| `LIGHT_GROUND` | Dark artwork on a transparent background | Day screens |
| `DARK_GROUND` | Light artwork, transparent or on its own solid background | Night screens and the sign-in brand panel |

PNG, WebP or JPEG, at most 200 KB, 128 to 1024 pixels, checked from the file's own bytes. Never SVG. Set and removed by the owner, with a reason, each one audited.

### 11b. This device, anyone

Stored in the browser, beside the printing settings from P05:

| Setting | Choices | Default |
|---|---|---|
| Theme | Automatic, Day, Night | Automatic: Day everywhere, the kitchen included |
| Density | Comfortable, Compact | Comfortable. Compact tightens spacing one step, never text size. |
| Text size | 100%, 115%, 130% | 100% |
| Second language | The restaurant's choice, or override | The restaurant's choice |

**The last restaurant (P22).** After a sign-in, this device also keeps the restaurant's look beside these settings: the logos as small `data:` URLs with their hashes, the wordmark, the accent pair, the tone and the brand pair. The sign-in screen uses them before anyone signs in, so the screen a cashier opens in the morning already looks like their restaurant, in Day. Signing out keeps them, because none of it is secret. A logo is fetched again only when the hash on `/auth/me` differs from the one kept. A device that has never seen a restaurant shows Ocean, cool, and the product's name.

### 11c. What can never be changed

State colours and their words.
The rule of one primary action.
Every contrast minimum.
The balance seal's position at the top of a report.

---

## 12. Words

Sentence case everywhere, including headings and chips: "Bill printed", not "BILL PRINTED".
No labels above content that only repeat what the content already says.
Glossary words for every number, from `docs/GLOSSARY.md`.
Error messages say what happened and what to do, in plain words, with no codes.
The availability states read "Available" and "Out of stock", exactly as before.

---

## 13. Where it lives in code

`client/src/index.css`, in Tailwind v4's `@theme` block, as CSS variables:
neutrals and states defined under `:root[data-theme="day"]` and `:root[data-theme="night"]`,
the accent as `--accent` and `--accent-night`, set on the root element at runtime from `settings.appearance`.
Tailwind classes follow the tokens by name: `bg-surface`, `text-muted`, `border-bill`, `bg-accent`.

The contrast rules from section 4c and `nightVariant`, which raises a colour's lightness in small steps until it reaches 4.5 to 1 on night `ground`, live in `server/utils/colour.js`. The server validates and computes. `client/src/utils/colour.js` is a mirror, used only to preview on the settings screen before saving.

A test fails the build if any component contains a raw hex colour, or any version 1 token class: `paper`, `steel`, `chana`, `mirch`, `patta`.

---

### 13a. Settled while building P20A

1. **Fonts.** `@fontsource-variable/anek-latin`, `anek-gujarati` and `anek-devanagari`, each through its `standard.css`, which registers both axes: weight 100 to 800 and width 75 to 125. The design's widths 82, 92, 100 and 112 sit inside that range and are used exactly as written, as `font-stretch` in the `type-*` utilities. No mapping was needed. IBM Plex Sans stays installed until P20B.
2. **Tailwind.** The neutrals and states are CSS variables on the root element, one set per `data-theme`, exposed through `@theme inline`. `inline` makes the utility read the variable itself, so `bg-surface` follows the theme at runtime. The accent is `--accent-active`, which points at `--accent` in day and `--accent-night` in night. Text on the accent is `text-on-accent`: white in day, night `ground` in night.
3. **Type scale.** Each style in 5b is a `@utility` (`type-title` to `type-num-meta`), in rem, so the device's text size scales it. Density changes two variables, `--d-gap` and `--d-pad`, and never a font size.
4. **Focus ring.** One base rule, `:focus-visible` in the accent at 2px with a 2px offset. Components do not draw their own.
5. **The second-language line on a button.** On a primary button the second line takes the button's own text colour at 80% rather than `muted`, because `muted` on the accent fails contrast. Everywhere else it reads `muted` by the same rule.
6. **A printed bill's time edge.** The floor's `GET /tables` occupancy block carries `openedAt` but no time the bill was printed, so a printed bill's edge, on its tile and in the billing strip, measures from the order's opening against `settings.floor.longOpenMinutes`, like any other taken table. Measuring against 10 minutes from printing, as 7a says, needs `billedAt` on the occupancy block: a contract change for its own prompt.
7. **State words for things that are not tables.** A bill: Unpaid is `bill`, Paid is `ok`, On Hold is `open`, Voided is `alert`. An order line: Not sent has no colour, With the kitchen is `open`, Ready is `ok`, Served is `served`, Cancelled is `alert`. Stock: In stock `ok`, Low `open`, Out `alert`. The clock: In `ok`, Out no colour.
8. **Selected, not primary.** A chosen option in a group (a payment method, a guest count, a reason) is a 2px `ink` border on `sunken`, never the accent, so the accent stays the one primary action.
9. **Where things moved.** `PanelShell` became `Sheet` (with `SheetActions` for the common footer); `ReasonPicker` moved to `components/ui/`; the two `Bilingual` copies and their label files became `features/i18n/`. `StatusBadge` and `AvailabilityStamp` were thin wrappers over `StateChip` until P20B removed them.

### 13b. Settled while building P20B

1. **Every screen is on version 2.** Version 1's tokens, IBM Plex Sans, `StatusBadge` and `AvailabilityStamp` are gone. Anek is the body font; Plex Mono stays for numbers.
2. **Guards on the whole client.** `server/tests/designGuard.test.js` fails on a raw hex colour, a version 1 token class, money formatted outside `Money`, or an import of a deleted component, anywhere in `client/src/`. One file is exempt from the hex rule: `utils/colour.js`, the mirror of the server's accent rules, which has to name the state and preset colours to measure against them and styles nothing.
3. **Money.** `Money`, `moneyText` and `compactMoneyText` (the short axis-tick form, ₹1.2L) are the only money formatters. `utils/formatMoney.js` keeps only input: typed rupees to paise, and back into a keypad.
4. **Themes on a subtree.** The day and night token sets apply to any element with `data-theme`, not only the root, so the Appearance page's preview can draw a night tile inside a day page. The A4 print stylesheet redeclares the day tokens, so a report always prints in Day.
5. **The Appearance page** is its own screen, `/settings/appearance`, opened from a section at the top of Settings, because the live preview needs the width the settings form does not have. It saves through `PATCH /settings` with a reason, like every setting. The wordmark field takes up to 24 characters; the server allows 30.
6. **Today tiles.** R1's `tiles` section follows `settings.appearance.todayTiles`: the owner's tiles in the owner's order, figures unchanged.
7. **Availability and other two-state toggles** are a `StateChip` with `onClick`: Available is `ok`, Out of stock is `alert`, through `availabilityChip`.

### 13c. Settled while building P22

1. **The warm set** lives as `NEUTRALS.WARM` in `server/utils/colour.js` and under `[data-theme][data-neutral='warm']` in `index.css`. ThemeProvider sets `data-neutral` on the root; a preview subtree sets both attributes. The print stylesheet outranks it, so paper is always cool day.
2. **One component draws a logo**, `components/ui/BrandLogo.jsx`, with the wordmark as its alt text. A test fails on an `<img>` anywhere else in the client, and on a request for the logo's bytes outside `api/brand.js`. A logo is never recoloured, filtered, inverted, cropped or stretched; `object-contain` keeps its proportions. The plate behind a logo has no padding of its own, because a logo file carries its own margin.
3. **Where the brand shows.** Sign-in: from 900px a `brand` panel about 40% wide with the logo at most 240px wide, the form on `ground` at most 400px wide, vertically centred; below 900px a 180px band and the form below it, starting at the top. Phone top bar: the logo at 32px. Wide back-office top bar: the logo at 40px. Wide service screens (floor, order, bills, kitchen): the logo in a 44px square at the top of the rail, 10px radius, and nothing in the top bar, so a screen shows the brand once. Browser tab: the wordmark as the title and the logo on its plate as the icon. Nowhere else: not tiles, tickets, sheets, reports, exports or printed receipts.
4. **No client's name in the product**, except in this repository. With no logo, every place above shows the wordmark: the restaurant's, then its name, then the product's, "Three O'Clock". From 2026-10-26 this repository is Three O'Clock's own, so the product is named after it, and a device that has never signed in shows Three O'Clock's logo, colours, Espresso accent and warm tone (`DEFAULT_BRAND` in `features/brand/brand.js`, its colours in `utils/colour.js`) instead of the blank product look. The sign-in screen, the top bar and the dashboard used to fall back to a hardcoded "Caffeza", and the sign-in screen carried Caffeza's city and a tagline; all three are gone.
5. **Spacing.** Padding, margin and gap use only 4, 8, 12, 16, 24, 32 and 48. P22 moved every other value to the nearest step: 2 to 4, 6 to 8, 10 to 12, 14 to 12, 20 to 16, 28 to 32, and 40 and 64 of vertical padding to 48. An offset that lines one thing up with another is not spacing and takes that other thing's size instead: the 28px indent under the balance seal's icon (20px icon, 8px gap), the 64px chart axis column, the 32px a table tile keeps clear for its corner menu, and the 20px at a table tile's foot, which is 16px plus its 4px time edge.
6. **Tap targets.** `Button`'s `sm` size is 48px tall like the others; it was 40. Pager buttons, the table order arrows, the recipe quantity field and the inline Void are 48px.
7. **Names.** An item name wraps to two lines on a menu tile, an order line and a bill line, then ends with an ellipsis, with the full name as the element's title. On a kitchen ticket it is smaller, beside a narrow switch, so it fits one line (P41); a name too long even then wraps, and is never cut off. A table name wraps at spaces only, never inside a word.
8. **Prices never wrap.** `Money` is `whitespace-nowrap`, and a price in a column or a repeated row is `tabular`.
9. **Loading.** `Spinner` no longer spins: it draws the screen's shape in `sunken`, still, a heading and rows. Screens that showed "Loading..." text show it too. A button that is working shows three still dots. A test fails on `animate-spin`, `animate-pulse`, `animate-ping` or `animate-bounce` anywhere in the client.
10. **Empty lists say what to do next.** Page-level lists use `EmptyState` with a next step; an empty list inside a card keeps its one quiet line and gains the next step.
11. **One title per screen.** The kitchen's "All caught up" was a second `title`; it is an `EmptyState`. The sign-in screen without a brand shows the name as a `heading`.
12. **A lazy screen loads in its shape** (P32). A back-office screen arrives in its own chunk the first time it opens. While it does, `AppShell`'s `Suspense` shows `ScreenLoading`: the frame stays where it is and the content area draws `Spinner` at `lg`, still, labelled "Opening the screen". The guest's page does the same. A fallback is never `null`, which reads as a broken screen.

### 13d. Sign in and Sign out, 2026-10-19

Rishi asked for a sign-in screen and a Sign out that were less plain. Within the rules above:

1. **The panel answers the person.** From 900px (branded) or 1024px (plain) the panel carries the time and day in India in `num-hero`, and a small floor of 12 tables, outlined in the panel's text colour. A table takes its seat, filled, for each digit or letter typed up to 10, then the password, then Sign in, over 200ms like a table tile's state (section 10, item 3). Nothing moves until a key is pressed. On a phone the brand band stays the logo alone (13c, item 3).
2. **Fields say what they have read.** Phone or email shows a phone, an @ or a person inside the field, counts a phone's digits to 10 and ticks at 10. Password has Show and Hide, and says "Caps Lock is on". `Input` gained optional `leading` and `trailing` slots for this; a field without them is unchanged.
3. **A refusal shakes once.** `refused` in `index.css`, 280ms, then still, and the cursor goes back to the password with it selected. It answers the press of Sign in, never loops, and is instant under reduced motion. It is the only motion in the product that answers a failure.
4. **Sign out is held.** `components/AccountMenu.jsx`: the initials in the accent, in the top bar, open a floating card with name, role, restaurant, This device (not for the kitchen login) and Sign out. Sign out fills in `alert-tint` while held for 0.7s; a tap says to hold. From the keyboard, or with reduced motion, it asks "Sign out now?" with Sign out and Stay. The More sheet uses the same button. After it, the sign-in screen says once, "Abhay, you are signed out. See you next shift."

## 14. How to check a screen

Before calling a screen done:

1. Look at it at 380, 768 and 1280 pixels wide.
2. Look at it in day and night.
3. Look at it at 130% text size.
4. Tab through it with the keyboard and see the focus ring on everything.
5. Find the one primary action. If there are two, fix it.
6. Find every state. Each must show its word and icon, not just a colour.
7. On a service screen, ask whether anything competes with a late time edge. If so, quiet it.
8. On a report, ask whether the balance seal is the first thing on the page.

## 15. Restaurant brand: Cafezza

Cafezza's registered trademark is a device mark, "CAFEZZA BE CAFFEINATED": the logo is the brand. Measured in P22 from the files in `docs/brand/`, with a throwaway script outside the repository:

| Name | Hex | Where | P22 measured |
|---|---|---|---|
| Logo brown | `#4A2E2A` | The logo square's background | `#4A2E2A` exactly, 83% of the pixels and all four corners. Hue 7.5 degrees, saturation 27.6%, lightness 22.7%. |
| Logo cream | `#F2D7BC` | The logo artwork | Median `#F8DDBF`, about 6 lighter per channel at the anti-aliased edges. `#F2D7BC` is kept. |
| Menu linen | about `#D6CCBE` | The menu page behind the cards | `#D3CBBD` |
| Menu card cream | about `#FFF4E8` | The menu item cards | `#FEF3E5` |
| Menu text brown | about `#543C24` | Item names and prices | `#543C24` exactly |

**Why the accent is `#49302D`, not `#4A2E2A`.** The logo brown sits at hue 7.5 degrees with 27.6% saturation. The `alert` colour is at 9.4 degrees. The brown is less than 30 degrees from it and over 25% saturated, so it fails section 4c: a primary button in it could be read as an error. `#49302D` is the same hue and lightness at 23.7% saturation. It passes through the low-saturation exception, and it is visually the logo brown. White text on it is 12.04 to 1; on cool day `ground` 10.90, on warm 9.98. Its night value is `#A6746E`, at 4.63 to 1 on cool night `ground` and 4.67 on warm. No rule was loosened to make it fit.

| Setting | Value |
|---|---|
| `accentPreset`, `accentHex` | `CUSTOM`, `#49302D` |
| `neutralTone` | `WARM` |
| `brandHex`, `onBrandHex` | `#4A2E2A`, `#F2D7BC`, at 8.87 to 1 |
| `wordmark` | `Cafezza` |
| `DARK_GROUND` logo | `docs/archive/caffeza/brand/cafezza-lockup-dark.png`, 391 by 241 |

The lockup is the square with only its plain brown margin trimmed, keeping padding of one eighth of the trimmed height on every side: 24px around 343 by 193 of artwork. Every non-brown pixel of the original is inside it, and no pixel of the padding differs from `#4A2E2A`. Nothing was scaled. The square is kept for the favicon and as the app icon. Until the owner sends a transparent version with brown artwork for light grounds, day screens show the cream logo on a brown plate.

The menu's uppercase item names, serif titles, cream cards, rounded menu cards, linen texture and photos are not copied. The menu reference image informs the look and is never shipped.
