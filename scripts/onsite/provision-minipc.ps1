# One-shot provisioning for the GMKtec G10 Mini PC (run AS ADMIN on the Mini PC).
# Installs Postgres 16, Node LTS, Git, Caddy, NSSM, Technitium DNS, win-acme,
# clones the repos, creates the DB, and registers services.
# Interactive bits it will STOP and tell you about: Postgres password,
# .env secrets, cert issuance, DNS overrides.

$ErrorActionPreference = 'Stop'
# PS 5.1 renders a progress bar per chunk during Invoke-WebRequest, throttling
# downloads to a crawl on big files - silence it for the whole run.
$ProgressPreference = 'SilentlyContinue'
$ROOT = 'C:\rodeo'

Write-Host "=== Holmdale Rodeo onsite server provisioning ===" -ForegroundColor Green

# ---- 1. Software ----
# --source winget: the msstore source fails cert checks on some machines and
# aborts the whole install; everything we need lives in the community source.
$pkgs = @(
  # Must match the primary's major version (17): sync-to-standby.ps1 runs the
  # primary's pg_dump/pg_restore against this box, and restoring a v17 dump
  # into a v16 server is not supported.
  @{ id = 'PostgreSQL.PostgreSQL.17'; name = 'Postgres 17' },
  @{ id = 'OpenJS.NodeJS.LTS';        name = 'Node LTS' },
  @{ id = 'Git.Git';                  name = 'Git' },
  @{ id = 'CaddyServer.Caddy';        name = 'Caddy' },
  @{ id = 'NSSM.NSSM';                name = 'NSSM' }
)
foreach ($p in $pkgs) {
  Write-Host "installing $($p.name)..." -ForegroundColor Cyan
  winget install --id $p.id -e --source winget --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { Write-Warning "$($p.name): winget exit $LASTEXITCODE (may already be installed)" }
}

# Installs above modified the machine PATH; pull it into this session so
# git/npm/psql work below without reopening the shell.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

New-Item -ItemType Directory -Force $ROOT | Out-Null

# Technitium DNS is not in winget - fetch the official installer and run it.
# Detect by SERVICE, not path: the installer defaults to Program Files (x86)
# ({commonpf32} in its Inno Setup script), so a Test-Path under plain
# 'Program Files' misses an existing install and relaunches the installer,
# which then blocks at -Wait until a human clicks through it.
if (Get-Service DnsService -ErrorAction SilentlyContinue) {
  Write-Host "Technitium DNS already installed (DnsService exists) - skipping" -ForegroundColor Cyan
} else {
  Write-Host "installing Technitium DNS..." -ForegroundColor Cyan
  $dnsZip = "$env:TEMP\DnsServerSetup.zip"
  Invoke-WebRequest 'https://download.technitium.com/dns/DnsServerSetup.zip' -OutFile $dnsZip -UseBasicParsing
  Expand-Archive $dnsZip -DestinationPath "$env:TEMP\DnsServerSetup" -Force
  $dnsSetup = Get-ChildItem "$env:TEMP\DnsServerSetup" -Filter *.exe -Recurse | Select-Object -First 1
  # Inno Setup installer - run it silent so provisioning never sits on a GUI
  Start-Process $dnsSetup.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait
}

# win-acme is not in winget either - grab the release zip; wacs.exe lands in C:\rodeo\win-acme
if (-not (Test-Path "$ROOT\win-acme\wacs.exe")) {
  Write-Host "installing win-acme..." -ForegroundColor Cyan
  $wacsZip = "$env:TEMP\win-acme.zip"
  Invoke-WebRequest 'https://github.com/win-acme/win-acme/releases/download/v2.2.9.1701/win-acme.v2.2.9.1701.x64.pluggable.zip' -OutFile $wacsZip -UseBasicParsing
  Expand-Archive $wacsZip -DestinationPath "$ROOT\win-acme" -Force
}

