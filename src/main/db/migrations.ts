export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Append-only. Never edit a shipped migration: add a new one. */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  experience TEXT NOT NULL DEFAULT '',
  education TEXT NOT NULL DEFAULT '',
  preferred_style TEXT NOT NULL DEFAULT 'conversational',
  preferred_mode TEXT NOT NULL DEFAULT 'standard',
  target_roles TEXT NOT NULL DEFAULT '[]',
  interview_preferences TEXT NOT NULL DEFAULT '',
  extra_facts TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('openai-compatible','anthropic','google')),
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE model_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  temperature REAL NOT NULL DEFAULT 0.4,
  max_tokens INTEGER NOT NULL DEFAULT 400,
  top_p REAL,
  timeout_ms INTEGER NOT NULL DEFAULT 20000,
  streaming INTEGER NOT NULL DEFAULT 1
);

-- Secrets are encrypted with the OS keystore (DPAPI on Windows) before they reach this table.
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  hint TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE resumes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  parse_method TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE interviews (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  job_title TEXT NOT NULL,
  company TEXT NOT NULL,
  interview_type TEXT NOT NULL,
  company_notes TEXT NOT NULL DEFAULT '',
  interviewer_info TEXT NOT NULL DEFAULT '',
  resume_id TEXT REFERENCES resumes(id) ON DELETE SET NULL,
  match_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE job_descriptions (
  id TEXT PRIMARY KEY,
  interview_id TEXT NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL,
  analysis_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE prep_sections (
  interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  model TEXT,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (interview_id, key)
);

CREATE TABLE stories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  situation TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  roles TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user',
  favorite INTEGER NOT NULL DEFAULT 0,
  practice_count INTEGER NOT NULL DEFAULT 0,
  last_practiced_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_questions_category ON questions(category);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('live','mock','practice')),
  interview_id TEXT REFERENCES interviews(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  interview_type TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  stats_json TEXT,
  prep_snapshot TEXT
);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  interview_id TEXT REFERENCES interviews(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  question_kind TEXT,
  answer_text TEXT NOT NULL,
  mode TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  latency_json TEXT,
  grounding_json TEXT,
  feedback TEXT NOT NULL DEFAULT '[]',
  edited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_answers_session ON answers(session_id);
CREATE INDEX idx_answers_interview ON answers(interview_id, source);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_transcripts_session ON transcripts(session_id, seq);

CREATE TABLE bench_runs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  result_json TEXT NOT NULL
);

-- Full-text search over sessions (questions, answers, transcript, notes). Rebuilt per session by the app.
CREATE VIRTUAL TABLE search_index USING fts5(session_id UNINDEXED, title, body, tokenize = 'porter unicode61');
`,
  },
  {
    id: 2,
    name: 'mock evaluation on answers',
    sql: `ALTER TABLE answers ADD COLUMN mock_json TEXT;`,
  },
  {
    id: 3,
    name: 'provider options (Google sign-in mode)',
    // JSON, only used for Google providers: { mode, backend, project, location }. NULL = an API-key provider.
    sql: `ALTER TABLE providers ADD COLUMN options_json TEXT;`,
  },
];
