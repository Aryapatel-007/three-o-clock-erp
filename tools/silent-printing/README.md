# Printing bills with no dialog

A web page cannot print without asking: Chrome shows its print dialog every
time, and no code in the app can turn that off. Chrome itself can, when it is
started with `--kiosk-printing`. Then every print goes straight to the
computer's default printer, at the page size the bill sets, with no dialog.

These two files start the till that way, in a Chrome window of its own:

| Computer | File |
|---|---|
| Mac | `Open the till (Mac).command` |
| Windows | `Open the till (Windows).cmd` |

The till window uses its own Chrome profile (`Dakaar Website Till`). So:

- Silent printing applies only to the till window. Everyday Chrome, with its
  own tabs and printing, is untouched and can stay open beside it.
- That profile never remembers "Save as PDF" as its printer, which is what an
  everyday Chrome often does.
- Staff sign in once in the till window. It remembers them like any Chrome.

## Setting up the counter computer, once

1. Make the bill printer the computer's **default printer**.
   - Mac: System Settings, Printers & Scanners, Default printer: the Rugtek.
   - Windows: Settings, Printers & scanners, the printer, Set as default. Turn
     off "Let Windows manage my default printer" first.
2. Set the printer's paper to the 80 mm roll in its own settings, never A4.
   `docs/DEPLOYMENT.md` section 10 has the details for each system.
3. Copy the file for this computer to the desktop. On a Mac, the first time,
   right-click it and choose Open, because it was not downloaded from the App
   Store. After that a double-click is enough.
4. Open the till with that file, sign in, and on **This device** choose the
   printer (Thermal, 80 mm) and the print width.
5. Print one bill. It should come out of the Rugtek with no dialog.

From then on, staff open the till only with that file. If Chrome shows the
print dialog again, the till was opened some other way: close that window and
use the file.

## Captains' bills at the counter

On the cafe PC, open the till with the PC's own desktop icon, **Dakaar -
Till (prints without asking)**. `Open the till (Windows).cmd` run on the cafe PC
opens the PC too; anywhere else it opens the website, where captains' bills
sent to the PC never arrive.


A captain's phone cannot reach the Rugtek. A captain taps **Print at counter**,
and the counter computer prints it, when **Print bills sent by captains** is on
in This device there. With the till opened by the file above, that print comes
out with no dialog and nobody at the counter has to touch anything.

## If something goes wrong

- **The bill prints on the wrong printer:** the default printer is wrong. Fix
  step 1 and print again.
- **The bill prints tiny, or on a whole sheet:** the printer's paper is A4.
  Fix step 2. If it still does, set Paper length to "The printer's roll" on
  This device.
- **Chrome says the profile is in use:** a till window is already open. Use
  that one.
