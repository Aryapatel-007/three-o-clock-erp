@echo off
rem Cafe POS: load the copy of the cloud's data onto this PC. Put the cafe-data-....archive.gz in this folder first.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0box\windows\load-data.ps1\"'"
