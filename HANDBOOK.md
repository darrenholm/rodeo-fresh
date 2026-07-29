# Holmdale Rodeo — Systems Handbook

**Purpose: if Darren is unavailable, this document gets someone else through the
event.** It explains how everything fits together, what to do on each day of
event week, and what to do when things break. Written for a technically
comfortable person who has never seen this system before.

Event: **Friday July 31 – Sunday August 2**. Cutover to the onsite server is
the evening of **Thursday July 30**; merge-back to the cloud is **Monday
August 3**.

---

## 1. The one-paragraph version

The rodeo runs on a web app: staff use phones/tablets at
`https://staff.holmdalerodeo.ca` for gate check-in (QR/NFC wristbands), bar
sales, merch, kitchen orders, and badges. On **normal days** that portal and
its API run in the cloud. On **event days** the whole stack runs on a mini PC
at the grounds, using the **same URLs** — a local DNS server at the grounds
answers those hostnames with the mini PC's LAN address instead of the cloud.
During the event the mini PC is the source of truth; the cloud only takes
online ticket sales and receives backups. After the event, one script merges
the event data back into the cloud.

## 2. The moving parts

### Cloud (normal days, and online sales during the event)

| Piece | What/where | Notes |
|---|---|---|
| Staff portal | **Vercel**, deploys from `darrenholm/holmdale-staff-portal` repo on push to `main` | Static pages in `public/` |
| API | **Railway** ("Holmdale Rodeo" project), deploys from `darrenholm/rodeo-fresh` repo | Node/Express, `server.js` |
| Database | **Railway Postgres** (same project) | `DATABASE_PUBLIC_URL` in the Railway Postgres service |
| Public DNS | `holmdalerodeo.ca` zone in **WHC cPanel** (Zone Editor) | `staff.` → Vercel, `api.` → Railway |
| Card payments | **Stripe** and **Moneris** | Keys in Railway variables and the mini PC's `.env` |
| Emails | **Resend** | Ticket confirmations etc. |
| Images | **Vercel Blob** | Badge photos, sponsor logos |
| Facebook posts | Cron jobs inside the API (`server.js`): daily countdown ~8am ET, sponsor spotlight, evening schedule | They stop by themselves after the event weekend |

### Onsite (event days)

Two Windows PCs at the grounds, identical stacks:

| | Primary (mini PC) | Standby |
|---|---|---|
| IP | **192.168.0.101** | **192.168.0.153** |
| Role | Runs everything; the writer | Kept 2 min behind; takes over if the primary dies |

Each PC runs, under `C:\rodeo`:

- **Postgres 17** — the local `rodeo_db` database. Both PCs must run the same
  major version (the primary's `pg_dump` pushes into the standby); scripts
  auto-detect the installed version.
- **RodeoAPI** (Windows service via NSSM) — the Node API on port 3000.
- **RodeoCaddy** (Windows service via NSSM) — HTTPS on 443, serves the portal
  pages from `C:\rodeo\holmdale-staff-portal\public` and proxies `/api` to
  the API. Real Let's Encrypt certs from `C:\rodeo\certs\` (valid 90 days,
  no internet needed).
- **Technitium DNS** (Windows service `DnsService`, admin GUI at
  `http://localhost:5380`) — answers `staff.` and `api.holmdalerodeo.ca`
  for devices on the event LAN. The zones are what turn "event mode" on/off.
- **Scheduled tasks** (`schtasks`):
  - `RodeoTicketSync` — every 2 min, pulls online ticket sales cloud → local (primary only, enabled)
  - `RodeoBackup` — every 15 min, dumps the local DB to `C:\rodeo\backups` (primary only, enabled)
  - `RodeoStandbySync` — every 2 min **on the primary**, pushes the whole local DB to the standby
  - On the **standby**, `RodeoTicketSync`/`RodeoBackup` exist but are **disabled** — they get enabled only if the standby is promoted.

The event LAN's router hands out **both PCs as DNS servers** (primary first).
Both answer with the **primary's** IP, so there's no split-brain — until you
deliberately change the standby's records during failover.

### The two repos

- `darrenholm/rodeo-fresh` — the API, migrations, and all onsite scripts
  (`scripts/onsite/`). Deployed by Railway (cloud) and pulled by git on the PCs.
- `darrenholm/holmdale-staff-portal` — the portal pages. Deployed by Vercel
  (cloud) and pulled by git on the PCs (Caddy serves the folder directly).

### Where the secrets are

**Nothing secret is in git.** On each PC:

