import { test } from "node:test";
import assert from "node:assert/strict";
import { replayTrace } from "./test-utils.ts";
import type { TraceEvent } from "./test-utils.ts";
import { deriveLocateOutcomes, aggregate, FULL_WINDOW_TURNS, FALLBACK_WINDOW_TURNS } from "./stats.ts";
import type { Outcome } from "./types.ts";

function makePrng(seed: number) {
  let s = seed >>> 0;
  return {
    next(): number {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 0x100000000;
    },
    int(lo: number, hi: number): number {
      return lo + Math.floor(this.next() * (hi - lo + 1));
    },
    pick<T>(arr: T[]): T {
      return arr[Math.floor(this.next() * arr.length)];
    },
  };
}

const SEED = 0xdeadbeef;

const PATHS = [
  "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts",
  "src/f.ts", "src/g.ts", "src/h.ts", "src/i.ts", "src/j.ts",
];

function locateEvent(
  turn: number,
  ranked: string[],
  cochange: string[],
  confidence: "high" | "low" = "high",
): TraceEvent {
  return {
    turn,
    toolName: "navigator_locate",
    args: { query: "test" },
    result: {
      details: {
        results: ranked.map((path, i) => ({
          path,
          score: 10 - i,
          signals: { fts: 1, path: 0, symbol: 0, recency: 0 },
        })),
        cluster: { cochange, referrers: [] },
        index: { coverage: 1, dirty: false, head_behind: 0, fresh: true },
        confidence,
        has_exact_def: false,
        used_or_fallback: false,
        top_has_anchor: false,
      },
    },
  };
}

function readEvent(turn: number, path: string): TraceEvent {
  return { turn, toolName: "read", args: { path }, result: {} };
}

function searchEvent(turn: number): TraceEvent {
  return { turn, toolName: "bash", args: { command: "rg somepattern" }, result: {} };
}

// Each template produces consume events after a locate and declares the expected outcome.
type ConsumeTemplate = {
  label: string;
  expected: Outcome;
  events(locateTurn: number, ranked: string[], cluster: string[]): TraceEvent[];
};

const TEMPLATES: ConsumeTemplate[] = [
  {
    label: "ranked_hit",
    expected: "hit",
    events: (t, ranked) => [readEvent(t + 1, ranked[0])],
  },
  {
    label: "ranked_hit_after_search",
    expected: "hit",
    events: (t, ranked) => [
      searchEvent(t + 1),
      readEvent(t + 2, ranked[0]),
    ],
  },
  {
    label: "cluster_before_search",
    expected: "cluster-assist",
    events: (t, _ranked, cluster) =>
      cluster.length > 0
        ? [readEvent(t + 1, cluster[0]), searchEvent(t + 2)]
        : [readEvent(t + 1, "src/unrelated.ts")],
  },
  {
    label: "search_before_cluster",
    expected: "miss-fallback",
    events: (t, _ranked, cluster) => [
      searchEvent(t + 1),
      ...(cluster.length > 0 ? [readEvent(t + 2, cluster[0])] : []),
    ],
  },
  {
    label: "search_in_fallback",
    expected: "miss-fallback",
    events: (t) => [searchEvent(t + 1)],
  },
  {
    // Search exactly at the fallback window boundary — inclusive edge → miss-fallback.
    label: "fallback_edge_inclusive",
    expected: "miss-fallback",
    events: (t) => [searchEvent(t + FALLBACK_WINDOW_TURNS)],
  },
  {
    // Search one turn past the fallback sub-window but still inside the full window.
    // No fallback-search is recorded, so the outcome is abandoned.
    label: "fallback_edge_exclusive",
    expected: "abandoned",
    events: (t) => [searchEvent(t + FALLBACK_WINDOW_TURNS + 1)],
  },
  {
    label: "late_search",
    expected: "abandoned",
    events: (t) => [searchEvent(t + FULL_WINDOW_TURNS + 2)],
  },
  {
    label: "nothing",
    expected: "abandoned",
    events: () => [],
  },
  {
    label: "unrelated_read",
    expected: "abandoned",
    events: (t) => [readEvent(t + 1, "src/unrelated-zzz.ts")],
  },
];

// The cluster_before_search template degrades when there's no cluster.
function resolvedExpected(tmpl: ConsumeTemplate, cluster: string[]): Outcome {
  if (tmpl.label === "cluster_before_search" && cluster.length === 0) return "abandoned";
  return tmpl.expected;
}

interface LocateSpec {
  ranked: string[];
  cluster: string[];
  template: ConsumeTemplate;
  expectedOutcome: Outcome;
}

interface Sequence {
  events: TraceEvent[];
  locates: LocateSpec[];
}

