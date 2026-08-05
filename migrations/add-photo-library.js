/**
 * Photo library schema — albums + photos.
 *
 * Run manually:  node migrations/add-photo-library.js
 *
 * The same statements also run from the auto-migration block in server.js, so a
 * plain Railway deploy creates these tables without anyone running this by hand.
 * This file exists for local databases and for the onsite Mini PC.
 */

require('dotenv').config();
const pool = require('../config/database');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS photo_albums (
     id            SERIAL PRIMARY KEY,
     name          VARCHAR(160) NOT NULL,
     slug          VARCHAR(160) UNIQUE NOT NULL,
     year          INTEGER,
     description   TEXT,
     is_public     BOOLEAN DEFAULT true,
     sort_order    INTEGER DEFAULT 0,
     created_at    TIMESTAMP DEFAULT NOW(),
     updated_at    TIMESTAMP DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS photos (
     id                UUID PRIMARY KEY,
     album_id          INTEGER REFERENCES photo_albums(id) ON DELETE SET NULL,

     -- pending | approved | rejected. Staff uploads skip straight to approved;
     -- anything from the public lands in pending for moderation.
     status            VARCHAR(20) NOT NULL DEFAULT 'pending',
     source            VARCHAR(20) NOT NULL DEFAULT 'public',   -- public | staff

     -- Private bucket. The full-resolution file exactly as it came off the camera.
     original_key      TEXT,
     original_filename TEXT,
     original_bytes    BIGINT,
     content_type      VARCHAR(100),

     -- Public bucket. Derivatives generated in the browser at upload time.
     web_key           TEXT,
     thumb_key         TEXT,

     width             INTEGER,
     height            INTEGER,
     taken_at          TIMESTAMP,

     caption           TEXT,
     credit            VARCHAR(200),
     tags              TEXT[] DEFAULT '{}',
     featured          BOOLEAN DEFAULT false,

     uploader_name     VARCHAR(160),
     uploader_email    VARCHAR(200),

     -- Proof of the licence grant for public submissions. consent_text stores the
     -- exact wording shown at upload time so a later reword can't retroactively
     -- change what someone actually agreed to.
     consent           BOOLEAN DEFAULT false,
     consent_text      TEXT,
     consent_ip        VARCHAR(64),
     consent_at        TIMESTAMP,

     uploaded_by       INTEGER,
     review_note       TEXT,
     reviewed_by       INTEGER,
     reviewed_at       TIMESTAMP,

     -- Anonymous uploaders have no session, so upload-init hands back a random
     -- token that the matching /complete call must present. Without it anyone
     -- could flip arbitrary photo rows to "uploaded".
     upload_token      VARCHAR(64),
     upload_complete   BOOLEAN DEFAULT false,

     created_at        TIMESTAMP DEFAULT NOW(),
     updated_at        TIMESTAMP DEFAULT NOW()
   )`,

  // The public gallery's hot query: approved + complete, newest first.
  `CREATE INDEX IF NOT EXISTS idx_photos_public
     ON photos (status, upload_complete, taken_at DESC NULLS LAST, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_album ON photos (album_id)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_status ON photos (status)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_tags ON photos USING GIN (tags)`,

  // Abandoned upload-init rows (browser closed mid-upload) are swept by the
  // cleanup job in routes/photos.js; this index keeps that sweep cheap.
  `CREATE INDEX IF NOT EXISTS idx_photos_incomplete
     ON photos (upload_complete, created_at) WHERE upload_complete = false`
];

async function run(query) {
  for (const sql of STATEMENTS) {
    await query(sql);
  }
}

module.exports = { STATEMENTS, run };

if (require.main === module) {
  (async () => {
    try {
      for (const sql of STATEMENTS) {
        await pool.query(sql);
        console.log('✓', sql.trim().split('\n')[0].slice(0, 70));
      }
      console.log('\n✓ Photo library schema ready');
      process.exit(0);
    } catch (err) {
      console.error('✗ Migration failed:', err.message);
      process.exit(1);
    }
  })();
}
