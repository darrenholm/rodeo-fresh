# Onsite Server (Mini PC) — Setup & Event Runbook

> **New here / covering for Darren?** Start with [`HANDBOOK.md`](../../HANDBOOK.md)
> at the repo root — the whole-system picture, event timeline, and failure
> playbooks. This file is the detailed onsite setup reference.

Runs the whole rodeo system (portal + API + Postgres) on the GMKtec G10 at the
grounds during event days. Same URLs as production — local DNS decides whether
devices hit the Mini PC or the cloud. **Onsite is the source of truth during
the event; the cloud is read-only for event data and receives backups.**

## Architecture

```
Normal days:   staff.holmdalerodeo.ca -> Vercel     api.holmdalerodeo.ca -> Railway
Event LAN:     Technitium DNS overrides BOTH hostnames -> Mini PC static IP
               Caddy (HTTPS, real LE certs) -> portal static files + /api -> Node :3000 -> local Postgres

Redundancy:    Mini PC (writer) --2 min DB push--> STANDBY PC (identical stack, idle)
                              \--15 min dumps--> C:\rodeo\backups (+ mirror)
                              \<-2 min ticket pull-- cloud (online sales)
```

Cutover = enable the two DNS zones in Technitium. Rollback = disable them.
Standby failover = edit the standby's DNS A records to its own IP (see below).

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

## Standby PC (third redundancy)

A second PC with the identical stack, kept 2 minutes behind the primary. It
covers the case the cloud fallback can't: the Mini PC dying **while Starlink
is also down or flaky** — mid-event, that's the moment a fallback matters.

**Setup (once) — fast path:**
1. Copy the primary's whole `C:\rodeo` folder to the standby (USB stick or
   share). This carries the repos + node_modules, `.env`, `onsite.env`,
   certs and win-acme — all the secrets and fiddly bits in one move.
   (Skip `C:\rodeo\backups` if you want a smaller copy.)
2. Run `provision-minipc.ps1` as admin — with `C:\rodeo` already populated it
   just installs the software (Postgres/Node/Git/Caddy/NSSM/Technitium).
   Use the SAME postgres password as the primary when the installer asks.
3. Run `setup-standby.ps1 -PostgresPassword <pw> -PrimaryIP <mini-pc-ip>`
   as admin — creates the db, opens Postgres to the primary, registers the
   services, creates the (disabled) scheduled tasks, firewall, power
   settings, and fixes up `onsite.env` for the standby role.
4. Technitium (manual, it's a web GUI — the script prints the exact values).
5. On the PRIMARY: set `STANDBY_DATABASE_URL` in `onsite.env` and add the task:
   `schtasks /Create /TN RodeoStandbySync /SC MINUTE /MO 2 /RU SYSTEM /TR "powershell -NoProfile -File C:\rodeo\rodeo-fresh\scripts\onsite\sync-to-standby.ps1"`
6. **DNS:** standby also runs Technitium with the same two zones, A records
   pointing at the **primary's** IP (not its own), **TTL 30 seconds**, zones
   enabled at cutover along with the primary's. The event router's DHCP hands
   out BOTH PCs as DNS servers (primary first). Both resolvers give the same
   answer, so there is no split-brain — until you deliberately change it.

**Failover (primary dies):**
1. Make sure the primary is really out — power it off / pull its ethernet.
   It must NOT come back later and resume pushing over a live standby.
2. On the standby's Technitium (http://localhost:5380): change both A records
   from the primary's IP to the **standby's** IP. (If the primary's Technitium
   is somehow still up, change it there too — dead PC usually means dead DNS,
   which is why clients fall over to the standby resolver on their own.)
3. Enable the standby's `RodeoTicketSync` and `RodeoBackup` tasks:
   `schtasks /Change /TN RodeoTicketSync /ENABLE` (same for RodeoBackup).
4. Terminals: refresh the page (worst case reboot — 30 s DNS TTL + resolver
   failover). Same JWT_SECRET means staff stay logged in.
5. Verify: green padlock on staff.holmdalerodeo.ca, one test NFC read,
   one test drink serve. Data loss window: ≤ 2 minutes.
6. The standby is now the writer with no standby behind it. `merge-back.js`
   after the event runs from whichever PC ended up as the writer.

**Using the standby as a workstation** (e.g. welcome-centre badge station)
is fine and keeps it warm — but ONLY through the browser at
`https://staff.holmdalerodeo.ca` like any other terminal. Never point
anything on it at `localhost` — its local DB is a replica that gets
overwritten every 2 minutes, so anything written locally is silently wiped.
No shutdowns/reboots without the ops lead's OK; it's still the backup server.

**Do not** re-add the old primary during the event unless you must; if you
do, it comes back as the *standby* (blank `STANDBY_DATABASE_URL`, A records
untouched, let the new writer push to it after setting `STANDBY_DATABASE_URL`
on the new writer to point at it).

## Code updates (office -> on-site PCs)

Fixes made at the office land on GitHub `main` as usual. The on-site PCs do
NOT auto-update; pull them forward deliberately, on BOTH PCs:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\rodeo\rodeo-fresh\scripts\onsite\update-code.ps1

Pulls both repos, installs deps, runs migrations, restarts `RodeoAPI`, and
checks `/health`. Portal pages need no restart (Caddy serves the repo folder).
**Code freeze once the event starts** — mid-event only for urgent fixes.

## Badge print station (Seaory S25)

The check-in laptop that drives the Seaory S25 card printer must run the
**print bridge** (`scripts/print-bridge/`) — the badge pages POST the rendered
card to `http://127.0.0.1:7777` and without the bridge nothing prints (badges
just pile up in the queue). One-time setup on that laptop:

    powershell -NoProfile -ExecutionPolicy Bypass -File C:\rodeo\rodeo-fresh\scripts\print-bridge\install-print-bridge.ps1

Full setup + day-of checklist: [`scripts/print-bridge/README.md`](../print-bridge/README.md).

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
- Mini PC dies: **promote the standby** (see "Standby PC" above) — ≤ 2 min
  of data loss and the grounds keep running locally. Falling back to the
  cloud (disable/repoint DNS zones, run against Railway) is the LAST resort
  now — it loses everything since cutover except the 15-minute dumps, and
  needs Starlink up.

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
| `sync-to-standby.ps1` | every 2 min on the PRIMARY: local db -> standby PC |
| `setup-standby.ps1` | one-shot standby config after copying C:\rodeo over |
| `update-code.ps1` | pull office fixes from GitHub, migrate, restart API |
| `merge-back.js` | after event: local -> cloud (dry-run by default) |
