# Three O'Clock: see and copy Chrome's print settings. 2026-10-22.
#
# Chrome keeps its print settings (printer, paper size, margins, scale) per
# browser profile, in the profile's Preferences file, and prints silently
# (--kiosk-printing) with exactly those. The website counter's till, the PC's
# till and the PC's print window are three different profiles, so the same bill
# can print three different ways. This script:
#   1. lists every Chrome and Edge profile on this PC with the settings it prints
#      with, and the bill printer's own default, and saves that list on the Desktop;
#   2. copies one profile's settings (the one that prints the bill right) into
#      both Three O'Clock windows;
#   3. clears saved settings whose paper is longer than Chrome can print
#      (like 80(72.1) x 99999 mm, which makes "Print preview failed");
#   4. resets the bill printer to its driver's factory settings, by removing it
#      and adding it again on the same driver and port, as Administrator.
# A copy of each Preferences file it changes is kept beside it as Preferences.bak.
# Written in plain ASCII for Windows PowerShell 5.1.

#   5. -AutoCopy (the installer, 2026-10-22): copies, with no questions, the settings of
#      the profile that prints on the bill printer with a sane paper (everyday Chrome
#      first) into both Three O'Clock windows, so the till prints as that Chrome does.
param([switch]$ReportOnly, [string]$ResetPrinter, [switch]$AutoCopy)

$ErrorActionPreference = 'Stop'

