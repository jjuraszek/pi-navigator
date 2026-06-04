import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSearch, classifyQuery } from "./detect.ts";

test("detectSearch recognizes search tools and extracts the pattern", () => {
  assert.deepEqual(detectSearch("rg -n foo src/"), { tool: "rg", pattern: "foo" });
  assert.deepEqual(detectSearch("grep -ri Bar ."), { tool: "grep", pattern: "Bar" });
  assert.deepEqual(detectSearch("git grep needle"), { tool: "git-grep", pattern: "needle" });
  assert.deepEqual(detectSearch("fd widget"), { tool: "fd", pattern: "widget" });
  assert.deepEqual(detectSearch("find . -name '*.ts'"), { tool: "find", pattern: "*.ts" });
  assert.deepEqual(detectSearch("cat foo | rg baz"), { tool: "rg", pattern: "baz" });
  assert.deepEqual(detectSearch("ag pattern"), { tool: "ag", pattern: "pattern" });
  assert.deepEqual(detectSearch("ack thing"), { tool: "ack", pattern: "thing" });
});
test("detectSearch returns null for non-search bash", () => {
  assert.equal(detectSearch("curl -H 'Authorization: x' https://h"), null);
  assert.equal(detectSearch("psql -c 'select 1'"), null);
  assert.equal(detectSearch("npm run typecheck"), null);
});
test("classifyQuery splits identifier / keyword / open-ended", () => {
  assert.deepEqual(classifyQuery("RollingIndexer"), { type: "identifier", tokenCount: 1 });
  assert.deepEqual(classifyQuery("Foo::Bar"), { type: "identifier", tokenCount: 1 });
  assert.deepEqual(classifyQuery("rolling indexer"), { type: "keyword", tokenCount: 2 });
  assert.deepEqual(classifyQuery("where do we open the db"), { type: "open-ended", tokenCount: 6 });
});
test("classifyQuery returns open-ended for empty/whitespace input", () => {
  assert.deepEqual(classifyQuery(""), { type: "open-ended", tokenCount: 0 });
  assert.deepEqual(classifyQuery("   "), { type: "open-ended", tokenCount: 0 });
});
