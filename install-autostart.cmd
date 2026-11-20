@echo off
chcp 936 >nul
cd /d "%~dp0"
echo 正在注册开机自启...
schtasks /create /tn "七鱼会话监控服务" /tr "\"%~dp0start.cmd\"" /sc onlogon /rl highest /f >nul 2>&1
if errorlevel 1 (
  echo [失败] 服务自启注册失败，请右键“以管理员身份运行”
) else (
  echo [成功] 登录 Windows 后自动启动监控服务
)
schtasks /create /tn "七鱼监控端" /tr "\"%~dp0open-qiyu.cmd\"" /sc onlogon /rl highest /f >nul 2>&1
if errorlevel 1 (
  echo [失败] 监控端自启注册失败
) else (
  echo [成功] 登录 Windows 后自动打开七鱼监控端
)
echo.
echo 完成后：开机登录 -^> 服务自动运行 -^> 监控端自动打开 -^> 飞书收告警
echo 不需要每天手动启动监控台。
pause
