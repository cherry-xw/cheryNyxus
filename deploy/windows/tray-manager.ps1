param(
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$manager = Join-Path $Root 'manager\dist\index.js'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$process = Start-Process -FilePath $node -ArgumentList "`"$manager`"" -WorkingDirectory $Root -WindowStyle Hidden -PassThru

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open local manager')
$open.Add_Click({ Start-Process 'http://127.0.0.1:39980' })
$restart = $menu.Items.Add('Restart manager')
$restart.Add_Click({
  if (!$process.HasExited) { $process.CloseMainWindow() | Out-Null }
  if (!$process.HasExited) { $process.Kill() }
  $script:process = Start-Process -FilePath $node -ArgumentList "`"$manager`"" -WorkingDirectory $Root -WindowStyle Hidden -PassThru
})
$menu.Items.Add('-')
$exit = $menu.Items.Add('Exit')
$exit.Add_Click({
  if (!$process.HasExited) { $process.Kill() }
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = 'CheryNyxus local manager'
$notify.ContextMenuStrip = $menu
$notify.Visible = $true
$notify.Add_DoubleClick({ Start-Process 'http://127.0.0.1:39980' })

[System.Windows.Forms.Application]::Run()
