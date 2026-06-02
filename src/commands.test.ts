import test from "node:test";
import assert from "node:assert/strict";
import { parseSub, registerNavigatorCommand, type NavigatorState } from "./commands.ts";

test("parseSub parses status/reindex/path/default", () => {
  assert.deepEqual(parseSub("status"), { sub: "status" });
  assert.deepEqual(parseSub(""), { sub: "status" });
  assert.deepEqual(parseSub("reindex"), { sub: "reindex" });
  assert.deepEqual(parseSub("reindex app/x.rb"), { sub: "reindex", path: "app/x.rb" });
  assert.deepEqual(parseSub("bogus"), { sub: "status" });
});

test("command handler notifies status and triggers reindex", async () => {
  const notes: string[] = [];
  let reindexed: string | undefined | "NOTCALLED" = "NOTCALLED";
  const state: NavigatorState = {
    active: true,
    coverage: { total: 10, indexed: 4, fullCrawlDone: false, headBehind: 0 },
    isWriter: true,
    dbPath: "/tmp/cache/repo_abc123.db",
    reindex: (p) => { reindexed = p; },
  };
  let captured: any;
  const pi = { registerCommand: (_n: string, opts: any) => { captured = opts; } };
  registerNavigatorCommand(pi, () => state);
  const ctx = { ui: { notify: (m: string) => notes.push(m) } };
  await captured.handler("status", ctx);
  assert.ok(notes.some((n) => /4\/10|40%/.test(n)), "status should report coverage");
  assert.ok(notes.some((n) => /\/tmp\/cache\/repo_abc123\.db/.test(n)), "status should include db path");
  await captured.handler("reindex app/x.rb", ctx);
  assert.equal(reindexed, "app/x.rb");
});

test("command handler reports inactive when not a git repo", async () => {
  const notes: string[] = [];
  let reindexed = false;
  const state: NavigatorState = {
    active: false,
    coverage: null,
    isWriter: false,
    dbPath: "",
    reindex: () => { reindexed = true; },
  };
  let captured: any;
  const pi = { registerCommand: (_n: string, opts: any) => { captured = opts; } };
  registerNavigatorCommand(pi, () => state);
  const ctx = { ui: { notify: (m: string) => notes.push(m) } };
  await captured.handler("status", ctx);
  await captured.handler("reindex", ctx);
  assert.ok(notes.every((n) => /inactive/.test(n)), "both subcommands report inactive");
  assert.equal(reindexed, false, "reindex must not fire when inactive");
});
