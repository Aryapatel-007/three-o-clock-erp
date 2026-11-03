# ThreeOClock: one-time setup on a Windows 10 or 11 PC. docs/WINDOWS-INSTALL.md.
#
# Run at the end of ThreeOClock-Setup.exe, which puts the app in C:\ThreeOClock (or by
# double-clicking "Install ThreeOClock.bat" in that folder). It runs as Administrator, then:
#   1. installs Node.js, MongoDB and the MongoDB tools with winget (needs internet, once)
#   2. makes MongoDB a single-node replica set, reachable from this PC only
#   3. installs the app's packages, writes its settings (.env), builds the indexes
#   4. creates the restaurant and the owner (asks only the name and the owner's mobile)
#   5. starts the server when Windows starts, before anyone logs in, and restarts
#      it if it stops; takes a snapshot of the database every hour; loads the sample
#      restaurant and saves every login to "ThreeOClock logins" on the desktop
#   6. lets tablets on the WiFi reach it (Windows Firewall)
#   7. puts one "ThreeOClock" icon on the desktop
#   8. installs new versions by itself at night (box\windows\update.mjs), from the
#      signed releases in Aryapatel-007/three-o-clock-releases
#
# Safe to run again: every step checks first, and nothing made before is lost.
# Written in plain ASCII for Windows PowerShell 5.1.

param(
  # From ThreeOClock-Setup.exe: no window and no questions. The answers come as parameters,
  # progress goes to standard output as "@@STEP <percent> <text>" lines for the
  # installer's progress bar, and a failure ends with one "@@FAIL <reason>" line
  # instead of waiting for Enter.
  [switch]$Unattended,
  [string]$RestaurantName = '',
  [string]$OwnerPhone = ''
)

