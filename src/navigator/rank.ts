import { basename, extname } from "node:path";
import type { LocateSignals } from "../types.ts";

export interface RankWeights {
  fts: number;
  path: number;
  symbol: number;
  recency: number;
}

export const DEFAULT_WEIGHTS: RankWeights = {
  fts: 1.0,
  path: 1.0,
  symbol: 2.0,
  recency: 0.5,
};

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
