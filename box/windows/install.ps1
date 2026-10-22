# Cafe POS: one-time setup on a Windows 10 or 11 PC. P62, docs/WINDOWS-INSTALL.md.
#
# Run by double-clicking "Install Cafe POS.bat" in the CafePOS folder. It asks
# for Administrator once, then:
#   1. installs Node.js, MongoDB and the MongoDB tools with winget (needs internet, once)
#   2. makes MongoDB a single-node replica set, reachable from this PC only
#   3. installs the app's packages, writes its settings (.env), builds the indexes
#   4. creates the restaurant and the owner's login (asks the name, phone, password)
#   5. starts the server when Windows starts, before anyone logs in, and restarts
#      it if it stops; takes a snapshot of the database every hour
#   6. lets tablets on the WiFi reach it (Windows Firewall)
#   7. puts "Cafe POS" and "Cafe POS - Connect a device" on the desktop
#   8. installs new versions by itself at night (box\windows\update.mjs)
#
# Safe to run again: every step checks first. Running it again after copying a
# newer CafePOS folder over this one updates the app by hand; step 8 does it
# without anyone, from signed GitHub releases.
# Written in plain ASCII for Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'
# Anything unexpected: say it and wait, so the window does not vanish before it can be read.
trap {
  Write-Host ''
  Write-Host "STOPPED: $_" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataDir = Join-Path $Root 'data'
$LogDir = Join-Path $DataDir 'logs'
$EnvFile = Join-Path $Root '.env'
$TaskName = 'CafePOS Server'
$SnapshotTask = 'CafePOS Snapshot'
$UpdateTask = 'CafePOS Update'
$PrinterTask = 'CafePOS Printer'

function Say($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Write-Host 'Nothing is lost. Fix this and double-click "Install Cafe POS" again.'
  Read-Host 'Press Enter to close'
  exit 1
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function New-Secret([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return [Convert]::ToBase64String($buffer)
}
function Winget-Install($id, $label) {
  Write-Host "Installing $label..."
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Run this as Administrator: double-click "Install Cafe POS.bat", and say Yes when Windows asks.'
}
# The server runs from this folder for good, so it must not be one that WhatsApp, a
# browser's downloads or Windows' clean-up can empty.
if ($Root -match '\\AppData\\|\\Temp\\|\\Downloads(\\|$)|\\OneDrive') {
  Fail "This folder is a download or app folder, which can be emptied at any time:`n  $Root`nMove the CafePOS folder (the one with Install Cafe POS in it) to C:\CafePOS, then double-click Install Cafe POS there."
}
if (-not (Test-Path (Join-Path $Root 'server\server.js'))) { Fail "This script must stay inside the CafePOS folder. Looked in $Root." }
if (-not (Test-Path (Join-Path $Root 'client\dist\index.html'))) { Fail 'The screens are missing (client\dist). Use the CafePOS.zip made by box/windows/make-package.sh.' }
New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

Write-Host 'Cafe POS setup' -ForegroundColor Green
Write-Host "Folder: $Root"

# ---------------------------------------------------------------------------
Say '1. Node.js and MongoDB'
Refresh-Path
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Fail 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js did not install. Install it from https://nodejs.org (LTS), then run this again.' }
Write-Host "Node.js $(node -v)"

$mongoService = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
if (-not $mongoService) { Winget-Install 'MongoDB.Server' 'MongoDB'; $mongoService = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue }
if (-not $mongoService) { Fail 'MongoDB did not install as a service. Install MongoDB Community Server (MSI, "Install as a Service"), then run this again.' }
if (-not (Get-Command mongodump -ErrorAction SilentlyContinue)) { Winget-Install 'MongoDB.DatabaseTools' 'MongoDB tools (for the hourly snapshot)' }
$toolsBin = Get-ChildItem 'C:\Program Files\MongoDB\Tools\*\bin' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($toolsBin -and -not (Get-Command mongodump -ErrorAction SilentlyContinue)) {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  [Environment]::SetEnvironmentVariable('Path', "$machinePath;$($toolsBin.FullName)", 'Machine')
  Refresh-Path
}

# ---------------------------------------------------------------------------
Say '2. MongoDB as a replica set, on this PC only'
$cfg = Get-ChildItem 'C:\Program Files\MongoDB\Server\*\bin\mongod.cfg' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $cfg) { Fail 'Could not find mongod.cfg under C:\Program Files\MongoDB\Server.' }
$cfgText = Get-Content $cfg.FullName -Raw
if ($cfgText -notmatch 'replSetName') {
  Copy-Item $cfg.FullName "$($cfg.FullName).before-cafe-pos" -Force
  # The installer's file has "#replication:" commented out; add a real section at the end.
  $cfgText = $cfgText.TrimEnd() + "`r`n`r`nreplication:`r`n  replSetName: rs0`r`n"
  Set-Content -Path $cfg.FullName -Value $cfgText -Encoding ASCII
  Write-Host "Added replSetName: rs0 to $($cfg.FullName)"
}
if ($cfgText -notmatch 'bindIp:\s*127\.0\.0\.1') {
  Write-Host 'Note: MongoDB is not bound to 127.0.0.1 only. Tablets never talk to MongoDB; keep it on this PC.' -ForegroundColor Yellow
}
Set-Service -Name 'MongoDB' -StartupType Automatic
Restart-Service -Name 'MongoDB' -Force
Start-Sleep -Seconds 5

# ---------------------------------------------------------------------------
Say '3. The app'
# A running server holds node_modules\bcrypt open, and npm ci cannot delete an open file.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Push-Location $Root
try {
  npm ci --omit=dev --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail 'Installing the app packages failed (npm ci). Check the internet and run this again.' }
} finally { Pop-Location }

node (Join-Path $PSScriptRoot 'init-replica-set.mjs')
if ($LASTEXITCODE -ne 0) { Fail 'MongoDB could not be made a replica set.' }

# Port 80 means staff type just the address; 8080 when something else holds 80.
$port = 80
$busy80 = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue
if (Test-Path $EnvFile) {
  $existing = Select-String -Path $EnvFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
  if ($existing) { $port = [int]$existing.Matches[0].Groups[1].Value }
} elseif ($busy80) { $port = 8080 }

# A bare origin never names the default port: http://localhost, not http://localhost:80.
$origin = 'http://localhost'
if ($port -ne 80) { $origin = "http://localhost:$port" }
if (-not (Test-Path $EnvFile)) {
  $lines = @(
    'NODE_ENV=production',
    "PORT=$port",
    'DEPLOYMENT_ROLE=BOX',
    'MONGO_URI=mongodb://127.0.0.1:27017/restaurant-erp?replicaSet=rs0',
    "JWT_ACCESS_SECRET=$(New-Secret 48)",
    "JWT_REFRESH_SECRET=$(New-Secret 48)",
    "INTEGRATION_SECRETS_KEY=$(New-Secret 32)",
    "CLIENT_ORIGIN=$origin",
    'TRUST_PROXY=false',
    "BOX_DATA_DIR=$DataDir",
    '# Empty: the address staff open is worked out from the WiFi this PC is on.',
    'BOX_PUBLIC_URL=',
    'BOX_LOCAL_NAME_URL=',
    'BOX_WIFI_CONTROL=off',
    '# Two-way sync with the website (docs/WINDOWS-INSTALL.md section 5c): SYNC_MODE=TWO_WAY,',
    '# MIRROR_URL = the website server address, REPLICATION_SECRET = the same as on the website.',
    'SYNC_MODE=ONE_WAY',
    '# Fill both to send a copy to the cloud mirror (docs/DEPLOYMENT.md section 18):',
    'MIRROR_URL=',
    'REPLICATION_SECRET='
  )
  # The updater's settings are added below, for new and old .env files alike.
  Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
  Write-Host "Settings written to $EnvFile (keep this file private)."
}

# The updater's settings (docs/WINDOWS-INSTALL.md section 6). Added when missing,
# so a PC set up before the updater gets them on its next run of this script.
function Ensure-EnvLine($key, $value) {
  $text = Get-Content -Path $EnvFile -Raw
  if ($text -notmatch "(?m)^$key=") {
    Add-Content -Path $EnvFile -Value "$key=$value" -Encoding ASCII
  }
}
function Set-EnvLine($key, $value) {
  $lines = @(Get-Content -Path $EnvFile | Where-Object { $_ -notmatch "^$key=" })
  $lines += "$key=$value"
  Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
}
# A .env from the first version of this script said http://localhost:80, which the
# server refuses: a bare origin never names the default port.
if (Select-String -Path $EnvFile -Pattern '^CLIENT_ORIGIN=http://localhost:80$' -Quiet) { Set-EnvLine 'CLIENT_ORIGIN' 'http://localhost' }
Ensure-EnvLine 'SYNC_MODE' 'ONE_WAY'
# 2026-10-22, Arya: a PC that already sends to the website (its secret is set) takes the
# website's changes too. One-way only sent, so the PC never had the website's bills or cancels.
if (Select-String -Path $EnvFile -Pattern '^REPLICATION_SECRET=.+' -Quiet) {
  if (-not (Select-String -Path $EnvFile -Pattern '^MIRROR_URL=.+' -Quiet)) { Set-EnvLine 'MIRROR_URL' 'https://zchaat-pos-api.onrender.com' }
  Set-EnvLine 'SYNC_MODE' 'TWO_WAY'
  Write-Host 'Two-way sync with the website is on: this PC takes the website''s changes as well as sending its own.'
}
Ensure-EnvLine 'UPDATE_AUTO' 'on'
Ensure-EnvLine 'UPDATE_WINDOW' '04:00-05:00'
Ensure-EnvLine 'UPDATE_REPO' 'riship-17/Cafezza-Offline'
Ensure-EnvLine 'UPDATE_TOKEN' ''
# UPDATE_TOKEN is left empty: automatic updates stay off until someone puts the
# token in .env by hand (docs/WINDOWS-INSTALL.md section 6).
# The day-end email (P44). Empty: Day Close works and sends nothing. The key is Render's own
# RESEND_API_KEY, put in by a person; it is a secret and never in this script.
Ensure-EnvLine 'RESEND_API_KEY' ''
Ensure-EnvLine 'DAY_END_EMAIL_FROM' 'Restaurant ERP <onboarding@resend.dev>'
# The version this folder holds, so the server and the updater both know it.
$versionFile = Join-Path $Root 'VERSION.txt'
if (Test-Path $versionFile) { Set-EnvLine 'RELEASE_VERSION' ((Get-Content -Path $versionFile -Raw).Trim()) }

Push-Location $Root
try {
  npm run db:indexes | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail 'Building the database indexes failed.' }
} finally { Pop-Location }

