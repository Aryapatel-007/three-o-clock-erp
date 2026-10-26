@echo off
REM Starts the Tally bridge. Keep this window open while you want vouchers to reach Tally.
cd /d "%~dp0"
node bridge.js run
pause
