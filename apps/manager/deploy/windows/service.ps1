param(
  [switch]$install,
  [switch]$uninstall
)

$ErrorActionPreference = 'Stop'
$root = if ($env:CHERY_MANAGER_ROOT) { $env:CHERY_MANAGER_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path }
$taskName = 'CheryNyxus Local Manager'
$trayScript = Join-Path $PSScriptRoot 'tray-manager.ps1'

if ($install) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$trayScript`" -Root `"$root`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'cheryNyxus local manager tray launcher' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Output "已安装并启动 Windows 登录任务：$taskName"
  exit 0
}

if ($uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "已卸载 Windows 登录任务：$taskName"
  exit 0
}

throw '用法：service.ps1 -install 或 -uninstall'
