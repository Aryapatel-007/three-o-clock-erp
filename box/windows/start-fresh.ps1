# Three O'Clock: start fresh before go-live, on this PC (2026-10-28).
#
# Run by double-clicking "Start fresh.bat" in C:\ThreeOClock, at night with
# billing stopped on this PC and on the website.
#
# It removes the duplicate restaurant "Three Oclock" the setup made, gives the
# real restaurant's owner login Dhruv Soni's phone and password, and clears every
# test order, KOT, bill, payment, cash book entry, Day Close and activity line,
# so the next bill is 2026-27/000001. The menu, tables, stations, staff, settings
# and payment methods stay. It takes a snapshot first, and backs up everything it
# removes. The server keeps running: two-way sync carries the changes to the
# website. Written in plain ASCII for Windows PowerShell 5.1.

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
$Keep = 'Three O''Clock Cafe'
$Duplicate = 'Three Oclock'

function Fail($text) {
  Write-Host ''
  Write-Host "STOPPED: $text" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
function Invoke-Tool([scriptblock]$command) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $saved }
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
# Runs start-fresh.mjs, shows its lines, and gives back its last line as an object.
function Invoke-StartFresh([string[]]$extra) {
  $script = Join-Path $PSScriptRoot 'start-fresh.mjs'
  Push-Location $Root
  try {
    $output = Invoke-Tool { node $script --uri $mongoUri --keep $Keep --remove $Duplicate --move-owner @extra }
  } finally { Pop-Location }
  $output | Where-Object { $_ -notmatch '^\{' } | Out-Host
  $jsonLine = $output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  if (-not $jsonLine) { Fail 'The script did not finish. Read the lines above.' }
  $result = $jsonLine | ConvertFrom-Json
  if (-not $result.ok) { Fail $result.message }
  return $result
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Run this as Administrator: double-click "Start fresh.bat", and say Yes when Windows asks.'
}
if (-not (Test-Path $EnvFile)) { Fail 'Three O''Clock is not installed here yet.' }
Refresh-Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is missing. Run "Install ThreeOClock" again.' }
if (-not (Get-Command mongodump -ErrorAction SilentlyContinue)) { Fail 'mongodump is missing. Run "Install ThreeOClock" again: it installs the MongoDB tools.' }

$uriLine = Select-String -Path $EnvFile -Pattern '^MONGO_URI=(.+)$' | Select-Object -First 1
if (-not $uriLine) { Fail 'MONGO_URI is missing from .env.' }
$mongoUri = $uriLine.Matches[0].Groups[1].Value.Trim()
if ($mongoUri -notmatch '^mongodb://(127\.0\.0\.1|localhost)[:/]') { Fail "This PC's MONGO_URI is not this PC ($mongoUri). Not touching it." }
$dbName = ([regex]::Match($mongoUri, '^mongodb://[^/]+/([^?]+)')).Groups[1].Value
if (-not $dbName) { Fail 'MONGO_URI names no database.' }
$serverUri = ($mongoUri -replace '^(mongodb://[^/]+)/[^?]*', '$1/')

Write-Host 'Start fresh' -ForegroundColor Green
Write-Host '== What it will do (nothing is changed yet)'
$plan = Invoke-StartFresh @()
$bills = [int]$plan.bills
Write-Host ''
Write-Host "Every order and all $bills bills of $Keep are removed for good, and bill numbers start again at 000001." -ForegroundColor Yellow
Write-Host 'Do this only if none of them was given to a paying guest, with billing stopped here and on the website.' -ForegroundColor Yellow
$answer = Read-Host "Type the number of bills ($bills) to go on"
if ($answer -ne "$bills") { Fail 'Nothing was changed.' }

$stamp = Get-Date -Format yyyyMMdd-HHmm
Write-Host ''
Write-Host '== Snapshot of the whole database first'
New-Item -ItemType Directory -Force -Path $SnapDir | Out-Null
$before = Join-Path $SnapDir "before-start-fresh-$stamp.archive.gz"
Invoke-Tool { mongodump "--uri=$serverUri" "--db=$dbName" --gzip "--archive=$before" } | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'The snapshot failed, so nothing was changed.' }
Write-Host "Kept $before"

Write-Host '== Starting fresh'
$backupDir = Join-Path $Root "data\backups\start-fresh-$stamp"
$done = Invoke-StartFresh @('--confirm-bills', "$bills", '--apply', '--backup-dir', $backupDir)
if (-not $done.applied) { Fail 'It did not run. Read the lines above.' }
Write-Host "Done here. Removed records are also in $backupDir" -ForegroundColor Green

# Sync carries this to the website within a minute or two. What the website had changed
# meanwhile can come back once; it is cleared again here, never more bills than agreed.
Write-Host ''
Write-Host '== Waiting for sync (about 3 minutes)'
for ($round = 1; $round -le 3; $round++) {
  Start-Sleep -Seconds 60
  $again = Invoke-StartFresh @('--confirm-bills', "$bills", '--apply', '--backup-dir', "$backupDir-again-$round")
  $left = @($again.wipe.PSObject.Properties).Count + @($again.remove.PSObject.Properties).Count
  if ($left -eq 0) { Write-Host "Round ${round}: nothing came back." } else { Write-Host "Round ${round}: cleared again what came back from the website." -ForegroundColor Yellow }
}

Write-Host ''
Write-Host 'All done on this PC.' -ForegroundColor Green
Write-Host "Owner login: $($done.owner.name), phone ending $($done.owner.phoneEnds), with Dhruv Soni's password."
Write-Host "Tell the developer it has run, with this id: $($done.duplicateId)"
Write-Host 'They check the website and clear what it held back. Bill no one until they say it is clean.'
Read-Host 'Press Enter to close'
