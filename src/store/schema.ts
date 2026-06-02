import type { Db } from "./db.ts";

export const SCHEMA_VERSION = 4;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, lang TEXT, size INTEGER,
  content_hash TEXT NOT NULL, mtime INTEGER, last_commit_at INTEGER,
  commits_30d INTEGER DEFAULT 0, commits_90d INTEGER DEFAULT 0,
  indexed_at INTEGER NOT NULL, symbols_done INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER, end_line INTEGER,
  start_byte INTEGER, end_byte INTEGER);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE TABLE IF NOT EXISTS cochange (
  file_a INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  file_b INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  weight REAL NOT NULL,
  PRIMARY KEY (file_a, file_b));
CREATE TABLE IF NOT EXISTS refs (
  src_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dst_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, PRIMARY KEY (src_file, dst_file, kind));
CREATE INDEX IF NOT EXISTS idx_refs_dst ON refs(dst_file);
-- standard stored FTS5 (NOT content=''), inverted index over tracked source only,
-- no original byte layout retained.
-- 'content' holds lowercase identifier fragments split from symbol names (NOT raw
-- source text), preserving the no-file-contents invariant.
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  path, symbol_names, keywords, content, tokenize='porter unicode61');
`;

export function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");

  const stored = (
    db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined
  )?.value;
  const storedVersion = stored ? parseInt(stored, 10) : 0;

  if (storedVersion > 0 && storedVersion < SCHEMA_VERSION) {
    // Atomic cleanup: all three must succeed or none, to avoid a half-migrated DB.
    db.exec("BEGIN IMMEDIATE");
    db.exec("DROP TABLE IF EXISTS search_index");
    db.exec("UPDATE files SET symbols_done=0");
    db.exec(
      "DELETE FROM meta WHERE key IN ('head_sha_at_index','cochange_scanned_through','full_crawl_done')",
    );
    db.exec("COMMIT");
  }

  db.exec(DDL);
  db.prepare(
    "INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(SCHEMA_VERSION));
}
