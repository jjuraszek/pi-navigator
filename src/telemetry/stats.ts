import type { Db } from "../store/db.ts";
import type { LocateOutcome, StatsSummary } from "./types.ts";

// Raw DB row shapes used internally.
interface LocateRow {
  id: number;
  session_id: string;
  seq: number;
  turn: number;
  result_count: number;
  confidence: string;
}

interface ConsumeRow {
  session_id: string;
  seq: number;
  turn: number;
  kind: string;
  locate_rank: number | null;
}

interface OutcomeInternal extends LocateOutcome {
  // consumes that fell inside this locate's attribution window
  windowConsumes: ConsumeRow[];
}

// ────────────────────────────────────────────────────────────────────────────
// Core derivation
// ────────────────────────────────────────────────────────────────────────────

function deriveInternal(db: Db, opts: { turnCap: number }): OutcomeInternal[] {
  const locates = db
    .prepare(
      "SELECT id, session_id, seq, turn, result_count, confidence FROM nav_locate ORDER BY session_id, seq",
    )
    .all() as unknown as LocateRow[];

  const consumes = db
    .prepare(
      "SELECT session_id, seq, turn, kind, locate_rank FROM nav_consume ORDER BY session_id, seq",
    )
    .all() as unknown as ConsumeRow[];

  // Group by session
  const consumesBySession = new Map<string, ConsumeRow[]>();
  for (const c of consumes) {
    let arr = consumesBySession.get(c.session_id);
    if (!arr) {
      arr = [];
      consumesBySession.set(c.session_id, arr);
    }
    arr.push(c);
  }

  const locatesBySession = new Map<string, LocateRow[]>();
  for (const l of locates) {
    let arr = locatesBySession.get(l.session_id);
    if (!arr) {
      arr = [];
      locatesBySession.set(l.session_id, arr);
    }
    arr.push(l);
  }

  const outcomes: OutcomeInternal[] = [];

  for (const [sessionId, sessionLocates] of locatesBySession) {
    const sessionConsumes = consumesBySession.get(sessionId) ?? [];

    for (let i = 0; i < sessionLocates.length; i++) {
      const L = sessionLocates[i];
      const nextSeq =
        i + 1 < sessionLocates.length ? sessionLocates[i + 1].seq : Infinity;

      const window = sessionConsumes.filter(
        (c) =>
          c.seq > L.seq &&
          c.seq < nextSeq &&
          c.turn <= L.turn + opts.turnCap,
      );

      // Hit: first slice/read with a non-null locate_rank
      const hitCandidates = window.filter(
        (c) => (c.kind === "slice" || c.kind === "read") && c.locate_rank !== null,
      );

      let outcome: LocateOutcome["outcome"];
      let consumedRank: number | null = null;
      let turnsToConsume: number | null = null;

      if (hitCandidates.length > 0) {
        // window is already ordered by seq (ascending), so first = earliest
        const earliest = hitCandidates[0];
        outcome = "hit";
        consumedRank = earliest.locate_rank;
        turnsToConsume = earliest.turn - L.turn;
      } else {
        const isMissFallback = window.some(
          (c) =>
            c.kind === "search" ||
            ((c.kind === "slice" || c.kind === "read") && c.locate_rank === null),
        );
        outcome = isMissFallback ? "miss-fallback" : "abandoned";
      }

      const justifiedFallback = L.confidence === "low" || L.result_count === 0;

      outcomes.push({
        locateId: L.id,
        sessionId,
        confidence: L.confidence as "high" | "low",
        resultCount: L.result_count,
        outcome,
        justifiedFallback,
        consumedRank,
        turnsToConsume,
        windowConsumes: window,
      });
    }
  }

  return outcomes;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export function deriveLocateOutcomes(db: Db, opts: { turnCap: number }): LocateOutcome[] {
  return deriveInternal(db, opts).map(
    ({ windowConsumes: _wc, ...rest }) => rest,
  );
}

export function aggregate(db: Db, opts: { turnCap: number; scope: string }): StatsSummary {
  const { scope } = opts;
  const all = deriveInternal(db, opts);
  const scoped = scope === "lifetime" ? all : all.filter((o) => o.sessionId === scope);

  const locateTotal = scoped.length;
  const hits = scoped.filter((o) => o.outcome === "hit");
  const missFallbacks = scoped.filter((o) => o.outcome === "miss-fallback");
  const abandoneds = scoped.filter((o) => o.outcome === "abandoned");

  const hitRate = locateTotal > 0 ? hits.length / locateTotal : 0;
  const missFallback = missFallbacks.length;
  const missFallbackUnjustified = missFallbacks.filter((o) => !o.justifiedFallback).length;
  const abandoned = abandoneds.length;
  const zeroResultLocates = scoped.filter((o) => o.resultCount === 0).length;

  // Spec MRR: mean of (1/consumedRank) over HITS only.
  // Denominator = hits.length so MRR stays orthogonal to hitRate.
  const mrr =
    hits.length > 0
      ? hits.reduce((s, o) => s + 1 / o.consumedRank!, 0) / hits.length
      : 0;

  const hitAt = (k: number) =>
    locateTotal > 0
      ? scoped.filter((o) => o.outcome === "hit" && o.consumedRank! <= k).length / locateTotal
      : 0;

  const lowLocates = scoped.filter((o) => o.confidence === "low");
  const highLocates = scoped.filter((o) => o.confidence === "high");
  const lowConfPrecision =
    lowLocates.length > 0 ? lowLocates.filter((o) => o.outcome === "hit").length / lowLocates.length : 0;
  const highConfPrecision =
    highLocates.length > 0 ? highLocates.filter((o) => o.outcome === "hit").length / highLocates.length : 0;

  const turnsArr = hits.map((o) => o.turnsToConsume!).sort((a, b) => a - b);
  const medianTurnsToUseful =
    turnsArr.length === 0
      ? 0
      : turnsArr.length % 2 === 1
        ? turnsArr[Math.floor(turnsArr.length / 2)]
        : (turnsArr[turnsArr.length / 2 - 1] + turnsArr[turnsArr.length / 2]) / 2;

  // fallbackSearches: search consumes inside miss-fallback windows (scoped)
  let fallbackSearches = 0;
  for (const o of missFallbacks) {
    fallbackSearches += o.windowConsumes.filter((c) => c.kind === "search").length;
  }

  // unavailableByReason
  const unavailRows = (
    scope === "lifetime"
      ? (db
          .prepare("SELECT reason, COUNT(*) as cnt FROM nav_unavailable GROUP BY reason")
          .all() as Array<{ reason: string; cnt: number }>)
      : (db
          .prepare(
            "SELECT reason, COUNT(*) as cnt FROM nav_unavailable WHERE session_id = ? GROUP BY reason",
          )
          .all(scope) as Array<{ reason: string; cnt: number }>)
  );
  const unavailableByReason: Record<string, number> = {};
  for (const r of unavailRows) {
    unavailableByReason[r.reason] = r.cnt;
  }

  // Sessions
  const sessRow = (
    scope === "lifetime"
      ? (db
          .prepare(
            "SELECT COUNT(*) as total, COALESCE(SUM(used_locate), 0) as with_locate FROM nav_session",
          )
          .get() as { total: number; with_locate: number })
      : (db
          .prepare(
            "SELECT COUNT(*) as total, COALESCE(SUM(used_locate), 0) as with_locate FROM nav_session WHERE session_id = ?",
          )
          .get(scope) as { total: number; with_locate: number })
  );
  const sessionsTotal = sessRow?.total ?? 0;
  const sessionsWithLocate = sessRow?.with_locate ?? 0;
  const bypassSessionRate = sessionsTotal > 0 ? 1 - sessionsWithLocate / sessionsTotal : 0;

  // staleSliceRate
  const sliceRow = (
    scope === "lifetime"
      ? (db
          .prepare(
            "SELECT SUM(CASE WHEN stale_index = 1 THEN 1 ELSE 0 END) as stale, COUNT(*) as total FROM nav_consume WHERE kind = 'slice'",
          )
          .get() as { stale: number | null; total: number })
      : (db
          .prepare(
            "SELECT SUM(CASE WHEN stale_index = 1 THEN 1 ELSE 0 END) as stale, COUNT(*) as total FROM nav_consume WHERE kind = 'slice' AND session_id = ?",
          )
          .get(scope) as { stale: number | null; total: number })
  );
  const staleSliceRate =
    sliceRow && sliceRow.total > 0 ? (sliceRow.stale ?? 0) / sliceRow.total : 0;

  // unchangedReadsAvoided
  const unchangedRow = (
    scope === "lifetime"
      ? (db
          .prepare(
            "SELECT COUNT(*) as cnt FROM nav_consume WHERE kind IN ('slice', 'read') AND unchanged = 1",
          )
          .get() as { cnt: number })
      : (db
          .prepare(
            "SELECT COUNT(*) as cnt FROM nav_consume WHERE kind IN ('slice', 'read') AND unchanged = 1 AND session_id = ?",
          )
          .get(scope) as { cnt: number })
  );
  const unchangedReadsAvoided = unchangedRow?.cnt ?? 0;

  return {
    scope,
    locateTotal,
    hitRate,
    missFallback,
    missFallbackUnjustified,
    abandoned,
    zeroResultLocates,
    fallbackSearches,
    unavailableByReason,
    sessionsTotal,
    sessionsWithLocate,
    bypassSessionRate,
    mrr,
    hitAt1: hitAt(1),
    hitAt3: hitAt(3),
    hitAt5: hitAt(5),
    lowConfPrecision,
    highConfPrecision,
    medianTurnsToUseful,
    staleSliceRate,
    unchangedReadsAvoided,
  };
}
