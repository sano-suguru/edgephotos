-- EdgePhotos v1 initial schema.
-- The schema source of truth is this migration directory (forward-only).

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ready', 'purging')),
  sha256 TEXT NOT NULL,
  original_size INTEGER NOT NULL,
  original_content_type TEXT NOT NULL,
  original_filename TEXT,
  width INTEGER,
  height INTEGER,
  taken_at TEXT,
  sort_at INTEGER NOT NULL,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  trashed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One asset per original byte sequence. Re-uploads converge on the existing asset.
CREATE UNIQUE INDEX assets_sha256 ON assets (sha256);
CREATE INDEX assets_timeline ON assets (sort_at DESC, id DESC);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'finalized', 'duplicate')),
  sha256 TEXT NOT NULL,
  original_size INTEGER NOT NULL,
  original_content_type TEXT NOT NULL,
  thumbnail_size INTEGER NOT NULL,
  preview_size INTEGER NOT NULL,
  original_filename TEXT,
  width INTEGER,
  height INTEGER,
  taken_at TEXT,
  duplicate_of TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finalized_at TEXT
);

CREATE INDEX uploads_status ON uploads (status, created_at);

CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE album_assets (
  album_id TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (album_id, asset_id)
);

CREATE INDEX album_assets_asset ON album_assets (asset_id);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  -- SHA-256 (hex) of the share secret. The plaintext secret is never stored.
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX shares_album ON shares (album_id, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