# ---------------------------------------------------------------------------
Say '4. The restaurant and the owner login'
$marker = Join-Path $DataDir 'restaurant-created.txt'
$ownerPhone = $null
$ownerPassword = $null
if (Test-Path $marker) {
  Write-Host 'The restaurant was already created. Skipping.'
} else {
  $cafeName = Read-Host 'Cafe name (for example Z Chaat)'
  $ownerName = Read-Host 'Owner full name'
  do { $ownerPhone = Read-Host 'Owner mobile number (10 digits, used to sign in)' } until ($ownerPhone -match '^\d{10}$')
  do {
    $secure = Read-Host 'Owner password (at least 8 characters, letters and numbers, no quotes)' -AsSecureString
    $ownerPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  } until ($ownerPassword.Length -ge 8)
  Push-Location $Root
  try {
    # The empty line answers the optional email question.
    '' | node server\scripts\provisionRestaurant.js --name "$cafeName" --owner "$ownerName" --phone $ownerPhone --password "$ownerPassword" | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'Creating the restaurant failed. Is that phone number already used?' }
  } finally { Pop-Location }
  Set-Content -Path $marker -Value "Created $(Get-Date -Format s) for $cafeName, owner phone $ownerPhone" -Encoding ASCII
}

# ---------------------------------------------------------------------------
Say '5. Start with Windows, restart if it stops, snapshot every hour, update at night'
$node = (Get-Command node).Source
$serverCmd = "/c cd /d `"$Root`" && `"$node`" server\server.js >> `"$LogDir\server.log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $serverCmd -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $system -Force | Out-Null

# The snapshot reads the whole server with --oplog, so its address names no database.
$snapCmd = "/c cd /d `"$Root`" && set `"MONGO_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0`" && `"$node`" server\scripts\localSnapshot.js >> `"$LogDir\snapshot.log`" 2>&1"
$snapAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $snapCmd -WorkingDirectory $Root
$snapTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(1) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $SnapshotTask -Action $snapAction -Trigger $snapTrigger -Settings $settings -Principal $system -Force | Out-Null

