import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { migrate } from "./schema.ts";
import {
  upsertFile,
  getFileByPath,
  getAllFiles,
  setSymbolsDone,
  replaceSymbols,
  replaceRefs,
  upsertCochange,
  ftsUpsert,
  setMeta,
  getMeta,
  getCoverage,
} from "./queries.ts";

function freshDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-q-")), "t.db"));
  migrate(db);
  return db;
}

const baseRec = {
  path: "app/grid.rb",
  lang: "ruby" as const,
  size: 10,
  content_hash: "h1",
  mtime: 1,
  last_commit_at: null,
  commits_30d: 0,
  commits_90d: 0,
  indexed_at: 1,
  symbols_done: 0 as const,
};

// --- from task spec ---

test("upsertFile inserts then updates (no duplicate)", () => {
  const db = freshDb();
  const id1 = upsertFile(db, baseRec);
  const id2 = upsertFile(db, { ...baseRec, content_hash: "h2", size: 20 });
  assert.equal(id1, id2);
  const row = getFileByPath(db, "app/grid.rb")!;
  assert.equal(row.content_hash, "h2");
  assert.equal(row.size, 20);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM files").get() as { c: number }).c, 1);
});

test("ftsUpsert is idempotent and searchable", () => {
  const db = freshDb();
  const id = upsertFile(db, baseRec);
  ftsUpsert(db, id, "app/grid.rb", "Grid sync", "class method");
  ftsUpsert(db, id, "app/grid.rb", "Grid sync", "class method"); // re-index, no dup
  const hits = db
    .prepare("SELECT rowid FROM search_index WHERE search_index MATCH ?")
    .all("Grid") as { rowid: number }[];
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rowid, id);
});

test("replaceSymbols replaces, getCoverage counts, meta roundtrips", () => {
  const db = freshDb();
  const id = upsertFile(db, baseRec);
  replaceSymbols(db, id, [
    { name: "Grid", kind: "class", start_line: 0, end_line: 5, start_byte: 0, end_byte: 50 },
  ]);
  replaceSymbols(db, id, [
    { name: "Grid2", kind: "class", start_line: 0, end_line: 5, start_byte: 0, end_byte: 50 },
  ]);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE file_id=?").get(id) as { c: number }).c,
    1,
  );
  setMeta(db, "head_sha_at_index", "abc");
  assert.equal(getMeta(db, "head_sha_at_index"), "abc");
  const cov = getCoverage(db);
  assert.equal(cov.total, 1);
});

// --- additional tests ---

test("replaceRefs deletes old then inserts new edges", () => {
  const db = freshDb();
  const a = upsertFile(db, { ...baseRec, path: "a.rb" });
  const b = upsertFile(db, { ...baseRec, path: "b.rb" });
  const c = upsertFile(db, { ...baseRec, path: "c.rb" });

  replaceRefs(db, a, [
    { dstFileId: b, kind: "require_relative" },
    { dstFileId: c, kind: "require_relative" },
  ]);
  let count = (
    db.prepare("SELECT COUNT(*) AS c FROM refs WHERE src_file=?").get(a) as { c: number }
  ).c;
  assert.equal(count, 2);

  // Replace with only one edge — old ones should be gone
  replaceRefs(db, a, [{ dstFileId: b, kind: "require_relative" }]);
  count = (db.prepare("SELECT COUNT(*) AS c FROM refs WHERE src_file=?").get(a) as { c: number })
    .c;
  assert.equal(count, 1);

  // Duplicate insert should not error (INSERT OR IGNORE)
  replaceRefs(db, a, [{ dstFileId: b, kind: "require_relative" }]);
  count = (db.prepare("SELECT COUNT(*) AS c FROM refs WHERE src_file=?").get(a) as { c: number })
    .c;
  assert.equal(count, 1);
});

test("upsertCochange normalises pair so file_a < file_b, accumulates weight", () => {
  const db = freshDb();
  const x = upsertFile(db, { ...baseRec, path: "x.rb" });
  const y = upsertFile(db, { ...baseRec, path: "y.rb" });
  assert.ok(x < y, "x should have lower id than y in this fresh db");

  // Insert with reversed order (y, x) — should normalise to (x, y)
  upsertCochange(db, y, x, 0.5);
  const row1 = db.prepare("SELECT * FROM cochange WHERE file_a=? AND file_b=?").get(x, y) as
    | { file_a: number; file_b: number; weight: number }
    | undefined;
  assert.ok(row1, "row should exist with file_a=x, file_b=y");
  assert.equal(row1.file_a, x);
  assert.equal(row1.file_b, y);
  assert.ok(Math.abs(row1.weight - 0.5) < 1e-9);

  // Upsert again with correct order — weight should be replaced (ON CONFLICT DO UPDATE)
  upsertCochange(db, x, y, 1.2);
  const row2 = db.prepare("SELECT weight FROM cochange WHERE file_a=? AND file_b=?").get(x, y) as
    | { weight: number }
    | undefined;
  assert.ok(row2);
  assert.ok(Math.abs(row2.weight - 1.2) < 1e-9);

  // Only one row
  const total = (db.prepare("SELECT COUNT(*) AS c FROM cochange").get() as { c: number }).c;
  assert.equal(total, 1);
});

test("getAllFiles returns lightweight rows including symbols_done", () => {
  const db = freshDb();
  upsertFile(db, baseRec);
  upsertFile(db, { ...baseRec, path: "b.rb", symbols_done: 0 });
  const rows = getAllFiles(db);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok("id" in r && "path" in r && "mtime" in r && "size" in r);
    assert.ok("content_hash" in r && "symbols_done" in r);
  }
});

test("setSymbolsDone flips the flag, getCoverage indexed count matches", () => {
  const db = freshDb();
  const id1 = upsertFile(db, { ...baseRec, path: "a.rb" });
  const id2 = upsertFile(db, { ...baseRec, path: "b.rb" });

  let cov = getCoverage(db);
  assert.equal(cov.total, 2);
  assert.equal(cov.indexed, 0);

  setSymbolsDone(db, id1, 1);
  cov = getCoverage(db);
  assert.equal(cov.indexed, 1);

  setSymbolsDone(db, id2, 1);
  cov = getCoverage(db);
  assert.equal(cov.indexed, 2);

  setSymbolsDone(db, id1, 0);
  cov = getCoverage(db);
  assert.equal(cov.indexed, 1);
});

test("getMeta returns undefined for missing key", () => {
  const db = freshDb();
  assert.equal(getMeta(db, "nonexistent"), undefined);
});
