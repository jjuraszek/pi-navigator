import type { Db } from "./db.ts";

export const SCHEMA_VERSION = 2;

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
-- FTS5: rowid == files.id.
-- Deliberate divergence from spec §5.6 (which specifies content='' contentless):
-- we store path, symbol_names, and kind_tags as real columns so SELECT returns
-- non-null values for ranking. These are metadata strings only — NOT file contents.
-- The no-contents invariant (spec §10 / AGENTS.md) is preserved.
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  path, symbol_names, kind_tags, tokenize='unicode61');
`;

export function migrate(db: Db): void {
  db.exec(DDL);
  db.prepare(
    "INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(SCHEMA_VERSION));
}
