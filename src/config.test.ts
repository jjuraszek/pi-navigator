import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, mergeConfig } from "./config.ts";

test("defaults: persona off, sqlite cache dir", () => {
  assert.equal(DEFAULT_CONFIG.injectPersona, false);
  assert.ok(DEFAULT_CONFIG.indexDir.endsWith("pi-navigator-cache"));
  assert.deepEqual(DEFAULT_CONFIG.languages, ["ruby", "python", "ts", "js"]);
});

test("mergeConfig overlays partial user settings", () => {
  const merged = mergeConfig({ injectPersona: true, maxLocateResults: 3 });
  assert.equal(merged.injectPersona, true);
  assert.equal(merged.maxLocateResults, 3);
  assert.equal(merged.indexBatchSize, DEFAULT_CONFIG.indexBatchSize);
});
