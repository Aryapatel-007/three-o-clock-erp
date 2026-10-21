@echo off
rem Opens the till in its own Chrome window that prints with no dialog.
rem Double-click this file on the counter computer. Everyday Chrome is left alone:
rem the till runs in a separate Chrome profile, so silent printing only applies there.
rem Before the first use: make the bill printer the computer's default printer.

set TILL_ADDRESS=https://zchaat-pos.vercel.app
rem On the cafe PC the till is the PC itself, not the website: use its own "Cafe POS - Till" icon.
if exist "%SystemDrive%\CafePOS\.env" set TILL_ADDRESS=http://localhost
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe

start "" "%CHROME%" --user-data-dir="%LocalAppData%\Restaurant ERP Till" --kiosk-printing --no-first-run --no-default-browser-check %TILL_ADDRESS%