# Every 15 minutes; it does something only inside UPDATE_WINDOW (4 to 5 AM by
# default) and only when a newer signed version is on GitHub. Never retried on
# its own, and never started late after the PC was off.
$updateCmd = "/c cd /d `"$Root`" && `"$node`" box\windows\update.mjs run >NUL 2>> `"$LogDir\update-task.log`""
$updateAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $updateCmd -WorkingDirectory $Root
$updateTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$updateSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $UpdateTask -Action $updateAction -Trigger $updateTrigger -Settings $updateSettings -Principal $system -Force | Out-Null

# The till (print-agent.ps1, start-till.ps1), which also prints captains' bills by itself. In
# the signed-in person's own session, since a browser and its printer live there, at sign-in
# and every minute after, so a till closed by mistake comes back within a minute.
$printerAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$(Join-Path $PSScriptRoot 'print-agent.vbs')`"" -WorkingDirectory $Root
$printerTrigger = New-ScheduledTaskTrigger -AtLogOn
$printerTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition
$printerSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
$users = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
Register-ScheduledTask -TaskName $PrinterTask -Action $printerAction -Trigger $printerTrigger -Settings $printerSettings -Principal $users -Force | Out-Null

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName $TaskName
$url = if ($port -eq 80) { 'http://localhost' } else { "http://localhost:$port" }
# The server listens on IPv4 only. Windows tries localhost as IPv6 first and takes
# about 2 seconds to be refused there, the whole timeout below, so the check asks 127.0.0.1.
$probe = if ($port -eq 80) { 'http://127.0.0.1' } else { "http://127.0.0.1:$port" }
$up = $false
for ($i = 0; $i -lt 60 -and -not $up; $i++) {
  Start-Sleep -Seconds 1
  try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$probe/api/v1/network/ping").StatusCode -eq 200 } catch { $up = $false }
}
if (-not $up) { Fail "The server did not start. Read $LogDir\server.log." }
Write-Host "The server is running at $url"
# The till opens now, not only at the next sign-in to Windows.
Start-ScheduledTask -TaskName $PrinterTask -ErrorAction SilentlyContinue

if ($ownerPhone) {
  $answer = Read-Host 'Load the sample Z Chaat menu and 12 starter tables? (Y/N)'
  if ($answer -match '^[Yy]') {
    $env:CAFE_URL = $url; $env:CAFE_PHONE = $ownerPhone; $env:CAFE_PASSWORD = $ownerPassword
    node (Join-Path $PSScriptRoot 'load-starter.mjs') | Out-Host
    Remove-Item Env:CAFE_PASSWORD -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
Say '6. Let tablets on the WiFi reach it'
# Any profile: a new WiFi is often marked Public by Windows, and the tablets must still get in.
Get-NetFirewallRule -DisplayName 'Cafe POS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Cafe POS' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
Write-Host "Port $port is open to devices on the network."

# ---------------------------------------------------------------------------
Say '7. Desktop icons'
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$shell = New-Object -ComObject WScript.Shell
$opener = Join-Path $PSScriptRoot 'open.vbs'
foreach ($icon in @(@{ Name = 'Cafe POS'; Page = '' }, @{ Name = 'Cafe POS - Connect a device'; Page = 'connect' })) {
  $shortcut = $shell.CreateShortcut((Join-Path $desktop "$($icon.Name).lnk"))
  $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $shortcut.Arguments = "`"$opener`" $($icon.Page)"
  $shortcut.WorkingDirectory = $Root
  $shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,15"
  $shortcut.Description = 'Opens the cafe system, starting the server if it is not running.'
  $shortcut.Save()
}
# 2026-10-22. "Cafe POS" opens the till itself (start-till.ps1), so the icons that
# opened a till or set up printing are gone: one icon, nothing to choose. The tools
# stay in box\windows (print-settings.cmd) for whoever looks after the PC.
foreach ($old in @('Cafe POS - Till (prints without asking)', 'Cafe POS - Printer setup (captains'' bills)', 'Cafe POS - Printer setup (till)', 'Cafe POS - Fix printing')) {
  foreach ($folder in @($desktop, [Environment]::GetFolderPath('Desktop'))) {
    Remove-Item -Path (Join-Path $folder "$old.lnk") -Force -ErrorAction SilentlyContinue
  }
}
# The print window of 2026-10-22 morning had its own profile. And the till and its hidden
# printer window keep the old screens in memory until closed: closed here, so the hidden
# printer comes back within a minute on the new version (the "CafePOS Printer" task).
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -like '*Cafe POS Printer*' -or $_.CommandLine -like '*Cafe POS Till*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# 2026-10-22. Chrome keeps its paper size, margins and scale per browser profile, and the till's
# profile never had them chosen, so it printed with blank paper above the bill. The Chrome on
# this PC that prints on the bill printer has them right: the till takes the same (print-settings.ps1).
try { & (Join-Path $PSScriptRoot 'print-settings.ps1') -AutoCopy } catch { Write-Host "Chrome's print settings were not copied: $($_.Exception.Message)" -ForegroundColor Yellow }

