@echo off
chcp 936 >nul
schtasks /delete /tn "七鱼会话监控服务" /f >nul 2>&1
schtasks /delete /tn "七鱼监控端" /f >nul 2>&1
echo 已取消开机自启。
pause
