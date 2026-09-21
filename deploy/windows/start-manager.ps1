$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  '-File', "$PSScriptRoot\tray-manager.ps1", '-Root', $root
) -WindowStyle Hidden
