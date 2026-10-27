@echo off
rem Three O'Clock: connect this PC to the website (two-way sync, a copy on Atlas). Run "Load cafe data" first.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0box\windows\connect-website.ps1\"'"
