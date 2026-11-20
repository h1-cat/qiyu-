# 启动七鱼会话 AI 风险监控（本机）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path (Join-Path $root '.env'))) {
    Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env')
    Write-Host '[setup] 已生成 .env，请按需填写 FEISHU_WEBHOOK / LLM_API_KEY' -ForegroundColor Yellow
}

$logs = Join-Path $root 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host '[error] 未找到 node，请先安装 Node.js >= 20' -ForegroundColor Red; exit 1 }

$outLog = Join-Path $logs 'server.log'
$errLog = Join-Path $logs 'server.err.log'
$proc = Start-Process -FilePath $node.Source -ArgumentList 'server/index.mjs' -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$proc.Id | Out-File -FilePath (Join-Path $logs 'server.pid') -Encoding ascii

Start-Sleep -Seconds 2
$url = 'http://127.0.0.1:8787'
try {
    $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 5
    Write-Host "[ok] 服务已启动，PID=$($proc.Id)，会话数=$($health.sessions)，消息数=$($health.stats.messages)" -ForegroundColor Green
} catch {
    Write-Host "[warn] 服务可能未就绪，查看日志：$errLog" -ForegroundColor Yellow
}

Start-Process $url
Write-Host "[info] 监控台：$url"
Write-Host '[info] 首次使用请在 Edge/Chrome 的扩展页加载 extension 目录（开发者模式）' -ForegroundColor Cyan
