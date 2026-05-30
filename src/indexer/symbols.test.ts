import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initParsers, extractSymbols, extractImports } from "./symbols.ts";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "__fixtures__", n), "utf8");

test("ruby symbols + imports", async () => {
  await initParsers(["ruby"]);
  const src = fx("sample.rb");
  const names = extractSymbols("ruby", src).map((s) => s.name);
  assert.ok(names.includes("Grid"));
  assert.ok(names.includes("Grids"));
  assert.ok(names.includes("sync"));
  const imps = extractImports("ruby", src).map((i) => i.toPathHint);
  assert.ok(imps.includes("grid_sync"));
});

test("python symbols", async () => {
  await initParsers(["python"]);
  const names = extractSymbols("python", fx("sample.py")).map((s) => s.name);
  assert.ok(names.includes("Grid") && names.includes("sync"));
});

test("ts symbols + imports", async () => {
  await initParsers(["ts"]);
  const src = fx("sample.ts");
  const names = extractSymbols("ts", src).map((s) => s.name);
  assert.ok(names.includes("MyClass"), `MyClass not in ${names.join(",")}`);
  assert.ok(names.includes("helper"), `helper not in ${names.join(",")}`);
  assert.ok(names.includes("FOO"), `FOO not in ${names.join(",")}`);
  const imps = extractImports("ts", src).map((i) => i.toPathHint);
  assert.ok(imps.includes("./dep"), `./dep not in ${imps.join(",")}`);
});
