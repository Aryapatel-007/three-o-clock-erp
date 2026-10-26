# Dakaar: load an exact copy of the cloud's data onto this PC. P62, docs/WINDOWS-INSTALL.md section 5b.
#
# Run by double-clicking "Load cafe data.bat" in C:\Dakaar, after Install Dakaar.
# The copy is a cafe-data-*.archive.gz made by box/export-cloud.sh, put in C:\Dakaar.
#
# It replaces everything in this PC's database with the copy: every order, bill,
# guest, closed day, setting and login from the cloud, with their own ids, so the
# next bill continues the cloud's invoice series. Before that it takes a snapshot of
# what is here now (data\snapshots\before-load-*.archive.gz). It never connects to
# the cloud. Written in plain ASCII for Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'
trap {
  Write-Host ''
  Write-Host "STOPPED: $_" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EnvFile = Join-Path $Root '.env'
$SnapDir = Join-Path $Root 'data\snapshots'
$TaskName = 'Dakaar Server'

function Fail($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
# mongodump and mongorestore report progress on stderr; with 'Stop', Windows
# PowerShell 5.1 would treat the first progress line as an error.
function Invoke-Tool([scriptblock]$command) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $saved }
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Run this as Administrator: double-click "Load cafe data.bat", and say Yes when Windows asks.'
}
if (-not (Test-Path $EnvFile)) { Fail 'Dakaar is not installed here yet. Double-click "Install Dakaar" first.' }
Refresh-Path
if (-not (Get-Command mongorestore -ErrorAction SilentlyContinue)) { Fail 'mongorestore is missing. Run "Install Dakaar" again: it installs the MongoDB tools.' }

$archive = Get-ChildItem -Path $Root -Filter '*.archive.gz' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $archive) { Fail "No copy found. Put the cafe-data-....archive.gz file in $Root, then run this again." }

$uriLine = Select-String -Path $EnvFile -Pattern '^MONGO_URI=(.+)$' | Select-Object -First 1
if (-not $uriLine) { Fail 'MONGO_URI is missing from .env.' }
$mongoUri = $uriLine.Matches[0].Groups[1].Value.Trim()
if ($mongoUri -notmatch '^mongodb://(127\.0\.0\.1|localhost)[:/]') { Fail "This PC's MONGO_URI is not this PC ($mongoUri). Not touching it." }
$dbName = ([regex]::Match($mongoUri, '^mongodb://[^/]+/([^?]+)')).Groups[1].Value
if (-not $dbName) { Fail 'MONGO_URI names no database.' }
$serverUri = ($mongoUri -replace '^(mongodb://[^/]+)/[^?]*', '$1/')
$port = 80
$portLine = Select-String -Path $EnvFile -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }
$url = if ($port -eq 80) { 'http://localhost' } else { "http://localhost:$port" }
# The server listens on IPv4 only. Windows tries localhost as IPv6 first and takes
# about 2 seconds to be refused there, the whole timeout below, so the check asks 127.0.0.1.
$probe = if ($port -eq 80) { 'http://127.0.0.1' } else { "http://127.0.0.1:$port" }

Write-Host 'Load cafe data' -ForegroundColor Green
Write-Host "Copy:     $($archive.Name)  ($([math]::Round($archive.Length / 1KB)) KB, made $($archive.LastWriteTime))"
Write-Host "Replaces: everything in the database $dbName on this PC"
Write-Host ''
Write-Host 'Everything on this PC now (orders, bills, the menu, logins) is replaced by the copy.' -ForegroundColor Yellow
Write-Host 'A snapshot of it is kept first. Staff sign in with their cloud phone and password.' -ForegroundColor Yellow
$answer = Read-Host 'Type LOAD to go on'
if ($answer -ne 'LOAD') { Fail 'Nothing was changed.' }

Write-Host ''
Write-Host '== Stopping the server'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

Write-Host '== Snapshot of what is here now'
New-Item -ItemType Directory -Force -Path $SnapDir | Out-Null
$before = Join-Path $SnapDir ("before-load-$(Get-Date -Format yyyyMMdd-HHmm).archive.gz")
Invoke-Tool { mongodump "--uri=$serverUri" "--db=$dbName" --gzip "--archive=$before" } | Out-Null
if ($LASTEXITCODE -ne 0) { Start-ScheduledTask -TaskName $TaskName; Fail 'The snapshot failed, so nothing was replaced. The server was started again.' }
Write-Host "Kept $before"

Write-Host '== Loading the copy'
Push-Location $Root
try {
  node (Join-Path $PSScriptRoot 'drop-local-database.mjs') $mongoUri
  if ($LASTEXITCODE -ne 0) { Fail 'Could not empty the database. Nothing else was changed; double-click "Install Dakaar" to start the server again.' }
  $restoreLog = Invoke-Tool { mongorestore "--uri=$serverUri" "--nsInclude=$dbName.*" --gzip "--archive=$($archive.FullName)" }
  $restoreExit = $LASTEXITCODE
  $summary = ($restoreLog | Select-String -Pattern 'document\(s\) restored' | Select-Object -Last 1)
  if ($restoreExit -ne 0 -or -not $summary -or "$summary" -notmatch ' 0 document\(s\) failed') {
    $restoreLog | Select-Object -Last 10 | Out-Host
    Write-Host 'The copy did not load completely. Putting back what was here before.' -ForegroundColor Red
    node (Join-Path $PSScriptRoot 'drop-local-database.mjs') $mongoUri | Out-Host
    Invoke-Tool { mongorestore "--uri=$serverUri" "--nsInclude=$dbName.*" --gzip "--archive=$before" } | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Fail "The copy could not be loaded. This PC is back as it was. Send $($archive.Name)'s size and the lines above to the person who set this up."
  }
  Write-Host (("$summary" -split "\t")[-1])
  npm run db:indexes | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail 'Building the database indexes failed. Double-click "Install Dakaar" to repair, then run this again.' }
} finally { Pop-Location }

Write-Host '== Starting the server'
Start-ScheduledTask -TaskName $TaskName
$up = $false
for ($i = 0; $i -lt 90 -and -not $up; $i++) {
  Start-Sleep -Seconds 1
  try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$probe/api/v1/health").Content -match '"database":"connected"' } catch { $up = $false }
}
if (-not $up) { Fail "The server did not start. Read $Root\data\logs\server.log." }

Write-Host ''
Write-Host 'All done. This PC now has the cloud copy.' -ForegroundColor Green
Write-Host 'Everyone signs in with the phone and password they use on the cloud.'
Write-Host 'From now on take bills here only: the cloud must not take any more bills, or the two would use the same bill numbers.' -ForegroundColor Yellow
Write-Host "Delete $($archive.Name) from this PC and the pen drive: it holds password hashes and guests' phone numbers."
Read-Host 'Press Enter to close'
Start-Process $url
