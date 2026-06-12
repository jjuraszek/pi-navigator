import type { Db } from "../store/db.ts";
import type { LocateRowInput, ConsumeRowInput, UnavailableRowInput, GuardRowInput } from "./types.ts";

function b(v: boolean): 0 | 1 {
  return v ? 1 : 0;
}

export function ensureSession(
  db: Db,
  row: { sessionId: string; startedAt: number; repoRoot: string; headSha: string | null; isWriter: boolean },
): void {
  db
    .prepare(
      `INSERT OR IGNORE INTO nav_session (session_id, started_at, repo_root, head_sha, is_writer)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.sessionId, row.startedAt, row.repoRoot, row.headSha ?? null, b(row.isWriter));
}

export function markWriter(db: Db, sessionId: string): void {
  db.prepare("UPDATE nav_session SET is_writer = 1 WHERE session_id = ?").run(sessionId);
}

export function markUsedLocate(db: Db, sessionId: string): void {
  db.prepare("UPDATE nav_session SET used_locate = 1 WHERE session_id = ?").run(sessionId);
}

export function insertLocate(db: Db, row: LocateRowInput): number {
  const result = db
    .prepare(
      `INSERT INTO nav_locate
         (session_id, seq, turn, ts, head_sha, query, query_token_count, query_type,
          limit_n, result_count, confidence, has_exact_def, used_or_fallback,
          top_has_anchor, coverage, dirty, head_behind, fresh, latency_ms,
          results_metadata, cochange, referrers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      row.sessionId,
      row.seq,
      row.turn,
      row.ts,
      row.headSha ?? null,
      row.query ?? null,
      row.queryTokenCount,
      row.queryType,
      row.limitN,
      row.resultCount,
      row.confidence,
      b(row.hasExactDef),
      b(row.usedOrFallback),
      b(row.topHasAnchor),
      row.coverage,
      b(row.dirty),
      row.headBehind,
      b(row.fresh),
      row.latencyMs,
      JSON.stringify(row.resultsMetadata),
      JSON.stringify(row.cochange),
      JSON.stringify(row.referrers),
    ) as { id: number };
  return result.id;
}

export function insertConsume(db: Db, row: ConsumeRowInput): void {
  db
    .prepare(
      `INSERT INTO nav_consume
         (session_id, seq, turn, ts, kind, path, locate_rank, stale_index,
          unchanged, search_tool, search_pattern, latency_ms, is_error, cluster_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.sessionId,
      row.seq,
      row.turn,
      row.ts,
      row.kind,
      row.path ?? null,
      row.locateRank ?? null,
      row.staleIndex == null ? null : b(row.staleIndex),
      row.unchanged == null ? null : b(row.unchanged),
      row.searchTool ?? null,
      row.searchPattern ?? null,
      row.latencyMs ?? null,
      b(row.isError),
      row.clusterKind ?? null,
    );
}

export function insertUnavailable(db: Db, row: UnavailableRowInput): void {
  db
    .prepare(
      `INSERT INTO nav_unavailable (session_id, seq, turn, ts, tool, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(row.sessionId, row.seq, row.turn, row.ts, row.tool, row.reason);
}

export function insertGuard(db: Db, row: GuardRowInput): void {
  db
    .prepare(`INSERT INTO nav_guard (session_id, ts, action, pattern_kind, reason) VALUES (?, ?, ?, ?, ?)`)
    .run(row.sessionId, row.ts, row.action, row.patternKind ?? null, row.reason ?? null);
}

export function markToolsSelected(db: Db, sessionId: string, selected: boolean): void {
  db.prepare("UPDATE nav_session SET tools_selected = ? WHERE session_id = ?").run(b(selected), sessionId);
}
