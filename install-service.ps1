$ErrorActionPreference = 'Stop'
$root = 'D:\deepseek工作区\七鱼会话监控'
$log = Join-Path $root 'logs\install-service.log'
function Log($m) { "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Out-File $log -Append -Encoding utf8 }
Log '=== start ==='
try {
  $id=[Security.Principal.WindowsIdentity]::GetCurrent()
  $pr=New-Object Security.Principal.WindowsPrincipal($id)
  Log ("admin=" + $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) + " user=" + $id.Name)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/index.mjs*' } | ForEach-Object {
    Log ("stop pid=" + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c cd /d "' + $root + '" && node server\\index.mjs >> logs\\server.log 2>&1') -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName 'QiyuMonitorService' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -User 'SYSTEM' -Force | Out-Null
  Log 'registered'
  Start-ScheduledTask -TaskName 'QiyuMonitorService'
  Log 'started'
  Start-Sleep -Seconds 3
  $t = Get-ScheduledTask -TaskName 'QiyuMonitorService'
  Log ("state=" + $t.State)
} catch {
  Log ("ERROR: " + $_.Exception.Message)
}
