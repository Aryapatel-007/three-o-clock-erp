# ThreeOClock: stops the running server, so ThreeOClock-Setup.exe can replace the app's files
# while nothing has them open. Run by the installer before it copies anything, on an
# update over an installed PC. The scheduled tasks stay registered: install.ps1
# starts the server again at the end. The database (MongoDB) keeps running.
Stop-ScheduledTask -TaskName 'ThreeOClock Server' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*server\server.js*' -or $_.CommandLine -like '*box\windows\update.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
