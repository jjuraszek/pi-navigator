import { test } from "node:test";
import assert from "node:assert/strict";
import { toRepoRel } from "./paths.ts";

test("toRepoRel returns POSIX repo-relative path for in-repo file", () => {
  assert.equal(toRepoRel("/repo", "src/a.ts", "/repo"), "src/a.ts");
  assert.equal(toRepoRel("/repo", "/repo/src/a.ts", "/anywhere"), "src/a.ts");
});

test("toRepoRel returns undefined when path escapes the repo root", () => {
  assert.equal(toRepoRel("/repo", "../outside.ts", "/repo"), undefined);
});
