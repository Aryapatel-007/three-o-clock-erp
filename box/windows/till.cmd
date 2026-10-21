@echo off
rem Cafe POS: the till on this cafe PC, in its own browser window that prints with no dialog.
rem Opened by the "Cafe POS - Till" desktop icon the installer makes. P62, tools\silent-printing\README.md.
rem It opens this PC's own address, never the website, so captains' bills and the counter
rem are on the same server. Chrome if it is installed, else Edge; both take --kiosk-printing.
rem Before the first use: make the bill printer this PC's default printer.

set ROOT=%~dp0..\..
set PORT=80
if exist "%ROOT%\.env" for /f "tokens=2 delims==" %%p in ('findstr /b /c:"PORT=" "%ROOT%\.env"') do set PORT=%%p
set TILL_ADDRESS=http://localhost
if not "%PORT%"=="80" set TILL_ADDRESS=http://localhost:%PORT%

set BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%BROWSER%" set BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%BROWSER%" set BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe
if not exist "%BROWSER%" set BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if not exist "%BROWSER%" set BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe

start "" "%BROWSER%" --user-data-dir="%LocalAppData%\Cafe POS Till" --kiosk-printing --no-first-run --no-default-browser-check %TILL_ADDRESS%
