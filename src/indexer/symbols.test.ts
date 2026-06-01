import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initParsers, extractSymbols, extractImports, extractText } from "./symbols.ts";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "__fixtures__", n), "utf8");

test("ruby constant references as ruby_const import hints", async () => {
  await initParsers(["ruby"]);
  const src = [
    "class OrdersController < ApplicationController",
    "  def index",
    "    user = User.find(1)",
    "    invoice = Billing::Invoice.new",
    "  end",
    "end",
  ].join("\n");
  const imps = extractImports("ruby", src);
  const consts = imps.filter((i) => i.kind === "ruby_const").map((i) => i.toPathHint);
  assert.ok(consts.includes("ApplicationController"), `ApplicationController not in ${consts.join(",")}`);
  assert.ok(consts.includes("User"), `User not in ${consts.join(",")}`);
  assert.ok(consts.includes("Billing::Invoice"), `Billing::Invoice not in ${consts.join(",")}`);
});

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

test("extractText returns comment and string-literal text (ruby + typescript)", async () => {
  await initParsers(["ruby", "ts"]);

  // Ruby: comment + string literal
  const rubySrc = [
    "# calculate power flow",
    "class Grid",
    "  ZONE = \"danger zone\"",
    "  def sync; end",
    "end",
  ].join("\n");
  const rubyTokens = extractText("ruby", rubySrc);
  const rubyJoined = rubyTokens.join(" ").toLowerCase();
  assert.ok(rubyJoined.includes("calculate"), `expected 'calculate' in: ${rubyJoined}`);
  assert.ok(rubyJoined.includes("power"), `expected 'power' in: ${rubyJoined}`);
  assert.ok(rubyJoined.includes("flow"), `expected 'flow' in: ${rubyJoined}`);
  assert.ok(rubyJoined.includes("danger"), `expected 'danger' in: ${rubyJoined}`);
  assert.ok(rubyJoined.includes("zone"), `expected 'zone' in: ${rubyJoined}`);

  // TypeScript: single-line comment + string literal
  const tsSrc = [
    "// initialise power flow",
    "const LABEL = \"danger zone\";",
  ].join("\n");
  const tsTokens = extractText("ts", tsSrc);
  const tsJoined = tsTokens.join(" ").toLowerCase();
  assert.ok(tsJoined.includes("power"), `expected 'power' in ts: ${tsJoined}`);
  assert.ok(tsJoined.includes("danger"), `expected 'danger' in ts: ${tsJoined}`);
});
