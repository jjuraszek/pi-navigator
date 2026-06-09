import { test } from "node:test";
import assert from "node:assert/strict";
import { isStrongHit, STRONG_HIT_DIRECTIVE } from "./strong-hit.ts";
import type { LocateResponse } from "../types.ts";

function resp(over: Partial<LocateResponse>): LocateResponse {
  return {
    results: [{ path: "a.ts", lang: "ts", score: 1, signals: { fts: 1, path: 0, symbol: 1, recency: 0 }, symbols: [] }],
    cluster: null,
    index: { fresh: true, head_behind: 0, coverage: 1, dirty: false },
    confidence: "high",
    has_exact_def: true,
    used_or_fallback: false,
    top_has_anchor: true,
    ...over,
  };
}

test("strong hit requires exact def AND anchor", () => {
  assert.equal(isStrongHit(resp({})), true);
});

test("no anchor is not a strong hit", () => {
  assert.equal(isStrongHit(resp({ top_has_anchor: false })), false);
});

test("no exact def is not a strong hit", () => {
  assert.equal(isStrongHit(resp({ has_exact_def: false })), false);
});

test("empty results is not a strong hit", () => {
  assert.equal(isStrongHit(resp({ results: [], has_exact_def: false })), false);
});

test("empty results is not a strong hit even with exact def", () => {
  assert.equal(isStrongHit(resp({ results: [] })), false);
});

test("strong hit and low-confidence are mutually exclusive", () => {
  const r = resp({});
  assert.equal(isStrongHit(r) && r.confidence === "low", false);
  assert.equal(isStrongHit(resp({ confidence: "low", has_exact_def: false, top_has_anchor: false })), false);
});

test("directive mentions slicing rank 1 and not re-searching", () => {
  assert.match(STRONG_HIT_DIRECTIVE, /slice rank 1/i);
  assert.match(STRONG_HIT_DIRECTIVE, /redundant/i);
});
