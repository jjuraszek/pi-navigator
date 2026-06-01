import test from "node:test";
import assert from "node:assert/strict";
import { splitIdentifier, extractKeywords, buildStoplist } from "./keywords.ts";

test("splitIdentifier splits camelCase and snake_case", () => {
  assert.deepEqual(splitIdentifier("createUser"), ["create", "user"]);
  assert.deepEqual(splitIdentifier("power_flow"), ["power", "flow"]);
  assert.deepEqual(splitIdentifier("HTTPServer"), ["http", "server"]);
});

test("extractKeywords drops language keywords but keeps domain terms", () => {
  const stop = buildStoplist("ruby", []);
  const kw = extractKeywords(["def", "calculate_power_flow", "Plant"], stop, 3);
  assert.ok(!kw.includes("def"), "def should be stoplisted");
  assert.ok(kw.includes("calculate") && kw.includes("power") && kw.includes("flow"));
  assert.ok(kw.includes("plant"), "domain term must survive");
});

test("extractKeywords applies length floor", () => {
  const kw = extractKeywords(["io", "os", "voltage"], new Set(), 3);
  assert.deepEqual(kw, ["voltage"]);
});

test("extractKeywords drops numeric/hex/uuid/url tokens", () => {
  const kw = extractKeywords(["123", "deadbeef0123", "https://x.com/y", "value"], new Set(), 3);
  assert.deepEqual(kw, ["value"]);
});

test("buildStoplist merges lang + cross-lang + user terms (lowercased)", () => {
  const stop = buildStoplist("python", ["FooBar"]);
  assert.ok(stop.has("def"));      // python kw
  assert.ok(stop.has("todo"));     // cross-lang
  assert.ok(stop.has("foobar"));   // user, lowercased
});
