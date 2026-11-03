# ThreeOClock: run by the uninstaller (Windows Settings, Apps, ThreeOClock) before it removes
# the app's files. Stops the server and removes what install.ps1 added to Windows.
# The database (MongoDB), data\ and .env are left alone, so nothing is lost.
foreach ($task in @('ThreeOClock Server', 'ThreeOClock Snapshot', 'ThreeOClock Update', 'ThreeOClock Printer')) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*server\server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetFirewallRule -DisplayName 'ThreeOClock' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
