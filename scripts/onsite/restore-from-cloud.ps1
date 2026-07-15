# Restore the cloud (Railway) database onto the local Mini PC Postgres.
# Run once at cutover (Jul 30 evening). DESTRUCTIVE to the local DB only.
#
#   powershell -File restore-from-cloud.ps1 [-Force]
#
# After restoring, bumps every SERIAL sequence by +100000 so rows created
# locally during the event can never collide with cloud IDs at merge-back.

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Load onsite.env
$envFile = Join-Path $here 'onsite.env'
if (-not (Test-Path $envFile)) { throw "Missing $envFile — copy onsite.env.example and fill it in." }
Get-Content $envFile | Where-Object { $_ -match '^\s*[^#=]+=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item "env:$($k.Trim())" $v.Trim()
}

$pgBin = $env:PG_BIN
$cloud = $env:CLOUD_DATABASE_URL
$local = $env:LOCAL_DATABASE_URL
if (-not $cloud -or -not $local) { throw 'CLOUD_DATABASE_URL / LOCAL_DATABASE_URL not set in onsite.env' }

# Local connection pieces (psql needs db name separate for drop/create)
$localUri = [Uri]($local -replace '^postgresql://', 'http://')
$localDb  = $localUri.AbsolutePath.Trim('/')
$localAdmin = $local -replace "/$([regex]::Escape($localDb))(\?|$)", '/postgres$1'

if (-not $Force) {
    Write-Host "This DROPS local database '$localDb' and replaces it with the cloud copy." -ForegroundColor Yellow
    $answer = Read-Host "Type YES to continue"
    if ($answer -ne 'YES') { Write-Host 'Aborted.'; exit 1 }
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$dump = Join-Path $env:TEMP "cloud_restore_$stamp.dump"

Write-Host "1/4 Dumping cloud database..." -ForegroundColor Cyan
& "$pgBin\pg_dump" --no-owner --no-privileges -Fc -f $dump $cloud
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed' }
Write-Host ("    dump: {0:N1} MB" -f ((Get-Item $dump).Length / 1MB))

Write-Host "2/4 Recreating local database '$localDb'..." -ForegroundColor Cyan
& "$pgBin\psql" $localAdmin -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $localDb WITH (FORCE)"
& "$pgBin\psql" $localAdmin -v ON_ERROR_STOP=1 -c "CREATE DATABASE $localDb"
if ($LASTEXITCODE -ne 0) { throw 'recreate database failed' }

Write-Host "3/4 Restoring..." -ForegroundColor Cyan
& "$pgBin\pg_restore" --no-owner --no-privileges -d $local $dump
# pg_restore returns 1 on harmless ownership warnings; verify with a real query instead
& "$pgBin\psql" $local -v ON_ERROR_STOP=1 -t -c "SELECT COUNT(*) FROM wristbands" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'restore verification failed (wristbands table missing)' }

Write-Host "4/4 Bumping SERIAL sequences by +100000 (merge-back safety)..." -ForegroundColor Cyan
$bumpSql = @'
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT sequencename AS seq FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('SELECT setval(%L, (SELECT last_value FROM %I) + 100000)', r.seq, r.seq);
    RAISE NOTICE 'bumped %', r.seq;
  END LOOP;
END $$;
'@
& "$pgBin\psql" $local -v ON_ERROR_STOP=1 -c $bumpSql
if ($LASTEXITCODE -ne 0) { throw 'sequence bump failed' }

Remove-Item $dump -Force

Write-Host ""
Write-Host "Row counts (local):" -ForegroundColor Green
& "$pgBin\psql" $local -c "SELECT 'wristbands' t, COUNT(*) FROM wristbands UNION ALL SELECT 'ticket_orders', COUNT(*) FROM ticket_orders UNION ALL SELECT 'drinks', COUNT(*) FROM drinks UNION ALL SELECT 'products', COUNT(*) FROM products UNION ALL SELECT 'staff', COUNT(*) FROM staff"
Write-Host "Done. Local DB is ready — record the cutover time for merge-back: $(Get-Date -Format o)" -ForegroundColor Green
Set-Content (Join-Path $here 'CUTOVER_TIME.txt') (Get-Date -Format o)
