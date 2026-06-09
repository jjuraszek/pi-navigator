import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import ext from "./index.ts";
import { NAVIGATOR_PROMPT_NUDGE } from "./src/prompt-guidance.ts";

const PERSONA = readFileSync(new URL("./prompts/navigator-persona.md", import.meta.url), "utf8").trim();

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

function promptEvent(prompt: string, selectedTools = ["navigator_locate", "navigator_slice"]) {
  return {
    prompt,
    systemPrompt: "base system prompt",
    systemPromptOptions: { selectedTools },
  };
}

async function locateText(pi: ReturnType<typeof fakePi>): Promise<string> {
  const res = await pi.tool("navigator_locate").execute("id", { query: "anything" }, undefined, undefined, {});
  return res.content.map((c: any) => c.text).join("").toLowerCase();
}

async function waitForPromptResult(
  pi: ReturnType<typeof fakePi>,
  event: ReturnType<typeof promptEvent>,
  until?: (result: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + 3_000;
  let last: any;
  while (Date.now() < deadline) {
    last = await pi.fire("before_agent_start", event, undefined);
    // Default: settle on the first non-empty guidance. With `until`, keep
    // polling until the predicate holds. The persona tier fires as soon as the
    // index is usable (mid-crawl), so a test that needs the freshness-gated
    // nudge must wait for full-crawl completion via `until`, not the first hit.
    const done = until ? last !== undefined && until(last) : last !== undefined;
    if (done) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

const nudgePresent = (r: any): boolean =>
  typeof r?.systemPrompt === "string" &&
  r.systemPrompt.includes(NAVIGATOR_PROMPT_NUDGE);

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

function gitRepoWithCommit(): { repo: string; git: (args: string[]) => Buffer } {
  const repo = mkdtempSync(join(tmpdir(), "nav-prompt-repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "grid.rb"), "class Grid\n  def sync; end\nend\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return { repo, git };
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

    const ready = await locateText(pi);
    assert.doesNotMatch(ready, /not inside a git repository|navigator is disabled/);

    await pi.fire("session_shutdown", {}, undefined);

    const afterShutdown = await locateText(pi);
    assert.match(afterShutdown, /try again/);
    assert.match(afterShutdown, /rg|fd/);
    rmSync(repo, { recursive: true, force: true });
  } finally {
    restore();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("before_agent_start: ready broad prompt appends persona and nudge despite stale injectPersona false", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-prompt-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"], injectPersona: false });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));

    // Wait for the nudge specifically: the persona fires mid-crawl, so polling
    // for the first non-empty result would race and return persona-only.
    const result = await waitForPromptResult(
      pi,
      promptEvent("investigate why navigator is rarely used in gridstrong"),
      nudgePresent,
    );

    assert.ok(result);
    assert.match(result.systemPrompt, /base system prompt/);
    assert.match(result.systemPrompt, new RegExp(PERSONA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.systemPrompt, new RegExp(NAVIGATOR_PROMPT_NUDGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("before_agent_start: ready exact-path prompt appends persona only", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-prompt-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));

    const result = await waitForPromptResult(pi, promptEvent("read grid.rb"));

    assert.ok(result);
    assert.match(result.systemPrompt, new RegExp(PERSONA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.systemPrompt, new RegExp(NAVIGATOR_PROMPT_NUDGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("before_agent_start: missing navigator_locate selected tool appends no guidance", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-prompt-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));

    assert.ok(
      await waitForPromptResult(
        pi,
        promptEvent("investigate why navigator is rarely used in gridstrong"),
      ),
    );

    const noGuidance = await pi.fire(
      "before_agent_start",
      promptEvent("investigate why navigator is rarely used in gridstrong", ["navigator_slice"]),
      undefined,
    );
    assert.equal(noGuidance, undefined);
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("before_agent_start: dirty worktree appends persona only", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-prompt-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));

    assert.ok(
      await waitForPromptResult(
        pi,
        promptEvent("investigate why navigator is rarely used in gridstrong"),
      ),
    );

    writeFileSync(join(repo, "grid.rb"), "class Grid\n  def sync\n    :dirty\n  end\nend\n");
    const result = await pi.fire(
      "before_agent_start",
      promptEvent("investigate why navigator is rarely used in gridstrong"),
      undefined,
    );
    assert.ok(result);
    assert.match(result.systemPrompt, new RegExp(PERSONA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.systemPrompt, new RegExp(NAVIGATOR_PROMPT_NUDGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("before_agent_start: stale indexed HEAD appends persona only", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-prompt-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo, git } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));

    assert.ok(
      await waitForPromptResult(
        pi,
        promptEvent("investigate why navigator is rarely used in gridstrong"),
      ),
    );

    writeFileSync(join(repo, "grid.rb"), "class Grid\n  def sync\n    :new_head\n  end\nend\n");
    git(["add", "."]);
    git(["commit", "-qm", "second"]);

    const result = await pi.fire(
      "before_agent_start",
      promptEvent("investigate why navigator is rarely used in gridstrong"),
      undefined,
    );
    assert.ok(result);
    assert.match(result.systemPrompt, new RegExp(PERSONA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.systemPrompt, new RegExp(NAVIGATOR_PROMPT_NUDGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("before_agent_start: readiness errors fail quiet", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-prompt-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));

    assert.ok(
      await waitForPromptResult(
        pi,
        promptEvent("investigate why navigator is rarely used in gridstrong"),
      ),
    );

    const noGuidance = await pi.fire(
      "before_agent_start",
      {
        prompt: "investigate why navigator is rarely used in gridstrong",
        systemPrompt: "base system prompt",
        get systemPromptOptions() {
          throw new Error("selected tools unavailable");
        },
      },
      undefined,
    );
    assert.equal(noGuidance, undefined);
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// grep-block hook (tool_call)
// ---------------------------------------------------------------------------

function bashToolCallEvent(command: string) {
  return { type: "tool_call", toolName: "bash", toolCallId: "tc-1", input: { command } };
}

const noopUiCtx = { ui: { notify() {}, setStatus() {} } };

test("grep-block: recursive grep is blocked when navigator is ready", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-grepblock-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));
    await waitForPromptResult(pi, { prompt: "orient", systemPrompt: "", systemPromptOptions: { selectedTools: ["navigator_locate"] } });

    const result = await pi.fire("tool_call", bashToolCallEvent(`grep -r FleetReadiness ${repo}`), noopUiCtx);
    assert.ok(result, "should be blocked");
    assert.equal(result.block, true);
    assert.match(result.reason, /rg|navigator_locate/i);
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("grep-block: repo-scan grep is allowed when navigator is not ready", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-grepblock-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    // No session_start: repoStatus stays "booting", navigatorActive is false.
    // The activation guard must allow the command rather than block where we
    // cannot offer the index as an alternative.
    const result = await pi.fire("tool_call", bashToolCallEvent(`grep -r foo ${repo}`), noopUiCtx);
    assert.equal(result, undefined, "repo-scan grep allowed when navigator inactive");
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("grep-block: piped grep is always allowed", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-grepblock-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));
    await waitForPromptResult(pi, { prompt: "orient", systemPrompt: "", systemPromptOptions: { selectedTools: ["navigator_locate"] } });

    const result = await pi.fire("tool_call", bashToolCallEvent("ps aux | grep node"), noopUiCtx);
    assert.equal(result, undefined, "piped grep should be allowed (returns undefined)");
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("grep-block: single-file grep is allowed", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-grepblock-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"] });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));
    await waitForPromptResult(pi, { prompt: "orient", systemPrompt: "", systemPromptOptions: { selectedTools: ["navigator_locate"] } });

    const result = await pi.fire("tool_call", bashToolCallEvent(`grep foo ${join(repo, "grid.rb")}`), noopUiCtx);
    assert.equal(result, undefined, "single-file grep should be allowed");
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test("grep-block: disabled via config grepBlock:false", async () => {
  const indexDir = mkdtempSync(join(tmpdir(), "nav-grepblock-idx-"));
  const { restore } = withAgentSettings({ indexDir, languages: ["ruby"], grepBlock: false });
  const { repo } = gitRepoWithCommit();
  const pi = fakePi();
  ext(pi as any);
  try {
    await pi.fire("session_start", {}, noopCtx(repo));
    await waitForPromptResult(pi, { prompt: "orient", systemPrompt: "", systemPromptOptions: { selectedTools: ["navigator_locate"] } });

    const result = await pi.fire("tool_call", bashToolCallEvent(`grep -r foo ${repo}`), noopUiCtx);
    assert.equal(result, undefined, "grep should be allowed when grepBlock is false");
  } finally {
    await pi.fire("session_shutdown", {}, undefined);
    restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});
