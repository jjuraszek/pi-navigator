import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "./config.ts";

test("defaults: persona on, sqlite cache dir", () => {
  assert.equal(DEFAULT_CONFIG.injectPersona, true);
  assert.ok(DEFAULT_CONFIG.indexDir.endsWith("pi-navigator-cache"));
  assert.deepEqual(DEFAULT_CONFIG.languages, ["ruby", "python", "ts", "js"]);
});

test("injectPersona defaults to true", () => {
  assert.equal(DEFAULT_CONFIG.injectPersona, true);
});

test("injectPersona can be disabled via settings", () => {
  const cfg = mergeConfig({ injectPersona: false });
  assert.equal(cfg.injectPersona, false);
});

test("loadConfig reads navigator block from settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-cfg-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ navigator: { maxLocateResults: 2, injectPersona: true } }));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const c = loadConfig();
    assert.equal(c.maxLocateResults, 2);
    assert.equal(c.injectPersona, true);
    assert.equal(c.indexBatchSize, DEFAULT_CONFIG.indexBatchSize);
  } finally { process.env.PI_CODING_AGENT_DIR = prev; }
});

test("loadConfig returns defaults when settings.json missing or corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-cfg2-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { assert.deepEqual(loadConfig(), DEFAULT_CONFIG); }
  finally { process.env.PI_CODING_AGENT_DIR = prev; }
});

test("mergeConfig overlays partial user settings", () => {
  const merged = mergeConfig({ injectPersona: true, maxLocateResults: 3 });
  assert.equal(merged.injectPersona, true);
  assert.equal(merged.maxLocateResults, 3);
  assert.equal(merged.indexBatchSize, DEFAULT_CONFIG.indexBatchSize);
});

test("telemetry config defaults", () => {
  assert.equal(DEFAULT_CONFIG.telemetry, false);
  assert.equal(DEFAULT_CONFIG.telemetryStoreQueries, true);
  assert.equal(DEFAULT_CONFIG.telemetryTurnCap, 10);
  assert.equal(DEFAULT_CONFIG.telemetryRetentionDays, 30);
});

test("mergeConfig: telemetry: true overrides default", () => {
  const merged = mergeConfig({ telemetry: true });
  assert.equal(merged.telemetry, true);
  assert.equal(merged.telemetryStoreQueries, true);
  assert.equal(merged.telemetryTurnCap, 10);
  assert.equal(merged.telemetryRetentionDays, 30);
});
