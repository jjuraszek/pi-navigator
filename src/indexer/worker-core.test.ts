import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

test("ref resolves when importer sorts before target (same pass)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nav-order-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  writeFileSync(join(d, "a_importer.rb"), "require_relative 'z_target'");
  writeFileSync(join(d, "z_target.rb"), "class ZTarget; end");
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-db2-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  const sid = (db.prepare("SELECT id FROM files WHERE path='a_importer.rb'").get() as any).id;
  const tid = (db.prepare("SELECT id FROM files WHERE path='z_target.rb'").get() as any).id;
  const rows = db.prepare("SELECT 1 FROM refs WHERE src_file=? AND dst_file=?").all(sid, tid);
  assert.equal(rows.length, 1, "importer-first ref must resolve");
});

test("ruby constant resolves to app file as ruby_const ref edge", async () => {
  const d = mkdtempSync(join(tmpdir(), "nav-rubyconst-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  mkdirSync(join(d, "app", "models"), { recursive: true });
  mkdirSync(join(d, "app", "controllers"), { recursive: true });
  writeFileSync(join(d, "app", "models", "user.rb"), "class User; end");
  writeFileSync(join(d, "app", "controllers", "orders_controller.rb"), "class OrdersController; def create; User.find(1); end; end");
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-db-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  const userRow = db.prepare("SELECT id FROM files WHERE path='app/models/user.rb'").get() as { id: number } | undefined;
  const ctrlRow = db.prepare("SELECT id FROM files WHERE path='app/controllers/orders_controller.rb'").get() as { id: number } | undefined;
  assert.ok(userRow, "user.rb must be indexed");
  assert.ok(ctrlRow, "orders_controller.rb must be indexed");
  const refs = db.prepare("SELECT kind FROM refs WHERE src_file=? AND dst_file=?").all(ctrlRow!.id, userRow!.id) as { kind: string }[];
  assert.ok(refs.some((r) => r.kind === "ruby_const"), "orders_controller must have a ruby_const ref to user.rb");
});

test("unresolvable stdlib constant produces no ref edge", async () => {
  const d = mkdtempSync(join(tmpdir(), "nav-stdlib-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  writeFileSync(join(d, "scheduler.rb"), "class Scheduler; def run; Time.now; end; end");
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-db-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  const row = db.prepare("SELECT id FROM files WHERE path='scheduler.rb'").get() as { id: number } | undefined;
  assert.ok(row, "scheduler.rb must be indexed");
  const refs = db.prepare("SELECT * FROM refs WHERE src_file=?").all(row!.id);
  assert.equal(refs.length, 0, "Time (stdlib) must not produce a ref edge");
});

test("keywords column populated and keyword MATCH finds file", async () => {
  const d = mkdtempSync(join(tmpdir(), "nav-kw-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  writeFileSync(join(d, "power_flow.rb"), "class PowerFlow; def calculate; end; end");
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-db-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  const hits = db.prepare("SELECT path FROM search_index WHERE search_index MATCH ?").all("calculate").map((r: any) => r.path) as string[];
  assert.ok(hits.includes("power_flow.rb"), "FTS keyword match for 'calculate' must find power_flow.rb");
});

test("comment-only term becomes searchable after indexing", async () => {
  const d = mkdtempSync(join(tmpdir(), "nav-comment-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  // 'authentication' appears only in a comment — not in any symbol name or path
  writeFileSync(join(d, "widget.rb"), [
    "class Widget",
    "  # handles authentication retries",
    "  def run",
    "  end",
    "end",
  ].join("\n"));
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-db-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  const fileRow = db.prepare("SELECT rowid FROM files WHERE path='widget.rb'").get() as { rowid: number } | undefined;
  assert.ok(fileRow, "widget.rb must be indexed");
  const hits = db
    .prepare("SELECT path FROM search_index WHERE search_index MATCH ?")
    .all("authentication")
    .map((r: any) => r.path) as string[];
  assert.ok(hits.includes("widget.rb"), `FTS MATCH 'authentication' must find widget.rb; got: ${hits.join(",")}`);
});
