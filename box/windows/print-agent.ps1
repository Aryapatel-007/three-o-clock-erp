# Cafe POS: keeps the till open on the cafe PC. 2026-10-22, at Rishi's word: a
# captain's one tap prints the bill, with nobody at the counter.
#
# Run hidden (print-agent.vbs) by the "CafePOS Printer" task when anyone signs in to
# Windows, and again every minute. If the till is not open and the server answers,
# it opens the till (start-till.ps1) with --kiosk-printing. The till prints every
# captain's bill on this PC's default printer (the Rugtek) with no dialog: on this
# PC every device has "Print bills sent by captains" on (useDeviceSettings.js).
# Staff sign in once in the till; it remembers them.
# Written in plain ASCII for Windows PowerShell 5.1.

$ErrorActionPreference = 'SilentlyContinue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'start-till.ps1')

$port = 80
$line = Select-String -Path (Join-Path $Root '.env') -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
$portPart = if ($port -eq 80) { '' } else { ":$port" }
# The page is opened at localhost, where staff sign in; the check asks 127.0.0.1, since
# Windows tries localhost as IPv6 first and the server listens on IPv4 only.
$page = "http://localhost$portPart/"
$probe = "http://127.0.0.1$portPart/api/v1/network/ping"

# Already open: nothing to do.
if (Test-TillOpen) { exit 0 }

# The server not answering yet (the PC just started): the next minute tries again.
try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $probe).StatusCode -eq 200 } catch { $up = $false }
if (-not $up) { exit 0 }

if (-not (Open-Till $page)) { exit 1 }
