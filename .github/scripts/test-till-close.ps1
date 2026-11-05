# Proves "Close ThreeOClock" on real Windows with a real browser. Run by build-installer.yml
# before the installer is built, so a broken script never reaches a PC.
$ErrorActionPreference = 'Stop'
$Win = Join-Path (Get-Location) 'box\windows'
. (Join-Path $Win 'start-till.ps1')

function Run-Script([string]$Name, [string[]]$More = @()) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Win $Name) @More
  if ($LASTEXITCODE -ne 0) { throw "$Name exited with $LASTEXITCODE" }
}
function Wait-For([scriptblock]$Condition, [string]$What) {
  for ($i = 0; $i -lt 60; $i++) {
    if (& $Condition) { Write-Host "ok: $What"; return }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for: $What"
}
function Stop-Till {
  foreach ($process in @(Get-TillProcess)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Every script parses in Windows PowerShell 5.1, the one the PCs run.
foreach ($file in Get-ChildItem $Win -Filter *.ps1) {
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
  if ($errors) { throw "$($file.Name): $($errors -join '; ')" }
}
Write-Host 'ok: every script parses'
if (-not (Get-TillBrowser)) { throw 'No Chrome or Edge on this machine.' }

# Stands in for the server: the scripts only ask whether the port in .env answers. Not port
# 80, which is taken on GitHub's machines. .env is git-ignored and removed below.
$Port = 8099
$EnvFile = Join-Path (Get-Location) '.env'
Set-Content -LiteralPath $EnvFile -Value "PORT=$Port"
$serverFile = Join-Path $env:TEMP 'fake-server.js'
$serverLog = Join-Path $env:TEMP 'fake-server.err.log'
Set-Content -LiteralPath $serverFile -Value "require('http').createServer((q,s)=>s.end('ok')).listen($Port,'127.0.0.1')"
$server = Start-Process -FilePath 'node' -ArgumentList "`"$serverFile`"" -PassThru -NoNewWindow -RedirectStandardError $serverLog
try {
  try {
    Wait-For { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/api/v1/network/ping").StatusCode -eq 200 } catch { $false } } 'the stand-in server answers'
  } catch {
    Write-Host "Stand-in server's errors: $(Get-Content -LiteralPath $serverLog -Raw -ErrorAction SilentlyContinue)"
    throw
  }
  Clear-TillClosedForGood

  Run-Script 'print-agent.ps1'
  Wait-For { Test-TillOpen } 'the every-minute task opens a closed till'

  Stop-Till
  Wait-For { -not (Test-TillOpen) } 'the till closed by mistake'
  Run-Script 'print-agent.ps1'
  Wait-For { Test-TillOpen } 'a till closed by mistake comes back'

  Run-Script 'close.ps1' @('-Yes')
  Wait-For { -not (Test-TillOpen) } 'Close ThreeOClock closes the till'
  if (-not (Test-TillClosedForGood)) { throw 'Close ThreeOClock left no flag.' }
  Write-Host 'ok: the flag is set'

  Run-Script 'print-agent.ps1'
  Start-Sleep -Seconds 8
  if (Test-TillOpen) { throw 'The every-minute task reopened a till closed for good.' }
  Write-Host 'ok: the every-minute task leaves it closed'

  Run-Script 'open.ps1'
  Wait-For { Test-TillOpen } 'the ThreeOClock icon opens it again'
  if (Test-TillClosedForGood) { throw 'The ThreeOClock icon left the flag set.' }
  Write-Host 'ok: the flag is cleared'

  Stop-Till
  Wait-For { -not (Test-TillOpen) } 'the till closed by mistake again'
  Run-Script 'print-agent.ps1'
  Wait-For { Test-TillOpen } 'after opening again, a till closed by mistake comes back'
} finally {
  Stop-Till
  Clear-TillClosedForGood
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $EnvFile -Force -ErrorAction SilentlyContinue
}
Write-Host 'All till close checks passed.'
