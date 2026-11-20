# 停止本机监控服务
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'logs/server.pid'
if (-not (Test-Path $pidFile)) { Write-Host '[info] 未找到 server.pid'; exit 0 }
$serverPid = [int](Get-Content $pidFile | Select-Object -First 1)
$proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($proc) {
    Stop-Process -Id $serverPid -Force
    Write-Host "[ok] 已停止 PID=$serverPid" -ForegroundColor Green
} else {
    Write-Host "[info] 进程不存在（可能已退出）"
}
Remove-Item $pidFile -ErrorAction SilentlyContinue
