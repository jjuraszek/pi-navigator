import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { openDb } from "../store/db.ts";
import { migrate } from "./schema.ts";
import {
  ensureSession,
  insertLocate,
  insertConsume,
  markUsedLocate,
} from "./queries.ts";
import { deriveLocateOutcomes, aggregate } from "./stats.ts";
import type { Db } from "../store/db.ts";

function makeTmpPath(): string {
  return join(tmpdir(), `nav-stats-test-${process.pid}-${Date.now()}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = path + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

function makeDb(): { db: Db; path: string } {
  const path = makeTmpPath();
  const db = openDb(path);
  migrate(db);
  return { db, path };
}

const baseLocate = {
  headSha: null,
  query: "test",
  queryTokenCount: 1,
  queryType: "keyword" as const,
  limitN: 10,
  hasExactDef: false,
  usedOrFallback: true,
  topHasAnchor: false,
  coverage: 0.9,
  dirty: false,
  headBehind: 0,
  fresh: true,
  latencyMs: 5,
  resultsMetadata: [],
  cochange: [],
  referrers: [],
};

const baseConsume = {
  headSha: null,
  ts: 1_000_000,
  path: "/foo.ts",
  staleIndex: null,
  unchanged: null,
  searchTool: null,
  searchPattern: null,
  latencyMs: null,
  isError: false,
};

// ────────────────────────────────────────────────────────────────────────────
// Test 1: hit + MRR + hit@k
// ────────────────────────────────────────────────────────────────────────────
test("hit: slice with locate_rank → outcome=hit, consumedRank, turnsToConsume", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s1",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "s1");

    insertLocate(db, {
      ...baseLocate,
      sessionId: "s1",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 3,
      confidence: "high",
    });

    insertConsume(db, {
      ...baseConsume,
      sessionId: "s1",
      seq: 2,
      turn: 1,
      kind: "slice",
      locateRank: 2,
    });

    const outcomes = deriveLocateOutcomes(db, { turnCap: 5 });
    assert.equal(outcomes.length, 1);
    const o = outcomes[0];
    assert.equal(o.outcome, "hit");
    assert.equal(o.consumedRank, 2);
    assert.equal(o.turnsToConsume, 1);
    assert.equal(o.confidence, "high");
    assert.equal(o.resultCount, 3);
    assert.equal(o.justifiedFallback, false);

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    assert.equal(summary.locateTotal, 1);
    assert.equal(summary.hitRate, 1);
    assert.ok(Math.abs(summary.mrr - 0.5) < 1e-9, `mrr should be 0.5, got ${summary.mrr}`);
    assert.equal(summary.hitAt1, 0);
    assert.equal(summary.hitAt3, 1);
    assert.equal(summary.hitAt5, 1);
    assert.equal(summary.medianTurnsToUseful, 1);
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 2: miss-fallback unjustified
// ────────────────────────────────────────────────────────────────────────────
test("miss-fallback unjustified: high-conf locate then search → justifiedFallback=false", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s2",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "s2");

    insertLocate(db, {
      ...baseLocate,
      sessionId: "s2",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 5,
      confidence: "high",
    });

    insertConsume(db, {
      ...baseConsume,
      sessionId: "s2",
      seq: 2,
      turn: 1,
      kind: "search",
      locateRank: null,
      path: null,
    });

    const outcomes = deriveLocateOutcomes(db, { turnCap: 5 });
    assert.equal(outcomes.length, 1);
    const o = outcomes[0];
    assert.equal(o.outcome, "miss-fallback");
    assert.equal(o.justifiedFallback, false);
    assert.equal(o.consumedRank, null);

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    assert.equal(summary.missFallback, 1);
    assert.equal(summary.missFallbackUnjustified, 1);
    assert.equal(summary.fallbackSearches, 1);
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 3: justified fallback (low confidence)
// ────────────────────────────────────────────────────────────────────────────
test("justified fallback: low-conf locate then search → justifiedFallback=true", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s3",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "s3");

    insertLocate(db, {
      ...baseLocate,
      sessionId: "s3",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 3,
      confidence: "low",
    });

    insertConsume(db, {
      ...baseConsume,
      sessionId: "s3",
      seq: 2,
      turn: 1,
      kind: "search",
      locateRank: null,
      path: null,
    });

    const outcomes = deriveLocateOutcomes(db, { turnCap: 5 });
    assert.equal(outcomes.length, 1);
    const o = outcomes[0];
    assert.equal(o.outcome, "miss-fallback");
    assert.equal(o.justifiedFallback, true);

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    assert.equal(summary.missFallback, 1);
    assert.equal(summary.missFallbackUnjustified, 0);
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 4: abandoned
// ────────────────────────────────────────────────────────────────────────────
test("abandoned: locate with no subsequent consumes → outcome=abandoned", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s4",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "s4");

    insertLocate(db, {
      ...baseLocate,
      sessionId: "s4",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 2,
      confidence: "high",
    });

    const outcomes = deriveLocateOutcomes(db, { turnCap: 5 });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "abandoned");

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    assert.equal(summary.abandoned, 1);
    assert.equal(summary.hitRate, 0);
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 5: turnCap boundary + next-locate boundary
// ────────────────────────────────────────────────────────────────────────────
test("turnCap boundary: at cap=hit; at cap+1=abandoned; past-next-locate=not attributed", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s5",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "s5");

    // Locate L1 at seq=1, turn=0
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s5",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 2,
      confidence: "high",
    });

    // Consume at turn = 0 + turnCap = 3 → should be IN window (hit)
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s5",
      seq: 2,
      turn: 3,
      kind: "slice",
      locateRank: 1,
    });

    const o1 = deriveLocateOutcomes(db, { turnCap: 3 });
    assert.equal(o1[0].outcome, "hit", "consume at exactly turnCap should be a hit");

    db.prepare("DELETE FROM nav_consume").run();
    db.prepare("DELETE FROM nav_locate").run();

    // Locate at seq=1, turn=0; consume at turn = turnCap+1=4 → abandoned
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s5",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 2,
      confidence: "high",
    });
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s5",
      seq: 2,
      turn: 4,
      kind: "slice",
      locateRank: 1,
    });

    const o2 = deriveLocateOutcomes(db, { turnCap: 3 });
    assert.equal(o2[0].outcome, "abandoned", "consume at turnCap+1 should be abandoned");

    db.prepare("DELETE FROM nav_consume").run();
    db.prepare("DELETE FROM nav_locate").run();

    // Two locates: L1 seq=1, L2 seq=10; consume at seq=11 (past L2's seq) → not in L1's window
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s5",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 2,
      confidence: "high",
    });
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s5",
      seq: 10,
      turn: 2,
      ts: 1_000_001,
      resultCount: 2,
      confidence: "high",
    });
    // Consume at seq=5 (between L1 and L2, within turnCap) → in L1's window
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s5",
      seq: 5,
      turn: 1,
      kind: "slice",
      locateRank: null, // no rank → miss-fallback for L1
    });
    // Consume at seq=11 (after L2) → in L2's window, NOT L1's
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s5",
      seq: 11,
      turn: 3,
      kind: "slice",
      locateRank: 1,
    });

    const o3 = deriveLocateOutcomes(db, { turnCap: 10 });
    assert.equal(o3.length, 2);
    // L1: miss-fallback (seq=5 consume has no rank, seq=11 is past L2 seq=10)
    assert.equal(o3[0].outcome, "miss-fallback", "consume past next-locate seq should not be attributed to L1");
    // L2: hit (seq=11 is in L2's window)
    assert.equal(o3[1].outcome, "hit", "consume after L2's seq should be attributed to L2");
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 6: low/high precision
// ────────────────────────────────────────────────────────────────────────────
test("low/high precision: mixed session", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s6",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "s6");

    // High-conf hit
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s6",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 3,
      confidence: "high",
    });
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s6",
      seq: 2,
      turn: 1,
      kind: "slice",
      locateRank: 1,
    });

    // High-conf miss (abandoned)
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s6",
      seq: 3,
      turn: 2,
      ts: 1_000_002,
      resultCount: 3,
      confidence: "high",
    });

    // Low-conf hit
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s6",
      seq: 4,
      turn: 3,
      ts: 1_000_003,
      resultCount: 2,
      confidence: "low",
    });
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s6",
      seq: 5,
      turn: 4,
      kind: "read",
      locateRank: 3,
    });

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    // 2 high-conf: 1 hit → highConfPrecision = 0.5
    assert.ok(Math.abs(summary.highConfPrecision - 0.5) < 1e-9, `highConfPrecision should be 0.5, got ${summary.highConfPrecision}`);
    // 1 low-conf: 1 hit → lowConfPrecision = 1
    assert.equal(summary.lowConfPrecision, 1);
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 7: bypass session rate
// ────────────────────────────────────────────────────────────────────────────
test("bypass: 2 sessions, one without locate → bypassSessionRate=0.5", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "sa",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "sa");

    ensureSession(db, {
      sessionId: "sb",
      startedAt: 1_000_001,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    // "sb" does NOT call markUsedLocate → used_locate=0

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    assert.equal(summary.sessionsTotal, 2);
    assert.equal(summary.sessionsWithLocate, 1);
    assert.ok(Math.abs(summary.bypassSessionRate - 0.5) < 1e-9, `bypassSessionRate should be 0.5, got ${summary.bypassSessionRate}`);
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 8: scope filter
// ────────────────────────────────────────────────────────────────────────────
test("scope: aggregate with session scope restricts to that session", () => {
  const { db, path } = makeDb();
  try {
    // Session A: 1 locate, hit
    ensureSession(db, {
      sessionId: "scopeA",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "scopeA");
    insertLocate(db, {
      ...baseLocate,
      sessionId: "scopeA",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 3,
      confidence: "high",
    });
    insertConsume(db, {
      ...baseConsume,
      sessionId: "scopeA",
      seq: 2,
      turn: 1,
      kind: "slice",
      locateRank: 1,
    });

    // Session B: 1 locate, abandoned
    ensureSession(db, {
      sessionId: "scopeB",
      startedAt: 1_000_002,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "scopeB");
    insertLocate(db, {
      ...baseLocate,
      sessionId: "scopeB",
      seq: 1,
      turn: 0,
      ts: 1_000_002,
      resultCount: 2,
      confidence: "high",
    });

    const summaryA = aggregate(db, { turnCap: 5, scope: "scopeA" });
    assert.equal(summaryA.locateTotal, 1, "scope=scopeA should see only 1 locate");
    assert.equal(summaryA.hitRate, 1, "scope=scopeA hitRate should be 1");
    assert.equal(summaryA.sessionsTotal, 1);
    assert.equal(summaryA.scope, "scopeA");

    const summaryAll = aggregate(db, { turnCap: 5, scope: "lifetime" });
    assert.equal(summaryAll.locateTotal, 2, "lifetime scope should see both locates");
    assert.equal(summaryAll.hitRate, 0.5, "lifetime hitRate should be 0.5");
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 9: staleSliceRate and unchangedReadsAvoided
// ────────────────────────────────────────────────────────────────────────────
test("staleSliceRate and unchangedReadsAvoided", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s9",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });

    insertConsume(db, {
      ...baseConsume,
      sessionId: "s9",
      seq: 1,
      turn: 1,
      kind: "slice",
      locateRank: null,
      staleIndex: true,
      unchanged: false,
    });
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s9",
      seq: 2,
      turn: 2,
      kind: "slice",
      locateRank: null,
      staleIndex: false,
      unchanged: false,
    });
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s9",
      seq: 3,
      turn: 3,
      kind: "read",
      locateRank: null,
      staleIndex: null,
      unchanged: true,
    });

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    // 2 slice total, 1 stale → staleSliceRate = 0.5
    assert.ok(Math.abs(summary.staleSliceRate - 0.5) < 1e-9, `staleSliceRate should be 0.5, got ${summary.staleSliceRate}`);
    // 1 unchanged read → unchangedReadsAvoided = 1
    assert.equal(summary.unchangedReadsAvoided, 1);
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 10: zeroResultLocates
// ────────────────────────────────────────────────────────────────────────────
test("zeroResultLocates counted and justifiedFallback=true when result_count=0", () => {
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s10",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "s10");

    insertLocate(db, {
      ...baseLocate,
      sessionId: "s10",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 0,
      confidence: "high",
    });
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s10",
      seq: 2,
      turn: 1,
      kind: "search",
      locateRank: null,
      path: null,
    });

    const outcomes = deriveLocateOutcomes(db, { turnCap: 5 });
    assert.equal(outcomes[0].justifiedFallback, true, "result_count=0 → justifiedFallback");

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    assert.equal(summary.zeroResultLocates, 1);
  } finally {
    cleanup(path);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 11: MRR denominator is hits, not locateTotal
// ────────────────────────────────────────────────────────────────────────────
test("mrr denominator is hits not locateTotal: 1 hit at rank 2, 1 miss → mrr=0.5", () => {
  // Proves the spec definition: MRR = mean(1/consumedRank) over HITS only.
  // locateTotal=2, hits=1 at rank 2 → mrr must be (1/2)/1 = 0.5, not (1/2)/2 = 0.25.
  const { db, path } = makeDb();
  try {
    ensureSession(db, {
      sessionId: "s11",
      startedAt: 1_000_000,
      repoRoot: "/r",
      headSha: null,
      isWriter: false,
    });
    markUsedLocate(db, "s11");

    // Locate A: seq=1, turn=0 — will be a HIT at rank 2
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s11",
      seq: 1,
      turn: 0,
      ts: 1_000_000,
      resultCount: 3,
      confidence: "high",
    });
    // Slice at rank 2 → hit for locate A
    insertConsume(db, {
      ...baseConsume,
      sessionId: "s11",
      seq: 2,
      turn: 1,
      kind: "slice",
      locateRank: 2,
    });

    // Locate B: seq=3, turn=2 — no consume follows → abandoned (miss)
    insertLocate(db, {
      ...baseLocate,
      sessionId: "s11",
      seq: 3,
      turn: 2,
      ts: 1_000_002,
      resultCount: 3,
      confidence: "high",
    });

    const summary = aggregate(db, { turnCap: 5, scope: "lifetime" });
    assert.equal(summary.locateTotal, 2, "locateTotal must be 2");
    assert.equal(summary.hitRate, 0.5, "hitRate = 1 hit / 2 locates");
    // MRR over HITS: only the rank-2 hit counts → (1/2) / 1 = 0.5
    // If denominator were locateTotal (= 2), mrr would be 0.25 — wrong.
    assert.ok(
      Math.abs(summary.mrr - 0.5) < 1e-9,
      `mrr should be 0.5 (hits denominator), got ${summary.mrr}`,
    );
  } finally {
    cleanup(path);
  }
});
