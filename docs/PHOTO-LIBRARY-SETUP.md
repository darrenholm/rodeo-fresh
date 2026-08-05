# Photo Library — setup

The photo library is built and deployed, but it stays switched off until the
Cloudflare R2 buckets exist and the Railway environment variables are set. Until
then `/api/photos/public/upload-info` reports `enabled: false`, the public upload
form shows "temporarily unavailable", and every upload endpoint returns 503. The
gallery itself just shows an empty state. Nothing breaks; it simply does nothing.

Budget for about 20 minutes.

## Why R2 and not Vercel Blob

The rodeo's sponsor and vendor logos live in Vercel Blob. Photos deliberately do
not. Blob bills data transfer, and the store was already suspended once mid-season
on logo traffic alone. A public gallery serving full-resolution originals is a far
heavier egress load than logos ever were. R2 charges **nothing** for egress —
about $0.015/GB-month for storage and that is the whole bill. 200 GB of rodeo
photos costs roughly $3/month with unlimited downloads.

## 1. Create two buckets

In the Cloudflare dashboard → **R2** → Create bucket. Location hint: North America
(ENAM).

| Bucket | Name | Public access |
|---|---|---|
| Originals | `holmdale-photos-originals` | **Off.** Never make this public. |
| Derivatives | `holmdale-photos-public` | Public, via custom domain (step 2) |

Two buckets rather than one is what actually enforces "staff-only originals". A
single bucket with an edge rule blocking `/originals/*` would work until someone
deletes the rule. With two, the full-resolution files are unreachable from the
internet as a property of the storage, not of a dashboard setting.

## 2. Bind a custom domain to the public bucket

`holmdale-photos-public` → **Settings** → **Public access** → *Custom domains* →
Connect domain → `photos.holmdalerodeo.ca`.

> ⚠️ DNS for holmdalerodeo.ca is on **WHC nameservers**, not Cloudflare. Cloudflare
> cannot create this record itself. It will show you a CNAME target — add that
> record by hand in the WHC cPanel Zone Editor (the rodeo has its own cPanel
> account on **srv38.swhc.ca**), then come back and let Cloudflare verify.

Do **not** use the `r2.dev` development URL in production — it is rate-limited and
Cloudflare explicitly does not support it for real traffic.

## 3. CORS on both buckets

Browsers upload straight to R2, so both buckets need to accept cross-origin PUTs.
Bucket → **Settings** → **CORS policy** → paste this into each:

```json
[
  {
    "AllowedOrigins": [
      "https://holmdalerodeo.ca",
      "https://www.holmdalerodeo.ca",
      "https://staff.holmdalerodeo.ca",
      "http://localhost:5173",
      "http://localhost:5183",
      "http://localhost:8765"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Miss this step and uploads fail with a bare "Network error while uploading" — the
browser blocks the request before R2 ever sees it.

## 4. Create an API token

R2 → **Manage R2 API Tokens** → Create API token.

- Permission: **Object Read & Write**
- Scope it to just the two buckets above
- TTL: forever

Copy the **Access Key ID** and **Secret Access Key** — the secret is shown once.
Note the **Account ID** from the R2 overview page as well.

## 5. Set the Railway variables

Railway → project **Holmdale Rodeo** → service **rodeo-fresh** → Variables.
(Confirm the project picker says *Holmdale Rodeo*, not *Holm Graphics* — they are
separate projects with separate databases.)

```
R2_ACCOUNT_ID=<your Cloudflare account id>
R2_ACCESS_KEY_ID=<from step 4>
R2_SECRET_ACCESS_KEY=<from step 4>
R2_BUCKET_ORIGINALS=holmdale-photos-originals
R2_BUCKET_PUBLIC=holmdale-photos-public
R2_PUBLIC_BASE=https://photos.holmdalerodeo.ca
```

Railway redeploys on save. Watch the deploy log — on boot you should see
`✓ Auto-migrations complete` and *not* the `⚠️  R2 not configured` warning. If the
warning is still there, one of the five values above is missing or misspelled.

The `photos` and `photo_albums` tables are created automatically by the startup
migration block. On the onsite Mini PC, run `node migrations/add-photo-library.js`
instead.

## 6. Check it works

1. Go to **staff.holmdalerodeo.ca → Photo Library**. The header stats should load
   with zeroes instead of an error.
2. Hit **Albums** and create one, e.g. "2026 Rodeo".
3. Hit **Upload Photos**, pick that album, drop in a few real photos. They publish
   immediately.
4. Open **holmdalerodeo.ca/Photos** — they should be there.
5. Submit one through **Share Your Photos** as a member of the public would. It
   should land under *Needs review* in the staff page, not on the public gallery.
6. Back in the staff page, open that photo and hit **⬇ Full resolution** — you
   should get the untouched original file.

## How it works, briefly

- The browser resizes each photo to a 2048px web copy and a 500px thumbnail and
  reads the EXIF capture date, then PUTs the original plus both derivatives
  directly to R2 using short-lived presigned URLs. Photo bytes never pass through
  Railway.
- If the browser cannot decode the format (HEIC outside Safari, mainly), it
  uploads only the original and flags the photo. The server then rebuilds the
  derivatives with `sharp`. Those photos appear under **Needs processing** with a
  **Reprocess** button if the automatic attempt failed.
- Public submissions record the exact consent wording, the uploader's name and
  email, their IP, and a timestamp — that is the licence grant for using the photo
  in marketing. It is visible on the photo's detail panel.
- Anonymous uploads are rate-limited to 60 per IP per hour, in memory. The
  moderation queue is the real defence; the limit just blunts a flood.
- Rows created by an upload that was never finished are swept nightly at 04:20.

## Costs

Storage is billed at ~$0.015/GB-month with no egress charge and 10 GB free.

| Library size | Monthly |
|---|---|
| 50 GB | ~$0.60 |
| 200 GB | ~$2.85 |
| 1 TB | ~$15 |

Class A operations (uploads) are $4.50/million; at rodeo volumes this rounds to
zero. Downloads are free regardless of volume — which is the entire reason for
choosing R2 over Blob here.
