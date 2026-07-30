@echo off
rem Rodeo Print Bridge — keeps the bridge running; relaunches it if it crashes.
rem Staff can double-click this, or let the Startup shortcut from
rem install-print-bridge.ps1 run it at logon. Leave the window open —
rem it shows every print job and any error from the Seaory driver.
title Rodeo Print Bridge (Seaory S25)
cd /d "%~dp0"
:loop
node server.js
echo.
echo Print bridge stopped (see error above) — restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
