@echo off
rem Dakaar: one-time setup. Double-click this, and say Yes when Windows asks.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0box\windows\install.ps1\"'"
