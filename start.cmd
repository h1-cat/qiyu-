@echo off
chcp 936 >nul
cd /d "%~dp0"
node start.js
if errorlevel 1 pause
timeout /t 1 >nul
