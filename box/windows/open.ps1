# Three O'Clock desktop icon: start the server if it is not running, then open the screens.
# P62. Called hidden by open.vbs. Argument: the page to open ("" or "connect").
param([string]$Page = '')
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$port = 80
$line = Select-String -Path (Join-Path $Root '.env') -Pattern '^PORT=(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
$url = if ($port -eq 80) { 'http://localhost' } else { "http://localhost:$port" }
# The server listens on IPv4 only. Windows tries localhost as IPv6 first and takes
# about 2 seconds to be refused there, the whole timeout below, so the check asks 127.0.0.1.
$probe = if ($port -eq 80) { 'http://127.0.0.1' } else { "http://127.0.0.1:$port" }

function Test-Up {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$probe/api/v1/network/ping").StatusCode -eq 200 } catch { return $false }
}

if (-not (Test-Up)) {
  # Normally the server is already running from Windows start-up; this is the fallback.
  try { Start-ScheduledTask -TaskName 'ThreeOClock Server' -ErrorAction Stop } catch {
    $logDir = Join-Path $Root 'data\logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/c node server\server.js >> `"$logDir\server.log`" 2>&1" -WorkingDirectory $Root -WindowStyle Hidden
  }
  for ($i = 0; $i -lt 60 -and -not (Test-Up); $i++) { Start-Sleep -Seconds 1 }
}

if (Test-Up) {
  # 2026-10-22. "Three O'Clock" opens the till, printing with no dialog: nobody chooses a browser or a launcher.
  . (Join-Path $PSScriptRoot 'start-till.ps1')
  if ($Page -or -not (Open-Till "$url/?till=1")) { Start-Process "$url/$Page" }
} else {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("The cafe server did not start.`n`nCheck that this PC is switched on fully, wait one minute and try again.`nIf it still fails, open $Root\data\logs\server.log and send it to the person who set this up.", 'Three O''Clock') | Out-Null
}
