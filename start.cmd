@echo off
rem Khmer AI Dubber - the one command: installs everything the first time, then starts the app.
rem Double-click it, or run:  start.cmd
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