- `C:\rodeo\rodeo-fresh\.env` — API secrets (`DATABASE_URL`, `JWT_SECRET` —
  same value as Railway so logins survive cutover — Stripe/Moneris/Resend/Blob keys).
- `C:\rodeo\rodeo-fresh\scripts\onsite\onsite.env` — DB URLs for the sync and
  backup scripts (cloud, local, standby), backup folders, Postgres bin path.

Account passwords (Railway, Vercel, WHC, Stripe, Moneris, Resend, GitHub,
the PCs' Windows and Postgres passwords): **<FILL IN: where these are kept —
password manager, envelope, etc.>**

People: **<FILL IN: who to call — ops lead, sound booth, gate lead, and a
backup technical contact>**

---

## 3. Event-week timeline

### Thursday July 30 evening — cutover

On the **primary**, in an **admin** PowerShell:

```powershell
cd C:\rodeo\rodeo-fresh\scripts\onsite
powershell -ExecutionPolicy Bypass -File .\restore-from-cloud.ps1
```

This copies the cloud DB onto the primary (type `YES` when asked — it only
destroys the *local* copy), bumps ID sequences by +100,000 so event rows can
never collide with cloud rows at merge-back, and records the cutover time in
`CUTOVER_TIME.txt` (merge-back reads it — don't delete it).

Then flip DNS: in Technitium (`http://localhost:5380`) on **both** PCs,
**enable** the `staff.holmdalerodeo.ca` and `api.holmdalerodeo.ca` zones.

Verify with one staff phone on the event Wi-Fi: forget/rejoin the network,
open `https://staff.holmdalerodeo.ca` — you want the padlock (no cert
warning), a successful login, and one test NFC/QR read.

Finally confirm the tasks are live on the primary:

```powershell
schtasks /Query /TN RodeoTicketSync
schtasks /Query /TN RodeoBackup
schtasks /Query /TN RodeoStandbySync
```

All three should show Ready/Running (not Disabled), and new `rodeo_*.dump`
files should appear in `C:\rodeo\backups` every 15 minutes.

### During the event — daily checks (2 minutes, morning and evening)

On the primary:

1. `https://staff.holmdalerodeo.ca` loads with a padlock from a phone on the LAN.
2. `C:\rodeo\backups` has a dump newer than 15 minutes ago.
3. Standby sync is landing: on the **standby**, this number should move
   within ~2 minutes of a sale on the primary:
   ```powershell
   & "$(Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory | Select -First 1 -Expand FullName)\bin\psql" -U postgres -h localhost -d rodeo_db -c "SELECT COUNT(*) FROM bar_transactions"
   ```
4. Online orders are syncing in (needs Starlink): gate can look up a
   just-bought online ticket within ~2 minutes.

### Monday August 3 — merge back

On whichever PC ended the event as the writer (normally the primary):

```powershell
cd C:\rodeo\rodeo-fresh
node scripts\onsite\merge-back.js          # dry run - review the counts
node scripts\onsite\merge-back.js --apply  # actually writes to the cloud
```

Then **disable** both DNS zones in Technitium on both PCs, and disable the
tasks (`schtasks /Change /TN RodeoTicketSync /DISABLE`, same for
`RodeoBackup` and `RodeoStandbySync`). The cloud is primary again.

---

## 4. When things break

### Starlink (internet) goes down

**Nothing to do — this is a designed-for state.** Gate, bar, merch, kitchen
all keep working (everything is local). What stops working:

- Card payments and emails → **go cash-only** until it's back.
- Brand-new online ticket purchases can't reach the gate → sell walk-ups;
  the orders appear automatically when the link returns.
- Badge photos and sponsor logos won't load (they live in Vercel Blob).

### The primary dies (the big one)

The standby has a copy of the database at most 2 minutes old. Promote it:

1. **Make sure the primary is really dead** — power it off or pull its
   ethernet. It must not come back later and overwrite the live standby.
2. On the **standby**, open Technitium (`http://localhost:5380`) and change
   the A records in both zones from the primary's IP to the **standby's own
   IP (192.168.0.153)**. TTL is 30 seconds, so devices follow quickly.
3. Enable the standby's tasks:
   ```powershell
   schtasks /Change /TN RodeoTicketSync /ENABLE
   schtasks /Change /TN RodeoBackup /ENABLE
   ```
4. Staff terminals: refresh the page (worst case, reboot the device). Staff
   stay logged in (same `JWT_SECRET`).
5. Verify: padlock on `staff.holmdalerodeo.ca`, one test NFC read, one test
   drink serve. Expect up to 2 minutes of lost data.

The standby is now the writer with nothing behind it. If you can revive the
old primary, it comes back **as the standby**: blank out
`STANDBY_DATABASE_URL` in *its* `onsite.env`, leave its DNS records alone,
and on the **new writer** set `STANDBY_DATABASE_URL` in `onsite.env` to point
at it so the 2-minute push resumes.

### Both PCs die (last resort: fall back to the cloud)

Only with Starlink up, and only if neither PC can be revived — this loses
everything since cutover except what's in the 15-minute dumps:

1. Disable both Technitium zones (or if the PCs are truly dead, their DNS is
   dead too and devices will fail through to real DNS on their own — but you
   may need to set the router's DHCP DNS back to normal).
2. If a recent dump survived (check `C:\rodeo\backups` and the mirror
   location if one was configured), restore it into the Railway Postgres from
   any machine with `pg_restore` and the `CLOUD_DATABASE_URL`.
3. Terminals now hit Vercel/Railway over Starlink like a normal day.

### A staff terminal misbehaves

In rough order: refresh the page → forget/rejoin the Wi-Fi → reboot the
device. If **every** device is failing the same way, the problem is on the
server — check the services on the primary:

```powershell
Get-Service RodeoAPI, RodeoCaddy, DnsService, postgresql*
Invoke-RestMethod http://localhost:3000/health
```

Anything not `Running`: `Start-Service <name>` (or `Restart-Service`), then
re-check `/health`. API logs: `nssm status RodeoAPI` and Windows Event Viewer.

### Cert warning on phones

The certs in `C:\rodeo\certs\` have expired or the wrong files are in place
(Caddy expects `fullchain.pem`/`privkey.pem`). Re-issue with
`C:\rodeo\win-acme\wacs.exe` (manual DNS-01; it prints TXT records to add in
WHC cPanel Zone Editor — needs internet), export PEMs to `C:\rodeo\certs\`,
then `Restart-Service RodeoCaddy`. TVs use the plain-http pages
(`http://staff.holmdalerodeo.ca/rodeo-…-display.html` or the raw IP) exactly
to avoid cert issues.

### Code fix needed mid-event

Fixes land on GitHub `main` from the office, then on **both** PCs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\rodeo\rodeo-fresh\scripts\onsite\update-code.ps1
```

Pulls both repos, installs deps, runs migrations, restarts the API (terminals
see a few seconds of errors), checks `/health`. Portal-page changes need no
restart. Don't update mid-event unless it's urgent.

---

## 5. Rules that prevent self-inflicted outages

- **The standby may be used as a normal workstation** (e.g. badge station) —
  but only through the browser at `https://staff.holmdalerodeo.ca`. **Never
  point anything at `localhost` on the standby** — its local DB is wiped and
  replaced every 2 minutes, so local writes silently vanish.
- **Don't reboot or shut down either PC** without the ops lead's OK.
- **Don't run `restore-from-cloud.ps1` after the event has started** — it
  destroys the local (live) database.
- **Don't run `merge-back.js --apply` twice** without checking the dry-run
  counts; and never run it *during* the event.
- **Never commit `onsite.env` or `.env`** to git.
- Ping being blocked is normal Windows behavior until the firewall rule from
  `setup-standby.ps1` is applied; test reachability with
  `Test-NetConnection <ip> -Port 5432` instead. Note the standby's Postgres
  only accepts connections **from the primary's IP**.

## 6. Reference card

| Thing | Value |
|---|---|
| Portal | `https://staff.holmdalerodeo.ca` |
| API | `https://api.holmdalerodeo.ca` (port 3000 internally, `/health` for status) |
| Primary / Standby | 192.168.0.101 / 192.168.0.153 |
| Technitium admin | `http://localhost:5380` on each PC |
| Windows services | `RodeoAPI`, `RodeoCaddy`, `DnsService`, `postgresql-x64-<version>` |
| Scheduled tasks | `RodeoTicketSync` (2 min), `RodeoBackup` (15 min), `RodeoStandbySync` (2 min, primary only) |
| Everything on disk | `C:\rodeo\` — repos, certs, backups, win-acme |
| Backups | `C:\rodeo\backups\rodeo_YYYYMMDD_HHMM.dump`, newest 300 kept |
| Setup/rebuild scripts | `scripts/onsite/provision-minipc.ps1` then `setup-standby.ps1` — see `scripts/onsite/README.md` for the full setup guide and file table |

A dump can be restored anywhere with:
`pg_restore --clean --if-exists --no-owner -d <database-url> <file>.dump`
