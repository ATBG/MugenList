-- 001_initial_schema.sql
-- Create core schema for MugelList

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS anime (
  root_mal_id INTEGER PRIMARY KEY,
  title_english TEXT,
  title_japanese TEXT,
  normalized_root_title TEXT,
  franchise_id INTEGER,
  franchise_rank_score REAL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_mal_id INTEGER NOT NULL REFERENCES anime(root_mal_id) ON DELETE CASCADE,
  mal_id INTEGER NOT NULL,
  title_english TEXT,
  title_japanese TEXT,
  progress INTEGER DEFAULT 0,
  total_episodes INTEGER DEFAULT 0,
  watch_status TEXT DEFAULT 'plan_to_watch',
  has_new_episode INTEGER DEFAULT 0,
  next_episode_airing_at INTEGER DEFAULT NULL,
  next_episode_number INTEGER DEFAULT NULL,
  last_notified_episode INTEGER DEFAULT NULL,
  updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(root_mal_id, mal_id)
);

CREATE INDEX IF NOT EXISTS idx_seasons_root ON seasons(root_mal_id);
CREATE INDEX IF NOT EXISTS idx_seasons_mal ON seasons(mal_id);

CREATE TABLE IF NOT EXISTS playback_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_mal_id INTEGER REFERENCES anime(root_mal_id) ON DELETE SET NULL,
  mal_id INTEGER,
  season_mal_id INTEGER,
  playback_time INTEGER,
  file_path TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_playback_recent ON playback_history(created_at DESC);

CREATE TABLE IF NOT EXISTS linked_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE,
  label TEXT,
  last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  payload TEXT,
  expires_at INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT,
  row_key TEXT,
  old_value TEXT,
  new_value TEXT,
  changed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reason TEXT
);

COMMIT;
