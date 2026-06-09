import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGrepAction } from "./grep-guard.ts";

const probeDir = (p: string) => p === "." || p === ".." || p.endsWith("/");
const base = { probeDir, rgAvailable: true, navigatorActive: true };

test("recursive grep is blocked", () => {
  const r = decideGrepAction({ command: "grep -r foo src/", ...base });
  assert.equal(r.action, "block");
});
test("grep over a directory path is blocked", () => {
  const r = decideGrepAction({ command: "grep foo .", ...base });
  assert.equal(r.action, "block");
});
test("grep over a single file is allowed", () => {
  const r = decideGrepAction({ command: "grep foo src/file.ts", ...base });
  assert.equal(r.action, "allow");
});
test("piped grep is allowed", () => {
  assert.equal(decideGrepAction({ command: "ps aux | grep node", ...base }).action, "allow");
  assert.equal(decideGrepAction({ command: "cat f | grep x", ...base }).action, "allow");
});
test("stdin grep (no path) is allowed", () => {
  assert.equal(decideGrepAction({ command: "grep foo", ...base }).action, "allow");
});
test("git grep is allowed", () => {
  assert.equal(decideGrepAction({ command: "git grep foo", ...base }).action, "allow");
});
test("grep --help is allowed", () => {
  assert.equal(decideGrepAction({ command: "grep --help", ...base }).action, "allow");
});
test("symbol pattern points at navigator_locate", () => {
  const r = decideGrepAction({ command: "grep -r FleetReadinessPresenter src/", ...base });
  assert.equal(r.action, "block");
  assert.match(r.reason!, /navigator_locate/);
});
test("regex pattern points at rg", () => {
  const r = decideGrepAction({ command: "grep -r 'foo.*bar' src/", ...base });
  assert.equal(r.action, "block");
  assert.match(r.reason!, /\brg\b/);
  assert.doesNotMatch(r.reason!, /navigator_locate/);
});
test("navigator inactive always allows", () => {
  const r = decideGrepAction({ command: "grep -r foo src/", probeDir, rgAvailable: true, navigatorActive: false });
  assert.equal(r.action, "allow");
});
test("rg absent on a repo-scan allows with warn flag", () => {
  const r = decideGrepAction({ command: "grep -r foo src/", probeDir, rgAvailable: false, navigatorActive: true });
  assert.equal(r.action, "allow");
  assert.equal(r.warn, true);
});
