# ThreeOClock: the "Close ThreeOClock" desktop icon. 2026-11-05. Closes the till for good: the
# "ThreeOClock Printer" task leaves it closed, across restarts, until the "ThreeOClock" icon
# opens it again. The server keeps running, so phones and tablets stay connected.
# Called hidden by close.vbs. -Yes skips the question.
# Written in plain ASCII for Windows PowerShell 5.1.
param([switch]$Yes)

. (Join-Path $PSScriptRoot 'start-till.ps1')
Add-Type -AssemblyName PresentationFramework

if (-not $Yes) {
  $question = "Close ThreeOClock on this computer?`n`nIt stays closed until you open the ThreeOClock icon, even after a restart. Until then, bills sent to the counter by captains will not print here.`n`nPhones and tablets stay connected."
  # DefaultDesktopOnly: this script has no window, so the question must come to the front by itself.
  $answer = [System.Windows.MessageBox]::Show($question, 'Close ThreeOClock', 'YesNo', 'Question', 'No', 'DefaultDesktopOnly')
  if ($answer -ne 'Yes') { exit 0 }
}

# The file first: the every-minute task must not reopen what is about to close.
try {
  Set-TillClosedForGood
} catch {
  [System.Windows.MessageBox]::Show("ThreeOClock could not be closed for good: $($_.Exception.Message)`n`nNothing was closed.", 'Close ThreeOClock', 'OK', 'Error', 'OK', 'DefaultDesktopOnly') | Out-Null
  exit 1
}

# Ask the window to close, as its X does, so the browser saves the sign-in cleanly.
foreach ($process in @(Get-TillProcess)) {
  $running = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
  if ($running -and $running.MainWindowHandle -ne 0) { [void]$running.CloseMainWindow() }
}
for ($i = 0; $i -lt 10 -and (Test-TillOpen); $i++) { Start-Sleep -Milliseconds 500 }

# Anything still running after five seconds is stopped.
foreach ($process in @(Get-TillProcess)) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
exit 0
