$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Start-Process -FilePath 'node.exe' -ArgumentList "$root\manager\dist\index.js" -WindowStyle Hidden -WorkingDirectory $root
Start-Process 'http://127.0.0.1:39980'
