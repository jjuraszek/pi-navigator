import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { migrate, SCHEMA_VERSION } from "./schema.ts";

test("deleting a file cascades to cochange", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-cc-")), "t.db"));
  migrate(db);
  db.exec("INSERT INTO files(id,path,content_hash,indexed_at) VALUES (1,'a.rb','h1',1),(2,'b.rb','h2',1)");
  db.exec("INSERT INTO cochange(file_a,file_b,weight) VALUES (1,2,3.0)");
  db.exec("DELETE FROM files WHERE id=1");
  const n = (db.prepare("SELECT COUNT(*) AS c FROM cochange").get() as { c: number }).c;
  assert.equal(n, 0);
});

test("migrate upgrades v2 DB to v3: widens search_index, resets symbols_done, clears stale meta", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-v2v3-"));
  const db = openDb(join(dir, "t.db"));

  // Build a v2-state DB manually
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, lang TEXT, size INTEGER,
      content_hash TEXT NOT NULL, mtime INTEGER, last_commit_at INTEGER,
      commits_30d INTEGER DEFAULT 0, commits_90d INTEGER DEFAULT 0,
      indexed_at INTEGER NOT NULL, symbols_done INTEGER DEFAULT 0);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      path, symbol_names, kind_tags, tokenize='unicode61');
  `);
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version','2')").run();
  db.prepare("INSERT INTO files(id,path,content_hash,indexed_at,symbols_done) VALUES(1,'a.ts','h1',1,1)").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('full_crawl_done','1')").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('head_sha_at_index','abc')").run();

  migrate(db);

  // schema_version updated to current SCHEMA_VERSION
  const sv = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;
  assert.equal(sv, String(SCHEMA_VERSION));

  // search_index DDL has keywords and content columns, not kind_tags
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='search_index'").get() as { sql: string };
  assert.ok(row.sql.includes("keywords"), "search_index missing keywords column");
  assert.ok(row.sql.includes("content"), "search_index missing content column");
  assert.ok(!row.sql.includes("kind_tags"), "search_index still has old kind_tags column");

  // symbols_done reset to 0
  const file = db.prepare("SELECT symbols_done FROM files WHERE id=1").get() as { symbols_done: number };
  assert.equal(file.symbols_done, 0);

  // full_crawl_done meta deleted; head_sha_at_index also deleted
  const fcRow = db.prepare("SELECT value FROM meta WHERE key='full_crawl_done'").get();
  assert.equal(fcRow, undefined);
  const hsRow = db.prepare("SELECT value FROM meta WHERE key='head_sha_at_index'").get();
  assert.equal(hsRow, undefined);
});

test("migrate creates all tables and is idempotent", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-sch-")), "t.db"));
  migrate(db);
  migrate(db); // idempotent
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r: any) => r.name);
  for (const t of ["meta", "files", "symbols", "cochange", "refs", "search_index"]) assert.ok(tables.includes(t), `missing ${t}`);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
});
