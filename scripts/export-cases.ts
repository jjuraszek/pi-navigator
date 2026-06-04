import { openDb, type Db } from "../src/store/db.ts";
import { migrate as migrateIndex } from "../src/store/schema.ts";
import { getFileByPath } from "../src/store/queries.ts";
import { deriveLocateOutcomes } from "../src/telemetry/stats.ts";
import { migrate as migrateTelemetry } from "../src/telemetry/schema.ts";
import { telemetryPathFor } from "../src/telemetry/db.ts";
import { isSecret } from "../src/indexer/walk.ts";
import { loadConfig } from "../src/config.ts";
import { resolveRepo } from "../src/worktree.ts";

export interface ExportOpts {
  limit?: number;
  outcome?: string;
  queryType?: string;
}

export interface ExportedCase {
  locateId: number;
  sessionId: string;
  query: string | null;
  queryType: string;
  queryTokenCount: number;
  confidence: string;
  outcome: string;
  justifiedFallback: boolean;
  resultsMetadata: Array<{
    path: string;
    score: number;
    signals: { fts: number; path: number; symbol: number; recency: number };
  }>;
  confidenceInputs: { hasExactDef: boolean; usedOrFallback: boolean; topHasAnchor: boolean };
  consumptions: Array<{
    kind: string;
    path: string | null;
    locateRank: number | null;
    searchTool: string | null;
    searchPattern: string | null;
  }>;
  indexWarmth: { coverage: number; fresh: boolean; dirty: boolean; headBehind: number };
  fallbackVerdicts: Array<{ path: string; indexed: "indexed" | "not_indexed" | "indexed_not_returned" }>;
}

// Internal row shapes matching the DB schema.
interface LocateRow {
  id: number;
  session_id: string;
  seq: number;
  turn: number;
  query: string | null;
  query_token_count: number;
  query_type: string;
  result_count: number;
  confidence: string;
  has_exact_def: number;
  used_or_fallback: number;
  top_has_anchor: number;
  coverage: number;
  dirty: number;
  head_behind: number;
  fresh: number;
  results_metadata: string;
}

interface ConsumeRow {
  session_id: string;
  seq: number;
  turn: number;
  kind: string;
  path: string | null;
  locate_rank: number | null;
  search_tool: string | null;
  search_pattern: string | null;
}

function priorityRank(outcome: string, justifiedFallback: boolean, confidence: string): number {
  if (outcome === "miss-fallback" && !justifiedFallback) return 0;
  if (outcome === "miss-fallback" && justifiedFallback) return 1;
  if (outcome === "abandoned") return 2;
  if (confidence === "low") return 3;
  return 4; // hit or other
}

