import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "./config.ts";

test("defaults: sqlite cache dir and language set", () => {
  assert.ok(DEFAULT_CONFIG.indexDir.endsWith("pi-navigator-cache"));
  assert.deepEqual(DEFAULT_CONFIG.languages, ["ruby", "python", "ts", "js"]);
});

test("loadConfig reads navigator block from settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-cfg-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ navigator: { maxLocateResults: 2, telemetry: true } }),
  );
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const c = loadConfig();
    assert.equal(c.maxLocateResults, 2);
    assert.equal(c.telemetry, true);
    assert.equal(c.indexBatchSize, DEFAULT_CONFIG.indexBatchSize);
    assert.equal("injectPersona" in c, false);
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("loadConfig ignores stale injectPersona and unknown config keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-cfg-ignore-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      navigator: {
        injectPersona: false,
        maxLocateResults: 4,
        unknownFlag: true,
      },
    }),
  );
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const c = loadConfig() as unknown as Record<string, unknown>;
    assert.equal(c.maxLocateResults, 4);
    assert.equal("injectPersona" in c, false);
    assert.equal("unknownFlag" in c, false);
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("loadConfig returns defaults when settings.json missing or corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-cfg2-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("mergeConfig filters stale injectPersona and unknown keys", () => {
  const merged = mergeConfig({ injectPersona: false, maxLocateResults: 3, extra: true } as never) as unknown as Record<string, unknown>;
  assert.equal(merged.maxLocateResults, 3);
  assert.equal(merged.indexBatchSize, DEFAULT_CONFIG.indexBatchSize);
  assert.equal("injectPersona" in merged, false);
  assert.equal("extra" in merged, false);
});

test("mergeConfig normalizes keyword stoplist and min length", () => {
  const merged = mergeConfig({
    keywordStoplist: ["Foo", 123, "BAR"] as never,
    keywordMinLength: 5,
  } as never);
  assert.deepEqual(merged.keywordStoplist, ["foo", "123", "bar"]);
  assert.equal(merged.keywordMinLength, 5);

  const fallback = mergeConfig({ keywordMinLength: 0 } as never);
  assert.equal(fallback.keywordMinLength, DEFAULT_CONFIG.keywordMinLength);
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

test("new adoption keys default to true", () => {
  const c = mergeConfig({});
  assert.equal(c.persona, true);
  assert.equal(c.promptNudge, true);
  assert.equal(c.strongHitDirective, true);
  assert.equal(c.grepBlock, true);
});

test("new adoption keys honor explicit false", () => {
  const c = mergeConfig({ persona: false, promptNudge: false, strongHitDirective: false, grepBlock: false });
  assert.equal(c.persona, false);
  assert.equal(c.promptNudge, false);
  assert.equal(c.strongHitDirective, false);
  assert.equal(c.grepBlock, false);
});

test("non-boolean adoption keys fall back to default true", () => {
  const c = mergeConfig({ persona: "yes" as unknown as boolean, grepBlock: 1 as unknown as boolean });
  assert.equal(c.persona, true);
  assert.equal(c.grepBlock, true);
});

test("unknown keys are still dropped", () => {
  const c = mergeConfig({ injectPersona: true } as Record<string, unknown>);
  assert.equal("injectPersona" in c, false);
});
