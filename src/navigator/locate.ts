import type { Db } from "../store/db.ts";
import { getMeta, getCoverage, refFanIn, findSymbolDefs } from "../store/queries.ts";
import { headSha } from "../worktree.ts";
import { countCommitsBetween } from "../indexer/git.ts";
import { score, pathMatch, recencyBoost, COLUMN_WEIGHTS, applyTestPenalty } from "./rank.ts";
import type {
  NavigatorConfig,
  LocateResponse,
  LocateResult,
  LocateSignals,
} from "../types.ts";

/**
 * An identifier-shaped query token: CamelCase (a lowercase/digit followed by an
 * uppercase letter), snake_case (contains "_"), or contains a digit. Only these
 * trigger the exact symbol-definition lookup. A bare lowercase dictionary word
 * ("bus", "parser") is deliberately excluded: it may also be a class name, but
 * treating it as an exact-symbol anchor would flood results across subsystems
 * and over-trust a lexically-seductive match (the example-monorepo P2 trap).
 */
function isIdentifierLike(token: string): boolean {
  return /_/.test(token) || /[0-9]/.test(token) || /[a-z][A-Z]/.test(token);
}

/** Escape a token so it is safe to use as a bare FTS5 term (wrap in double-quotes). */
function ftsEscape(token: string): string {
  // Double any embedded double-quotes, then wrap in double-quotes
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build an FTS5 MATCH expression joining escaped tokens with the given joiner
 * (AND or OR). Returns null when there are no usable tokens.
 */
function buildMatchExpr(query: string, joiner: "AND" | "OR"): string | null {
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map(ftsEscape).join(` ${joiner} `);
}

interface FtsRow {
  rowid: number;
  b: number; // bm25 value — negative; more negative = better match
  path: string;
  symbol_names: string;
}

interface FileMeta {
  id: number;
  lang: string | null;
  commits_30d: number;
  last_commit_at: number | null;
}

interface SymbolRow {
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
}

export function locate(
  db: Db,
  root: string,
  query: string,
  config: NavigatorConfig,
): LocateResponse {
  const nowSeconds = Math.floor(Date.now() / 1000);

  // --- index status (computed regardless of query result) ---
  const indexHeadSha = getMeta(db, "head_sha_at_index");
  const currentHead = headSha(root);
  const fresh = Boolean(indexHeadSha && currentHead && indexHeadSha === currentHead);
  const cov = getCoverage(db);
  const coverage = cov.total > 0 ? cov.indexed / cov.total : 0;
  const head_behind = fresh ? 0 : countCommitsBetween(root, indexHeadSha ?? "");
  const indexStatus = { fresh, head_behind, coverage };

  const empty: LocateResponse = {
    results: [],
    cluster: null,
    index: indexStatus,
    confidence: "low",
  };

  // --- FTS search (bm25 is negative; more negative = better) ---
  // AND-first: narrow to files containing ALL query terms; fall back to OR only
  // when AND yields zero rows (emptiness, not sparsity). A single precise result
  // must never be diluted by OR re-running.
  const [w_path, w_sym, w_kw, w_content] = COLUMN_WEIGHTS.order;

  const runMatch = (expr: string): FtsRow[] => {
    try {
      return db
        .prepare(
          `SELECT rowid, bm25(search_index, ?, ?, ?, ?) AS b, path, symbol_names
           FROM search_index
           WHERE search_index MATCH ?
           ORDER BY b ASC
           LIMIT 200`,
        )
        .all(w_path, w_sym, w_kw, w_content, expr) as unknown as FtsRow[];
    } catch {
      return [];
    }
  };

  const andExpr = buildMatchExpr(query, "AND");
  if (!andExpr) return empty;
  const queryTokenCount = query.split(/\s+/).filter((t) => t.length > 0).length;
  let ftsRows = runMatch(andExpr);
  // usedOrFallback: no single file contained ALL query terms, so we widened to
  // OR. For a multi-term query this is a weak-recall signal worth surfacing.
  let usedOrFallback = false;
  if (ftsRows.length === 0) {
    const orExpr = buildMatchExpr(query, "OR");
    if (orExpr) {
      ftsRows = runMatch(orExpr);
      usedOrFallback = true;
    }
  }

  // --- exact symbol-definition recall ---
  // Identifier-shaped query tokens are looked up directly in the symbols table,
  // bypassing FTS tokenization (which splits/stems CamelCase so a precise symbol
  // query never retrieves its own definition site). Matched definition files are
  // pinned above pure-FTS hits and make the result high-confidence.
  const idTokens = query
    .split(/\s+/)
    .filter((t) => t.length > 0 && isIdentifierLike(t));
  const defRows = idTokens.length > 0 ? findSymbolDefs(db, idTokens) : [];
  const defPaths = new Set(defRows.map((r) => r.path));
  const hasExactDef = defPaths.size > 0;

  if (ftsRows.length === 0 && !hasExactDef) return empty;

  // --- compute bm25 normalisation: fts = -b (positive; larger = better match) ---
  // The most-negative b is the best match; negating makes it the largest fts value.
  // We additionally shift all values so the worst candidate is at 0 (keeps signal ≥ 0).
  const maxB = ftsRows.length > 0 ? Math.max(...ftsRows.map((r) => r.b)) : 0; // least-negative (worst)
  // ftsNorm(row) = maxB - row.b  (≥ 0; best row gets largest value)

  // --- query tokens for the symbol-exact signal ---
  const queryTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  // --- join file metadata for all candidates ---
  const fileMetaStmt = db.prepare(
    `SELECT id, lang, commits_30d, last_commit_at FROM files WHERE path = ?`,
  );

  // --- assemble candidate set: FTS rows + any exact-def files not already present ---
  const candidatePaths = new Map<string, FtsRow | null>();
  for (const row of ftsRows) candidatePaths.set(row.path, row);
  for (const d of defRows) {
    if (!candidatePaths.has(d.path)) candidatePaths.set(d.path, null);
  }

  // --- score each candidate ---
  const scored: Array<{
    path: string;
    meta: FileMeta;
    totalScore: number;
    signals: LocateSignals;
    isExactDef: boolean;
  }> = [];

  for (const [path, row] of candidatePaths) {
    const meta = fileMetaStmt.get(path) as FileMeta | undefined;
    if (!meta) continue; // file deleted between index and query

    // fts signal: shift so best = maxB - minB (all ≥ 0); 0 for def-only files.
    const fts = row ? maxB - row.b : 0;

    // path signal
    const pathSig = pathMatch(query, path);

    // symbol-exact signal: an exact symbol-definition match (identifier-gated),
    // or — for FTS rows — any query token equal to a stored symbol-name token.
    const isExactDef = defPaths.has(path);
    const symbolNames = row?.symbol_names
      ? row.symbol_names.toLowerCase().split(/\s+/)
      : [];
    const symbolSig =
      isExactDef || queryTokens.some((t) => symbolNames.includes(t)) ? 1 : 0;

    // recency signal
    const recency = recencyBoost(meta.commits_30d, meta.last_commit_at, nowSeconds);

    const signals: LocateSignals = { fts, path: pathSig, symbol: symbolSig, recency };
    const totalScore = applyTestPenalty(score(signals), path);

    scored.push({ path, meta, totalScore, signals, isExactDef });
  }

  if (scored.length === 0) return empty;

  // Exact symbol-definition matches are pinned ahead of pure-FTS hits: an exact
  // identifier match is the strongest possible anchor, so it must not be diluted
  // by prose docs that merely mention the term. Ties broken by composite score.
  scored.sort((a, b) => {
    if (a.isExactDef !== b.isExactDef) return a.isExactDef ? -1 : 1;
    return b.totalScore - a.totalScore;
  });
  const topN = scored.slice(0, config.maxLocateResults);

  // --- load symbols for each top result ---
  const symbolsStmt = db.prepare(
    `SELECT s.name, s.kind, s.start_line, s.end_line
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE f.path = ?
     ORDER BY s.start_line`,
  );

  const results: LocateResult[] = topN.map(({ path, meta, totalScore, signals }) => {
    const syms = symbolsStmt.all(path) as unknown as SymbolRow[];
    return {
      path,
      lang: meta.lang as import("../types.ts").Lang | null,
      score: totalScore,
      signals,
      symbols: syms.map((s) => ({
        name: s.name,
        kind: s.kind,
        lines: [s.start_line, s.end_line] as [number, number],
      })),
    };
  });

  // --- confidence: weak recall → caller should fall back to rg/find/read ---
  // Low when (a) terms didn't co-occur in any file for a multi-term query, or
  // (b) the top hit has no structural anchor (matched only on keyword/content,
  // not symbol name or path). Both are the cases where the prior eval saw the
  // agent confidently pick a lexically-seductive wrong file.
  // An exact symbol-definition match is an unambiguous anchor → always high,
  // even when the FTS arm fell back to OR on the surrounding prose tokens.
  const top = results[0];
  const topHasAnchor = top.signals.symbol > 0 || top.signals.path > 0;
  const confidence: "high" | "low" = hasExactDef
    ? "high"
    : (usedOrFallback && queryTokenCount >= 2) || !topHasAnchor
      ? "low"
      : "high";

  // --- cluster fan-out for the top result ---
  const anchor = results[0];
  const anchorId = (fileMetaStmt.get(anchor.path) as FileMeta | undefined)?.id;

  let cluster = null;
  if (anchorId !== undefined) {
    // co-change neighbours: pick the other side of each edge
    const cochangeRows = db
      .prepare(
        `SELECT
           CASE WHEN file_a = ? THEN file_b ELSE file_a END AS other_id
         FROM cochange
         WHERE file_a = ? OR file_b = ?
         ORDER BY weight DESC
         LIMIT 5`,
      )
      .all(anchorId, anchorId, anchorId) as { other_id: number }[];

    const idToPathStmt = db.prepare(`SELECT path FROM files WHERE id = ?`);
    const cochangePaths = cochangeRows
      .map((r) => (idToPathStmt.get(r.other_id) as { path: string } | undefined)?.path)
      .filter((p): p is string => p !== undefined);

    // referrers: files that import/require the anchor — suppressed when fan-in is
    // too high (> REF_DF_CAP_PCT of all files), since listing every caller of a
    // hub file is noise not signal.
    //
    // Scope note (spec §8.3): refFanIn counts only ruby_const edges, so Rails hub
    // constants are correctly capped. The referrer list itself may include
    // import/require edges (TS/JS), meaning high-fan-in TS/JS hub modules are NOT
    // throttled in this iteration — deliberate, matching current spec scope.
    const REF_DF_CAP_PCT = 0.2;
    const totalFiles = Math.max(1, cov.total);
    const overCap = refFanIn(db, anchorId) / totalFiles > REF_DF_CAP_PCT;

    let referrerPaths: string[];
    if (overCap) {
      referrerPaths = [];
    } else {
      const referrerRows = db
        .prepare(
          `SELECT f.path FROM refs r JOIN files f ON f.id = r.src_file WHERE r.dst_file = ? LIMIT 10`,
        )
        .all(anchorId) as { path: string }[];
      referrerPaths = referrerRows.map((r) => r.path);
    }

    cluster = {
      anchor: anchor.path,
      cochange: cochangePaths,
      referrers: referrerPaths,
    };
  }

  return { results, cluster, index: indexStatus, confidence };
}