$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } | Select-Object -ExpandProperty IPAddress
$portPart = if ($port -eq 80) { '' } else { ":$port" }
Write-Host ''
Write-Host 'All done.' -ForegroundColor Green
Write-Host 'On this PC: double-click "Cafe POS" on the desktop.'
foreach ($address in $addresses) { Write-Host "On tablets and phones on the same WiFi: http://$address$portPart" -ForegroundColor Green }
Write-Host 'Print the card with QR codes: "Cafe POS - Connect a device" on the desktop.'
Write-Host 'The server starts by itself whenever this PC is switched on.'
if (Select-String -Path $EnvFile -Pattern '^UPDATE_TOKEN=.+' -Quiet) {
  Write-Host 'New versions install by themselves between 4 and 5 AM (UPDATE_WINDOW in .env).'
} else {
  Write-Host 'Automatic updates are off until UPDATE_TOKEN is set in .env (docs\WINDOWS-INSTALL.md section 6).' -ForegroundColor Yellow
}
if (-not (Select-String -Path $EnvFile -Pattern '^RESEND_API_KEY=.+' -Quiet)) {
  Write-Host 'The day-end email is off until RESEND_API_KEY is set in .env (docs\WINDOWS-INSTALL.md section 5c).' -ForegroundColor Yellow
}
Write-Host 'The till opens by itself when Windows starts, and from "Cafe POS" on the desktop. It prints with no dialog.'
Write-Host 'Sign in to the till once with a cashier or manager login: it prints its bills and the captains'' bills.' -ForegroundColor Green
Read-Host 'Press Enter to close'
Start-Process $url