$ErrorActionPreference = 'Stop'
# One line the installer window reads, whatever else is printed around it.
function Mark($line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
# Anything unexpected: say it and wait, so the window does not vanish before it can be read.
trap {
  Write-Host ''
  Write-Host "STOPPED: $_" -ForegroundColor Red
  if ($Unattended) { Mark "@@FAIL $_"; exit 1 }
  Read-Host 'Press Enter to close'
  exit 1
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataDir = Join-Path $Root 'data'
$LogDir = Join-Path $DataDir 'logs'
$EnvFile = Join-Path $Root '.env'
$TaskName = 'ThreeOClock Server'
$SnapshotTask = 'ThreeOClock Snapshot'
$UpdateTask = 'ThreeOClock Update'
$PrinterTask = 'ThreeOClock Printer'

function Say($text, $percent) {
  Write-Host ''
  Write-Host "== $text" -ForegroundColor Cyan
  Mark "@@STEP $percent $($text -replace '^\d+\.\s*', '')"
}
# A smaller line under the step, for the long waits.
function Detail($text) { Write-Host $text; Mark "@@DETAIL $text" }
function Fail($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  if ($Unattended) { Mark "@@FAIL $text"; exit 1 }
  Write-Host 'Nothing is lost. Fix this and double-click "Install ThreeOClock" again.'
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
# Ten letters and digits, without the ones people misread (0 O 1 l I).
function New-Password {
  $alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $buffer = New-Object byte[] 10
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return -join ($buffer | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}
function Winget-Install($id, $label, $note) {
  Detail "Installing $label..."
  if ($note) { Detail $note }
  # 2026-10-26. Straight to this window, never through a pipe: winget draws its
  # download progress bar only when it writes to the console itself. Piped, a
  # large download (MongoDB) sat on "Downloading" with no sign it was moving.
  # 2026-11-03. Only the winget source: on a PC that never used winget, the Microsoft
  # Store source can refuse its first search and stop the install (the first try of
  # ThreeOClock-Setup.exe ended there). Tried twice, since that first search can also time out.
  $wingetArgs = @('install', '--id', $id, '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      $process = Start-Process -FilePath 'winget' -ArgumentList $wingetArgs -NoNewWindow -Wait -PassThru -ErrorAction Stop
      $code = $process.ExitCode
    } catch {
      & winget @wingetArgs
      $code = $LASTEXITCODE
    }
    Refresh-Path
    # 0 installed; -1978335189 (0x8A15002B) already installed with no newer version.
    if ($code -eq 0 -or $code -eq -1978335189) { return }
    Write-Host "winget finished with code $code for $label (try $attempt of 2)." -ForegroundColor Yellow
    if ($attempt -eq 1) { & winget source update --name winget 2>&1 | Out-Null; Start-Sleep -Seconds 5 }
  }
}
# An MSI can finish a moment before Windows lists the service it made.
function Wait-Service($name, [int]$seconds = 60) {
  for ($i = 0; $i -lt $seconds; $i += 2) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($service) { return $service }
    Start-Sleep -Seconds 2
  }
  return $null
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Run this as Administrator: double-click "Install ThreeOClock.bat", and say Yes when Windows asks.'
}
# The server runs from this folder for good, so it must not be one that WhatsApp, a
# browser's downloads or Windows' clean-up can empty.
if ($Root -match '\\AppData\\|\\Temp\\|\\Downloads(\\|$)|\\OneDrive') {
  Fail "This folder is a download, temporary or OneDrive folder, which Windows can empty or move:`n  $Root`nInstall ThreeOClock into another folder, for example C:\ThreeOClock."
}
if (-not (Test-Path (Join-Path $Root 'server\server.js'))) { Fail "This script must stay inside the ThreeOClock folder. Looked in $Root." }
if (-not (Test-Path (Join-Path $Root 'client\dist\index.html'))) { Fail 'The screens are missing (client\dist). Use the ThreeOClock.zip made by box/windows/make-package.sh.' }
New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null
# Every run is kept, so a failure always has its reason written down.
try { Start-Transcript -Path (Join-Path $LogDir 'install.log') -Append | Out-Null } catch { }

Write-Host 'ThreeOClock setup' -ForegroundColor Green
Write-Host "Folder: $Root"

# ---------------------------------------------------------------------------
Say '1. Node.js and MongoDB' 5
Refresh-Path
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Fail 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js' }
# The Node.js installer adds itself to the PATH of new windows only.
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $env:Path = "C:\Program Files\nodejs;$env:Path" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js did not install. Check the internet and run ThreeOClock-Setup.exe again.' }
Write-Host "Node.js $(node -v)"

$mongoService = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
if (-not $mongoService) {
  Say '1. Downloading MongoDB, the database (about 900 MB, 5 to 30 minutes)' 10
  Winget-Install 'MongoDB.Server' 'MongoDB' 'About 900 MB to download: this can take 5 to 30 minutes.'
  $mongoService = Wait-Service 'MongoDB'
}
if (-not $mongoService) { Fail 'MongoDB did not install as a service. Install MongoDB Community Server (MSI, "Install as a Service"), then run this again.' }
if (-not (Get-Command mongodump -ErrorAction SilentlyContinue)) {
  Say '1. Installing the database tools, for the hourly backup' 38
  Winget-Install 'MongoDB.DatabaseTools' 'MongoDB tools (for the hourly snapshot)'
}
$toolsBin = Get-ChildItem 'C:\Program Files\MongoDB\Tools\*\bin' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($toolsBin -and -not (Get-Command mongodump -ErrorAction SilentlyContinue)) {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  [Environment]::SetEnvironmentVariable('Path', "$machinePath;$($toolsBin.FullName)", 'Machine')
  Refresh-Path
}

# ---------------------------------------------------------------------------
Say '2. Setting up the database' 42
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
Say '3. Installing the app' 48
# A running server holds node_modules\bcrypt open, and npm ci cannot delete an open file.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Push-Location $Root
try {
  Detail "Downloading the app's packages..."
  npm ci --omit=dev --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail 'Installing the app packages failed (npm ci). Check the internet and run this again.' }
} finally { Pop-Location }

node (Join-Path $PSScriptRoot 'init-replica-set.mjs')
if ($LASTEXITCODE -ne 0) { Fail 'MongoDB could not be made a replica set.' }

# An update over a running restaurant: a snapshot of the whole database first, the
# same one the hourly task and the nightly updater take, kept in data\snapshots. The
# update itself never touches the database, data\ or .env; this is the safety copy.
$marker = Join-Path $DataDir 'restaurant-created.txt'
if ((Test-Path $marker) -and (Test-Path $EnvFile)) {
  Say '3. Backing up the restaurant''s data before the update' 55
  $savedUri = $env:MONGO_URI
  $env:MONGO_URI = 'mongodb://127.0.0.1:27017/?replicaSet=rs0'
  Push-Location $Root
  try {
    node server\scripts\localSnapshot.js | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Host 'The snapshot did not finish; the update goes on, and the database is not changed by it.' -ForegroundColor Yellow }
  } finally {
    Pop-Location
    $env:MONGO_URI = $savedUri
  }
}

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
    '# Its own database, so it never meets another product installed on the same PC (2026-11-03).',
    'MONGO_URI=mongodb://127.0.0.1:27017/three-o-clock?replicaSet=rs0',
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
    '# Push and pull with the website (docs/WINDOWS-INSTALL.md section 5c): SYNC_MODE=TWO_WAY,',
    '# MIRROR_URL = the website server address, REPLICATION_SECRET = the same as on the website.',
    'SYNC_MODE=ONE_WAY',
    '# Filled by "Connect to the website":',
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
# 2026-10-22, Arya: a PC that sends to the website (its secret is set) takes the website's
# changes too: two-way. 2026-11-03: the PC is the main system, and where both changed the
# same thing, the PC's change is kept.
if (Select-String -Path $EnvFile -Pattern '^REPLICATION_SECRET=.+' -Quiet) {
  if (-not (Select-String -Path $EnvFile -Pattern '^MIRROR_URL=.+' -Quiet)) { Set-EnvLine 'MIRROR_URL' 'https://three-o-clock-erp-api.onrender.com' }
  # 2026-11-03: the website's server moved to its own Render workspace, at a new address.
  if (Select-String -Path $EnvFile -Pattern '^MIRROR_URL=https://three-o-clock-erp-api.onrender.com$' -Quiet) { Set-EnvLine 'MIRROR_URL' 'https://three-o-clock-erp-api.onrender.com' }
  Set-EnvLine 'SYNC_MODE' 'TWO_WAY'
  Write-Host 'Push and pull with the website is on: this PC pushes its records and pulls the website''s changes; this PC''s change wins a clash.'
}
Ensure-EnvLine 'UPDATE_AUTO' 'on'
Ensure-EnvLine 'UPDATE_WINDOW' '04:00-05:00'
# Signed releases come from the public releases repository, which needs no token.
Set-EnvLine 'UPDATE_REPO' 'Aryapatel-007/three-o-clock-releases'
Ensure-EnvLine 'UPDATE_TOKEN' ''
# The day-end email (P44). Empty: Day Close works and sends nothing. The key is Render's own
# RESEND_API_KEY, put in by a person; it is a secret and never in this script.
Ensure-EnvLine 'RESEND_API_KEY' ''
Ensure-EnvLine 'DAY_END_EMAIL_FROM' 'ThreeOClock <onboarding@resend.dev>'
# The version this folder holds, so the server and the updater both know it.
$versionFile = Join-Path $Root 'VERSION.txt'
if (Test-Path $versionFile) { Set-EnvLine 'RELEASE_VERSION' ((Get-Content -Path $versionFile -Raw).Trim()) }