function fisherYates<T>(arr: T[], rng: ReturnType<typeof makePrng>): T[] {
  const a = [...arr];
  for (let k = a.length - 1; k > 0; k--) {
    const j = Math.floor(rng.next() * (k + 1));
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a;
}

function generateSequence(rng: ReturnType<typeof makePrng>): Sequence {
  const numLocates = rng.int(1, 3);
  const events: TraceEvent[] = [];
  const locates: LocateSpec[] = [];

  let turn = 0;

  for (let i = 0; i < numLocates; i++) {
    const numRanked = rng.int(1, 4);
    const numCluster = rng.int(0, 2);

    const shuffled = fisherYates(PATHS, rng);
    const ranked = shuffled.slice(0, numRanked);
    const cluster = shuffled.slice(numRanked, numRanked + numCluster);

    const confidence: "high" | "low" = rng.next() < 0.5 ? "high" : "low";
    const tmpl = rng.pick(TEMPLATES);
    const expectedOutcome = resolvedExpected(tmpl, cluster);

    events.push(locateEvent(turn, ranked, cluster, confidence));
    const consumeEvents = tmpl.events(turn, ranked, cluster);
    events.push(...consumeEvents);

    locates.push({ ranked, cluster, template: tmpl, expectedOutcome });

    const maxConsumeOffset = consumeEvents.reduce(
      (m, e) => Math.max(m, e.turn - turn),
      0,
    );
    turn = turn + Math.max(FULL_WINDOW_TURNS + 2, maxConsumeOffset + 2);
  }

  return { events, locates };
}

const VALID_OUTCOMES = new Set<string>(["hit", "cluster-assist", "miss-fallback", "abandoned"]);
const NUM_SEQUENCES = 200;

test("invariants: partition, precedence, range, mutual-exclusion over 200 generated sequences", () => {
  const rng = makePrng(SEED);

  for (let i = 0; i < NUM_SEQUENCES; i++) {
    const seq = generateSequence(rng);
    const { telemetryDb, sessionId } = replayTrace(seq.events);

    const outcomes = deriveLocateOutcomes(telemetryDb, {});
    const sessionOutcomes = outcomes.filter((o) => o.sessionId === sessionId);
    const stats = aggregate(telemetryDb, { scope: sessionId });

    const ctx = `seq#${i} seed=${SEED} templates=[${seq.locates.map((l) => l.template.label).join(",")}]`;

    // Invariant 1: PARTITION — count matches; no duplicate locateIds; all outcomes are valid strings.

    assert.equal(
      sessionOutcomes.length,
      seq.locates.length,
      `PARTITION count mismatch: ${ctx}`,
    );

    const seenIds = new Set<number>();
    for (const o of sessionOutcomes) {
      assert.ok(
        !seenIds.has(o.locateId),
        `PARTITION duplicate locateId ${o.locateId}: ${ctx}`,
      );
      seenIds.add(o.locateId);
      assert.ok(
        VALID_OUTCOMES.has(o.outcome),
        `PARTITION invalid outcome "${o.outcome}": ${ctx}`,
      );
    }

    // Invariant 2: PRECEDENCE
    // (a) hit-dominance: ranked read/slice in window → outcome must be 'hit'
    // (b) cluster-assist ordering: cluster read before fallback search → 'cluster-assist'
    // (c) search-before-cluster → 'miss-fallback'

    for (let li = 0; li < seq.locates.length; li++) {
      const spec = seq.locates[li];
      const o = sessionOutcomes[li];
      if (!o) continue;

      if (spec.template.label === "ranked_hit" || spec.template.label === "ranked_hit_after_search") {
        assert.equal(
          o.outcome,
          "hit",
          `PRECEDENCE hit-dominance: ranked read must win, got "${o.outcome}": ${ctx}`,
        );
      }

      if (spec.template.label === "cluster_before_search" && spec.cluster.length > 0) {
        assert.equal(
          o.outcome,
          "cluster-assist",
          `PRECEDENCE cluster-before-search must be cluster-assist, got "${o.outcome}": ${ctx}`,
        );
      }

      if (spec.template.label === "search_before_cluster") {
        assert.equal(
          o.outcome,
          "miss-fallback",
          `PRECEDENCE search-before-cluster must be miss-fallback, got "${o.outcome}": ${ctx}`,
        );
      }
    }

    // Invariant 3: RANGE — all rate fields in [0,1], finite; medianTurnsToUseful excluded (raw count).

    const rateFields: (keyof typeof stats)[] = [
      "hitRate", "assistRate", "bypassSessionRate", "staleSliceRate",
      "hitAt1", "hitAt3", "hitAt5", "lowConfPrecision", "highConfPrecision",
      "mrr",
    ];

    for (const f of rateFields) {
      const v = stats[f] as number;
      assert.ok(
        Number.isFinite(v),
        `RANGE ${f} is not finite (got ${v}): ${ctx}`,
      );
      assert.ok(
        v >= 0 && v <= 1,
        `RANGE ${f}=${v} outside [0,1]: ${ctx}`,
      );
    }

    // Invariant 4: MUTUAL EXCLUSION
    // DB CHECK constraint enforces this at insert (belt-and-suspenders); the real guard is the
    // ranked-wins assertion in the dedicated test below.
    const badRows = telemetryDb
      .prepare(
        "SELECT * FROM nav_consume WHERE session_id = ? AND locate_rank IS NOT NULL AND cluster_kind IS NOT NULL",
      )
      .all(sessionId) as any[];

    assert.equal(
      badRows.length,
      0,
      `MUTUAL EXCLUSION: ${badRows.length} row(s) have both locate_rank and cluster_kind: ${ctx}`,
    );

    telemetryDb.close();
  }
});

test("invariants: ranked-wins when path appears in both ranked results and cluster", () => {
  // classifyConsume checks ranked first; if found, returns { rank: N, clusterKind: null }.
  // This test constructs an overlap (same path in ranked AND cochange) to verify that.
  const overlapPath = "src/a.ts";
  const otherPath = "src/b.ts";

  const evts: TraceEvent[] = [
    locateEvent(0, [overlapPath, otherPath], [overlapPath]), // overlapPath in both ranked and cochange
    readEvent(1, overlapPath),
  ];

  const { telemetryDb, sessionId } = replayTrace(evts);

  const rows = telemetryDb
    .prepare("SELECT locate_rank, cluster_kind FROM nav_consume WHERE session_id = ? AND path = ?")
    .all(sessionId, overlapPath) as Array<{ locate_rank: number | null; cluster_kind: string | null }>;

  assert.equal(rows.length, 1, "expected exactly one consume row for overlapPath");
  assert.notEqual(rows[0].locate_rank, null, "ranked wins: locate_rank must be set");
  assert.equal(rows[0].cluster_kind, null, "ranked wins: cluster_kind must be null when path is also ranked");

  // Belt-and-suspenders: DB-wide check (also enforced by CHECK constraint at insert).
  const bad = telemetryDb
    .prepare("SELECT COUNT(*) as n FROM nav_consume WHERE locate_rank IS NOT NULL AND cluster_kind IS NOT NULL")
    .get() as { n: number };
  assert.equal(bad.n, 0, "no row may have both locate_rank and cluster_kind set");

  telemetryDb.close();
});

test("invariants: zero-locate session yields 0 not NaN for all rates", () => {
  const { telemetryDb, sessionId } = replayTrace([
    { turn: 0, toolName: "bash", args: { command: "echo hello" }, result: {} },
  ]);

  const stats = aggregate(telemetryDb, { scope: sessionId });

  assert.equal(stats.locateTotal, 0);
  assert.equal(stats.hitRate, 0);
  assert.equal(stats.assistRate, 0);
  // bypassSessionRate = 1 when session exists but has no locates (correct behaviour, not NaN).
  assert.ok(Number.isFinite(stats.bypassSessionRate));

  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === "number") {
      assert.ok(Number.isFinite(v), `Zero-locate session: ${k} is not finite (got ${v})`);
    }
  }

  telemetryDb.close();
});

