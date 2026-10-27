# Three O'Clock: connect this PC to the website, so each takes the other's orders and bills
# and Atlas always holds a copy. P63, docs/WINDOWS-INSTALL.md section 5c.
#
# Run by double-clicking "Connect to the website.bat" in C:\ThreeOClock, after
# "Load cafe data" has put the website's copy on this PC.
#
# It asks for REPLICATION_SECRET (Render, Environment), checks with the website that
# the secret is right and that the website already holds this PC's restaurant, and
# only then writes SYNC_MODE=TWO_WAY, MIRROR_URL and the secret into .env and restarts
# the server. A wrong secret or a PC with other data changes nothing.
# Written in plain ASCII for Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'
trap {
  Write-Host ''
  Write-Host "STOPPED: $_" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EnvFile = Join-Path $Root '.env'
$TaskName = 'ThreeOClock Server'
$DefaultWebsite = 'https://three-o-clock-erp-api.onrender.com'

function Fail($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Get-EnvValue($key) {
  $line = Select-String -Path $EnvFile -Pattern "^$key=(.*)$" | Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
  return ''
}
function Set-EnvLine($key, $value) {
  $lines = @(Get-Content -Path $EnvFile | Where-Object { $_ -notmatch "^$key=" })
  $lines += "$key=$value"
  Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
}
function Read-Secret($prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Run this as Administrator: double-click "Connect to the website.bat", and say Yes when Windows asks.'
}
if (-not (Test-Path $EnvFile)) { Fail 'Three O''Clock is not installed here yet. Double-click "Install ThreeOClock" first.' }
Refresh-Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is missing. Run "Install ThreeOClock" again.' }

$mongoUri = Get-EnvValue 'MONGO_URI'
if ($mongoUri -notmatch '^mongodb://(127\.0\.0\.1|localhost)[:/]') { Fail "This PC's MONGO_URI is not this PC ($mongoUri). Not touching it." }
$website = Get-EnvValue 'MIRROR_URL'
if (-not $website) { $website = $DefaultWebsite }
$port = 80
$portValue = Get-EnvValue 'PORT'
if ($portValue -match '^\d+$') { $port = [int]$portValue }
$probe = if ($port -eq 80) { 'http://127.0.0.1' } else { "http://127.0.0.1:$port" }

Write-Host 'Connect to the website' -ForegroundColor Green
Write-Host "Website server: $website"
if ((Get-EnvValue 'SYNC_MODE') -eq 'TWO_WAY' -and (Get-EnvValue 'REPLICATION_SECRET')) {
  Write-Host 'This PC is already connected. Going on checks the secret again and restarts the server.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'On Render: the three-o-clock-erp-api service, Environment, REPLICATION_SECRET, the eye icon, copy.'
$secret = Read-Secret 'Paste REPLICATION_SECRET here (it stays hidden), then press Enter'
if (-not $secret) { Fail 'Nothing was pasted. Nothing was changed.' }

Write-Host ''
Write-Host '== Asking the website (it can take a minute if it was asleep)'
Push-Location $Root
try {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & node (Join-Path $PSScriptRoot 'check-website.mjs') $mongoUri $website $secret 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $saved }
} finally { Pop-Location }
$jsonLine = $output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
if (-not $jsonLine) { $output | Select-Object -Last 10 | Out-Host; Fail 'The check did not finish. Nothing was changed.' }
$check = $jsonLine | ConvertFrom-Json
if (-not $check.ok) { Fail "$($check.message) Nothing was changed." }
foreach ($restaurant in $check.results) { Write-Host "The website knows $($restaurant.name)." -ForegroundColor Green }

Write-Host ''
Write-Host 'Optional, only if the website has card machine, Swiggy, Zomato or Razorpay connections:'
Write-Host 'paste Render''s INTEGRATION_SECRETS_KEY and PAYMENT_SECRETS_KEY so this PC can read them. Press Enter to skip each.'
$integrationKey = Read-Secret 'INTEGRATION_SECRETS_KEY (Enter to skip)'
$paymentKey = Read-Secret 'PAYMENT_SECRETS_KEY (Enter to skip)'

Write-Host ''
Write-Host '== Writing the settings'
Copy-Item -Path $EnvFile -Destination "$EnvFile.before-connect" -Force
Set-EnvLine 'SYNC_MODE' 'TWO_WAY'
Set-EnvLine 'MIRROR_URL' $website
Set-EnvLine 'REPLICATION_SECRET' $secret
if ($integrationKey) { Set-EnvLine 'INTEGRATION_SECRETS_KEY' $integrationKey }
if ($paymentKey) { Set-EnvLine 'PAYMENT_SECRETS_KEY' $paymentKey }
Write-Host "Saved. The settings from before are in $EnvFile.before-connect."

Write-Host '== Restarting the server'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName $TaskName
$up = $false
for ($i = 0; $i -lt 90 -and -not $up; $i++) {
  Start-Sleep -Seconds 1
  try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$probe/api/v1/health").Content -match '"database":"connected"' } catch { $up = $false }
}
if (-not $up) {
  Copy-Item -Path "$EnvFile.before-connect" -Destination $EnvFile -Force
  Start-ScheduledTask -TaskName $TaskName
  Fail "The server did not start with the new settings, so the old ones were put back. Read $Root\data\logs\server.log."
}

$hours = Get-EnvValue 'SYNC_HOURS'
if (-not $hours) { $hours = '08:30-02:30' }
Write-Host ''
Write-Host 'Connected.' -ForegroundColor Green
Write-Host "This PC and the website now swap orders and bills every minute between $hours (India time),"
Write-Host 'and at night whenever this PC has something new. Atlas holds the website''s copy.'
Write-Host 'Check: sign in as the owner on this PC, open Sync in the menu. Within two minutes it says In step.' -ForegroundColor Green
Write-Host 'Bill on this PC. Use the website only when this PC has a problem (docs\DEPLOYMENT.md section 19.4).'
Read-Host 'Press Enter to close'
