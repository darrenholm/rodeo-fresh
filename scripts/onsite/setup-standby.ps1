# One-shot STANDBY PC configuration. Run AS ADMIN after:
#   1. C:\rodeo has been copied over from the primary (repos, .env, onsite.env, certs)
#   2. provision-minipc.ps1 has run (installs Postgres/Node/Caddy/NSSM/Technitium;
#      it skips repo cloning when C:\rodeo already has the folders)
#
#   powershell -ExecutionPolicy Bypass -File C:\rodeo\rodeo-fresh\scripts\onsite\setup-standby.ps1 `
#       -PostgresPassword <this PC's postgres password> -PrimaryIP <mini PC's LAN IP>
#
# Use the SAME postgres password as the primary — then the copied .env works as-is.
# Handles: database, Postgres LAN access, services, disabled tasks, firewall,
# power settings, onsite.env fixups. The ONE remaining manual step is Technitium
# (it's a web GUI): zones for both hostnames -> A record -> PRIMARY's IP, TTL 30,
# leave disabled until cutover.

param(
    [Parameter(Mandatory = $true)][string]$PostgresPassword,
    [Parameter(Mandatory = $true)][string]$PrimaryIP
)

$ErrorActionPreference = 'Stop'
$ROOT = 'C:\rodeo'
$PGDATA = 'C:\Program Files\PostgreSQL\16\data'
$PGBIN = 'C:\Program Files\PostgreSQL\16\bin'
$env:PGPASSWORD = $PostgresPassword

function Step($label) { Write-Host "== $label ==" -ForegroundColor Cyan }

Step 'Creating rodeo database (if missing)'
$exists = & "$PGBIN\psql" -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='rodeo'"
if ($LASTEXITCODE -ne 0) {
    throw "Cannot talk to Postgres. If the password is unknown, see the pg_hba trust dance in provision-minipc.ps1"
}
if ($exists -ne '1') {
    & "$PGBIN\createdb" -U postgres -h localhost rodeo
    if ($LASTEXITCODE -ne 0) { throw 'createdb failed' }
}

Step 'Allowing the primary to push snapshots (postgresql.conf / pg_hba.conf)'
$conf = Get-Content "$PGDATA\postgresql.conf" -Raw
if ($conf -notmatch "(?m)^\s*listen_addresses\s*=\s*'\*'") {
    Add-Content "$PGDATA\postgresql.conf" "`nlisten_addresses = '*'"
}
$hbaLine = "host    all    postgres    $PrimaryIP/32    scram-sha-256"
$hba = Get-Content "$PGDATA\pg_hba.conf" -Raw
if ($hba -notmatch [regex]::Escape("$PrimaryIP/32")) {
    Add-Content "$PGDATA\pg_hba.conf" "`n$hbaLine"
}
Restart-Service postgresql-x64-16

Step 'onsite.env fixups (this PC is the standby)'
$envFile = "$ROOT\rodeo-fresh\scripts\onsite\onsite.env"
if (-not (Test-Path $envFile)) { throw "$envFile missing - was C:\rodeo copied from the primary?" }
$lines = Get-Content $envFile
$lines = $lines -replace '^LOCAL_DATABASE_URL=.*', "LOCAL_DATABASE_URL=postgresql://postgres:$PostgresPassword@localhost:5432/rodeo"
$lines = $lines -replace '^STANDBY_DATABASE_URL=.+', 'STANDBY_DATABASE_URL='   # standby pushes to nobody
Set-Content $envFile $lines

Step 'Registering services (RodeoAPI, RodeoCaddy)'
$node = (Get-Command node).Source
$caddyCmd = Get-Command caddy -ErrorAction SilentlyContinue
$caddy = if ($caddyCmd) { $caddyCmd.Source } else { 'C:\Program Files\Caddy\caddy.exe' }
if (-not (Get-Service RodeoAPI -ErrorAction SilentlyContinue)) {
    nssm install RodeoAPI $node "$ROOT\rodeo-fresh\server.js"
    nssm set RodeoAPI AppDirectory "$ROOT\rodeo-fresh"
    nssm set RodeoAPI AppExit Default Restart
    nssm set RodeoAPI Start SERVICE_AUTO_START
}
if (-not (Get-Service RodeoCaddy -ErrorAction SilentlyContinue)) {
    nssm install RodeoCaddy $caddy "run --config $ROOT\rodeo-fresh\scripts\onsite\Caddyfile"
    nssm set RodeoCaddy AppDirectory $ROOT
    nssm set RodeoCaddy Start SERVICE_AUTO_START
}
Start-Service RodeoAPI, RodeoCaddy

Step 'Scheduled tasks (created DISABLED - enabled only if this PC is promoted)'
# \" (not `") around $node: PowerShell 5.1 wraps a whitespace-containing native
# arg in quotes WITHOUT escaping embedded ones, so `" reaches schtasks as
# ""C:\Program... and the /TR value splits. Backslash-escaped quotes survive.
$syncTr = "\`"$node\`" $ROOT\rodeo-fresh\scripts\onsite\sync-ticket-orders.js"
schtasks /Create /F /TN RodeoTicketSync /SC MINUTE /MO 2 /RU SYSTEM /DISABLE /TR $syncTr | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'schtasks failed creating RodeoTicketSync' }
schtasks /Create /F /TN RodeoBackup /SC MINUTE /MO 15 /RU SYSTEM /DISABLE `
    /TR "powershell -NoProfile -File $ROOT\rodeo-fresh\scripts\onsite\backup-dump.ps1" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'schtasks failed creating RodeoBackup' }

Step 'Firewall (HTTPS, DNS, Postgres from primary only)'
netsh advfirewall firewall add rule name="Rodeo HTTPS" dir=in action=allow protocol=TCP localport=443 | Out-Null
netsh advfirewall firewall add rule name="Rodeo DNS" dir=in action=allow protocol=UDP localport=53 | Out-Null
netsh advfirewall firewall add rule name="Rodeo PG from primary" dir=in action=allow protocol=TCP localport=5432 remoteip=$PrimaryIP | Out-Null

Step 'Power settings (never sleep)'
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Step 'Health check'
Start-Sleep -Seconds 3
try {
    Invoke-RestMethod 'http://localhost:3000/health' -TimeoutSec 10 | Out-Null
    Write-Host 'API healthy.' -ForegroundColor Green
} catch {
    Write-Warning 'API not answering /health yet - check .env (JWT_SECRET, DATABASE_URL password) and: nssm status RodeoAPI'
}

Write-Host @"

Standby setup done. ONE manual step left - Technitium (http://localhost:5380):
  - set forwarders (Starlink DNS / 8.8.8.8)
  - add zones staff.holmdalerodeo.ca + api.holmdalerodeo.ca
    each: one A record -> $PrimaryIP  (the PRIMARY, not this PC), TTL 30
  - leave both zones DISABLED until cutover night

At the grounds (on the PRIMARY): set STANDBY_DATABASE_URL in onsite.env to
this PC, create the RodeoStandbySync task, and watch one sync land.
"@ -ForegroundColor Yellow
