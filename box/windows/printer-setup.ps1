# Three O'Clock: set up printing for the till or the print window, once. 2026-10-22.
#
# Both windows print with no dialog (--kiosk-printing), each in its own browser
# profile. Chrome keeps its print settings (paper size, margins, scale) per
# profile and uses them for every silent print, so a new profile prints with
# Chrome's defaults: the bill cut short or shifted. This opens the chosen
# profile once WITH the print dialog, at This device, so a person can set the
# bill's paper there and print one bill through the dialog with the right
# paper size, margins and scale. Chrome remembers those choices for the
# silent prints afterwards. Written in plain ASCII for Windows PowerShell 5.1.

param([ValidateSet('Printer', 'Till')][string]$Window = 'Printer')

$ErrorActionPreference = 'SilentlyContinue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ProfileDir = if ($Window -eq 'Till') { Join-Path $env:LOCALAPPDATA 'ThreeOClock Till' } else { Join-Path $env:LOCALAPPDATA 'ThreeOClock Printer' }

$port = 80
$line = Select-String -Path (Join-Path $Root '.env') -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
$portPart = if ($port -eq 80) { '' } else { ":$port" }
$page = "http://localhost$portPart/device"

# A window already open in this profile keeps its no-dialog flag, so close it first.
# The "ThreeOClock Printer" task opens the print window again within a minute of this one closing.
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -like "*$ProfileDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Write-Host 'Chrome or Edge was not found.'; exit 1 }

Write-Host ''
Write-Host "Opening the $Window window's settings, with the print dialog on."
Write-Host '1. Sign in if asked. On This device set Printer, Print width, Paper length,'
Write-Host '   Bill text size and Edge margin exactly as on the website counter.'
Write-Host '2. Open Bills, open any bill and press Print bill. In the print dialog choose'
Write-Host '   the Rugtek, then More settings: Paper size, Margins and Scale as on the'
Write-Host '   website counter. Print.'
Write-Host '3. Close the window. Chrome keeps these choices for the silent prints.'
Write-Host ''
Start-Process -FilePath $browser -ArgumentList @(
  "--user-data-dir=`"$ProfileDir`"",
  '--no-first-run',
  '--no-default-browser-check',
  $page
)
