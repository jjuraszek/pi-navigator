import test from "node:test";
import assert from "node:assert/strict";
import { parseSub, registerNavigatorCommand, formatStats, type NavigatorState } from "./commands.ts";
import type { StatsSummary } from "./telemetry/types.ts";

test("parseSub parses status/reindex/path/default", () => {
  assert.deepEqual(parseSub("status"), { sub: "status" });
  assert.deepEqual(parseSub(""), { sub: "status" });
  assert.deepEqual(parseSub("reindex"), { sub: "reindex" });
  assert.deepEqual(parseSub("reindex app/x.rb"), { sub: "reindex", path: "app/x.rb" });
  assert.deepEqual(parseSub("bogus"), { sub: "status" });
});

test("parseSub parses stats", () => {
  assert.deepEqual(parseSub("stats"), { sub: "stats" });
});

test("command handler notifies status and triggers reindex", async () => {
  const notes: string[] = [];
  let reindexed: string | undefined | "NOTCALLED" = "NOTCALLED";
  const state: NavigatorState = {
    active: true,
    coverage: { total: 10, indexed: 4, fullCrawlDone: false, headBehind: 0 },
    isWriter: true,
    dbPath: "/tmp/cache/repo_abc123.db",
    reindex: (p) => { reindexed = p; },
    telemetryStats: null,
  };
  let captured: any;
  const pi = { registerCommand: (_n: string, opts: any) => { captured = opts; } };
  registerNavigatorCommand(pi, () => state);
  const ctx = { ui: { notify: (m: string) => notes.push(m) } };
  await captured.handler("status", ctx);
  assert.ok(notes.some((n) => /4\/10|40%/.test(n)), "status should report coverage");
  assert.ok(notes.some((n) => /\/tmp\/cache\/repo_abc123\.db/.test(n)), "status should include db path");
  await captured.handler("reindex app/x.rb", ctx);
  assert.equal(reindexed, "app/x.rb");
});

test("command handler reports inactive when not a git repo", async () => {
  const notes: string[] = [];
  let reindexed = false;
  const state: NavigatorState = {
    active: false,
    coverage: null,
    isWriter: false,
    dbPath: "",
    reindex: () => { reindexed = true; },
    telemetryStats: null,
  };
  let captured: any;
  const pi = { registerCommand: (_n: string, opts: any) => { captured = opts; } };
  registerNavigatorCommand(pi, () => state);
  const ctx = { ui: { notify: (m: string) => notes.push(m) } };
  await captured.handler("status", ctx);
  await captured.handler("reindex", ctx);
  assert.ok(notes.every((n) => /inactive/.test(n)), "both subcommands report inactive");
  assert.equal(reindexed, false, "reindex must not fire when inactive");
});

function makeStats(overrides: Partial<StatsSummary> = {}): StatsSummary {
  return {
    scope: "session",
    locateTotal: 4,
    hitRate: 0.5,
    assistRate: 0,
    missFallback: 1,
    missFallbackUnjustified: 0,
    abandoned: 1,
    zeroResultLocates: 0,
    fallbackSearches: 1,
    unavailableByReason: {},
    sessionsTotal: 1,
    sessionsWithLocate: 1,
    bypassSessionRate: 0.0,
    mrr: 0.5,
    hitAt1: 0.25,
    hitAt3: 0.5,
    hitAt5: 0.5,
    lowConfPrecision: 0.4,
    highConfPrecision: 0.6,
    medianTurnsToUseful: 1,
    staleSliceRate: 0.1,
    unchangedReadsAvoided: 2,
    guardBlocks: 0,
    guardWarns: 0,
    guardAllowFallback: 0,
    sessionsToolAvailable: 1,
    sessionsToolUnavailable: 0,
    ...overrides,
  };
}