Say '3. Preparing the database' 60
Push-Location $Root
try {
  npm run db:indexes | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail 'Building the database indexes failed.' }
} finally { Pop-Location }

# ---------------------------------------------------------------------------
Say '4. Creating the restaurant and the owner login' 66
$ownerPhone = $null
$ownerPassword = $null
if (Test-Path $marker) {
  Write-Host 'The restaurant was already created. Skipping.'
} else {
  # Two questions, both with an answer already filled in, so pressing Enter twice is enough.
  # The passwords are made here and saved to "ThreeOClock logins" on the desktop (step 5).
  # From ThreeOClock-Setup.exe the installer window asked them already.
  if ($Unattended) {
    $cafeName = $RestaurantName.Trim()
    $ownerPhone = $OwnerPhone.Trim()
  } else {
    $cafeName = (Read-Host 'Restaurant name (press Enter for "My Restaurant")').Trim()
    do {
      $ownerPhone = (Read-Host 'Owner mobile number, used to sign in (press Enter for 9000000001)').Trim()
      if (-not $ownerPhone) { $ownerPhone = '9000000001' }
    } until ($ownerPhone -match '^[6-9]\d{9}$')
  }
  if (-not $cafeName) { $cafeName = 'My Restaurant' }
  if (-not $ownerPhone) { $ownerPhone = '9000000001' }
  if ($ownerPhone -notmatch '^[6-9]\d{9}$') { Fail "The owner mobile number must be 10 digits starting with 6, 7, 8 or 9. It was: $ownerPhone" }
  $ownerPassword = New-Password
  Push-Location $Root
  try {
    # The empty line answers the optional email question.
    '' | node server\scripts\provisionRestaurant.js --name "$cafeName" --owner 'Owner' --phone $ownerPhone --password "$ownerPassword" | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'Creating the restaurant failed. Is that phone number already used?' }
  } finally { Pop-Location }
  Set-Content -Path $marker -Value "Created $(Get-Date -Format s) for $cafeName, owner phone $ownerPhone" -Encoding ASCII
}

