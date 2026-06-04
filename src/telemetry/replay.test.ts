import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { replayTrace, indexDbWith } from "./test-utils.ts";
import type { TraceEvent } from "./test-utils.ts";
import { aggregate, FALLBACK_WINDOW_TURNS } from "./stats.ts";
import { exportCases } from "../../scripts/export-cases.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

function loadFixture(name: string): TraceEvent[] {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as TraceEvent[];
}

test("cd-rg-fallback: locate then cd+rg bash → miss-fallback", () => {
  const events = loadFixture("cd-rg-fallback.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  // One search consume recorded with tool=rg
  const consumeRows = telemetryDb
    .prepare("SELECT * FROM nav_consume WHERE session_id = ?")
    .all(sessionId) as any[];
  assert.equal(consumeRows.length, 1, "one search consume expected");
  assert.equal(consumeRows[0].kind, "search");
  assert.equal(consumeRows[0].search_tool, "rg");
  assert.equal(consumeRows[0].search_pattern, "foo");

  const stats = aggregate(telemetryDb, { scope: sessionId });
  assert.equal(stats.locateTotal, 1);
  assert.equal(stats.missFallback, 1);
  assert.equal(stats.hitRate, 0);
});

test("pipe-grep: locate then ls|grep|head bash → grep detected, miss-fallback", () => {
  const events = loadFixture("pipe-grep.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  const consumeRows = telemetryDb
    .prepare("SELECT * FROM nav_consume WHERE session_id = ?")
    .all(sessionId) as any[];
  assert.equal(consumeRows.length, 1, "one search consume expected");
  assert.equal(consumeRows[0].kind, "search");
  assert.equal(consumeRows[0].search_tool, "grep");
  // grep -v x → the first non-flag token is 'x'
  assert.equal(consumeRows[0].search_pattern, "x");

  const stats = aggregate(telemetryDb, { scope: sessionId });
  assert.equal(stats.missFallback, 1);
});

test("pattern-clean: rg navigator; echo done → search_pattern is 'navigator', no trailing semicolon", () => {
  const events = loadFixture("pattern-clean.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  const row = telemetryDb
    .prepare("SELECT * FROM nav_consume WHERE session_id = ?")
    .get(sessionId) as any;
  assert.ok(row, "nav_consume row expected");
  assert.equal(row.kind, "search");
  assert.equal(row.search_tool, "rg");
  assert.equal(row.search_pattern, "navigator");
});

test("cluster-assist: locate with cochange cluster then read cluster path → cluster-assist", () => {
  const events = loadFixture("cluster-assist.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  const consumeRows = telemetryDb
    .prepare("SELECT * FROM nav_consume WHERE session_id = ?")
    .all(sessionId) as any[];
  assert.equal(consumeRows.length, 1);
  assert.equal(consumeRows[0].kind, "read");
  assert.equal(consumeRows[0].cluster_kind, "cochange");
  assert.equal(consumeRows[0].locate_rank, null);

  const stats = aggregate(telemetryDb, { scope: sessionId });
  assert.equal(stats.locateTotal, 1);
  assert.equal(stats.assistRate, 1);
  assert.equal(stats.missFallback, 0);
});

// Fixture: locate (cluster.cochange=[post-search-p.ts]) → bash rg foo → read post-search-p.ts
// Expected per spec: miss-fallback (search preceded the cluster read → fallback, not assist)
// NOTE: If this test FAILS with cluster-assist, that is a real attribution bug in stats.ts.

test("post-search-read: locate → rg bash → read cluster path → miss-fallback", () => {
  const events = loadFixture("post-search-read.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  const stats = aggregate(telemetryDb, { scope: sessionId });
  assert.equal(stats.locateTotal, 1, "one locate expected");
  assert.equal(stats.missFallback, 1, "search before cluster-read must count as miss-fallback, not cluster-assist");
  assert.equal(stats.assistRate, 0, "cluster-assist must NOT fire when a search preceded the cluster-read");
});

// post-search-read: exportCases verdict for P when P is in the index DB → indexed
test("post-search-read: exportCases fallbackVerdict path=post-search-p.ts indexed='indexed' when in index", () => {
  const events = loadFixture("post-search-read.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  const indexDb = indexDbWith(["post-search-p.ts"]);
  const cases = exportCases(telemetryDb, indexDb, { outcome: "miss-fallback" });

  assert.ok(cases.length > 0, "at least one miss-fallback case expected");
  const c = cases[0];
  assert.equal(c.fallbackVerdicts.length, 1);
  assert.equal(c.fallbackVerdicts[0].path, "post-search-p.ts");
  assert.equal(c.fallbackVerdicts[0].indexed, "indexed");
  indexDb.close();
});

test(`late-search: locate at turn 0, rg at turn ${FALLBACK_WINDOW_TURNS + 2} → abandoned`, () => {
  const events = loadFixture("late-search.json");
  const searchTurn = events.find((e) => e.toolName === "bash")?.turn ?? -1;
  assert.ok(searchTurn > FALLBACK_WINDOW_TURNS, "fixture search turn must exceed FALLBACK_WINDOW_TURNS or this test is vacuous");

  const { telemetryDb, sessionId } = replayTrace(events);

  const locateRow = telemetryDb
    .prepare("SELECT turn FROM nav_locate WHERE session_id = ?")
    .get(sessionId) as any;
  assert.equal(locateRow?.turn, 0);

  const consumeRow = telemetryDb
    .prepare("SELECT turn, kind FROM nav_consume WHERE session_id = ?")
    .get(sessionId) as any;
  assert.equal(consumeRow?.turn, 5);

  const stats = aggregate(telemetryDb, { scope: sessionId });
  assert.equal(stats.locateTotal, 1);
  assert.equal(stats.abandoned, 1, "search outside fallback window must give abandoned outcome");
  assert.equal(stats.missFallback, 0);
});

test("search-then-hit: locate → rg bash → read ranked result → hit (hit precedence over fallback)", () => {
  const events = loadFixture("search-then-hit.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  const consumeRows = telemetryDb
    .prepare("SELECT kind, locate_rank FROM nav_consume WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as any[];

  // Two consumes: one search, one read with locate_rank=1
  assert.equal(consumeRows.length, 2);
  assert.equal(consumeRows[0].kind, "search");
  assert.equal(consumeRows[1].kind, "read");
  assert.equal(consumeRows[1].locate_rank, 1);

  const stats = aggregate(telemetryDb, { scope: sessionId });
  assert.equal(stats.locateTotal, 1);
  assert.equal(stats.hitRate, 1);
  assert.equal(stats.missFallback, 0);
});

test("multi-search: cd x && rg a && rg b in one bash → exactly ONE search consume recorded", () => {
  const events = loadFixture("multi-search.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  const consumeRows = telemetryDb
    .prepare("SELECT * FROM nav_consume WHERE session_id = ? AND kind = 'search'")
    .all(sessionId) as any[];

  assert.equal(consumeRows.length, 1, "detectSearch returns on first match → one search consume");
  assert.equal(consumeRows[0].search_tool, "rg");
  assert.equal(consumeRows[0].search_pattern, "a");
});

test("unrelated-read: locate (high-conf) then read non-result non-cluster path → abandoned", () => {
  const events = loadFixture("unrelated-read.json");
  const { telemetryDb, sessionId } = replayTrace(events);

  const consumeRows = telemetryDb
    .prepare("SELECT kind, locate_rank, cluster_kind FROM nav_consume WHERE session_id = ?")
    .all(sessionId) as any[];
  assert.equal(consumeRows.length, 1);
  assert.equal(consumeRows[0].kind, "read");
  assert.equal(consumeRows[0].locate_rank, null);
  assert.equal(consumeRows[0].cluster_kind, null);

  const stats = aggregate(telemetryDb, { scope: sessionId });
  assert.equal(stats.locateTotal, 1);
  assert.equal(stats.abandoned, 1);
  assert.equal(stats.hitRate, 0);
  assert.equal(stats.missFallback, 0);
  assert.equal(stats.assistRate, 0);
});
