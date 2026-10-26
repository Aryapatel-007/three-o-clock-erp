# Dakaar: opens the till on this PC, printing with no dialog. 2026-10-22.
# Dot-sourced by open.ps1 (the "Dakaar" desktop icon) and print-agent.ps1 (the
# "Dakaar Printer" task at Windows sign-in), so both open the same till: one
# browser profile, one sign-in, one set of This device settings. The till prints
# its own bills and the bills captains send to the counter, on the default printer.
# Written in plain ASCII for Windows PowerShell 5.1.

$TillProfile = Join-Path $env:LOCALAPPDATA 'Dakaar Till'

function Get-TillBrowser {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Test-TillOpen {
  [bool](Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -like "*$TillProfile*" })
}

# Opens the till at $Url. With the till already open, Chrome brings it a new tab
# in the same window, which keeps printing with no dialog.
# -App: a window of its own with no address bar, as the hidden printer window (print-agent.ps1).
function Open-Till([string]$Url, [switch]$App) {
  $browser = Get-TillBrowser
  if (-not $browser) { return $false }
  Start-Process -FilePath $browser -ArgumentList @(
    "--user-data-dir=`"$TillProfile`"",
    '--kiosk-printing',
    '--no-first-run',
    '--no-default-browser-check',
    # Captains' bills print while the window is covered, minimized or hidden.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    $(if ($App) { "--app=$Url" } else { $Url })
  )
  return $true
}