# ---------------------------------------------------------------------------
Say '5. Starting ThreeOClock and loading the sample menu and staff' 72
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
Detail 'Waiting for ThreeOClock to start...'
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

# A new restaurant gets the sample: tables, stations, payment methods, the 139-dish menu
# and a login for each standard role. Every login goes to "ThreeOClock logins" on the desktop.
$loginsFile = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'ThreeOClock logins.txt'
if ($ownerPhone) {
  Say '5. Loading the sample menu, tables and staff logins' 80
  $env:CAFE_URL = $url; $env:CAFE_PHONE = $ownerPhone; $env:CAFE_PASSWORD = $ownerPassword; $env:LOGINS_FILE = $loginsFile
  node (Join-Path $PSScriptRoot 'load-starter.mjs') | Out-Host
  if ($LASTEXITCODE -ne 0) {
    # The owner can still sign in: save that login before anything else can go wrong.
    Set-Content -Path $loginsFile -Value @('THREE O CLOCK LOGINS - keep this file private', '', "OWNER  phone $ownerPhone  password $ownerPassword") -Encoding ASCII
    Write-Host 'The sample menu and staff were not loaded; the owner login is saved. Run this installer again to retry.' -ForegroundColor Yellow
  }
  Remove-Item Env:CAFE_PASSWORD -ErrorAction SilentlyContinue
  Copy-Item $loginsFile (Join-Path $DataDir 'logins.txt') -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Say '6. Letting tablets on the WiFi reach it' 92
# Any profile: a new WiFi is often marked Public by Windows, and the tablets must still get in.
Get-NetFirewallRule -DisplayName 'ThreeOClock' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'ThreeOClock' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
Write-Host "Port $port is open to devices on the network."

# ---------------------------------------------------------------------------
Say '7. Adding the desktop icons' 95
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$shell = New-Object -ComObject WScript.Shell
$opener = Join-Path $PSScriptRoot 'open.vbs'
# One icon. Connect a device is on ThreeOClock's home screen, so it needs none of its own.
foreach ($icon in @(@{ Name = 'ThreeOClock'; Page = '' })) {
  $shortcut = $shell.CreateShortcut((Join-Path $desktop "$($icon.Name).lnk"))
  $shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $shortcut.Arguments = "`"$opener`" $($icon.Page)"
  $shortcut.WorkingDirectory = $Root
  $shortcut.IconLocation = Join-Path $PSScriptRoot 'threeoclock.ico'
  $shortcut.Description = 'Opens ThreeOClock, starting the server if it is not running.'
  $shortcut.Save()
}
# 2026-10-22. "ThreeOClock" opens the till itself (start-till.ps1), so the icons that
# opened a till or set up printing are gone: one icon, nothing to choose. The tools
# stay in box\windows (print-settings.cmd) for whoever looks after the PC.
foreach ($old in @('ThreeOClock - Connect a device', 'ThreeOClock - Till (prints without asking)', 'ThreeOClock - Printer setup (captains'' bills)', 'ThreeOClock - Printer setup (till)', 'ThreeOClock - Fix printing')) {
  foreach ($folder in @($desktop, [Environment]::GetFolderPath('Desktop'))) {
    Remove-Item -Path (Join-Path $folder "$old.lnk") -Force -ErrorAction SilentlyContinue
  }
}
# The print window of 2026-10-22 morning had its own profile. And the till and its hidden
# printer window keep the old screens in memory until closed: closed here, so the hidden
# printer comes back within a minute on the new version (the "ThreeOClock Printer" task).
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -like '*ThreeOClock Printer*' -or $_.CommandLine -like '*ThreeOClock Till*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# 2026-10-22. Chrome keeps its paper size, margins and scale per browser profile, and the till's
# profile never had them chosen, so it printed with blank paper above the bill. The Chrome on
# this PC that prints on the bill printer has them right: the till takes the same (print-settings.ps1).
try { & (Join-Path $PSScriptRoot 'print-settings.ps1') -AutoCopy } catch { Write-Host "Chrome's print settings were not copied: $($_.Exception.Message)" -ForegroundColor Yellow }

# Only real network cards: VirtualBox, VMware, Hyper-V and WSL add private addresses no tablet can reach.
$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and $_.InterfaceAlias -notmatch 'VirtualBox|VMware|vEthernet|Hyper-V|WSL|Loopback|Bluetooth' } |
  Select-Object -ExpandProperty IPAddress
$portPart = if ($port -eq 80) { '' } else { ":$port" }
Write-Host ''
Write-Host 'All done.' -ForegroundColor Green
Write-Host 'On this PC: double-click "ThreeOClock" on the desktop.'
foreach ($address in $addresses) { Write-Host "On tablets and phones on the same WiFi: http://$address$portPart" -ForegroundColor Green }
Write-Host 'Connect tablets and phones: Connect a device, on the ThreeOClock home screen.'
Write-Host 'The server starts by itself whenever this PC is switched on.'
Write-Host 'New versions install by themselves between 4 and 5 AM.'
if (Test-Path $loginsFile) { Write-Host 'Every login and password is in "ThreeOClock logins" on the desktop. Keep it private.' -ForegroundColor Green }
Write-Host 'The till opens by itself when Windows starts, and from "ThreeOClock" on the desktop. It prints with no dialog.'
Write-Host 'Sign in to the till once with a cashier or manager login: it prints its bills and the captains'' bills.' -ForegroundColor Green
try { Stop-Transcript | Out-Null } catch { }
if ($Unattended) {
  # The installer window shows these on its last page, then opens ThreeOClock.
  foreach ($address in $addresses) { Mark "@@ADDRESS http://$address$portPart" }
  Mark "@@DONE $url"
  exit 0
}
Read-Host 'Press Enter to close'
Start-Process $url
