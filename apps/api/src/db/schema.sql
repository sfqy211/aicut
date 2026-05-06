PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'bilibili',
  room_id TEXT NOT NULL UNIQUE,
  streamer_name TEXT,
  cookie TEXT,
  auto_record INTEGER NOT NULL DEFAULT 1,
  analysis_interval INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  session_type TEXT NOT NULL DEFAULT 'live',
  live_id TEXT,
  title TEXT,
  streamer_name TEXT,
  cover_url TEXT,
  avatar_url TEXT,
  start_time INTEGER,
  end_time INTEGER,
  status TEXT NOT NULL DEFAULT 'recording',
  total_duration INTEGER,
  total_size INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER,
  file_path TEXT NOT NULL,
  start_offset INTEGER NOT NULL DEFAULT 0,
  duration INTEGER,
  size INTEGER,
  has_danmaku INTEGER NOT NULL DEFAULT 0,
  danmaku_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_msg TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'auto',
  full_text TEXT,
  words_json TEXT,
  segments_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_transcripts_session_id ON transcripts(session_id);

CREATE TABLE IF NOT EXISTS danmaku_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  text TEXT,
  user_id TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  ai_description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  user_note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  candidate_ids TEXT,
  ranges_json TEXT,
  output_path TEXT,
  options_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  error_msg TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS bilibili_accounts (
  uid INTEGER PRIMARY KEY,
  uname TEXT NOT NULL,
  face TEXT,
  cookie TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sessions_source_id ON sessions(source_id);
CREATE INDEX IF NOT EXISTS idx_segments_session_id ON segments(session_id);
CREATE INDEX IF NOT EXISTS idx_danmaku_session_time ON danmaku_events(session_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_candidates_session_id ON candidates(session_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_exports_session_id ON exports(session_id);
