import test from "node:test";
import assert from "node:assert/strict";
import { score, pathMatch, recencyBoost, DEFAULT_WEIGHTS } from "./rank.ts";

test("score applies weights additively (symbol weighted 2x)", () => {
  const s = { fts: 1, path: 0, symbol: 1, recency: 0 };
  assert.equal(score(s), 1 * 1 + 0 + 2 * 1 + 0); // 3
  assert.equal(score({ fts: 0, path: 1, symbol: 0, recency: 0 }), 1);
});

test("exact-symbol signal outranks path-only", () => {
  const symbolHit = score({ fts: 2, path: 0, symbol: 1, recency: 0 }); // 2 + 2 = 4
  const pathOnly = score({ fts: 2, path: 1, symbol: 0, recency: 0 });  // 2 + 1 = 3
  assert.ok(symbolHit > pathOnly);
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
