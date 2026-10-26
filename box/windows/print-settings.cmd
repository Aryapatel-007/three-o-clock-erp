@echo off
rem Cafe POS: see every browser's print settings on this PC, copy the ones that
rem print the bill right into the Cafe POS windows, or clear a broken paper size.
rem box\windows\print-settings.ps1 says how.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0print-settings.ps1"
pause