export function exportCases(telemetryDb: Db, indexDb: Db, opts: ExportOpts): ExportedCase[] {
  const TURN_CAP = 10;

  const outcomeList = deriveLocateOutcomes(telemetryDb, { turnCap: TURN_CAP });
  const outcomeMap = new Map(outcomeList.map((o) => [o.locateId, o]));

  const locates = telemetryDb
    .prepare(
      `SELECT id, session_id, seq, turn, query, query_token_count, query_type,
              result_count, confidence, has_exact_def, used_or_fallback, top_has_anchor,
              coverage, dirty, head_behind, fresh, results_metadata
       FROM nav_locate ORDER BY session_id, seq`,
    )
    .all() as unknown as LocateRow[];

  const allConsumes = telemetryDb
    .prepare(
      `SELECT session_id, seq, turn, kind, path, locate_rank, search_tool, search_pattern
       FROM nav_consume ORDER BY session_id, seq`,
    )
    .all() as unknown as ConsumeRow[];

  // Index consumes by session for O(1) window extraction.
  const consumesBySession = new Map<string, ConsumeRow[]>();
  for (const c of allConsumes) {
    let arr = consumesBySession.get(c.session_id);
    if (!arr) { arr = []; consumesBySession.set(c.session_id, arr); }
    arr.push(c);
  }

  // Index locates by session to find nextSeq per locate (same window rule as stats.ts).
  const locatesBySession = new Map<string, LocateRow[]>();
  for (const l of locates) {
    let arr = locatesBySession.get(l.session_id);
    if (!arr) { arr = []; locatesBySession.set(l.session_id, arr); }
    arr.push(l);
  }

  const cases: ExportedCase[] = [];

  for (const l of locates) {
    const outcomeInfo = outcomeMap.get(l.id);
    if (!outcomeInfo) continue;

    // Replicate the attribution window from stats.ts: deriveInternal.
    const sessionLocates = locatesBySession.get(l.session_id)!;
    const lIdx = sessionLocates.findIndex((sl) => sl.id === l.id);
    const nextSeq = lIdx + 1 < sessionLocates.length ? sessionLocates[lIdx + 1].seq : Infinity;

    const sessionConsumes = consumesBySession.get(l.session_id) ?? [];
    const window = sessionConsumes.filter(
      (c) => c.seq > l.seq && c.seq < nextSeq && c.turn <= l.turn + TURN_CAP,
    );

    // Parse results_metadata JSON; fall back to empty array on any parse error.
    let resultsMetadata: Array<{
      path: string;
      score: number;
      signals: { fts: number; path: number; symbol: number; recency: number };
    }> = [];
    try {
      const parsed = JSON.parse(l.results_metadata);
      if (Array.isArray(parsed)) resultsMetadata = parsed;
    } catch {}

    // Redact secret paths from resultsMetadata.
    resultsMetadata = resultsMetadata.filter((r) => !isSecret(r.path));

    const resultPathSet = new Set(resultsMetadata.map((r) => r.path));

    // Collect fallback paths: slice/read with locate_rank=null, or search with a path.
    const fallbackPaths = new Set<string>();
    for (const c of window) {
      if ((c.kind === "slice" || c.kind === "read") && c.locate_rank === null && c.path) {
        fallbackPaths.add(c.path);
      } else if (c.kind === "search" && c.path) {
        fallbackPaths.add(c.path);
      }
    }

    // Derive indexed/not_indexed/indexed_not_returned verdict per fallback path.
    const fallbackVerdicts: Array<{
      path: string;
      indexed: "indexed" | "not_indexed" | "indexed_not_returned";
    }> = [];
    for (const p of fallbackPaths) {
      if (isSecret(p)) continue;
      const rec = getFileByPath(indexDb, p);
      if (!rec) {
        fallbackVerdicts.push({ path: p, indexed: "not_indexed" });
      } else if (!resultPathSet.has(p)) {
        fallbackVerdicts.push({ path: p, indexed: "indexed_not_returned" });
      } else {
        fallbackVerdicts.push({ path: p, indexed: "indexed" });
      }
    }

    // Build consumptions, omitting secret paths.
    const consumptions = window
      .filter((c) => !c.path || !isSecret(c.path))
      .map((c) => ({
        kind: c.kind,
        path: c.path,
        locateRank: c.locate_rank,
        searchTool: c.search_tool,
        searchPattern: c.search_pattern,
      }));

    cases.push({
      locateId: l.id,
      sessionId: l.session_id,
      query: l.query,
      queryType: l.query_type,
      queryTokenCount: l.query_token_count,
      confidence: l.confidence,
      outcome: outcomeInfo.outcome,
      justifiedFallback: outcomeInfo.justifiedFallback,
      resultsMetadata,
      confidenceInputs: {
        hasExactDef: l.has_exact_def === 1,
        usedOrFallback: l.used_or_fallback === 1,
        topHasAnchor: l.top_has_anchor === 1,
      },
      consumptions,
      indexWarmth: {
        coverage: l.coverage,
        fresh: l.fresh === 1,
        dirty: l.dirty === 1,
        headBehind: l.head_behind,
      },
      fallbackVerdicts,
    });
  }

  // Sort: unjustified miss-fallback first, justified miss-fallback, abandoned, low-conf, hits.
  cases.sort((a, b) => {
    const pa = priorityRank(a.outcome, a.justifiedFallback, a.confidence);
    const pb = priorityRank(b.outcome, b.justifiedFallback, b.confidence);
    if (pa !== pb) return pa - pb;
    // Stable secondary sort by locateId for determinism.
    return a.locateId - b.locateId;
  });

  // Apply filters then limit.
  let result = cases;
  if (opts.outcome) result = result.filter((c) => c.outcome === opts.outcome);
  if (opts.queryType) result = result.filter((c) => c.queryType === opts.queryType);
  const limit = opts.limit ?? 50;
  return result.slice(0, limit);
}

// CLI entry point — only executes when run directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let limit: number | undefined;
  let outcome: string | undefined;
  let queryType: string | undefined;
  let repoPath: string | undefined;
  let indexDbPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case "--limit": {
        limit = parseInt(args[++i]!, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          console.error("--limit requires a positive integer");
          process.exit(1);
        }
        break;
      }
      case "--outcome": outcome = args[++i]; break;
      case "--query-type": queryType = args[++i]; break;
      case "--repo": repoPath = args[++i]; break;
      case "--index-db": indexDbPath = args[++i]; break;
    }
  }

  const config = loadConfig();
  const repo = resolveRepo(repoPath ?? process.cwd(), config);
  const resolvedIndexDbPath = indexDbPath ?? repo.dbPath;
  if (!resolvedIndexDbPath) {
    console.error("Not in a git repository; pass --repo or --index-db to point at an indexed repo.");
    process.exit(1);
  }
  const telDbPath = telemetryPathFor(resolvedIndexDbPath);

  const indexDb = openDb(resolvedIndexDbPath);
  const telDb = openDb(telDbPath);
  migrateIndex(indexDb);
  migrateTelemetry(telDb);

  try {
    const result = exportCases(telDb, indexDb, { limit, outcome, queryType });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    indexDb.close();
    telDb.close();
  }
}