test("invariants: expected outcome matches derived outcome for each template", () => {
  const rng = makePrng(SEED + 1);
  let checked = 0;

  for (let i = 0; i < 100; i++) {
    const seq = generateSequence(rng);
    const { telemetryDb, sessionId } = replayTrace(seq.events);
    const outcomes = deriveLocateOutcomes(telemetryDb, {});
    const sessionOutcomes = outcomes.filter((o) => o.sessionId === sessionId);

    for (let li = 0; li < seq.locates.length; li++) {
      const spec = seq.locates[li];
      const o = sessionOutcomes[li];
      if (!o) continue;

      // unrelated_read is deterministically abandoned: the read path is not in ranked or cluster.
      const deterministic = [
        "ranked_hit",
        "ranked_hit_after_search",
        "search_before_cluster",
        "search_in_fallback",
        "fallback_edge_inclusive",
        "fallback_edge_exclusive",
        "late_search",
        "nothing",
        "unrelated_read",
      ];
      if (!deterministic.includes(spec.template.label)) continue;

      assert.equal(
        o.outcome,
        spec.expectedOutcome,
        `Template "${spec.template.label}" at seq#${i} locate#${li}: expected "${spec.expectedOutcome}" got "${o.outcome}" (seed=${SEED + 1})`,
      );
      checked++;
    }

    telemetryDb.close();
  }

  assert.ok(checked > 50, `expected at least 50 deterministic checks, got ${checked}`);
});
