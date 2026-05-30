import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";

test("openDb yields a WAL database with fts5+bm25", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-db-"));
  const db = openDb(join(dir, "t.db"));
  const jm = db.prepare("PRAGMA journal_mode").get();
  assert.ok(jm != null);
  assert.equal((jm as { journal_mode: string }).journal_mode, "wal");
  db.exec("CREATE VIRTUAL TABLE s USING fts5(x)");
  db.exec("INSERT INTO s VALUES('grid sync')");
  const row = db.prepare("SELECT bm25(s) AS b FROM s WHERE s MATCH ?").get("grid");
  assert.ok(row != null);
  assert.equal(typeof (row as { b: number }).b, "number");
  db.close();
});
