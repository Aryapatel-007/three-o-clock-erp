#!/bin/bash
# Opens the till in its own Chrome window that prints with no dialog.
# Double-click this file on the counter Mac. Your everyday Chrome is left alone:
# the till runs in a separate Chrome profile, so silent printing only applies
# there, and that profile never remembers "Save as PDF" as its printer.
#
# Before the first use: make the bill printer (the Rugtek) the Mac's default,
# in System Settings, Printers & Scanners, Default printer.

TILL_ADDRESS="https://zchaat-pos.vercel.app"
PROFILE="$HOME/Library/Application Support/Restaurant ERP Till"

open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE" \
  --kiosk-printing \
  --no-first-run \
  --no-default-browser-check \
  "$TILL_ADDRESS"
