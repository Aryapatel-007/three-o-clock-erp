# Three O'Clock Profile

This file is the setup of our client, Three O'Clock Cafe, Gandhinagar.
It was read on 16 October 2026 from public sources only:

- the cafe's own site, threeoclockgandhinagar.com (address, phone, hours, payment methods, logo);
- the four menu cards on its Zomato and District listings (every item and price);
- the photos on those listings.

On 18 October 2026 the menu was read again from the cafe's own site,
threeoclockgandhinagar.com/menu (a 12-page PDF). That menu is newer than the
Zomato cards, and replaces them: see section 7.

Nothing here has been confirmed by the owner yet. `TO CONFIRM` means we have
not seen the answer. Build with the stated default, and make the value a setting
so the answer can change without code. Nothing in the code names Three O'Clock:
its details live only here, in `setup/threeoclock.json`,
`setup/threeoclock-menu.csv`, `setup/threeoclock-addons.csv`, and its own
records in the database.

Section 10 lists every open item in one place.

This repository was copied from Z Chaat's on 16 October 2026. Z Chaat's profile
is archived in `docs/archive/zchaat/PROFILE.md`.

The menu cards and photos as downloaded are kept on the developer's computer in
`docs/clients/threeoclock/source/`, which git ignores: most of the photos were
posted on Zomato and are not ours to publish.

---

## 1. The business

| Field | Value | Where it lives in our system |
|---|---|---|
| Name | "Three O'Clock Cafe". The site writes "Three O'Clock Café"; the bill uses no accent until they say otherwise. | `restaurants.name` |
| Name on the menu | "Three O'Clock" | `settings.appearance.wordmark` |
| What it is | An outlet of Three O'Clock, the Vietnamese coffee chain, opened with Franchise India. Vietnamese phin coffee, milk and fruit teas, bánh mì, bakes and desserts. Live music nights. | |
| Line under the name | "Vietnamese Coffee & Cafe", our wording. `TO CONFIRM`. | `settings.receipt.headerLine2` |
| Footer | "Thank you! Open till 3 AM.", our wording. `TO CONFIRM`. | `settings.receipt.footerText` |
| Address | 226/2, Koba, near Khodiyar Pan Parlour, PDPU Road, Raysan, Gandhinagar, Gujarat | `restaurants.address` |
| Pincode | `TO CONFIRM`. The site and the menu say 382700, which does not look like a Gandhinagar pincode; Raysan is usually 382007. | `restaurants.address.pincode` |
| Phone | +91 98989 47333, from the site and District | `restaurants.phone` |
| Instagram | @threeoclock_gandhinagar | |
| Legal name | `TO CONFIRM`: the franchisee's company | `restaurants.legalName` |
| GSTIN | `TO CONFIRM`. It must print on every bill. | `restaurants.gstin` |
| FSSAI licence number | `TO CONFIRM`. It must print on every bill. | `restaurants.fssaiLicenseNumber` |
| Logo | From the site: a black badge, a teapot with a clock, and "THREE O'CLOCK" under it. `docs/clients/threeoclock/brand/`: the original for light grounds, and the same badge in white for dark grounds. It is 200 by 169 pixels; `TO CONFIRM` a larger PNG from the owner. | `restaurants.brandLogos` |

## 2. Size and hours

| Fact | Value |
|---|---|
| Days open | Seven days a week |
| Hours | 4:00 PM to 3:00 AM, from the cafe's site. District says 8:00 AM to 3:00 AM and EazyDiner 11:00 AM. `TO CONFIRM`. |
| Business day starts | 5:00 AM, the default, so a night that runs past midnight to 3 AM is one business day. `settings.businessDayStartsAtMinutes` 300. |
| Size | About 1,500 sq ft, with an outdoor terrace under umbrellas (the listing photos) |
| Outlets | One in Gandhinagar. The chain has others in India; each would be its own restaurant here. |

## 3. Tax

| Fact | Value |
|---|---|
| Prices | Exclusive of tax: every card says "local taxes extra". GST is added on top. |
| Rate | 5% on every item, split CGST 2.5% and SGST 2.5%, the usual rate for a standalone cafe. `TO CONFIRM` with their CA. |
| Packaging | The cards say "additional packaging charges for takeaway". `TO CONFIRM` the amount, then set it as a charge. |
| Platform delivery orders | 0% on our bill, the platform paying GST under section 9(5): `settings.delivery.platformCollectsGst` on. `TO CONFIRM`. |

## 4. Invoice numbers

`TO CONFIRM`: their prefix and the starting number. Set by hand on cutover day,
as `docs/GO-LIVE.md` says, through Settings, never by a script.

## 5. Order types

Dine in and takeaway. Hot tea is served for dine-in only (the hot beverages
card); the item descriptions say so. Delivery platforms: `TO CONFIRM`. The site
links Swiggy Dineout, and the cafe is listed on Zomato and District.

## 6. Floor

Not seen yet. `setup/threeoclock.json` starts with a guess from the listing
photos, which show an indoor hall of four-seat tables and an outdoor terrace:

