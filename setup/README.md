# Setting up a restaurant

Two scripts set a restaurant up from files, through the real API, signed in as
the owner. They are how staging is set up for training and how production is
set up on cutover day, the same way both times.

Both change nothing unless you add `--apply`. Both are safe to run again: they
match what already exists by name and only create or update what differs.
Neither ever deletes or switches anything off, creates an order or a bill, or
sets the invoice series.

You are asked for the owner's password at the terminal, with the characters
hidden. It is never read from a file or a flag.

## Order

1. Provision the restaurant and its owner: `npm run provision:restaurant`.
2. Set it up, dry run first:

   ```
   npm run setup:restaurant -- --config setup/zchaat.json --owner-phone 98xxxxxxxx
   npm run setup:restaurant -- --config setup/zchaat.json --owner-phone 98xxxxxxxx --apply
   ```

   New staff logins get a generated password, printed once at the end. Hand
   each one over privately. An existing user's password is never touched.

3. Import the menu, dry run first. `--config` routes each category to its
   kitchen station; `--addons` is optional.

   ```
   npm run import:menu -- --file setup/zchaat-menu.csv --config setup/zchaat.json --owner-phone 98xxxxxxxx
   npm run import:menu -- --file setup/zchaat-menu.csv --config setup/zchaat.json --owner-phone 98xxxxxxxx --apply
   ```

4. Read every line of each plan before adding `--apply`.

Paths are relative to the folder you run `npm` from.

## The setup file, `zchaat.json`

| Key | What it sets |
|---|---|
| `restaurant` | Name, legal name, GSTIN, FSSAI number, address, contact phone |
| `settings` | `businessDayStartsAtMinutes`, and the `features`, `receipt`, `delivery`, `discounts` and `dayClose` groups |
| `stations` | Kitchen stations, by name |
| `categoryStations`, `defaultStation` | Which station each category's tickets go to. A category not listed goes to the default. |
| `tables` | One `section`, the table `names`, and `seats` for each |
| `paymentMethods` | Matched by `code`. A method's code and kind never change. |
| `accounts` | On Hold accounts. The opening balance is set once, when the account is created. |
| `staff` | Name, phone, role, and `station` for a `KITCHEN` login |

Any value written as `"TO CONFIRM"` is skipped, listed in the summary, and never
sent. A staff member whose phone is `"TO CONFIRM"` is not created, because a
login needs a phone. A file containing `settings.invoice` is refused: the
invoice series is set by hand on cutover day (`docs/GO-LIVE.md` section 4).

The whole file is checked with the server's own validation before anything
changes, and every problem is listed at once.

## The menu file, `zchaat-menu.csv`

```
category,item,size,price,gst_percent,available,description
Chaat Darbar,Sev Poori Chaat,,265.00,5,yes,"Flat puris with potato, onion, tamarind and green chutney and sev. 200gm"
Breads,Tandoori Roti,Plain,69.00,5,yes,
Breads,Tandoori Roti,Butter,69.00,5,yes,
```

- One row per item, or per size of an item that comes in sizes. Rows with the
  same category and item and a size become one item with sizes; the item's own
  price is its first size's.
- Prices are rupees before tax, with up to two decimals.
- `gst_percent` is 0, 5, 12, 18 or 28.
- `available` is yes or no.
- `description` is optional, up to 500 characters. A file with only the first
  six columns still works, and then leaves existing descriptions alone. With
  the column, an empty cell means no description, and an item with sizes takes
  the first description among its rows. A description with a comma or a quote
  goes in double quotes, with a quote inside written twice: `"Says ""hi"", once"`.
- Categories are made in the order they first appear. Items keep their file
  order.
- A name containing a comma goes in double quotes.
- Lines starting with `#` are comments.
- If any row has a problem, every problem is listed with its line number and
  nothing is written.
- Re-running updates an item's price, GST, sizes, availability and, with the
  column, description to match the file. Items on the menu but not in the file are listed and left alone.

The add-ons file, passed with `--addons`:

```
item,addon,price,available
Caffe Latte,Extra Shot,40.00,yes
```

`zchaat-menu.csv` is Z Chaat's menu, read from their printed menu and table
cards on 8 October 2026. Check every TO CONFIRM item in
`docs/clients/zchaat/PROFILE.md` before cutover.

Cafezza's files, the first client's, are kept in `setup/archive/caffeza/`.
