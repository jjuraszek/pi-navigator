import test from "node:test";
import assert from "node:assert/strict";
import { parseLog, foldSignals } from "./git.ts";

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
