import test from "node:test";
import assert from "node:assert/strict";
import { parseLog, foldSignals, readLog } from "./git.ts";

const RAW = [
  "__C__ aaa 1000",
  "app/grid.rb",
  "app/grid_sync.rb",
  "",
  "__C__ bbb 900",
  "app/grid.rb",
  "README.md",
].join("\n");

test("parseLog groups files per commit", () => {
  const commits = parseLog(RAW);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], { sha: "aaa", ts: 1000, files: ["app/grid.rb", "app/grid_sync.rb"] });
});

test("foldSignals: co-change pairs + recency counts", () => {
  const now = 1000 + 5 * 86400;
  const { recency, cochange } = foldSignals(parseLog(RAW), {
    now, windowDays: 180, maxFilesPerCommit: 50,
  });
  assert.ok((cochange.get("app/grid.rb\u0000app/grid_sync.rb") ?? 0) > 0);
  assert.equal(recency.get("app/grid.rb")!.c90, 2);
  assert.equal(recency.get("README.md")!.c90, 1);
});

test("foldSignals clamps future-dated commits to weight <= 1", () => {
  const raw = ["__C__ aaa 9999999999", "a.rb", "b.rb"].join("\n");
  const { cochange } = foldSignals(parseLog(raw), { now: 1000, windowDays: 180, maxFilesPerCommit: 50 });
  const w = cochange.get("a.rb\u0000b.rb")!;
  assert.ok(w > 0 && w <= 1, `weight should be clamped to (0,1], got ${w}`);
});

test("foldSignals sorts pair keys regardless of file order in commit", () => {
  const raw = ["__C__ aaa 1000", "z.rb", "a.rb"].join("\n");
  const { cochange } = foldSignals(parseLog(raw), { now: 1000, windowDays: 180, maxFilesPerCommit: 50 });
  assert.ok(cochange.has("a.rb\u0000z.rb"), "pair key must be ascending-sorted");
  assert.ok(!cochange.has("z.rb\u0000a.rb"));
});

test("parseLog ignores malformed __C__ header (no NaN commit)", () => {
  const raw = ["__C__ onlyone", "a.rb", "__C__ bbb 900", "b.rb"].join("\n");
  const commits = parseLog(raw);
  assert.ok(commits.every((c) => Number.isFinite(c.ts)), "no commit should have NaN ts");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, "bbb");
});

test("readLog returns [] on a non-git directory", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "nav-readlog-"));
  assert.deepEqual(readLog(d, 100), []);
});

test("foldSignals: mega-commit skips cochange but still counts recency", () => {
  const raw = [
    "__C__ ccc 500",
    "a.rb",
    "b.rb",
    "c.rb",
  ].join("\n");
  const now = 500 + 1 * 86400; // 1 day later
  const { recency, cochange } = foldSignals(parseLog(raw), {
    now, windowDays: 180, maxFilesPerCommit: 2, // 3 files > limit
  });
  // No cochange pairs because k=3 > maxFilesPerCommit=2
  assert.equal(cochange.size, 0, "mega-commit must produce no cochange pairs");
  // But recency must still be tracked for all 3 files
  assert.equal(recency.get("a.rb")!.c90, 1);
  assert.equal(recency.get("b.rb")!.c90, 1);
  assert.equal(recency.get("c.rb")!.c90, 1);
});
