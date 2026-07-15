# One-shot provisioning for the GMKtec G10 Mini PC (run AS ADMIN on the Mini PC).
# Installs Postgres 16, Node LTS, Git, Caddy, NSSM, Technitium DNS, win-acme,
# clones the repos, creates the DB, and registers services.
# Interactive bits it will STOP and tell you about: Postgres password,
# .env secrets, cert issuance, DNS overrides.

$ErrorActionPreference = 'Stop'
$ROOT = 'C:\rodeo'

Write-Host "=== Holmdale Rodeo onsite server provisioning ===" -ForegroundColor Green

# ---- 1. Software ----
$pkgs = @(
  @{ id = 'PostgreSQL.PostgreSQL.16'; name = 'Postgres 16' },
  @{ id = 'OpenJS.NodeJS.LTS';        name = 'Node LTS' },
  @{ id = 'Git.Git';                  name = 'Git' },
  @{ id = 'CaddyServer.Caddy';        name = 'Caddy' },
  @{ id = 'NSSM.NSSM';                name = 'NSSM' },
  @{ id = 'TechnitiumSoftware.DNSServer'; name = 'Technitium DNS' },
  @{ id = 'win-acme.win-acme';        name = 'win-acme' }
)
foreach ($p in $pkgs) {
  Write-Host "installing $($p.name)..." -ForegroundColor Cyan
  winget install --id $p.id -e --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { Write-Warning "$($p.name): winget exit $LASTEXITCODE (may already be installed)" }
}

# ---- 2. Repos ----
New-Item -ItemType Directory -Force $ROOT | Out-Null
Set-Location $ROOT
if (-not (Test-Path "$ROOT\rodeo-fresh")) { git clone https://github.com/darrenholm/rodeo-fresh.git }
if (-not (Test-Path "$ROOT\holmdale-staff-portal")) { git clone https://github.com/darrenholm/holmdale-staff-portal.git }
Set-Location "$ROOT\rodeo-fresh"; npm install --omit=dev

# ---- 3. Database ----
Write-Host @"

MANUAL STEP — create the database (Postgres asked for a superuser password during install):
  & 'C:\Program Files\PostgreSQL\16\bin\psql' -U postgres -c "CREATE DATABASE rodeo"

MANUAL STEP — secrets:
  1. Copy $ROOT\rodeo-fresh\scripts\onsite\onsite.env.example -> onsite.env and fill in
     (CLOUD_DATABASE_URL from Railway Postgres 'DATABASE_PUBLIC_URL'; local URL with your postgres password)
  2. Create $ROOT\rodeo-fresh\.env with:
       DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/rodeo
       JWT_SECRET=<SAME value as Railway rodeo-fresh service>   <- tokens then work on both
       PORT=3000
       STRIPE_SECRET_KEY=..., STRIPE_WEBHOOK_SECRET=..., MONERIS_*=..., RESEND_API_KEY=...,
       RESEND_FROM_EMAIL=..., BLOB_READ_WRITE_TOKEN=...        <- copy from Railway variables
     Do NOT set NODE_ENV (local Postgres has no SSL).
"@ -ForegroundColor Yellow

# ---- 4. Services (run after the manual steps above) ----
Write-Host @"
Then register services (as admin):

  nssm install RodeoAPI  "C:\Program Files\nodejs\node.exe" "$ROOT\rodeo-fresh\server.js"
  nssm set RodeoAPI AppDirectory "$ROOT\rodeo-fresh"
  nssm set RodeoAPI AppExit Default Restart
  nssm set RodeoAPI Start SERVICE_AUTO_START
  nssm start RodeoAPI

  nssm install RodeoCaddy "$((Get-Command caddy -ErrorAction SilentlyContinue)?.Source ?? 'C:\Program Files\Caddy\caddy.exe')" "run --config $ROOT\rodeo-fresh\scripts\onsite\Caddyfile"
  nssm set RodeoCaddy AppDirectory "$ROOT"
  nssm set RodeoCaddy Start SERVICE_AUTO_START
  nssm start RodeoCaddy

Scheduled tasks:
  schtasks /Create /TN RodeoTicketSync /SC MINUTE /MO 2 /RU SYSTEM /TR "\"C:\Program Files\nodejs\node.exe\" $ROOT\rodeo-fresh\scripts\onsite\sync-ticket-orders.js"
  schtasks /Create /TN RodeoBackup     /SC MINUTE /MO 15 /RU SYSTEM /TR "powershell -NoProfile -File $ROOT\rodeo-fresh\scripts\onsite\backup-dump.ps1"

Certs (week before event): run win-acme (wacs.exe), manual DNS-01 for
  staff.holmdalerodeo.ca + api.holmdalerodeo.ca (add the TXT records it prints
  in WHC cPanel Zone Editor). Export PEM files to $ROOT\certs\ as
  staff.crt/staff.key/api.crt/api.key (paths the Caddyfile expects).

Technitium (http://localhost:5380 after install): set forwarders to Starlink/8.8.8.8,
add zones staff.holmdalerodeo.ca and api.holmdalerodeo.ca each with one A record ->
the Mini PC's static LAN IP. DISABLE both zones until cutover night.

Firewall:
  netsh advfirewall firewall add rule name="Rodeo HTTPS" dir=in action=allow protocol=TCP localport=443
  netsh advfirewall firewall add rule name="Rodeo DNS" dir=in action=allow protocol=UDP localport=53
"@ -ForegroundColor Yellow

Write-Host "Provisioning bootstrap done — work through the yellow manual steps above." -ForegroundColor Green
