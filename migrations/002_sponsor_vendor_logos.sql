-- ============================================
-- 002 — SPONSOR & VENDOR LOGOS
-- ============================================
--
-- Adds multi-logo support for sponsors and vendors. Files are stored on
-- Vercel Blob; only the URL is persisted here.
--
-- NOTE: This file is the canonical schema doc. The same statements are
-- mirrored in server.js auto-migrations so they actually run on Railway
-- deploy. Eventually both should move to a real migration tool.

-- ============================================
-- LINK SPONSORS / VENDORS TO USERS (future portal)
-- ============================================
-- Not used by the v1 logo routes (admin/manager only), but added now so a
-- future sponsor/vendor self-serve portal can attach accounts.

ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vendors  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sponsors_user_id ON sponsors(user_id);
CREATE INDEX IF NOT EXISTS idx_vendors_user_id  ON vendors(user_id);

-- ============================================
-- SPONSOR LOGOS
-- ============================================

CREATE TABLE IF NOT EXISTS sponsor_logos (
  id            SERIAL PRIMARY KEY,
  sponsor_id    INTEGER NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  blob_url      TEXT NOT NULL,
  filename      VARCHAR(500) NOT NULL,
  extension     VARCHAR(20),
  format        VARCHAR(10) NOT NULL CHECK (format IN ('vector', 'bitmap')),
  variant       VARCHAR(20) CHECK (variant IS NULL OR variant IN ('full-color', 'black', 'white', 'icon')),
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  size_bytes    BIGINT,
  notes         TEXT,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sponsor_logos_sponsor ON sponsor_logos(sponsor_id);

-- At most one primary logo per sponsor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsor_logos_one_primary
  ON sponsor_logos(sponsor_id) WHERE is_primary;

-- ============================================
-- VENDOR LOGOS
-- ============================================

CREATE TABLE IF NOT EXISTS vendor_logos (
  id            SERIAL PRIMARY KEY,
  vendor_id     INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  blob_url      TEXT NOT NULL,
  filename      VARCHAR(500) NOT NULL,
  extension     VARCHAR(20),
  format        VARCHAR(10) NOT NULL CHECK (format IN ('vector', 'bitmap')),
  variant       VARCHAR(20) CHECK (variant IS NULL OR variant IN ('full-color', 'black', 'white', 'icon')),
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  size_bytes    BIGINT,
  notes         TEXT,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vendor_logos_vendor ON vendor_logos(vendor_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_logos_one_primary
  ON vendor_logos(vendor_id) WHERE is_primary;
