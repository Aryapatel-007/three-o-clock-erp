@echo off
rem Three O'Clock: set up printing once, for the print window (default) or the till.
rem   printer-setup.cmd           the "Three O'Clock printer" window, which prints captains' bills
rem   printer-setup.cmd Till      the "Three O'Clock - Till" window
rem box\windows\printer-setup.ps1 says why.
set WINDOW=Printer
if /i "%~1"=="Till" set WINDOW=Till
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0printer-setup.ps1" -Window %WINDOW%
pause
