# Print a PNG full-bleed on a CR80 card printer (Seaory S25).
# Called by server.js — not meant to be run by hand, but it works standalone:
#   powershell -NoProfile -ExecutionPolicy Bypass -File print-png.ps1 -Path card.png
#
# -Printer '' (default) auto-detects: first installed printer whose name
# matches seaory/s2<digit>, else the Windows default printer.
# The image is auto-rotated to match the driver's page orientation and
# stretched to the full page bounds (no margins — badge art is full-bleed).

param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$Printer = '',
  [string]$DocName = 'Rodeo badge'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Path)) { throw "PNG not found: $Path" }

if (-not $Printer) {
  $installed = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters)
  $Printer = $installed | Where-Object { $_ -match 'seaory|s2\d' } | Select-Object -First 1
  # fall through with '' → PrintDocument uses the Windows default printer
}

$doc = New-Object System.Drawing.Printing.PrintDocument
if ($Printer) { $doc.PrinterSettings.PrinterName = $Printer }
if (-not $doc.PrinterSettings.IsValid) {
  $names = ([System.Drawing.Printing.PrinterSettings]::InstalledPrinters) -join ', '
  throw "Printer '$Printer' not found. Installed printers: $names"
}

$doc.DocumentName = $DocName
# StandardPrintController = no progress dialog (this runs headless from node)
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

$script:img = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Path))

$doc.add_PrintPage({
  param($sender, $e)
  $bounds = $e.PageBounds
  # The pages render the card portrait (638x1012 @ 300 DPI). If the driver's
  # page is landscape, rotate so the art fills the card instead of squashing.
  $imgPortrait  = $script:img.Height -gt $script:img.Width
  $pagePortrait = $bounds.Height -gt $bounds.Width
  if ($imgPortrait -ne $pagePortrait) {
    $script:img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone)
  }
  $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $e.Graphics.DrawImage($script:img, $bounds)
  $e.HasMorePages = $false
})

try {
  $doc.Print()
} finally {
  $script:img.Dispose()
}

# stdout is surfaced by the bridge as the "printed on …" confirmation
Write-Output $doc.PrinterSettings.PrinterName
