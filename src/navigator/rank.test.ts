import test from "node:test";
import assert from "node:assert/strict";
import { score, pathMatch, recencyBoost, DEFAULT_WEIGHTS, isTestPath, applyTestPenalty, DEFAULT_TEST_PENALTY, COLUMN_WEIGHTS } from "./rank.ts";

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

test("isTestPath: matches test/spec patterns, rejects impl paths", () => {
  // spec file patterns
  assert.ok(isTestPath("app/models/user_spec.rb"), "ruby spec");
  assert.ok(isTestPath("spec/models/user.rb"), "spec/ directory");
  assert.ok(isTestPath("src/utils.test.ts"), "*.test.ts");
  assert.ok(isTestPath("src/utils.spec.tsx"), "*.spec.tsx");
  assert.ok(isTestPath("tests/test_utils.py"), "test_*.py");
  assert.ok(isTestPath("lib/user_test.rb"), "_test.rb suffix");
  assert.ok(isTestPath("tests/utils.js"), "tests/ directory");
  assert.ok(isTestPath("src/foo.spec.js"), "*.spec.js");
  assert.ok(isTestPath("src/foo.test.jsx"), "*.test.jsx");
  // impl paths must be rejected
  assert.equal(isTestPath("app/models/user.rb"), false, "plain impl path");
  assert.equal(isTestPath("src/navigator/rank.ts"), false, "plain ts impl");
  assert.equal(isTestPath("lib/testable_service.rb"), false, "'test' substring only in segment");
});

test("applyTestPenalty: demotes test path, leaves impl unchanged", () => {
  const composite = 5.0;
  // test path is multiplied by penalty
  assert.equal(applyTestPenalty(composite, "spec/models/user_spec.rb"), composite * DEFAULT_TEST_PENALTY);
  // impl path unchanged
  assert.equal(applyTestPenalty(composite, "app/models/user.rb"), composite);
  // test path score is below equal-starting impl score
  const testScore = applyTestPenalty(composite, "spec/user_spec.rb");
  const implScore = applyTestPenalty(composite, "app/user.rb");
  assert.ok(testScore < implScore, "test path must score below equal impl path");
});

test("applyTestPenalty: respects custom penalty override", () => {
  assert.equal(applyTestPenalty(4.0, "src/foo.test.ts", 0.25), 4.0 * 0.25);
});

test("COLUMN_WEIGHTS: order getter returns a 4-tuple of numbers", () => {
  const order = COLUMN_WEIGHTS.order;
  assert.equal(order.length, 4, "order must be a 4-tuple");
  assert.ok(order.every((n: number) => typeof n === "number"), "all elements must be numbers");
  assert.equal(order[0], COLUMN_WEIGHTS.path);
  assert.equal(order[1], COLUMN_WEIGHTS.symbol_names);
  assert.equal(order[2], COLUMN_WEIGHTS.keywords);
  assert.equal(order[3], COLUMN_WEIGHTS.content);
  // content weight is lowest (demoted); path weight is highest
  assert.ok(COLUMN_WEIGHTS.content < COLUMN_WEIGHTS.keywords, "content < keywords");
  assert.ok(COLUMN_WEIGHTS.keywords < COLUMN_WEIGHTS.symbol_names, "keywords < symbol_names");
  assert.ok(COLUMN_WEIGHTS.symbol_names < COLUMN_WEIGHTS.path, "symbol_names < path");
});
