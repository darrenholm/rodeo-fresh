# Onsite Server (Mini PC) — Setup & Event Runbook

Runs the whole rodeo system (portal + API + Postgres) on the GMKtec G10 at the
grounds during event days. Same URLs as production — local DNS decides whether
devices hit the Mini PC or the cloud. **Onsite is the source of truth during
the event; the cloud is read-only for event data and receives backups.**

## Architecture

```
Normal days:   staff.holmdalerodeo.ca -> Vercel     api.holmdalerodeo.ca -> Railway
Event LAN:     Technitium DNS overrides BOTH hostnames -> Mini PC static IP
               Caddy (HTTPS, real LE certs) -> portal static files + /api -> Node :3000 -> local Postgres
```

Cutover = enable the two DNS zones in Technitium. Rollback = disable them.

## One-time setup

1. Run `provision-minipc.ps1` **as admin** and work through its yellow manual
   steps (Postgres password, `.env` secrets, NSSM services, scheduled tasks).
2. **Certs (week before the event):** run `wacs.exe` (win-acme), manual
   DNS-01 for `staff.holmdalerodeo.ca` and `api.holmdalerodeo.ca`. It prints
   TXT records — add them in WHC cPanel Zone Editor, validate, then export PEM
   to `C:\rodeo\certs\{staff,api}.{crt,key}`. Certs are valid 90 days and work
   with zero internet afterward.
3. **Technitium** (`http://localhost:5380`): forwarders -> Starlink DNS +
   8.8.8.8; add zones for the two hostnames, each a single A record -> the
   Mini PC's static LAN IP. **Leave the zones disabled until cutover.**
4. **Network prerequisite:** the event LAN's DHCP must hand out the Mini PC as
   the DNS server. Stock Starlink router can't do this — use your own router
   with Starlink in bypass mode, or set DNS manually on each staff device.
5. Dry-run checklist is in the plan (laptop + Android phone with DNS pointed
   at the Mini PC: HTTPS green lock, login, bar-service NFC, QR gate scan,
   drink serve, merch variant sale, then pull the WAN and repeat).

## Event runbook

**Cutover (Jul 30 evening)**
1. `powershell -File restore-from-cloud.ps1` (dumps cloud -> local, bumps
   sequences +100000, records `CUTOVER_TIME.txt`).
2. Enable both zones in Technitium.
3. On one staff phone: forget/rejoin Wi-Fi, open staff.holmdalerodeo.ca,
   confirm the little padlock + login + a test NFC read.
4. Confirm scheduled tasks are running: `RodeoTicketSync` (2 min),
   `RodeoBackup` (15 min, dumps in `C:\rodeo\backups`).

**During the event**
- Online ticket buyers appear locally within ~2 min while Starlink is up
  (`sync-ticket-orders.js`). If Starlink is down, the gate can't see brand-new
  online orders — sell walk-ups locally; the orders sync when it returns.
- Starlink down: gate/bar/merch/kitchen all keep working. Cards + emails fail
  (cash only); badge photos and sponsor logos won't render (Vercel Blob).
- Mini PC dies: disable the DNS zones (or power off the Mini PC — devices
  fall back once DNS cache expires only if zones are served elsewhere; fastest
  is rebooting the router with DNS pointed back at Starlink). Grounds run
  against the cloud, minus whatever was written locally — restore the latest
  15-minute dump into the cloud later.

**After the event (Aug 3)**
1. `node scripts/onsite/merge-back.js` — review the dry-run counts.
2. `node scripts/onsite/merge-back.js --apply` — writes event data to cloud,
   resets cloud sequences. Cloud is primary again.
3. Disable the Technitium zones; stop the scheduled tasks.

## Files

| File | Purpose |
|---|---|
| `onsite.env.example` | copy to `onsite.env` (gitignored), both DB URLs + backup dirs |
| `provision-minipc.ps1` | one-shot software install + service registration guide |
| `Caddyfile` | HTTPS portal + API reverse proxy |
| `restore-from-cloud.ps1` | cutover: cloud -> local + sequence bump |
| `sync-ticket-orders.js` | every 2 min: online sales cloud -> local |
| `backup-dump.ps1` | every 15 min: local dump + mirror |
| `merge-back.js` | after event: local -> cloud (dry-run by default) |