# ---- 2. Repos ----
Set-Location $ROOT
if (-not (Test-Path "$ROOT\rodeo-fresh")) { git clone https://github.com/darrenholm/rodeo-fresh.git }
if (-not (Test-Path "$ROOT\holmdale-staff-portal")) { git clone https://github.com/darrenholm/holmdale-staff-portal.git }
Set-Location "$ROOT\rodeo-fresh"; npm install --omit=dev

# ---- 3. Database ----
Write-Host @"

MANUAL STEP - create the database:
  & 'C:\Program Files\PostgreSQL\17\bin\psql' -U postgres -c "CREATE DATABASE rodeo_db"

  The silent installer may not have asked for a superuser password. If psql
  prompts for one you don't know: open C:\Program Files\PostgreSQL\17\data\pg_hba.conf,
  change the METHOD column on the '127.0.0.1/32' and '::1/128' lines to trust,
  run 'Restart-Service postgresql-x64-17', then set one:
    & 'C:\Program Files\PostgreSQL\17\bin\psql' -U postgres -c "ALTER USER postgres PASSWORD 'yourpassword'"
  and change the METHOD lines back to scram-sha-256 + restart again.

MANUAL STEP - secrets:
  1. Copy $ROOT\rodeo-fresh\scripts\onsite\onsite.env.example -> onsite.env and fill in
     (CLOUD_DATABASE_URL from Railway Postgres 'DATABASE_PUBLIC_URL'; local URL with your postgres password)
  2. Create $ROOT\rodeo-fresh\.env with:
       DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/rodeo_db
       (percent-encode reserved chars in <pw> — an '@' must be written %40, or
        libpq reads the rest of the password as the hostname)
       JWT_SECRET=<SAME value as Railway rodeo-fresh service>   <- tokens then work on both
       PORT=3000
       STRIPE_SECRET_KEY=..., STRIPE_WEBHOOK_SECRET=..., MONERIS_*=..., RESEND_API_KEY=...,
       RESEND_FROM_EMAIL=..., BLOB_READ_WRITE_TOKEN=...        <- copy from Railway variables
     Do NOT set NODE_ENV (local Postgres has no SSL).
"@ -ForegroundColor Yellow

# ---- 4. Services (run after the manual steps above) ----
# (plain if/else rather than ?. / ?? so this parses on Windows PowerShell 5.1)
$caddyCmd = Get-Command caddy -ErrorAction SilentlyContinue
$caddyExe = if ($caddyCmd) { $caddyCmd.Source } else { 'C:\Program Files\Caddy\caddy.exe' }
Write-Host @"
Then register services (as admin):

  nssm install RodeoAPI  "C:\Program Files\nodejs\node.exe" "$ROOT\rodeo-fresh\server.js"
  nssm set RodeoAPI AppDirectory "$ROOT\rodeo-fresh"
  nssm set RodeoAPI AppExit Default Restart
  nssm set RodeoAPI Start SERVICE_AUTO_START
  nssm start RodeoAPI

  nssm install RodeoCaddy "$caddyExe" "run --config $ROOT\rodeo-fresh\scripts\onsite\Caddyfile"
  nssm set RodeoCaddy AppDirectory "$ROOT"
  nssm set RodeoCaddy Start SERVICE_AUTO_START
  nssm start RodeoCaddy

Scheduled tasks (paste into PowerShell as-is; the single quotes + \" are what
survive PowerShell 5.1's native-arg handling so schtasks stores a quoted
node.exe path):
  schtasks /Create /TN RodeoTicketSync /SC MINUTE /MO 2 /RU SYSTEM /TR '\"C:\Program Files\nodejs\node.exe\" $ROOT\rodeo-fresh\scripts\onsite\sync-ticket-orders.js'
  schtasks /Create /TN RodeoBackup     /SC MINUTE /MO 15 /RU SYSTEM /TR 'powershell -NoProfile -File $ROOT\rodeo-fresh\scripts\onsite\backup-dump.ps1'

Certs (week before event): run $ROOT\win-acme\wacs.exe, manual DNS-01 for
  staff.holmdalerodeo.ca + api.holmdalerodeo.ca (add the TXT records it prints
  in WHC cPanel Zone Editor). Export PEM files to $ROOT\certs\ as
  fullchain.pem/privkey.pem — one SAN cert covering both names, which is what
  the current Caddyfile loads (the older staff.crt/api.crt split is unused).

Technitium (http://localhost:5380 after install): set forwarders to Starlink/8.8.8.8,
add zones staff.holmdalerodeo.ca and api.holmdalerodeo.ca each with one A record ->
the Mini PC's static LAN IP. DISABLE both zones until cutover night.

Firewall:
  netsh advfirewall firewall add rule name="Rodeo HTTPS" dir=in action=allow protocol=TCP localport=443
  netsh advfirewall firewall add rule name="Rodeo DNS" dir=in action=allow protocol=UDP localport=53
"@ -ForegroundColor Yellow

Write-Host "Provisioning bootstrap done - work through the yellow manual steps above." -ForegroundColor Green
