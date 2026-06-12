import test from "node:test";
import assert from "node:assert/strict";
import type { NavigatorPromptReadinessFacts } from "./prompt-guidance.ts";
import {
  NAVIGATOR_PROMPT_NUDGE,
  NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX,
  NAVIGATOR_BOOT_CAVEAT,
  NAVIGATOR_LAG_CAVEAT,
  buildNavigatorPromptGuidance,
  classifyNavigatorPrompt,
  hasExactLocalPath,
  isExternalOnlyPrompt,
  personaUsable,
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

test("buildNavigatorPromptGuidance: ready broad prompt returns persona and nudge", () => {
  assert.deepEqual(
    buildNavigatorPromptGuidance({
      prompt: broadPromptCases[0],
      persona,
      readiness: readyFacts,
      enablePersona: true,
      enableNudge: true,
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
      enablePersona: true,
      enableNudge: true,
    }),
    [persona],
  );
});

test("buildNavigatorPromptGuidance: partial index fires persona and weak directive", () => {
  // Persona fires (indexed > 0 = usable); partial coverage -> weak tier nudge.
  const result = buildNavigatorPromptGuidance({
    prompt: broadPromptCases[0],
    persona,
    readiness: {
      ...readyFacts,
      coverage: { total: 10, indexed: 5 },
    },
    enablePersona: true,
    enableNudge: true,
  });
  assert.equal(result[0], persona);
  assert.ok(result.some((l) => l.startsWith(NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX)));
  assert.ok(result.some((l) => l.includes("50%")));
});

test("buildNavigatorPromptGuidance: both disabled returns empty array", () => {
  assert.deepEqual(
    buildNavigatorPromptGuidance({
      prompt: broadPromptCases[0],
      persona,
      readiness: readyFacts,
      enablePersona: false,
      enableNudge: false,
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
      enablePersona: true,
      enableNudge: true,
    }),
    [NAVIGATOR_PROMPT_NUDGE],
  );
});

// Two-tier tests

const usableDirty: NavigatorPromptReadinessFacts = {
  repoResolved: true,
  selectedTools: ["navigator_locate"],
  coverage: { total: 100, indexed: 40 },
  fullCrawlDone: false,
  indexedHead: "abc",
  currentHead: "def",
  dirty: true,
  workerFailed: false,
};

test("personaUsable: fires when dirty/behind/partial as long as indexed > 0", () => {
  assert.equal(personaUsable(usableDirty), true);
});

test("personaUsable: false when nothing indexed", () => {
  assert.equal(personaUsable({ ...usableDirty, coverage: { total: 100, indexed: 0 } }), false);
});

test("personaUsable: false when worker failed / tool unselected", () => {
  assert.equal(personaUsable({ ...usableDirty, workerFailed: true }), false);
  assert.equal(personaUsable({ ...usableDirty, selectedTools: [] }), false);
  assert.equal(personaUsable({ ...usableDirty, selectedTools: undefined }), false);
  assert.equal(personaUsable({ ...usableDirty, repoResolved: false }), false);
});

test("persona fires and weak directive on a dirty/partial index", () => {
  // dirty + head mismatch + partial -> weak directive + lag caveat
  const g = buildNavigatorPromptGuidance({
    prompt: "where is the readiness presenter",
    persona: "PERSONA",
    readiness: usableDirty,
    enablePersona: true,
    enableNudge: true,
  });
  assert.equal(g[0], "PERSONA");
  assert.ok(g.some((l) => l.startsWith(NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX)));
  assert.ok(g.includes(NAVIGATOR_LAG_CAVEAT));
});

test("nudge appended only when fresh gate passes and prompt is orientation", () => {
  const fresh: NavigatorPromptReadinessFacts = {
    ...usableDirty,
    coverage: { total: 100, indexed: 100 },
    fullCrawlDone: true,
    currentHead: "abc",
    dirty: false,
  };
  const g = buildNavigatorPromptGuidance({
    prompt: "where is the readiness presenter",
    persona: "PERSONA",
    readiness: fresh,
    enablePersona: true,
    enableNudge: true,
  });
  assert.deepEqual(g, ["PERSONA", NAVIGATOR_PROMPT_NUDGE]);
});

test("config flags gate each tier independently", () => {
  const fresh: NavigatorPromptReadinessFacts = {
    ...usableDirty,
    coverage: { total: 100, indexed: 100 },
    fullCrawlDone: true,
    currentHead: "abc",
    dirty: false,
  };
  assert.deepEqual(
    buildNavigatorPromptGuidance({ prompt: "where is x", persona: "P", readiness: fresh, enablePersona: false, enableNudge: true }),
    [NAVIGATOR_PROMPT_NUDGE],
  );
  assert.deepEqual(
    buildNavigatorPromptGuidance({ prompt: "where is x", persona: "P", readiness: fresh, enablePersona: true, enableNudge: false }),
    ["P"],
  );
});

// Availability-gated guidance with strong/weak tiers and caveats

const baseFacts = {
  repoResolved: true,
  selectedTools: ["navigator_locate", "read"] as const,
  coverage: { total: 100, indexed: 100 },
  fullCrawlDone: true,
  indexedHead: "abc",
  currentHead: "abc",
  dirty: false,
  workerFailed: false,
};
const args = (over: Partial<typeof baseFacts>, prompt = "where is the rolling indexer") => ({
  prompt, persona: "PERSONA", enablePersona: true, enableNudge: true,
  readiness: { ...baseFacts, ...over },
});

test("strong tier: full coverage + crawl done -> strong directive, no caveats", () => {
  const g = buildNavigatorPromptGuidance(args({}));
  assert.ok(g.includes("PERSONA"));
  assert.ok(g.includes(NAVIGATOR_PROMPT_NUDGE));
  assert.ok(!g.some((l) => l.startsWith(NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX)));
  assert.ok(!g.includes(NAVIGATOR_LAG_CAVEAT));
});

test("weak tier: below 0.9 coverage -> weak directive with percentage, no strong directive", () => {
  const g = buildNavigatorPromptGuidance(args({ coverage: { total: 100, indexed: 50 }, fullCrawlDone: false }));
  assert.ok(g.some((l) => l.startsWith(NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX)));
  assert.ok(g.some((l) => l.includes("50%")));
  assert.ok(!g.includes(NAVIGATOR_PROMPT_NUDGE));
});

test("boot state: indexed=0 -> weak directive + boot caveat, persona suppressed", () => {
  const g = buildNavigatorPromptGuidance(args({ coverage: { total: 100, indexed: 0 }, fullCrawlDone: false }));
  assert.ok(!g.includes("PERSONA"));
  assert.ok(g.some((l) => l.startsWith(NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX)));
  assert.ok(g.includes(NAVIGATOR_BOOT_CAVEAT));
});

test("dirty / HEAD drift while usable -> strong directive + lag caveat", () => {
  const g = buildNavigatorPromptGuidance(args({ dirty: true }));
  assert.ok(g.includes(NAVIGATOR_PROMPT_NUDGE));
  assert.ok(g.includes(NAVIGATOR_LAG_CAVEAT));
  const g2 = buildNavigatorPromptGuidance(args({ indexedHead: "abc", currentHead: "def" }));
  assert.ok(g2.includes(NAVIGATOR_LAG_CAVEAT));
});

test("tool not selected -> no guidance at all", () => {
  const g = buildNavigatorPromptGuidance(args({ selectedTools: ["read", "grep"] as unknown as readonly ["navigator_locate", "read"] }));
  assert.deepEqual(g, []);
});

test("exact-path prompt -> persona kept, directive + caveats suppressed", () => {
  const g = buildNavigatorPromptGuidance(args({ dirty: true }, "open src/worktree.ts and fix it"));
  assert.ok(g.includes("PERSONA"));
  assert.ok(!g.includes(NAVIGATOR_PROMPT_NUDGE));
  assert.ok(!g.some((l) => l.startsWith(NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX)));
  assert.ok(!g.includes(NAVIGATOR_LAG_CAVEAT));
});

test("external-only prompt -> persona only, no directive", () => {
  const g = buildNavigatorPromptGuidance(args({}, "show git status"));
  assert.ok(g.includes("PERSONA"));
  assert.ok(!g.includes(NAVIGATOR_PROMPT_NUDGE));
  assert.ok(!g.some((l) => l.startsWith(NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX)));
});

test("enablePersona=false drops persona but keeps directive", () => {
  const g = buildNavigatorPromptGuidance({ ...args({}), enablePersona: false });
  assert.ok(!g.includes("PERSONA"));
  assert.ok(g.includes(NAVIGATOR_PROMPT_NUDGE));
});
