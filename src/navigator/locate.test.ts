import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../store/db.ts";
import { migrate } from "../store/schema.ts";
import { initParsers } from "../indexer/symbols.ts";
import { runIndexPass } from "../indexer/worker-core.ts";
import { locate } from "./locate.ts";
import { DEFAULT_CONFIG } from "../config.ts";

async function indexedFixture() {
  const d = mkdtempSync(join(tmpdir(), "nav-loc-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  writeFileSync(join(d, "grid.rb"), "class Grid\n  def sync; end\nend\n");
  writeFileSync(join(d, "grid_sync.rb"), "require_relative 'grid'\nclass GridSync; end\n");
  writeFileSync(join(d, "unrelated.rb"), "class Widget; end\n");
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-locdb-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  return { db, root: d };
}

test("locate ranks the Grid class file first and fans out referrers", async () => {
  const { db, root } = await indexedFixture();
  const res = locate(db, root, "Grid", DEFAULT_CONFIG);
  assert.ok(res.results.length > 0, "should return results");
  assert.equal(res.results[0].path, "grid.rb");
  assert.ok(res.cluster, "cluster present");
  assert.equal(res.cluster!.anchor, "grid.rb");
  // grid_sync.rb require_relative 'grid' → referrer of grid.rb
  assert.ok(res.cluster!.referrers.includes("grid_sync.rb"), "referrer fan-out");
});

test("test-file penalty: impl outranks spec for equal query", async () => {
  const d = mkdtempSync(join(tmpdir(), "nav-loc-penalty-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  writeFileSync(join(d, "grid.rb"), [
    "class Grid",
    "  # power flow calculation",
    "  def power_flow; end",
    "  def grid_sync; end",
    "end",
  ].join("\n") + "\n");
  mkdirSync(join(d, "spec"), { recursive: true });
  writeFileSync(join(d, "spec", "grid_spec.rb"), [
    "describe Grid do",
    "  # power flow spec",
    "  it 'computes power flow' do",
    "    grid = Grid.new",
    "    expect(grid.power_flow).to eq(true)",
    "  end",
    "end",
  ].join("\n") + "\n");
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-loc-penaltydb-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  const res = locate(db, d, "grid power flow", DEFAULT_CONFIG);
  assert.ok(res.results.length >= 2, "should return at least 2 results");
  assert.equal(res.results[0].path, "grid.rb", "impl file should rank above spec");
});

test("df-cap suppresses referrer list when anchor has high fan-in", async () => {
  const d = mkdtempSync(join(tmpdir(), "nav-loc-dfcap-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
  writeFileSync(join(d, "application_record.rb"), "class ApplicationRecord\n  # base record\nend\n");
  writeFileSync(join(d, "user.rb"), "class User < ApplicationRecord\nend\n");
  writeFileSync(join(d, "post.rb"), "class Post < ApplicationRecord\nend\n");
  writeFileSync(join(d, "comment.rb"), "class Comment < ApplicationRecord\nend\n");
  git(["add", "."]); git(["commit", "-qm", "init"]);
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-loc-dfcapdb-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
  const res = locate(db, d, "ApplicationRecord", DEFAULT_CONFIG);
  assert.ok(res.results.length > 0, "should return results");
  assert.equal(res.results[0].path, "application_record.rb", "ApplicationRecord should be top result");
  // fan-in = 3 (user, post, comment all reference ApplicationRecord)
  // totalFiles = 4, ratio = 3/4 = 0.75 > 0.2 → referrers suppressed
  assert.ok(res.cluster, "cluster should be present");
  assert.deepEqual(res.cluster!.referrers, [], "referrers suppressed when fan-in exceeds df-cap");
});

test("locate on no match returns empty, no throw", async () => {
  const { db, root } = await indexedFixture();
  const res = locate(db, root, "nonexistentsymbolxyz", DEFAULT_CONFIG);
  assert.deepEqual(res.results, []);
  assert.equal(res.cluster, null);
});
