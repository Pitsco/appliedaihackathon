// Our own database, outside Clio: one SQLite file under data/.
// Clio is only ever read. Everything we derive (facts, briefs, shares, costs) lives here.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.join(config.dataDir, 'files'), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'casebrief.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

-- One row per thing pulled from Clio. "hash" is the content hash at the last pull,
-- "digested_hash" the hash the AI last read. They differ only for new or edited items,
-- which is what keeps a re-sync from digesting the whole case again.
CREATE TABLE IF NOT EXISTS source_items (
  id INTEGER PRIMARY KEY,
  matter_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  clio_id TEXT,
  title TEXT,
  body TEXT,
  date TEXT,
  meta TEXT,
  hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  removed_at TEXT,
  digested_hash TEXT,
  digested_at TEXT,
  digest_error TEXT,
  summary TEXT,
  category TEXT,
  importance INTEGER,
  importance_reason TEXT,
  doc_label TEXT,
  doc_type TEXT,
  page_count INTEGER,
  pages_read INTEGER,
  file_path TEXT,
  extra TEXT,
  UNIQUE (matter_id, ref)
);

CREATE TABLE IF NOT EXISTS doc_pages (
  source_id INTEGER NOT NULL,
  page INTEGER NOT NULL,
  text TEXT,
  PRIMARY KEY (source_id, page)
);

-- Atomic, cited facts. Every fact points at the item (and page) it came from and carries
-- the passage that proves it. origin = 'clio' for structured fields, 'ai' for extracted ones.
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  matter_id TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  origin TEXT NOT NULL,
  page INTEGER,
  type TEXT NOT NULL,
  title TEXT,
  detail TEXT,
  date TEXT,
  amount REAL,
  contact_id TEXT,
  status TEXT,
  quote TEXT,
  quote_verified INTEGER,
  sensitivity TEXT
);
CREATE INDEX IF NOT EXISTS facts_by_source ON facts (source_id);
CREATE INDEX IF NOT EXISTS facts_by_matter ON facts (matter_id, type);

CREATE TABLE IF NOT EXISTS briefs (
  matter_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  model TEXT
);

CREATE TABLE IF NOT EXISTS views (id INTEGER PRIMARY KEY, matter_id TEXT NOT NULL, opened_at TEXT NOT NULL);

-- A share is a frozen snapshot of exactly what the attorney approved for one provider.
-- The provider page renders this snapshot and nothing else.
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY,
  matter_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT,
  provider_key TEXT NOT NULL,
  provider_name TEXT,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS share_opens (id INTEGER PRIMARY KEY, share_id INTEGER NOT NULL, opened_at TEXT NOT NULL, agent TEXT);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  matter_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  stats TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  matter_id TEXT,
  step TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  ok INTEGER,
  error TEXT,
  created_at TEXT
);
`);

const statements = new Map();
const prepared = (sql) => {
  let s = statements.get(sql);
  if (!s) {
    s = db.prepare(sql);
    statements.set(sql, s);
  }
  return s;
};

// node:sqlite rejects undefined and booleans, so normalise once here.
const bind = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));

export const all = (sql, ...params) => prepared(sql).all(...bind(params));
export const get = (sql, ...params) => prepared(sql).get(...bind(params));
export const run = (sql, ...params) => prepared(sql).run(...bind(params));

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => new Date().toISOString();

export const getSetting = (key) => get('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
export const setSetting = (key, value) =>
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    key,
    value == null ? null : String(value),
  );

export const parseJson = (text, fallback = null) => {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
