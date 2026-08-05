/**
 * lib/r2.js — Cloudflare R2 storage for the photo library.
 *
 * Why R2 and not Vercel Blob (which the sponsor/vendor logos use): R2 charges
 * nothing for egress. The photo library serves full-resolution originals and a
 * public gallery, so egress — not storage — is the cost that would bite. The
 * Blob store was already suspended once mid-season on logo traffic alone.
 *
 * TWO buckets, deliberately:
 *   - PRIVATE  (R2_BUCKET_ORIGINALS) holds the untouched camera files. No public
 *     access at all; staff reach them through short-lived presigned GET URLs.
 *   - PUBLIC   (R2_BUCKET_PUBLIC) holds only the web-sized and thumbnail
 *     derivatives, and is bound to a Cloudflare custom domain so the gallery can
 *     serve them cached and cacheable.
 *
 * A single bucket with a "block /originals/*" edge rule would also work, but the
 * guarantee would live in a dashboard rule someone could delete. Two buckets
 * makes "the public can never fetch an original" a property of the storage
 * itself.
 *
 * Browsers PUT directly to R2 using presigned URLs — the bytes never pass
 * through Railway. A 40 MB raw JPEG through Express would mean holding it in
 * memory and paying Railway egress for the privilege.
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;

const BUCKET_ORIGINALS = process.env.R2_BUCKET_ORIGINALS || 'holmdale-photos-originals';
const BUCKET_PUBLIC = process.env.R2_BUCKET_PUBLIC || 'holmdale-photos-public';

// Custom domain bound to the public bucket, e.g. https://photos.holmdalerodeo.ca
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '');

const isConfigured = Boolean(ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && PUBLIC_BASE);

let client = null;
if (isConfigured) {
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
  });
} else {
  console.warn(
    '⚠️  R2 not configured — photo library uploads will return 503. ' +
    'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE.'
  );
}

function requireClient() {
  if (!client) {
    const err = new Error('Photo storage is not configured on this server');
    err.status = 503;
    throw err;
  }
  return client;
}

/** Public URL for a derivative living in the public bucket. */
function publicUrl(key) {
  if (!key) return null;
  return `${PUBLIC_BASE}/${key.replace(/^\/+/, '')}`;
}

/**
 * Presigned PUT the browser can upload straight to.
 *
 * contentType is baked into the signature, so the browser MUST send the exact
 * same Content-Type header or R2 rejects the request — the client code and this
 * value have to agree.
 */
async function presignPut(bucket, key, contentType, expiresIn = 900) {
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  return getSignedUrl(requireClient(), cmd, { expiresIn });
}

/**
 * Presigned GET for a private original. Short TTL: these links get pasted into
 * chats and shared, and each one is an unauthenticated bearer of the full-res
 * file for as long as it lives.
 */
async function presignGet(key, { expiresIn = 300, downloadAs = null } = {}) {
  const cmd = new GetObjectCommand({
    Bucket: BUCKET_ORIGINALS,
    Key: key,
    ...(downloadAs
      ? { ResponseContentDisposition: `attachment; filename="${downloadAs.replace(/"/g, '')}"` }
      : {})
  });
  return getSignedUrl(requireClient(), cmd, { expiresIn });
}

/** Fetch an object's bytes into memory. Only used by the sharp reprocess path. */
async function getObjectBuffer(bucket, key) {
  const res = await requireClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Server-side upload. Used by the reprocess fallback, not the normal path. */
async function putObject(bucket, key, body, contentType) {
  await requireClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Derivatives are immutable — the key contains a UUID, so a changed image
      // is always a new key. Let the CDN and browsers hold them forever.
      CacheControl: 'public, max-age=31536000, immutable'
    })
  );
}

/** True if the key exists. Used to confirm a browser upload actually landed. */
async function objectExists(bucket, key) {
  try {
    await requireClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
    throw err;
  }
}

/** Size in bytes of an uploaded object, or null if it isn't there. */
async function objectSize(bucket, key) {
  try {
    const res = await requireClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return res.ContentLength ?? null;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
    throw err;
  }
}

async function deleteObject(bucket, key) {
  if (!key) return;
  await requireClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Delete every object belonging to a set of photos. Failures are swallowed per
 * key: an orphaned object costs a fraction of a cent, but a failed delete that
 * blocks the DB cleanup leaves a broken row in the gallery forever.
 */
async function deletePhotoObjects(photos) {
  const originals = photos.map(p => p.original_key).filter(Boolean);
  const derivatives = photos.flatMap(p => [p.web_key, p.thumb_key]).filter(Boolean);

  const drop = async (bucket, keys) => {
    if (!keys.length) return;
    // DeleteObjects caps at 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000).map(Key => ({ Key }));
      try {
        await requireClient().send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } })
        );
      } catch (err) {
        console.error(`R2 delete failed (${bucket}, ${batch.length} keys):`, err.message);
      }
    }
  };

  await drop(BUCKET_ORIGINALS, originals);
  await drop(BUCKET_PUBLIC, derivatives);
}

module.exports = {
  isConfigured,
  BUCKET_ORIGINALS,
  BUCKET_PUBLIC,
  PUBLIC_BASE,
  publicUrl,
  presignPut,
  presignGet,
  getObjectBuffer,
  putObject,
  objectExists,
  objectSize,
  deleteObject,
  deletePhotoObjects
};
