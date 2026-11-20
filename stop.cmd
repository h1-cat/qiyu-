@echo off
chcp 936 >nul
cd /d "%~dp0"
node stop.js
pause
