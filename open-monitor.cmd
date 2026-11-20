@echo off
chcp 936 >nul
cd /d "%~dp0"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo 未找到 Edge，请手动打开浏览器访问 http://127.0.0.1:8787
  pause
  exit /b 1
)
set "PROFILE=%TEMP%\qrm-edge-profile"
if not exist "logs" mkdir logs
"%EDGE%" --user-data-dir="%PROFILE%" --load-extension="%~dp0extension" --no-first-run --no-default-browser-check --new-window "http://127.0.0.1:8787" "https://your-company.qiyukf.com/onsite/monitor"
