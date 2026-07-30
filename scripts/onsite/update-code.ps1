# Pull the latest code from GitHub onto this on-site machine and restart the API.
# Run on the PRIMARY and the STANDBY whenever fixes have been pushed from the
# office (a standby running old code is a failover surprise):
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\rodeo\rodeo-fresh\scripts\onsite\update-code.ps1
#
# Code freeze once the event starts — update mid-event only for urgent fixes
# (this restarts the RodeoAPI service; terminals see a few seconds of errors).

$ErrorActionPreference = 'Stop'
$ROOT = 'C:\rodeo'

function Invoke-Step($label, $block) {
    Write-Host "== $label ==" -ForegroundColor Cyan
    & $block
    if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

Invoke-Step 'Updating backend (rodeo-fresh)' { git -C "$ROOT\rodeo-fresh" pull --ff-only origin main }
Set-Location "$ROOT\rodeo-fresh"
Invoke-Step 'Installing backend deps' { npm install --omit=dev }
Invoke-Step 'Updating staff portal pages' { git -C "$ROOT\holmdale-staff-portal" pull --ff-only origin main }
# Caddy serves the portal directly from the repo folder - no restart needed.

# Migrations: if this fails, do NOT restart the API onto a half-migrated db.
Invoke-Step 'Running database migrations' { npm run migrate }

# Pre-warm the sponsor-logo cache while we still have internet. Non-fatal:
# a partial cache beats blocking the update, and /api/badges/logo also
# caches on first use whenever internet happens to be up.
Write-Host "== Caching sponsor logos for offline badge printing ==" -ForegroundColor Cyan
try { node scripts\onsite\cache-logos.js } catch { Write-Warning "logo cache pre-warm failed: $_" }

Write-Host "== Restarting API ==" -ForegroundColor Cyan
Restart-Service RodeoAPI

Start-Sleep -Seconds 3
try {
    Invoke-RestMethod 'http://localhost:3000/health' -TimeoutSec 10 | Out-Null
    Write-Host "== Done - API healthy ==" -ForegroundColor Green
} catch {
    Write-Warning "API did not answer /health after restart - check: nssm status RodeoAPI"
    exit 1
}
