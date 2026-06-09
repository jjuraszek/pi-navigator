import type { LocateResponse } from "../types.ts";

export const STRONG_HIT_DIRECTIVE =
  "  [high-confidence exact match — slice rank 1 directly; re-running rg/grep/read to re-find this is redundant]";

// has_exact_def ⇒ confidence === "high" by locate.ts derivation, so the
// confidence flag is not re-checked here; top_has_anchor is the non-redundant
// discriminator that separates a definitive rank-1 from a plausible-but-soft hit.
export function isStrongHit(res: LocateResponse): boolean {
  return res.results.length > 0 && res.has_exact_def && res.top_has_anchor;
}