test("stats subcommand calls formatStats and notifies with session and lifetime labels", async () => {
  const session = makeStats({ scope: "session", locateTotal: 4, hitRate: 0.5, mrr: 0.5 });
  const lifetime = makeStats({ scope: "lifetime", locateTotal: 20, hitRate: 0.75, mrr: 0.8 });
  const notes: string[] = [];
  const state: NavigatorState = {
    active: true,
    coverage: { total: 10, indexed: 10, fullCrawlDone: true, headBehind: 0 },
    isWriter: true,
    dbPath: "/tmp/test.db",
    reindex: () => {},
    telemetryStats: () => ({ session, lifetime }),
  };
  let captured: any;
  const pi = { registerCommand: (_n: string, opts: any) => { captured = opts; } };
  registerNavigatorCommand(pi, () => state);
  const ctx = { ui: { notify: (m: string) => notes.push(m) } };
  await captured.handler("stats", ctx);
  assert.equal(notes.length, 1);
  const out = notes[0];
  assert.ok(out.includes("navigator stats [session]"), "should have session header");
  assert.ok(out.includes("navigator stats [lifetime]"), "should have lifetime header");
  assert.ok(out.includes("hit_rate"), "should include hit_rate field");
  assert.ok(out.includes("50%"), "should render 0.5 as 50%");
  assert.ok(out.includes("75%"), "should render 0.75 as 75%");
  assert.ok(out.includes("0.500"), "should render mrr as decimal");
  assert.ok(out.includes("mrr"), "should include mrr field");
});

test("stats subcommand notifies 'telemetry is off' when telemetryStats is null", async () => {
  const notes: string[] = [];
  const state: NavigatorState = {
    active: true,
    coverage: { total: 10, indexed: 10, fullCrawlDone: true, headBehind: 0 },
    isWriter: true,
    dbPath: "/tmp/test.db",
    reindex: () => {},
    telemetryStats: null,
  };
  let captured: any;
  const pi = { registerCommand: (_n: string, opts: any) => { captured = opts; } };
  registerNavigatorCommand(pi, () => state);
  const ctx = { ui: { notify: (m: string) => notes.push(m) } };
  await captured.handler("stats", ctx);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes("telemetry is off"), "should report telemetry off");
});

test("stats subcommand notifies 'no data' when telemetry is on but returns null", async () => {
  const notes: string[] = [];
  const state: NavigatorState = {
    active: true,
    coverage: { total: 10, indexed: 10, fullCrawlDone: true, headBehind: 0 },
    isWriter: true,
    dbPath: "/tmp/test.db",
    reindex: () => {},
    telemetryStats: () => null,
  };
  let captured: any;
  const pi = { registerCommand: (_n: string, opts: any) => { captured = opts; } };
  registerNavigatorCommand(pi, () => state);
  const ctx = { ui: { notify: (m: string) => notes.push(m) } };
  await captured.handler("stats", ctx);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes("no data recorded yet"), "should report no data, not 'off'");
  assert.ok(!notes[0].includes("is off"), "must not say telemetry is off when configured");
});

test("formatStats renders all expected fields", () => {
  const s = makeStats({ locateTotal: 8, hitRate: 0.625, mrr: 0.75, hitAt1: 0.5, hitAt3: 0.625, hitAt5: 0.625, unavailableByReason: { non_git: 2, disabled: 1 } });
  const out = formatStats("test", s);
  assert.ok(out.startsWith("navigator stats [test]"));
  assert.ok(out.includes("locate_total"));
  assert.ok(out.includes("hit_rate"));
  assert.ok(out.includes("mrr"));
  assert.ok(out.includes("hit@1"));
  assert.ok(out.includes("hit@3"));
  assert.ok(out.includes("hit@5"));
  assert.ok(out.includes("miss_fallback"));
  assert.ok(out.includes("miss_fallback_unjustified"));
  assert.ok(out.includes("abandoned"));
  assert.ok(out.includes("zero_result_locates"));
  assert.ok(out.includes("low_conf_precision"));
  assert.ok(out.includes("bypass_session_rate"));
  assert.ok(out.includes("stale_slice_rate"));
  assert.ok(out.includes("unavailable_by_reason"));
  assert.ok(out.includes("non_git=2"), "should render reason=count pairs");
  assert.ok(out.includes("disabled=1"), "should render reason=count pairs");
  assert.ok(out.includes("guard_blocks"));
  assert.ok(out.includes("guard_warns"));
  assert.ok(out.includes("guard_allow_fallback"));
  assert.ok(out.includes("sessions_tool_available"));
  assert.ok(out.includes("sessions_tool_unavailable"));
});
