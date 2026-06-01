import { basename, extname } from "node:path";
import type { LocateSignals } from "../types.ts";

export interface RankWeights {
  fts: number;
  path: number;
  symbol: number;
  recency: number;
}

// path weight is intentionally high (3.5) so that an exact basename-stem
// match beats test-file FTS inflation.  Rationale: for source navigation the
// file whose stem exactly matches the query token is almost always the
// definition site.  Evaluated against the project's own eval/cases.jsonl.
export const DEFAULT_WEIGHTS: RankWeights = {
  fts: 1.0,
  path: 3.5,
  symbol: 2.0,
  recency: 0.5,
};

/**
 * BM25 column weights for the FTS5 `bm25()` call.
 * Higher weight = that column matters more to the relevance score.
 * content is demoted (0.5) to prevent large-file noise from swamping symbol
 * and path signals.
 */
export const COLUMN_WEIGHTS = {
  path: 4.0,
  symbol_names: 3.0,
  keywords: 2.0,
  content: 0.5,
  get order(): [number, number, number, number] {
    return [this.path, this.symbol_names, this.keywords, this.content];
  },
};

export const DEFAULT_TEST_PENALTY = 0.5;

// Patterns that identify test/spec files. Checked in order; first match wins.
const TEST_GLOBS: RegExp[] = [
  /(?:^|\/)spec\//,           // spec/ directory anywhere in path
  /(?:^|\/)tests?\//,         // test/ or tests/ directory anywhere in path
  /_spec\.[a-z]+$/,           // *_spec.rb  *_spec.py etc.
  /_test\.[a-z]+$/,           // *_test.rb  *_test.go etc.
  /\.(?:test|spec)\.[tj]sx?$/, // *.test.ts  *.spec.tsx  *.test.js  *.spec.jsx
  /(?:^|\/)test_[^/]+$/,      // test_*.py  test_*.rb  at filename start
];

/** Returns true if `path` looks like a test or spec file. */
export function isTestPath(path: string): boolean {
  return TEST_GLOBS.some((re) => re.test(path));
}

/**
 * Multiplies `composite` by `penalty` when `path` is a test file.
 * Leaves the score unchanged for impl files.
 * Default penalty is DEFAULT_TEST_PENALTY (0.5), demoting tests below
 * equal-scoring impl files.
 */
export function applyTestPenalty(
  composite: number,
  path: string,
  penalty: number = DEFAULT_TEST_PENALTY,
): number {
  return isTestPath(path) ? composite * penalty : composite;
}

export function score(signals: LocateSignals, weights: RankWeights = DEFAULT_WEIGHTS): number {
  return (
    weights.fts * signals.fts +
    weights.path * signals.path +
    weights.symbol * signals.symbol +
    weights.recency * signals.recency
  );
}

/**
 * Returns the path-match signal for a query against a file path.
 * Splits query into whitespace tokens and returns the MAX signal across tokens:
 *   1.0 — a token exactly equals the basename stem (case-insensitive)
 *   0.5 — a token is a substring of any path segment (case-insensitive)
 *   0   — no match
 */
export function pathMatch(query: string, path: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  const stem = basename(path, extname(path)).toLowerCase();
  const segments = path.toLowerCase().split("/");

  let best = 0;
  for (const token of tokens) {
    if (token === stem) return 1; // exact stem match — best possible, short-circuit
    for (const seg of segments) {
      if (seg.includes(token)) {
        best = Math.max(best, 0.5);
        break;
      }
    }
  }
  return best;
}

/**
 * Recency boost in [0, 1).
 *
 * freq  = min(commits30d, 10) / 10          → 0..1, capped at 10 commits
 * age   = lastCommitAt != null
 *           ? exp(-max(0, (now - lastCommitAt) / 86400) / 90)
 *           : 0
 * boost = (freq + age) / 2
 *
 * Returns 0 when both commits30d === 0 and lastCommitAt === null.
 * Deterministic: `now` is passed in, no Date.now() calls.
 */
export function recencyBoost(
  commits30d: number,
  lastCommitAt: number | null,
  now: number,
): number {
  if (commits30d === 0 && lastCommitAt === null) return 0;

  const freq = Math.min(commits30d, 10) / 10;

  let age = 0;
  if (lastCommitAt !== null) {
    const ageDays = Math.max(0, (now - lastCommitAt) / 86400);
    age = Math.exp(-ageDays / 90);
  }

  return (freq + age) / 2;
}
