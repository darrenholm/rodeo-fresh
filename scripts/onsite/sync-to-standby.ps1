# Push the primary's local DB to the STANDBY PC every 2 minutes (Scheduled Task
# RodeoStandbySync on the PRIMARY only). One-way primary -> standby.
# Quietly does nothing when STANDBY_DATABASE_URL is blank or the standby is
# off/unreachable — a missing standby must never break the primary.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-Content (Join-Path $here 'onsite.env') | Where-Object { $_ -match '^\s*[^#=]+=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item "env:$($k.Trim())" $v.Trim()
}

if (-not $env:STANDBY_DATABASE_URL) {
    Write-Host "standby sync: STANDBY_DATABASE_URL not set - nothing to do"
    exit 0
}

$tmp = Join-Path $env:TEMP 'rodeo_standby_sync.dump'

& "$($env:PG_BIN)\pg_dump" --no-owner --no-privileges -Fc -f $tmp $env:LOCAL_DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw "pg_dump of local db failed" }

# --clean --if-exists: standby becomes an exact copy; its API can stay running
# (idle pool connections don't block drops, and nothing writes to the standby).
& "$($env:PG_BIN)\pg_restore" --clean --if-exists --no-owner --no-privileges `
    -d $env:STANDBY_DATABASE_URL $tmp
if ($LASTEXITCODE -ne 0) {
    # Expected whenever the standby is powered off or mid-boot.
    Write-Host "standby sync: standby unreachable or restore failed - will retry next run"
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    exit 0
}

Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Write-Host "standby sync: ok $(Get-Date -Format 'HH:mm:ss')"
