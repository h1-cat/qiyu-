@echo off
chcp 936 >nul
cd /d "%~dp0"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo 未找到 Edge，请手动打开 https://your-company.qiyukf.com/onsite/monitor
  pause
  exit /b 1
)
set "PROFILE=%TEMP%\qrm-edge-profile"
start "" "%EDGE%" --user-data-dir="%PROFILE%" --load-extension="%~dp0extension" --no-first-run --no-default-browser-check --new-window "https://your-company.qiyukf.com/onsite/monitor"
