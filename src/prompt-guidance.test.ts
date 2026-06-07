import test from "node:test";
import assert from "node:assert/strict";
import type { NavigatorPromptReadinessFacts } from "./prompt-guidance.ts";
import {
  NAVIGATOR_PROMPT_NUDGE,
  buildNavigatorPromptGuidance,
  classifyNavigatorPrompt,
  hasExactLocalPath,
  isExternalOnlyPrompt,
  isNavigatorPromptGuidanceReady,
} from "./prompt-guidance.ts";

const broadPromptCases = [
  "investigate why navigator is rarely used in gridstrong",
  "review Linear E-1935",
  "review this ticket",
  "review this issue",
  "what needs changing to support X?",
  "where is fleet readiness implemented?",
  "fix the heatmap behavior",
  "add support for X",
  "look into this behavior",
  "is this actionable?",
  "explain how X works",
  "find where X is handled",
];

const looselyOrientingCases = [
  "how does fleet readiness work",
  "why is navigator rarely used",
  "debug the heatmap rendering",
  "understand the auth flow",
  "refactor the rolling indexer",
  "review the Linear ticket E-1935",
  "what is the capital of France",
];

const exactPathCases = [
  "read src/foo.ts",
  "edit doc/specs/2026-06-03-usefulness-telemetry.md",
  "why does test src/foo.test.ts fail?",
  "open ./src/foo.ts:42",
  "inspect ../gridstrong/app/models/user.rb:10:2",
  "summarize README.md",
  "check package.json",
  "summarize `README.md`",
  "read 'AGENTS.md'",
  'open "AGENTS.md"',
];

const externalOnlyCases = [
  "summarize https://example.com/post",
  "fetch this URL: https://example.com/post",
  "check GitHub PR comments",
  "review PR comments",
  "review GitHub PR comments",
  "review GitHub PR comments without asking for code impact",
  "check GitHub PR comments without asking for code impact",
  "what branch am I on?",
  "show git status",
  "report git branch information only",
  "send a Slack message to Alice",
  "query sentry for recent errors",
  "inspect the database schema",
];

const codeImpactCases = [
  "check https://example.com and see what code needs to change",
  "show git status and tell me what code needs to change",
  "review Linear E-1935 and identify implementation changes",
  "look at this PR and see what code needs to change",
  "review GitHub issue 123 and fix the behavior",
];

const readyFacts: NavigatorPromptReadinessFacts = {
  repoResolved: true,
  selectedTools: ["navigator_locate", "navigator_slice"],
  coverage: { total: 10, indexed: 10 },
  fullCrawlDone: true,
  indexedHead: "abc123",
  currentHead: "abc123",
  dirty: false,
  workerFailed: false,
};

const persona =
  "Repo orientation rule: when a task requires finding code/docs and no exact path is already known, call `navigator_locate` once before broad `rg`/`find`/`read`; use `rg` for regex or full-content scans.";

test("classifyNavigatorPrompt: broad repo prompts nudge", () => {
  for (const prompt of broadPromptCases) {
    assert.equal(classifyNavigatorPrompt(prompt), "likely_orientation", prompt);
  }
});

test("classifyNavigatorPrompt: default-on nudges loosely orienting prompts", () => {
  for (const prompt of looselyOrientingCases) {
    assert.equal(classifyNavigatorPrompt(prompt), "likely_orientation", prompt);
  }
});

test("hasExactLocalPath: exact path prompts skip nudge", () => {
  for (const prompt of exactPathCases) {
    assert.equal(hasExactLocalPath(prompt), true, prompt);
    assert.equal(classifyNavigatorPrompt(prompt), "skip_nudge", prompt);
  }
});

test("isExternalOnlyPrompt: external-only prompts skip nudge", () => {
  for (const prompt of externalOnlyCases) {
    assert.equal(isExternalOnlyPrompt(prompt), true, prompt);
    assert.equal(classifyNavigatorPrompt(prompt), "skip_nudge", prompt);
  }
});

test("isExternalOnlyPrompt: code-impact prompts stay orienting", () => {
  for (const prompt of codeImpactCases) {
    assert.equal(isExternalOnlyPrompt(prompt), false, prompt);
    assert.equal(classifyNavigatorPrompt(prompt), "likely_orientation", prompt);
  }
});

test("isNavigatorPromptGuidanceReady: complete facts are ready", () => {
  assert.equal(isNavigatorPromptGuidanceReady(readyFacts), true);
});

test("isNavigatorPromptGuidanceReady: incomplete coverage is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      coverage: { total: 10, indexed: 9 },
    }),
    false,
  );
});

test("isNavigatorPromptGuidanceReady: empty coverage is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      coverage: { total: 0, indexed: 0 },
    }),
    false,
  );
});

test("isNavigatorPromptGuidanceReady: missing full crawl is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      fullCrawlDone: false,
    }),
    false,
  );
});

test("isNavigatorPromptGuidanceReady: stale indexed head is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      indexedHead: "def456",
    }),
    false,
  );
});

test("isNavigatorPromptGuidanceReady: dirty worktree is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      dirty: true,
    }),
    false,
  );
});

test("isNavigatorPromptGuidanceReady: missing navigator_locate is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      selectedTools: ["navigator_slice"],
    }),
    false,
  );
});

test("isNavigatorPromptGuidanceReady: repo unresolved is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      repoResolved: false,
    }),
    false,
  );
});

test("isNavigatorPromptGuidanceReady: currentHead null is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      currentHead: null,
    }),
    false,
  );
});

test("isNavigatorPromptGuidanceReady: worker failure is not ready", () => {
  assert.equal(
    isNavigatorPromptGuidanceReady({
      ...readyFacts,
      workerFailed: true,
    }),
    false,
  );
});

test("buildNavigatorPromptGuidance: ready broad prompt returns persona and nudge", () => {
  assert.deepEqual(
    buildNavigatorPromptGuidance({
      prompt: broadPromptCases[0],
      persona,
      readiness: readyFacts,
    }),
    [persona, NAVIGATOR_PROMPT_NUDGE],
  );
});

test("buildNavigatorPromptGuidance: ready exact-path prompt returns persona only", () => {
  assert.deepEqual(
    buildNavigatorPromptGuidance({
      prompt: exactPathCases[0],
      persona,
      readiness: readyFacts,
    }),
    [persona],
  );
});

test("buildNavigatorPromptGuidance: not-ready prompt returns empty array", () => {
  assert.deepEqual(
    buildNavigatorPromptGuidance({
      prompt: broadPromptCases[0],
      persona,
      readiness: {
        ...readyFacts,
        coverage: { total: 10, indexed: 5 },
      },
    }),
    [],
  );
});

test("buildNavigatorPromptGuidance: blank persona still returns nudge for ready broad prompt", () => {
  assert.deepEqual(
    buildNavigatorPromptGuidance({
      prompt: broadPromptCases[0],
      persona: "   ",
      readiness: readyFacts,
    }),
    [NAVIGATOR_PROMPT_NUDGE],
  );
});
