import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../store/db.ts";
import { migrate } from "../store/schema.ts";
import { initParsers } from "../indexer/symbols.ts";
import { slice } from "./slice.ts";
import { VerifiedCache } from "./verified-cache.ts";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "nav-slice-"));
  writeFileSync(join(root, "grid.rb"), "class Grid\n  def sync\n    1\n  end\nend\n");
  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-sdb-")), "i.db"));
  migrate(db);
  return { root, db };
}

test("slice returns a symbol body + hash; second read is unchanged; edit invalidates", async () => {
  const { root, db } = await setup();
  const cache = new VerifiedCache();
  const r1 = slice(db, root, cache, { path: "grid.rb", symbol: "Grid" });
  assert.ok(r1.content.includes("class Grid"));
  assert.equal(r1.unchanged_since_last_read, false);
  assert.match(r1.content_hash, /^[0-9a-f]{64}$/);

  const r2 = slice(db, root, cache, { path: "grid.rb", symbol: "Grid" });
  assert.equal(r2.unchanged_since_last_read, true, "same content → unchanged");

  writeFileSync(join(root, "grid.rb"), "class Grid\n  def sync; 2; end\nend\n");
  const r3 = slice(db, root, cache, { path: "grid.rb", symbol: "Grid" });
  assert.equal(r3.unchanged_since_last_read, false, "after edit → changed");
  assert.notEqual(r3.content_hash, r1.content_hash);
});

test("slice rejects path traversal", async () => {
  const { root, db } = await setup();
  const cache = new VerifiedCache();
  assert.throws(() => slice(db, root, cache, { path: "../../etc/passwd" }), /escapes worktree/);
});

test("slice by line range returns those lines", async () => {
  const { root, db } = await setup();
  const cache = new VerifiedCache();
  const r = slice(db, root, cache, { path: "grid.rb", startLine: 2, endLine: 3 });
  assert.equal(r.content, "  def sync\n    1"); // lines 2-3 (1-based)
});

test("slice refuses secret files", async () => {
  const { root, db } = await setup();
  writeFileSync(join(root, ".env"), "SECRET=hunter2\n");
  const cache = new VerifiedCache();
  assert.throws(() => slice(db, root, cache, { path: ".env" }), /secret/i);
});
