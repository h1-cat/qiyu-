@echo off
chcp 936 >nul
cd /d "%~dp0"
title 七鱼会话监控 - 停止
echo 正在停止监控服务...
node stop.js
echo.
echo 已停止。七鱼监控端标签可以手动关闭。
timeout /t 3 >nul
