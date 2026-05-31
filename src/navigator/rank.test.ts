import test from "node:test";
import assert from "node:assert/strict";
import { score, pathMatch, recencyBoost, DEFAULT_WEIGHTS } from "./rank.ts";

test("score applies weights additively — values derived from DEFAULT_WEIGHTS", () => {
  // fts+symbol only
  const s = { fts: 1, path: 0, symbol: 1, recency: 0 };
  assert.equal(score(s), DEFAULT_WEIGHTS.fts + DEFAULT_WEIGHTS.symbol);
  // path only
  assert.equal(score({ fts: 0, path: 1, symbol: 0, recency: 0 }), DEFAULT_WEIGHTS.path);
});

test("symbol signal always adds to score; exact stem beats substring path", () => {
  // symbol weight > 0: adding symbol always increases total
  const withSym = score({ fts: 1, path: 0.5, symbol: 1, recency: 0 });
  const noSym   = score({ fts: 1, path: 0.5, symbol: 0, recency: 0 });
  assert.ok(withSym > noSym, "symbol signal must increase score");
  // exact stem match (pathMatch=1.0) beats substring (0.5) all else equal
  const exactPath = score({ fts: 1, path: 1.0, symbol: 0, recency: 0 });
  const subPath   = score({ fts: 1, path: 0.5, symbol: 0, recency: 0 });
  assert.ok(exactPath > subPath, "exact path stem must beat substring");
});

test("pathMatch: basename stem hit = 1, segment substring = 0.5, miss = 0", () => {
  assert.equal(pathMatch("grid", "app/models/grid.rb"), 1);
  assert.equal(pathMatch("model", "app/models/grid.rb"), 0.5);
  assert.equal(pathMatch("zzz", "app/models/grid.rb"), 0);
});

test("recencyBoost is deterministic and bounded [0,1]", () => {
  const now = 1_000_000_000;
  const b = recencyBoost(5, now - 86400, now);
  assert.ok(b >= 0 && b <= 1);
  assert.equal(recencyBoost(0, null, now), 0);
  // more commits → higher or equal
  assert.ok(recencyBoost(10, now, now) >= recencyBoost(1, now, now));
});
