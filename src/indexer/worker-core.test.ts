import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../store/db.ts";
import { migrate } from "../store/schema.ts";
import { initParsers } from "./symbols.ts";
import { deriveBacklog, runIndexPass } from "./worker-core.ts";
import { DEFAULT_CONFIG } from "../config.ts";

async function fixtureRepo() {
  const d = mkdtempSync(join(tmpdir(), "nav-wc-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  writeFileSync(join(d, "grid.rb"), "class Grid; def sync; end; end");
  writeFileSync(join(d, "grid_sync.rb"), "require_relative 'grid'");
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  return d;
}

test("runIndexPass indexes all files and is resumable", async () => {
  const d = await fixtureRepo();
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-db-")), "i.db"));
  migrate(db);
  const c1 = runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 1, maxFiles: 1, priority: [] });
  assert.equal(c1.indexed, 1);
  const backlog = deriveBacklog(db, d, DEFAULT_CONFIG);
  assert.equal(backlog.files.length, 1);
  const c2 = runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  assert.equal(c2.indexed, 2);
  const hit = db.prepare("SELECT path FROM search_index WHERE search_index MATCH ?").all("Grid").map((r: any) => r.path);
  assert.ok(hit.includes("grid.rb"));
});

test("import resolution creates grid_sync.rb -> grid.rb ref", async () => {
  const d = await fixtureRepo();
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-db2-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  const gRow = db.prepare("SELECT id FROM files WHERE path='grid.rb'").get() as { id: number } | undefined;
  const sRow = db.prepare("SELECT id FROM files WHERE path='grid_sync.rb'").get() as { id: number } | undefined;
  assert.ok(gRow, "grid.rb must be indexed");
  assert.ok(sRow, "grid_sync.rb must be indexed");
  const refRows = db.prepare("SELECT 1 FROM refs WHERE src_file=? AND dst_file=?").all(sRow!.id, gRow!.id);
  assert.equal(refRows.length, 1, "grid_sync.rb must have a ref edge to grid.rb");
});
