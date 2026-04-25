PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'bilibili',
  room_id TEXT NOT NULL UNIQUE,
  streamer_name TEXT,
  cookie TEXT,
  auto_record INTEGER NOT NULL DEFAULT 1,
  output_dir TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  session_type TEXT NOT NULL DEFAULT 'live',
  title TEXT,
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
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
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
  segment_id INTEGER REFERENCES segments(id) ON DELETE SET NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  -- 规则评分
  rule_score REAL NOT NULL DEFAULT 0,
  score_danmaku REAL NOT NULL DEFAULT 0,
  score_interaction REAL NOT NULL DEFAULT 0,
  score_transcript REAL NOT NULL DEFAULT 0,
  score_energy REAL NOT NULL DEFAULT 0,
  -- 最终评分（规则 + LLM）
  score_total REAL NOT NULL DEFAULT 0,
  -- LLM 分析结果
  llm_score REAL,
  llm_category TEXT,
  llm_confidence REAL,
  llm_worth INTEGER,
  llm_risk TEXT,
  -- 推荐信息
  ai_summary TEXT,
  ai_title_suggestion TEXT,
  ai_reason TEXT,
  ai_highlight TEXT,
  -- 建议的时间调整
  suggested_trim_start INTEGER DEFAULT 0,
  suggested_trim_end INTEGER DEFAULT 0,
  -- 审核状态
  status TEXT NOT NULL DEFAULT 'pending',
  user_note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  candidate_ids TEXT NOT NULL,
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

-- 会话统计缓存（避免重复计算）
CREATE TABLE IF NOT EXISTS session_stats (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  -- 弹幕统计
  danmaku_total INTEGER DEFAULT 0,
  danmaku_p50 REAL,
  danmaku_p75 REAL,
  danmaku_p90 REAL,
  -- 付费统计
  interaction_total INTEGER DEFAULT 0,
  interaction_p75 REAL,
  interaction_p90 REAL,
  interaction_p95 REAL,
  -- 能量统计
  energy_p75 REAL,
  energy_p90 REAL,
  -- 元数据
  computed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sessions_source_id ON sessions(source_id);
CREATE INDEX IF NOT EXISTS idx_segments_session_id ON segments(session_id);
CREATE INDEX IF NOT EXISTS idx_danmaku_segment_time ON danmaku_events(segment_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_candidates_session_id ON candidates(session_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_score ON candidates(session_id, score_total DESC);
CREATE INDEX IF NOT EXISTS idx_exports_session_id ON exports(session_id);
