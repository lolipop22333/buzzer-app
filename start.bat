@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Buzzer App

echo Starting Buzzer App...
echo.
node.exe server.js

echo.
echo Server stopped. Press any key to close this window.
pause >nul
