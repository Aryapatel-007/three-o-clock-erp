# Cafe POS: keeps the print window open on the cafe PC. 2026-10-22, at Rishi's word:
# a captain's one tap prints the bill, with nobody at the counter.
#
# Run hidden (print-agent.vbs) by the "CafePOS Printer" task when anyone signs in to
# Windows, and again every minute. If the print window is not open and the server
# answers, it opens http://localhost/print-station in its own browser profile with
# --kiosk-printing, so every captain's bill prints on this PC's default printer (the
# Rugtek) with no dialog. Staff sign in once in that window; it remembers them.
# Written in plain ASCII for Windows PowerShell 5.1.

$ErrorActionPreference = 'SilentlyContinue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ProfileDir = Join-Path $env:LOCALAPPDATA 'Cafe POS Printer'

$port = 80
$line = Select-String -Path (Join-Path $Root '.env') -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
$portPart = if ($port -eq 80) { '' } else { ":$port" }
# The page is opened at localhost, where staff sign in; the check asks 127.0.0.1, since
# Windows tries localhost as IPv6 first and the server listens on IPv4 only.
$page = "http://localhost$portPart/print-station"
$probe = "http://127.0.0.1$portPart/api/v1/network/ping"

# Already open: nothing to do.
$open = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -like "*$ProfileDir*" }
if ($open) { exit 0 }

# The server not answering yet (the PC just started): the next minute tries again.
try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $probe).StatusCode -eq 200 } catch { $up = $false }
if (-not $up) { exit 0 }

$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { exit 1 }

Start-Process -FilePath $browser -ArgumentList @(
  "--user-data-dir=`"$ProfileDir`"",
  '--kiosk-printing',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  "--app=$page"
)
# Not minimized: a minimized window may hold back its printing. The flags above keep
# it printing while the till or anything else covers it.
