# Dump the local event database every 15 minutes (Scheduled Task).
# Keeps the last 300 dumps locally; mirrors the newest to BACKUP_MIRROR_DIR when set/reachable.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-Content (Join-Path $here 'onsite.env') | Where-Object { $_ -match '^\s*[^#=]+=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item "env:$($k.Trim())" $v.Trim()
}

New-Item -ItemType Directory -Force $env:BACKUP_DIR | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmm'
$file = Join-Path $env:BACKUP_DIR "rodeo_$stamp.dump"

& "$($env:PG_BIN)\pg_dump" --no-owner --no-privileges -Fc -f $file $env:LOCAL_DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
Write-Host "backup: $file ($([math]::Round((Get-Item $file).Length/1MB,1)) MB)"

# prune: keep newest 300
Get-ChildItem $env:BACKUP_DIR -Filter 'rodeo_*.dump' | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 300 | Remove-Item -Force -Confirm:$false

# best-effort mirror (OneDrive/UNC/USB) — never fail the backup over the mirror
if ($env:BACKUP_MIRROR_DIR) {
    try {
        New-Item -ItemType Directory -Force $env:BACKUP_MIRROR_DIR | Out-Null
        Copy-Item $file $env:BACKUP_MIRROR_DIR -Force
        Write-Host "mirrored to $($env:BACKUP_MIRROR_DIR)"
    } catch { Write-Host "mirror skipped: $($_.Exception.Message)" }
}