# Run as Administrator by the R choice below, in a window of its own.
if ($ResetPrinter) {
  try {
    $printer = Get-Printer -Name $ResetPrinter
    $wasDefault = (Get-CimInstance Win32_Printer -Filter "Name = '$($ResetPrinter.Replace("'", "''"))'").Default
    Write-Host "Resetting '$ResetPrinter' (driver $($printer.DriverName), port $($printer.PortName))."
    Get-PrintJob -PrinterName $ResetPrinter -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue
    Remove-Printer -Name $ResetPrinter
    Add-Printer -Name $ResetPrinter -DriverName $printer.DriverName -PortName $printer.PortName
    if ($wasDefault) { Get-CimInstance Win32_Printer -Filter "Name = '$($ResetPrinter.Replace("'", "''"))'" | Invoke-CimMethod -MethodName SetDefaultPrinter | Out-Null }
    Restart-Service -Name Spooler -Force
    Write-Host 'Done: the printer is back on its factory settings.' -ForegroundColor Green
  } catch {
    Write-Host "Could not reset the printer: $($_.Exception.Message)" -ForegroundColor Red
    if ($printer) { Write-Host "To add it back by hand: Add-Printer -Name '$ResetPrinter' -DriverName '$($printer.DriverName)' -PortName '$($printer.PortName)'" }
  }
  Read-Host 'Press Enter to close'
  exit 0
}
$Local = $env:LOCALAPPDATA
# Chrome cannot draw a page longer than this (a PDF page is at most 200 inches).
$LongestMm = 5000
$StickyPattern = '"print_preview_sticky_settings":\{[^{}]*?"appState":"((?:[^"\\]|\\.)*)"[^{}]*\}'
$Targets = @(
  @{ Label = 'Three O''Clock - Till (this PC)'; Dir = Join-Path $Local 'ThreeOClock Till' },
  @{ Label = 'Three O''Clock printer window (captains'' bills)'; Dir = Join-Path $Local 'ThreeOClock Printer' }
)

function Read-Sticky($file) {
  if (-not (Test-Path $file)) { return $null }
  $match = [regex]::Match([IO.File]::ReadAllText($file), $StickyPattern)
  if (-not $match.Success) { return $null }
  $raw = $match.Groups[1].Value
  try { $state = [regex]::Unescape($raw) | ConvertFrom-Json } catch { return @{ Raw = $raw; Text = '(could not be read)'; Broken = $false } }
  $destination = @($state.recentDestinations)[0]
  $printer = if ($destination) { if ($destination.displayName) { $destination.displayName } else { $destination.id } } else { '(default printer)' }
  $paper = '(printer default)'
  $broken = $false
  if ($state.mediaSize) {
    $widthMm = [math]::Round($state.mediaSize.width_microns / 1000, 1)
    $heightMm = [math]::Round($state.mediaSize.height_microns / 1000, 1)
    $name = if ($state.mediaSize.custom_display_name) { $state.mediaSize.custom_display_name } else { $state.mediaSize.name }
    $paper = "$name ($widthMm x $heightMm mm)"
    $broken = $heightMm -gt $LongestMm
    if ($heightMm -eq 0) { $paper = '(printer default)' }
  }
  $margins = @{ 0 = 'Default'; 1 = 'None'; 2 = 'Minimum'; 3 = 'Custom' }[[int]$state.marginsType]
  $scale = switch ([int]$state.scalingType) { 1 { 'Fit to page' } 2 { 'Fit to printable area' } 3 { "Custom $($state.scaling)%" } default { 'Default' } }
  return @{
    Raw = $raw
    Broken = $broken
    Text = "printer: $printer | paper: $paper | margins: $margins | scale: $scale | headers and footers: $([bool]$state.isHeaderFooterEnabled)"
  }
}

function Stop-Profile($profile) {
  Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" | Where-Object {
    if ($profile.Everyday) { $_.Name -eq $profile.Exe -and $_.CommandLine -notlike '*--user-data-dir*' } else { $_.CommandLine -like "*$($profile.Dir)*" }
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Backup($file) {
  if ((Test-Path $file) -and -not (Test-Path "$file.bak")) { Copy-Item $file "$file.bak" }
}

function Write-Sticky($file, $raw) {
  $entry = '"print_preview_sticky_settings":{"appState":"' + $raw + '"}'
  if (-not (Test-Path $file)) {
    New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
    [IO.File]::WriteAllText($file, '{"printing":{' + $entry + '}}')
    return
  }
  Backup $file
  $text = [IO.File]::ReadAllText($file)
  $match = [regex]::Match($text, $StickyPattern)
  if ($match.Success) {
    $text = $text.Substring(0, $match.Index) + $entry + $text.Substring($match.Index + $match.Length)
  } elseif ($text.Contains('"printing":{')) {
    $at = $text.IndexOf('"printing":{') + '"printing":{'.Length
    $text = $text.Substring(0, $at) + $entry + ',' + $text.Substring($at)
  } else {
    $at = $text.IndexOf('{') + 1
    $text = $text.Substring(0, $at) + '"printing":{' + $entry + '},' + $text.Substring($at)
  }
  [IO.File]::WriteAllText($file, $text)
}

function Clear-Sticky($file) {
  Backup $file
  $text = [IO.File]::ReadAllText($file)
  [IO.File]::WriteAllText($file, [regex]::Replace($text, $StickyPattern, '"print_preview_sticky_settings":{}'))
}

# Every profile on this PC that can hold print settings.
$profiles = New-Object System.Collections.ArrayList
foreach ($browser in @(
    @{ Name = 'Chrome'; Exe = 'chrome.exe'; Data = Join-Path $Local 'Google\Chrome\User Data' },
    @{ Name = 'Edge'; Exe = 'msedge.exe'; Data = Join-Path $Local 'Microsoft\Edge\User Data' })) {
  if (-not (Test-Path $browser.Data)) { continue }
  Get-ChildItem $browser.Data -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'Preferences') } | ForEach-Object {
    [void]$profiles.Add(@{ Label = "Everyday $($browser.Name), profile $($_.Name)"; File = Join-Path $_.FullName 'Preferences'; Everyday = $true; Exe = $browser.Exe })
  }
}
[void]$profiles.Add(@{ Label = 'Website till launcher (ThreeOClock Website Till)'; Dir = Join-Path $Local 'ThreeOClock Website Till'; File = Join-Path $Local 'ThreeOClock Website Till\Default\Preferences' })
foreach ($target in $Targets) {
  [void]$profiles.Add(@{ Label = $target.Label; Dir = $target.Dir; File = Join-Path $target.Dir 'Default\Preferences'; Target = $true })
}

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("Print settings on $env:COMPUTERNAME, $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
$default = Get-CimInstance Win32_Printer -Filter 'Default = TRUE' -ErrorAction SilentlyContinue
[void]$lines.Add("Default printer: $(if ($default) { $default.Name } else { '(none)' })")
Get-Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*POS*' -or $_.Name -like '*80*' -or ($default -and $_.Name -eq $default.Name) } | ForEach-Object {
  $config = Get-PrintConfiguration -PrinterName $_.Name -ErrorAction SilentlyContinue
  [void]$lines.Add("Printer '$($_.Name)': driver $($_.DriverName), default paper $(if ($config) { $config.PaperSize } else { 'unknown' })")
}
[void]$lines.Add('')
for ($index = 0; $index -lt $profiles.Count; $index++) {
  $profile = $profiles[$index]
  $sticky = Read-Sticky $profile.File
  $profile.Sticky = $sticky
  $state = if (-not (Test-Path $profile.File)) { 'not on this PC yet' } elseif ($sticky) { $sticky.Text } else { 'nothing saved: prints with the printer''s default paper' }
  $flag = if ($sticky -and $sticky.Broken) { '   <-- BROKEN: paper too long, Chrome cannot print it' } else { '' }
  [void]$lines.Add("[$($index + 1)] $($profile.Label)")
  [void]$lines.Add("    $state$flag")
}

if ($AutoCopy) {
  # A profile that prints on the default printer (the Rugtek), with a paper Chrome can print.
  $printerName = if ($default) { $default.Name } else { 'POS' }
  $source = $profiles | Where-Object {
    -not $_.Target -and $_.Sticky -and -not $_.Sticky.Broken -and ($_.Sticky.Text -like "*printer: $printerName*" -or $_.Sticky.Text -like '*printer: POS*')
  } | Sort-Object { if ($_.Everyday -and $_.Label -like '*Chrome*Default*') { 0 } elseif ($_.Everyday) { 1 } else { 2 } } | Select-Object -First 1
  if (-not $source) { Write-Host 'No browser on this PC has bill printer settings to copy; the till keeps its own.'; exit 0 }
  foreach ($target in ($profiles | Where-Object { $_.Target })) {
    Stop-Profile $target
    Write-Sticky $target.File $source.Sticky.Raw
  }
  Write-Host "The till prints as $($source.Label) does: $($source.Sticky.Text)" -ForegroundColor Green
  exit 0
}

$report = Join-Path ([Environment]::GetFolderPath('Desktop')) 'print-settings-report.txt'
$lines | Set-Content -Path $report -Encoding ASCII
Write-Host ''
$lines | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host "Saved to $report"
if ($ReportOnly) { exit 0 }

Write-Host ''
Write-Host 'What now?'
Write-Host '  F        fix printing: clear every BROKEN setting above, then reset the bill'
Write-Host '           printer to its factory settings (Chrome closes; Windows asks for permission)'
Write-Host '  C        only clear every BROKEN setting above (Chrome closes while it is done)'
Write-Host '  R        only reset the bill printer to its factory settings'
Write-Host '  a number copy that profile''s settings into both Three O''Clock windows'
Write-Host '           (choose the one the website counter prints correctly with)'
Write-Host '  Enter    do nothing'
$answer = (Read-Host 'Your choice').Trim()

if ($answer -ieq 'C' -or $answer -ieq 'F') {
  $cleared = 0
  foreach ($profile in $profiles) {
    if ($profile.Sticky -and $profile.Sticky.Broken) {
      Stop-Profile $profile
      Clear-Sticky $profile.File
      $cleared++
      Write-Host "Cleared: $($profile.Label)" -ForegroundColor Green
    }
  }
  if ($cleared -eq 0) { Write-Host 'No browser had a broken paper size saved.' }
}
if ($answer -ieq 'R' -or $answer -ieq 'F') {
  $guess = if ($default -and $default.Name -notlike '*PDF*' -and $default.Name -notlike '*OneNote*') { $default.Name } else { (Get-Printer | Where-Object { $_.Name -like '*POS*' } | Select-Object -First 1).Name }
  $name = (Read-Host "The bill printer's name [$guess]").Trim()
  if (-not $name) { $name = $guess }
  if (-not $name -or -not (Get-Printer -Name $name -ErrorAction SilentlyContinue)) { Write-Host "No printer named '$name'." -ForegroundColor Yellow; exit 1 }
  Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-ResetPrinter', "`"$name`"")
} elseif ($answer -match '^\d+$') {
  $source = $profiles[[int]$answer - 1]
  if (-not $source) { Write-Host 'No profile has that number.' -ForegroundColor Yellow; exit 1 }
  if (-not $source.Sticky) { Write-Host "$($source.Label) has no saved print settings to copy." -ForegroundColor Yellow; exit 1 }
  if ($source.Sticky.Broken) { Write-Host "$($source.Label) has the BROKEN paper size; it would break the Three O'Clock windows too." -ForegroundColor Yellow; exit 1 }
  foreach ($target in ($profiles | Where-Object { $_.Target })) {
    if ($target.File -eq $source.File) { continue }
    Stop-Profile $target
    Write-Sticky $target.File $source.Sticky.Raw
    Write-Host "Copied into: $($target.Label)" -ForegroundColor Green
  }
  Write-Host 'The print window opens again by itself within a minute. Open the till with its desktop icon.'
}
