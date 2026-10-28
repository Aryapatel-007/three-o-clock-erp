@echo off
rem Three O'Clock: start fresh before go-live. Removes the duplicate restaurant and every test bill; keeps the menu, tables and staff.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0box\windows\start-fresh.ps1\"'"
