#!/usr/bin/env bash
# The box's health in one screen. P62. Reads only; changes nothing.
#
#   bash box/check-box.sh
#
# For the manager or whoever is called at 9pm: every line says OK or what is wrong.
set -uo pipefail

ok() { printf '  OK    %s\n' "$1"; }
bad() { printf '  FIX   %s\n' "$1"; }

echo "Cafe server check, $(date)"

systemctl is-active --quiet mongod && ok "MongoDB is running" || bad "MongoDB is not running: sudo systemctl start mongod"
systemctl is-active --quiet cafe-pos && ok "The POS server is running" || bad "The POS server is not running: sudo systemctl restart cafe-pos"
systemctl is-active --quiet cafe-snapshot.timer && ok "Hourly snapshots are scheduled" || bad "Snapshots are not scheduled: sudo systemctl enable --now cafe-snapshot.timer"

if curl -fsS --max-time 3 http://127.0.0.1/api/v1/network/ping >/dev/null; then ok "The server answers"; else bad "The server does not answer on port 80"; fi

if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
  ok "The clock is set over the internet (NTP)"
else
  bad "The clock has not been checked against the internet yet. Fine while offline; check the time looks right: $(date)"
fi

if command -v nmcli >/dev/null; then
  wifi="$(nmcli -t -f ACTIVE,SSID,SIGNAL dev wifi 2>/dev/null | awk -F: '$1=="yes"{print $2" ("$3"%)"}')"
  wired="$(nmcli -t -f TYPE,STATE device 2>/dev/null | awk -F: '$1=="ethernet" && $2=="connected"' | wc -l)"
  [[ -n "$wifi" ]] && ok "On WiFi: $wifi"
  [[ "$wired" -gt 0 ]] && ok "On a cable"
  [[ -z "$wifi" && "$wired" -eq 0 ]] && bad "Not on any network: check the router and the cable"
fi

echo "Addresses staff can open:"
hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.' | sed 's#^#    http://#'
echo "    http://$(hostname).local"

df -h /var/lib/mongodb /var/lib/cafe-pos 2>/dev/null | awk 'NR==1 || /\//'
