# Rodeo Print Bridge — Seaory S25 badge printing

The badge pages in the staff portal (`badge-checkin.html`, `badge-print.html`,
`badge-admin.html`) render the CR80 card in the browser, rasterize it to a
300-DPI PNG, and POST it to `http://127.0.0.1:7777/print`. A browser cannot
talk to the Seaory driver directly — **this little app is the missing link**.
If it is not running on the check-in laptop, "Save & Send to Printer" saves
the badge but shows *"couldn't reach the printer (bridge offline)"* and
nothing prints.

```
badge page (Chrome, https://staff.holmdalerodeo.ca)
   └─ html2canvas → CR80 PNG (638×1012 @ 300 DPI)
       └─ POST http://127.0.0.1:7777/print          ← this bridge
           └─ print-png.ps1 → Windows driver → Seaory S25
```

## Setup (once, on the laptop the S25 is plugged into)

1. Install the **Seaory S25 Windows driver** and print its test page.
2. Install Node.js if missing: `winget install OpenJS.NodeJS.LTS`
3. Get this repo onto the laptop (clone, or copy just this folder).
4. Run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File install-print-bridge.ps1
   ```

   That verifies the printer, drops a **Startup shortcut** (bridge starts at
   every logon), starts it now, and checks `/health`.

5. First print from the portal: Chrome may ask to allow the site to access
   a "local network" / "device on your network" resource — click **Allow**.
   The bridge answers the Private Network Access preflight, but the
   permission prompt is still the user's to accept.

Pin a specific printer (skip auto-detect):

```powershell
powershell ... install-print-bridge.ps1 -Printer "Seaory S25"
```

## Day-of checklist

- A window titled **"Rodeo Print Bridge (Seaory S25)"** is open on the
  check-in laptop. Every job and every driver error prints there.
- `http://127.0.0.1:7777/health` in a browser tab shows
  `{"ok":true, "printer": …}` plus the last job's result.
- Cards loaded in the S25 hopper, driver set to CR80.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Portal says *bridge offline* | Bridge window not running — double-click `start-print-bridge.cmd` (or log out/in; the Startup shortcut relaunches it). |
| *Printer 'X' not found* in the bridge window | Driver not installed, or the name doesn't match — re-run `install-print-bridge.ps1 -Printer "<exact name>"`. |
| Job says printed but no card comes out | Windows print queue: check the Seaory queue for stuck/held jobs; power-cycle the S25; verify card hopper. |
| Prints on the wrong printer | Auto-detect fell through to the Windows default — pin it with `-Printer`. |
| Card art squashed / rotated | The bridge auto-rotates to the driver's orientation; set the driver page size to CR80 (2.13 × 3.37 in). |
| Testing with no printer attached | `set PRINT_BRIDGE_DRY_RUN=1` then `node server.js` — jobs are accepted and logged, nothing prints. |

## API

- `GET /health` → `{ ok, printer, dryRun, queued, lastJob }`
- `POST /print` body `{ pngBase64, badgeId, name }` (`pngBase64` = data URL or
  raw base64) → `{ ok: true, printer }` or `{ ok: false, error }`

Jobs are printed **one at a time** (serialized) — the S25 feeds a single card
per job. Failed jobs keep their PNG in `%TEMP%\rodeo-print-bridge\` for
reprint/debugging.

Env vars: `PRINT_BRIDGE_PORT` (default 7777 — the portal pages expect this),
`SEAORY_PRINTER_NAME`, `PRINT_BRIDGE_DRY_RUN=1`.

The bridge binds **127.0.0.1 only** — nothing else on the event LAN can feed
cards into the printer, and no firewall rule is needed.