| Section | Tables | Seats |
|---|---|---|
| Indoor | Table 1 to Table 10 | 4 |
| Outdoor | Outdoor 1 to Outdoor 8 | 4 |

`TO CONFIRM`: how many tables each side really has, their names, and seats.
Change the file and run the setup again; a table never used can be deleted in
Table setup, and each is placed on the plan in More, Table setup, Arrange tables.

## 7. Menu

`setup/threeoclock-menu.csv`: 139 items in 33 categories, every one vegetarian,
read on 18 October 2026 from the menu on the cafe's own site
(threeoclockgandhinagar.com/menu, the PDF behind it). It replaced the
16 October file read from the Zomato and District cards, which was older:

- Most prices are higher, by ₹10 to ₹40 (Hot Latte ₹220 to ₹230, Caesar Salad
  ₹350 to ₹370, White Sauce Pasta ₹360 to ₹395).
- New on the site: Wraps, Hunger Pack Meals (rice), Blueberry Cheesecake, the
  Signature Collection (12 drinks at ₹350), and the Specials page: Neapolitan
  Pizza, Chef Specials, Shakes, Refreshers, Cold Brew, Cakes & Bakes.
- Gone from the site: Vietnamese Cheesecake, Blueberry Muffin, Double
  Chocolate Muffin. They are not in the file.
- The iced "Classic Iced Coffee" is "Black Classic Coffee" on the site.
- "Fresh & Fit Salads" and "Signature Pastas" are "Salads" and "Pastas".

How the file is written:

- **Sizes.** Cold drinks come in Small 354ml, Medium 473ml and Large 650ml.
  An item sold in more than one size has them as sizes; an item sold in one
  size names it in its description.
- **Hot and iced.** The menu sells some drinks both hot and iced under the same
  name, like Americano. A name is unique here, so those carry "Hot" or "Iced".
- **Notes.** "Contains milk", "contains nuts", "contains oats", "contains
  mushroom" and "best-seller" from the menu's marks are in the descriptions,
  with the weight and a short form of the menu's own description. The calories
  are not.
- **Toppings.** `setup/threeoclock-addons.csv` puts the menu's Topping / Add On
  box on every iced drink on the two cold beverages pages: Extra Espresso,
  Black Pearl, Grass Jelly ₹60; Vanilla, Caramel or Hazelnut Syrup ₹60; Oat
  Milk, Almond Milk ₹70; Cheese Foam ₹90. The menu joins the milks and the
  syrups on one line each; they are split here so the bar sees which.
  `TO CONFIRM` which drinks really take which topping.
- **Names changed from the menu.** "Veggies Fingers" is Veggie Fingers; the
  three Hot Pizzas have "Pizza" added; the Refreshers' "Black Currant" is
  "Black Currant Refresher", so a bill never confuses it with the shake or the
  cheese foam tea.
- **Thin entries.** The Specials page gives only a name and a price for Chef
  Specials, Shakes, Refreshers, Cold Brew and Cakes & Bakes, so those have no
  description. The Tofu Sandwich's description on the menu is a copy of the
  mushroom croissant's, so it has only its weight.
- The menu says "Jain options are also available": that is a note to the
  kitchen on the line, not a dish.

## 8. Kitchen stations

| Station | Categories |
|---|---|
| Coffee Bar | Every hot and iced drink, the Signature Collection, Shakes, Refreshers, Cold Brew |
| Bakery Counter | Freshly Baked, Tea Cakes, Delicate Desserts, Puffs & Pies, Cakes & Bakes (from the display counter) |
| Kitchen | Everything else: sandwiches, toasts, salads, pastas, both pizza menus, fries, nachos, appetisers, Chef Specials, wraps, Hunger Pack Meals |

No station prints tickets until the owner says which have printers.

## 9. Payment methods and the look

- Cash, card and UPI, the ones the site lists. Tally ledger codes and any
  platform methods (Swiggy Dineout, District, Zomato) are `TO CONFIRM`.
- The look: the logo's black (#1A1A1A) with the menu's gold (#E2C08D) on it as
  the brand pair, and the Espresso accent. The menu's own gold, #AE7D42, is
  refused as an accent: white text on it is too faint, and darker shades come too
  close to the Open state.
- Second language off: the menu is in English. `TO CONFIRM` whether the staff
  want Gujarati.

## 10. Open items

1. Legal name, GSTIN and FSSAI number.
2. The pincode.
3. Hours, and whether the business day should start at 5:00 AM.
4. GST rate with their CA, and platform orders under section 9(5).
5. The packaging charge for takeaway.
6. Invoice prefix and starting number, on cutover day.
7. Tables: how many, names, seats, sections.
8. Which toppings go on which drinks, and what is in the Specials page's dishes that have no description.
9. Staff: names, phones and roles. No login is made without a phone.
10. Delivery and dine-out platforms, their commissions, and Tally ledger codes.
11. Receipt header and footer lines.
12. A larger logo PNG.
13. Which stations have a printer.
