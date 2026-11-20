@echo off
chcp 936 >nul
cd /d "%~dp0"
title 七鱼会话监控
echo ========================================
echo   七鱼会话监控 - 一键启动
echo ========================================
echo.
echo [1/2] 启动后台监控服务...
node start.js
echo.
echo [2/2] 打开七鱼监控端（带扩展）...
start "" "%~dp0open-qiyu.cmd"
echo.
echo 启动完成。
echo 监控台（需要时再打开）：http://127.0.0.1:8787
echo 飞书会接收中高风险告警。
timeout /t 4 >nul
