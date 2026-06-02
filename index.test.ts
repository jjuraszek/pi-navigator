import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import ext from "./index.ts";

/**
 * Exercises the live session_start → shutdown → session_start state machine in
 * index.ts (the pi-runtime seam) through a fake ExtensionAPI. Asserts the
 * repoStatus gating the user actually sees: a non-git or disabled navigator
 * must give a TERMINAL "use rg/fd" message (never the retryable "try again"),
 * and a booting/torn-down index must be retryable.
 */

function fakePi() {
  const handlers = new Map<string, (e: any, c: any) => any>();
  const tools: any[] = [];
  return {
    on: (ev: string, fn: (e: any, c: any) => any) => handlers.set(ev, fn),
    registerTool: (def: any) => tools.push(def),
    registerCommand: (_n: string, _o: any) => {},
    fire: (ev: string, event: any, ctx: any) => handlers.get(ev)?.(event, ctx),
    tool: (name: string) => tools.find((t) => t.name === name),
  };
}

const noopCtx = (cwd: string) => ({ cwd, ui: { notify() {}, setStatus() {} } });

async function locateText(pi: ReturnType<typeof fakePi>): Promise<string> {
  const res = await pi.tool("navigator_locate").execute("id", { query: "anything" }, undefined, undefined, {});
  return res.content.map((c: any) => c.text).join("").toLowerCase();
}

function withAgentSettings(navigator: Record<string, unknown>): { agentDir: string; restore: () => void } {
  const agentDir = mkdtempSync(join(tmpdir(), "nav-agent-"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ navigator }));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return {
    agentDir,
    restore: () => {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

test("session_start: disabled config yields a terminal disabled message (not 'try again')", async () => {
  const { restore } = withAgentSettings({ enabled: false });
  try {
    const dir = mkdtempSync(join(tmpdir(), "nav-disabled-"));
    const pi = fakePi();
    ext(pi as any);
    await pi.fire("session_start", {}, noopCtx(dir));
    const text = await locateText(pi);
    assert.match(text, /disabled/);
    assert.match(text, /rg|fd/);
    assert.doesNotMatch(text, /try again/);
    await pi.fire("session_shutdown", {}, undefined);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("session_start: non-git cwd yields a terminal not-a-git-repo message", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-idx-"));
  const { restore } = withAgentSettings({ indexDir });
  try {
    const dir = mkdtempSync(join(tmpdir(), "nav-nogit-"));
    const pi = fakePi();
    ext(pi as any);
    await pi.fire("session_start", {}, noopCtx(dir));
    const text = await locateText(pi);
    assert.match(text, /not inside a git repository/);
    assert.match(text, /rg|fd/);
    assert.doesNotMatch(text, /try again/);
    await pi.fire("session_shutdown", {}, undefined);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    restore();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("session_start → shutdown: a git repo serves, then becomes retryable after teardown", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  try {
    const repo = mkdtempSync(join(tmpdir(), "nav-repo-"));
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.t"]);
    g(["config", "user.name", "t"]);
    writeFileSync(join(repo, "grid.rb"), "class Grid\n  def sync; end\nend\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);

    const pi = fakePi();
    ext(pi as any);
    await pi.fire("session_start", {}, noopCtx(repo));

    // Ready: the tool no longer returns a terminal/unavailable gating message.
    const ready = await locateText(pi);
    assert.doesNotMatch(ready, /not inside a git repository|navigator is disabled/);

    await pi.fire("session_shutdown", {}, undefined);

    // After teardown the index is gone; status falls back to retryable booting.
    const afterShutdown = await locateText(pi);
    assert.match(afterShutdown, /try again/);
    assert.match(afterShutdown, /rg|fd/);
    rmSync(repo, { recursive: true, force: true });
  } finally {
    restore();
    rmSync(indexDir, { recursive: true, force: true });
  }
});
