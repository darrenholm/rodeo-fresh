# One-time setup of the print bridge on the badge check-in laptop.
# Run in a normal (non-admin) PowerShell on the machine the Seaory S25
# is plugged into:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-print-bridge.ps1
#   powershell ... install-print-bridge.ps1 -Printer "Seaory S25"   # pin a printer
#
# What it does:
#   1. checks node.exe is installed and the Seaory printer is visible
#   2. (optional) persists SEAORY_PRINTER_NAME for this user
#   3. drops a shortcut in the user's Startup folder → bridge runs at every logon
#   4. starts the bridge now and verifies http://127.0.0.1:7777/health

param(
  [string]$Printer = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1 — prerequisites
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is not installed (or not on PATH)." -ForegroundColor Red
  Write-Host "Install it first:  winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
  exit 1
}
Add-Type -AssemblyName System.Drawing
$printers = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters)
$seaory = $printers | Where-Object { $_ -match 'seaory|s2\d' } | Select-Object -First 1
if ($Printer) {
  if ($printers -notcontains $Printer) {
    Write-Host "Printer '$Printer' is not installed. Installed: $($printers -join ', ')" -ForegroundColor Red
    exit 1
  }
  Write-Host "Using printer: $Printer"
  # persist for future logons; also used by the process we start below
  [Environment]::SetEnvironmentVariable('SEAORY_PRINTER_NAME', $Printer, 'User')
  $env:SEAORY_PRINTER_NAME = $Printer
} elseif ($seaory) {
  Write-Host "Seaory printer detected: $seaory (auto-detect will use it)"
} else {
  Write-Host "WARNING: no printer matching 'Seaory'/'S2x' found — the bridge will use the Windows default printer." -ForegroundColor Yellow
  Write-Host "Installed printers: $($printers -join ', ')" -ForegroundColor Yellow
  Write-Host "Install the Seaory S25 driver, or re-run with -Printer '<name>'." -ForegroundColor Yellow
}

# 2 — Startup shortcut (per-user; runs in the interactive session so the
#     driver behaves exactly like a staff member printing by hand)
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Rodeo Print Bridge.lnk'
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $here 'start-print-bridge.cmd'
$lnk.WorkingDirectory = $here
$lnk.Description = 'Rodeo badge print bridge (Seaory S25) — must be running for badge printing'
$lnk.Save()
Write-Host "Startup shortcut created: $lnkPath"

# 3 — start it now (in its own window so staff can see job logs)
Start-Process -FilePath (Join-Path $here 'start-print-bridge.cmd') -WorkingDirectory $here
Start-Sleep -Seconds 2

# 4 — verify
try {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7777/health' -TimeoutSec 5
  Write-Host ""
  Write-Host "Print bridge is UP  →  printer: $($h.printer)" -ForegroundColor Green
  Write-Host "Test it from the portal: Badge Admin → any badge → Print." -ForegroundColor Green
} catch {
  Write-Host "Bridge did not answer on http://127.0.0.1:7777 — check the 'Rodeo Print Bridge' window for errors." -ForegroundColor Red
  exit 1
}
