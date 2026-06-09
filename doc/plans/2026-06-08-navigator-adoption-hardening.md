# Navigator Adoption Hardening Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans (or subagent-driven-development) skill to implement this plan task-by-task.

**Goal:** Raise organic `navigator_locate` adoption in real working repos, suppress redundant re-search after high-confidence hits, and block slow shell-grep repo scans — without removing the rg/fd/read fallback.

**Architecture:** Four independent mechanisms. (M1) Split prompt guidance into an always-on persona tier (usable-index gate) and a freshness-gated nudge tier. (M2) A pure strong-hit predicate drives a directive line in locate output plus a `promptGuidelines` reinforcement. (M3) A pure `decideGrepAction` classifier, wired into a `pi.on("tool_call")` bash hook, blocks recursive/directory shell grep and degrades to warn-only when `rg` is absent. (M4) Four `navigator.*` booleans (default true) gate each mechanism.

**Tech Stack:** TypeScript (Node 24 native type-stripping; `.ts` import extensions mandatory), `node:test`, typebox, pi extension API (`pi.on("tool_call")`, `isToolCallEventType`).

**Spec:** `doc/specs/2026-06-08-navigator-adoption-hardening.md`

**Linear:** none

---

## Files

**Create:**
- `src/grep-guard.ts` (pure `classifyGrepCommand` + `decideGrepAction`)
- `src/grep-guard.test.ts`
- `src/navigator/strong-hit.ts` (pure `isStrongHit` + `STRONG_HIT_DIRECTIVE`)
- `src/navigator/strong-hit.test.ts`

**Modify:**
- `src/types.ts` (add 4 fields to `NavigatorConfig`)
- `src/config.ts` (add 4 defaults + 4 merge branches)
- `src/config.test.ts` (new-key cases)
- `src/prompt-guidance.ts` (`personaUsable` + two-tier `buildNavigatorPromptGuidance` with two new boolean args)
- `src/prompt-guidance.test.ts` (persona/nudge tier cases)
- `prompts/navigator-persona.md` (non-asserting rewrite)
- `src/tools.ts` (strong-hit directive in locate renderer + `promptGuidelines` line; gate on `config.strongHitDirective`)
- `src/tools.test.ts` (directive render cases)
- `index.ts` (`tool_call` grep hook + rg-availability module state; thread persona/nudge booleans into `before_agent_start`)
- `README.md` (Prerequisites section)

**Delete:** none

---

## Wave 1 — Foundations

Parallel-safe: Tasks 1–5 own pairwise-disjoint files (see each task's Files block). No task in this wave depends on another.

### Task 1: Config fields for the four mechanisms

**TDD scenario:** Modifying tested code — `src/config.test.ts` exists; run it first, then extend.

**Files:**
- Modify: `src/types.ts` (`NavigatorConfig` interface)
- Modify: `src/config.ts` (`DEFAULT_CONFIG`, `mergeConfig`)
- Test: `src/config.test.ts`

- [ ] **Step 1: Run existing config tests, confirm green baseline**

  Run: `node --test src/config.test.ts`
  Expected: PASS (baseline before changes)

- [ ] **Step 2: Write failing tests for the new keys**

  Add to `src/config.test.ts`:

  ```ts
  test("new adoption keys default to true", () => {
    const c = mergeConfig({});
    assert.equal(c.persona, true);
    assert.equal(c.promptNudge, true);
    assert.equal(c.strongHitDirective, true);
    assert.equal(c.grepBlock, true);
  });

  test("new adoption keys honor explicit false", () => {
    const c = mergeConfig({ persona: false, promptNudge: false, strongHitDirective: false, grepBlock: false });
    assert.equal(c.persona, false);
    assert.equal(c.promptNudge, false);
    assert.equal(c.strongHitDirective, false);
    assert.equal(c.grepBlock, false);
  });

  test("non-boolean adoption keys fall back to default true", () => {
    const c = mergeConfig({ persona: "yes" as unknown as boolean, grepBlock: 1 as unknown as boolean });
    assert.equal(c.persona, true);
    assert.equal(c.grepBlock, true);
  });

  test("unknown keys are still dropped", () => {
    const c = mergeConfig({ injectPersona: true } as Record<string, unknown>);
    assert.equal("injectPersona" in c, false);
  });
  ```

- [ ] **Step 3: Run tests, confirm failure**

  Run: `node --test src/config.test.ts`
  Expected: FAIL (`c.persona` is `undefined`)

- [ ] **Step 4: Add the four fields to `NavigatorConfig`**

  In `src/types.ts`, inside `interface NavigatorConfig`, after `telemetryRetentionDays: number;`:

  ```ts
  persona: boolean;             // M1 always-on persona tier; default true
  promptNudge: boolean;         // M1 freshness-gated nudge tier; default true
  strongHitDirective: boolean;  // M2 locate strong-hit directive; default true
  grepBlock: boolean;           // M3 shell-grep block (bash only); default true
  ```

- [ ] **Step 5: Add defaults and merge branches in `src/config.ts`**

  In `DEFAULT_CONFIG`, after `telemetryRetentionDays: 30,`:

  ```ts
  persona: true,
  promptNudge: true,
  strongHitDirective: true,
  grepBlock: true,
  ```

  In `mergeConfig`, after the `telemetryRetentionDays:` branch (mirror the existing boolean pattern):

  ```ts
  persona:
    typeof partial.persona === "boolean" ? partial.persona : DEFAULT_CONFIG.persona,
  promptNudge:
    typeof partial.promptNudge === "boolean" ? partial.promptNudge : DEFAULT_CONFIG.promptNudge,
  strongHitDirective:
    typeof partial.strongHitDirective === "boolean" ? partial.strongHitDirective : DEFAULT_CONFIG.strongHitDirective,
  grepBlock:
    typeof partial.grepBlock === "boolean" ? partial.grepBlock : DEFAULT_CONFIG.grepBlock,
  ```

- [ ] **Step 6: Run tests + typecheck, confirm pass**

  Run: `node --test src/config.test.ts && npm run typecheck`
  Expected: PASS

- [ ] **Step 7: Commit**

  ```bash
  git add src/types.ts src/config.ts src/config.test.ts
  git commit -m "config: add persona/promptNudge/strongHitDirective/grepBlock keys (default true)"
  ```

### Task 2: grep-guard pure classifier

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/grep-guard.ts`
- Test: `src/grep-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

  Create `src/grep-guard.test.ts`:

  ```ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { decideGrepAction } from "./grep-guard.ts";

  // probeDir: treat a path as a directory if it ends in "/" or is "." / ".."
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
  ```

- [ ] **Step 2: Run tests, confirm failure**

  Run: `node --test src/grep-guard.test.ts`
  Expected: FAIL (`decideGrepAction` not found)

- [ ] **Step 3: Implement `src/grep-guard.ts`**

  ```ts
  export type GrepPatternKind = "symbol" | "regex";

  export interface GrepClassification {
    isRepoScan: boolean;
    patternKind: GrepPatternKind | null;
  }

  const GREP_HEAD_RE = /^(?:e|f)?grep$/;
  const RECURSIVE_RE = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
  const SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function stripQuotes(token: string): string {
    if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) {
      return token.slice(1, -1);
    }
    return token;
  }

  // Classify the LAST pipeline segment's leading command. A grep downstream of a
  // pipe reads stdin and is never a repo scan, so only the segment that *starts*
  // with grep (segment index 0 of the whole command) can qualify.
  export function classifyGrepCommand(command: string, probeDir: (p: string) => boolean): GrepClassification {
    const noScan: GrepClassification = { isRepoScan: false, patternKind: null };
    const firstSegment = command.split("|")[0]!.trim();
    const tokens = firstSegment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return noScan;
    // git grep is fast/tracked-aware — not in scope.
    if (tokens[0] === "git") return noScan;
    if (!GREP_HEAD_RE.test(tokens[0]!)) return noScan;

    const rest = tokens.slice(1);
    if (rest.some((t) => t === "--help" || t === "--version" || t === "-V")) return noScan;

    let recursive = false;
    let pattern: string | null = null;
    const paths: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i]!;
      if (tok === "-e" || tok === "--regexp") {
        const next = rest[++i];
        if (next !== undefined && pattern === null) pattern = stripQuotes(next);
        continue;
      }
      if (tok.startsWith("-")) {
        if (RECURSIVE_RE.test(tok)) recursive = true;
        continue;
      }
      if (pattern === null) { pattern = stripQuotes(tok); continue; }
      paths.push(stripQuotes(tok));
    }

    const scansDir = recursive || paths.some((p) => probeDir(p));
    if (!scansDir) return noScan;

    const patternKind: GrepPatternKind = pattern !== null && SYMBOL_RE.test(pattern) ? "symbol" : "regex";
    return { isRepoScan: true, patternKind };
  }

  export interface GrepActionInput {
    command: string;
    probeDir: (p: string) => boolean;
    rgAvailable: boolean;
    navigatorActive: boolean;
  }

  export interface GrepAction {
    action: "allow" | "block";
    reason?: string;
    warn?: boolean;
  }

  export function decideGrepAction(input: GrepActionInput): GrepAction {
    const { isRepoScan, patternKind } = classifyGrepCommand(input.command, input.probeDir);
    if (!isRepoScan) return { action: "allow" };
    if (!input.navigatorActive) return { action: "allow" };
    if (!input.rgAvailable) return { action: "allow", warn: true };

    const reason =
      patternKind === "symbol"
        ? "Slow repo-scanning grep is blocked. This looks like a symbol search — call `navigator_locate` for ranked entry points, or use `rg` for a raw scan."
        : "Slow repo-scanning grep is blocked. Use `rg` (ripgrep) — it is faster and gitignore-aware.";
    return { action: "block", reason };
  }
  ```

- [ ] **Step 4: Run tests + typecheck, confirm pass**

  Run: `node --test src/grep-guard.test.ts && npm run typecheck`
  Expected: PASS (all 11 cases)

- [ ] **Step 5: Commit**

  ```bash
  git add src/grep-guard.ts src/grep-guard.test.ts
  git commit -m "feat: grep-guard pure classifier for shell-grep repo scans"
  ```

### Task 3: strong-hit pure predicate

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/navigator/strong-hit.ts`
- Test: `src/navigator/strong-hit.test.ts`

- [ ] **Step 1: Write the failing tests**

  Create `src/navigator/strong-hit.test.ts`:

  ```ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { isStrongHit, STRONG_HIT_DIRECTIVE } from "./strong-hit.ts";
  import type { LocateResponse } from "../types.ts";

  function resp(over: Partial<LocateResponse>): LocateResponse {
    return {
      results: [{ path: "a.ts", lang: "ts", score: 1, signals: { fts: 1, path: 0, symbol: 1, recency: 0 }, symbols: [] }],
      cluster: null,
      index: { fresh: true, head_behind: 0, coverage: 1, dirty: false },
      confidence: "high",
      has_exact_def: true,
      used_or_fallback: false,
      top_has_anchor: true,
      ...over,
    };
  }

  test("strong hit requires exact def AND anchor", () => {
    assert.equal(isStrongHit(resp({})), true);
  });

  test("no anchor is not a strong hit", () => {
    assert.equal(isStrongHit(resp({ top_has_anchor: false })), false);
  });

  test("no exact def is not a strong hit", () => {
    assert.equal(isStrongHit(resp({ has_exact_def: false })), false);
  });

  test("empty results is not a strong hit", () => {
    assert.equal(isStrongHit(resp({ results: [], has_exact_def: false })), false);
  });

  test("strong hit and low-confidence are mutually exclusive", () => {
    // has_exact_def ⇒ confidence === "high" by locate.ts derivation; a strong hit
    // can never also be low-confidence.
    const r = resp({});
    assert.equal(isStrongHit(r) && r.confidence === "low", false);
  });

  test("directive mentions slicing rank 1 and not re-searching", () => {
    assert.match(STRONG_HIT_DIRECTIVE, /slice rank 1/i);
    assert.match(STRONG_HIT_DIRECTIVE, /redundant/i);
  });
  ```

- [ ] **Step 2: Run tests, confirm failure**

  Run: `node --test src/navigator/strong-hit.test.ts`
  Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/navigator/strong-hit.ts`**

  ```ts
  import type { LocateResponse } from "../types.ts";

  export const STRONG_HIT_DIRECTIVE =
    "  [high-confidence exact match — slice rank 1 directly; re-running rg/grep/read to re-find this is redundant]";

  // has_exact_def ⇒ confidence === "high" by locate.ts derivation, so the
  // confidence flag is not re-checked here; top_has_anchor is the non-redundant
  // discriminator that separates a definitive rank-1 from a plausible-but-soft hit.
  export function isStrongHit(res: LocateResponse): boolean {
    return res.results.length > 0 && res.has_exact_def && res.top_has_anchor;
  }
  ```

- [ ] **Step 4: Run tests + typecheck, confirm pass**

  Run: `node --test src/navigator/strong-hit.test.ts && npm run typecheck`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add src/navigator/strong-hit.ts src/navigator/strong-hit.test.ts
  git commit -m "feat: strong-hit predicate + directive constant for locate results"
  ```

### Task 4: Two-tier prompt guidance + persona rewrite

**TDD scenario:** Modifying tested code — `src/prompt-guidance.test.ts` exists; run it first.

**Files:**
- Modify: `src/prompt-guidance.ts` (`personaUsable`, two-arg `buildNavigatorPromptGuidance`)
- Modify: `prompts/navigator-persona.md`
- Test: `src/prompt-guidance.test.ts`

- [ ] **Step 1: Run existing guidance tests, confirm green baseline**

  Run: `node --test src/prompt-guidance.test.ts`
  Expected: PASS

- [ ] **Step 2: Write failing tests for the two tiers**

  The signature of `buildNavigatorPromptGuidance` gains two booleans (`enablePersona`, `enableNudge`) — supplied by the caller (index.ts reads `config.persona`/`config.promptNudge`). Prompt-guidance stays free of the new config fields. Add to `src/prompt-guidance.test.ts`:

  ```ts
  const usableDirty: NavigatorPromptReadinessFacts = {
    repoResolved: true,
    selectedTools: ["navigator_locate"],
    coverage: { total: 100, indexed: 40 },
    fullCrawlDone: false,
    indexedHead: "abc",
    currentHead: "def",   // behind HEAD
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
  });

  test("persona fires but nudge suppressed on a dirty/partial index", () => {
    const g = buildNavigatorPromptGuidance({
      prompt: "where is the readiness presenter",
      persona: "PERSONA",
      readiness: usableDirty,
      enablePersona: true,
      enableNudge: true,
    });
    assert.deepEqual(g, ["PERSONA"]);  // nudge gated out by isNavigatorPromptGuidanceReady
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
    assert.equal(g.includes(NAVIGATOR_PROMPT_NUDGE), true);
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
  ```

  Add `personaUsable` to the existing import from `./prompt-guidance.ts` in the test file.

- [ ] **Step 3: Run tests, confirm failure**

  Run: `node --test src/prompt-guidance.test.ts`
  Expected: FAIL (`personaUsable` not exported; `enablePersona` not in args type)

- [ ] **Step 4: Implement the two-tier split in `src/prompt-guidance.ts`**

  Extend the args interface:

  ```ts
  export interface BuildNavigatorPromptGuidanceArgs {
    prompt: string;
    persona: string;
    readiness: NavigatorPromptReadinessFacts;
    enablePersona: boolean;
    enableNudge: boolean;
  }
  ```

  Add the persona-tier gate (note: NOT gated on dirty / head match / fullCrawlDone):

  ```ts
  export function personaUsable(facts: NavigatorPromptReadinessFacts): boolean {
    return (
      facts.repoResolved &&
      facts.selectedTools?.includes("navigator_locate") === true &&
      facts.coverage.indexed > 0 &&
      !facts.workerFailed
    );
  }
  ```

  Replace the body of `buildNavigatorPromptGuidance`:

  ```ts
  export function buildNavigatorPromptGuidance(args: BuildNavigatorPromptGuidanceArgs): string[] {
    const guidance: string[] = [];
    const persona = args.persona.trim();

    if (args.enablePersona && persona && personaUsable(args.readiness)) {
      guidance.push(persona);
    }

    if (
      args.enableNudge &&
      isNavigatorPromptGuidanceReady(args.readiness) &&
      classifyNavigatorPrompt(args.prompt) === "likely_orientation"
    ) {
      guidance.push(NAVIGATOR_PROMPT_NUDGE);
    }

    return guidance;
  }
  ```

- [ ] **Step 5: Rewrite `prompts/navigator-persona.md` to non-asserting wording**

  Replace the file's entire contents with:

  ```
  Repo orientation: a navigator index (`navigator_locate` / `navigator_slice`) is available. Prefer it for first orientation — where code or docs live, what changes together, who references a file — before broad `rg`/`find`/`read`. Slices read live working-tree bytes; the ranking index may lag recent edits, so verify with `rg`/`fd`/`read` when a result looks stale.
  ```

- [ ] **Step 6: Run tests + typecheck, confirm pass**

  Run: `node --test src/prompt-guidance.test.ts && npm run typecheck`
  Expected: PASS

- [ ] **Step 7: Commit**

  ```bash
  git add src/prompt-guidance.ts src/prompt-guidance.test.ts prompts/navigator-persona.md
  git commit -m "feat: two-tier prompt guidance (always-on persona, fresh-gated nudge)"
  ```

### Task 5: README prerequisites

**TDD scenario:** Trivial change — doc only, no test.

**Files:**
- Modify: `README.md` (insert Prerequisites section before `## Install`)

- [ ] **Step 1: Insert the Prerequisites section**

  Immediately before the `## Install` heading (currently line 31), add:

  ```markdown
  ## Prerequisites

  - **`rg` (ripgrep) on `PATH`** — required. Navigator treats ripgrep as the sanctioned raw-search tool: the grep block (see Configuration → `grepBlock`) redirects slow repo-scanning shell `grep` to `rg`. If `rg` is absent the block degrades to a one-time warning and never fires, but recall-fallback guidance still assumes `rg` is present. Install: `brew install ripgrep` / `apt-get install -y ripgrep` / `cargo install ripgrep`.

  ```

- [ ] **Step 2: Verify the section renders and Install still follows**

  Run: `rg -n "^## (Prerequisites|Install)" README.md`
  Expected: `## Prerequisites` immediately precedes `## Install`

- [ ] **Step 3: Commit**

  ```bash
  git add README.md
  git commit -m "docs: add rg (ripgrep) prerequisite to README"
  ```

---

## Wave 2 — Wire-up

Depends on Wave 1: Task 6 consumes `isStrongHit`/`STRONG_HIT_DIRECTIVE` (Task 3) and `config.strongHitDirective` (Task 1). Task 7 consumes `decideGrepAction` (Task 2), the new `enablePersona`/`enableNudge` args (Task 4), and `config.grepBlock`/`config.persona`/`config.promptNudge` (Task 1).

Parallel-safe within Wave 2: Task 6 owns `src/tools.ts` + `src/tools.test.ts`; Task 7 owns `index.ts`. Disjoint.

### Task 6: Locate renderer directive + promptGuidelines reinforcement

**TDD scenario:** Modifying tested code — `src/tools.test.ts` exists; run it first.

**Files:**
- Modify: `src/tools.ts` (import strong-hit; append directive gated on `config.strongHitDirective`; add `promptGuidelines` line)
- Test: `src/tools.test.ts`

- [ ] **Step 1: Run existing tools tests, confirm green baseline**

  Run: `node --test src/tools.test.ts`
  Expected: PASS

- [ ] **Step 2: Inspect how `src/tools.test.ts` drives `navigator_locate`**

  Read `src/tools.test.ts` to confirm the existing harness (how it registers the tool and captures `execute` output). Reuse that harness shape for the new cases — do not invent a second registration path.

- [ ] **Step 3: Write failing tests for the directive**

  Add cases that register the tool with a stub `getCtx` returning a `NavigatorCtx` whose `db`/`root` yield a controllable `locate` result. If the existing test already stubs `locate` output, assert on the rendered text:
  - strong hit (`has_exact_def && top_has_anchor`) AND `config.strongHitDirective !== false` → output contains `STRONG_HIT_DIRECTIVE`.
  - strong hit but `config.strongHitDirective === false` → output does NOT contain it.
  - low-confidence result → output contains the existing low-confidence line and NOT `STRONG_HIT_DIRECTIVE` (mutual exclusivity).

  ```ts
  import { STRONG_HIT_DIRECTIVE } from "./navigator/strong-hit.ts";
  // ... assert.match(text, new RegExp(escapeRegExp(STRONG_HIT_DIRECTIVE))) etc.
  ```

  If the current harness cannot stub `locate` cleanly, extract the rendering of the results array into a small exported pure function `renderLocateText(res: LocateResponse, query: string, strongHitDirectiveEnabled: boolean): string` in `src/tools.ts` and unit-test that directly. Prefer this extraction — it makes the renderer testable without a DB.

- [ ] **Step 4: Run tests, confirm failure**

  Run: `node --test src/tools.test.ts`
  Expected: FAIL

- [ ] **Step 5: Implement the renderer change in `src/tools.ts`**

  Add import at top:

  ```ts
  import { isStrongHit, STRONG_HIT_DIRECTIVE } from "./navigator/strong-hit.ts";
  ```

  In the `navigator_locate` `execute`, after the low-confidence block and before the `return`, append the strong-hit directive (mutually exclusive with low by construction):

  ```ts
  if (config.strongHitDirective !== false && isStrongHit(res)) {
    lines.push(STRONG_HIT_DIRECTIVE);
  }
  ```

  (`config` here is the per-call merged object already built in `execute`; it inherits `strongHitDirective` from `navCtx.config`.)

  Add a fifth bullet to the `navigator_locate` `promptGuidelines` array:

  ```ts
  "When navigator_locate returns a high-confidence exact match (has_exact_def + top_has_anchor), use navigator_slice on the rank-1 result directly — re-running rg/grep/read to re-find the same symbol is redundant.",
  ```

- [ ] **Step 6: Run tests + typecheck, confirm pass**

  Run: `node --test src/tools.test.ts && npm run typecheck`
  Expected: PASS

- [ ] **Step 7: Commit**

  ```bash
  git add src/tools.ts src/tools.test.ts
  git commit -m "feat: strong-hit directive in locate output + promptGuidelines reinforcement"
  ```

### Task 7: index.ts wiring — grep hook + rg availability + guidance flags

**TDD scenario:** Modifying tested code — index.ts is the extension entry (no unit test; logic is covered by grep-guard.test.ts and prompt-guidance.test.ts). Verify by typecheck + full suite + manual load.

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Add module-scope rg-availability state inside the default export**

  Near the other per-session `let` declarations in the exported function (after `const pendingArgs = ...`):

  ```ts
  let rgAvailable: boolean | undefined;
  let rgWarnedOnce = false;
  ```

- [ ] **Step 2: Add imports at top of `index.ts`**

  ```ts
  import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
  import { existsSync, statSync } from "node:fs";
  import { execFileSync } from "node:child_process";
  import { decideGrepAction } from "./src/grep-guard.ts";
  ```

  (Keep the existing `readFileSync` import; merge the `node:fs` import line.)

- [ ] **Step 3: Register the `tool_call` grep hook**

  Add after the `registerTools(...)` / `registerNavigatorCommand(...)` block (load-time, late-bound state via the closure):

  ```ts
  pi.on("tool_call", async (event, ctx) => {
    if (!config.grepBlock) return;
    if (!isToolCallEventType("bash", event)) return;
    // Activation guard: never push locate-first where the index is untrustworthy/absent.
    const navigatorActive = repoStatus === "ready" && state !== null;

    if (rgAvailable === undefined) {
      try {
        execFileSync("rg", ["--version"], { stdio: "ignore" });
        rgAvailable = true;
      } catch {
        rgAvailable = false;
      }
    }

    const probeDir = (p: string): boolean => {
      try { return statSync(p).isDirectory(); }
      catch { return p === "." || p === ".." || p.endsWith("/"); }
    };

    const decision = decideGrepAction({
      command: event.input.command,
      probeDir,
      rgAvailable,
      navigatorActive,
    });

    if (decision.warn && !rgWarnedOnce) {
      rgWarnedOnce = true;
      ctx.ui.notify("rg not found — navigator grep block degraded to warn-only; install ripgrep for faster search", "warn");
    }
    if (decision.action === "block") {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });
  ```

  Note: `existsSync` is imported for parity with `statSync` use; if `probeDir` only needs `statSync`, drop `existsSync` from the import to avoid an unused-symbol typecheck error. Confirm against `npm run typecheck`.

- [ ] **Step 4: Thread the new guidance flags into `before_agent_start`**

  In the existing `pi.on("before_agent_start", ...)` handler, the `buildNavigatorPromptGuidance({...})` call gains two args:

  ```ts
  const guidance = buildNavigatorPromptGuidance({
    prompt: event.prompt ?? "",
    persona,
    readiness: { /* unchanged */ },
    enablePersona: config.persona,
    enableNudge: config.promptNudge,
  });
  ```

  Also relax the early return so the persona tier can fire on a usable-but-not-fully-ready index. The handler currently bails on `repoStatus !== "ready"`; keep that (the persona still needs a ready DB handle to read coverage), but the internal readiness facts already allow dirty/partial — no change needed there beyond passing the flags. Confirm the handler still returns `undefined` when `guidance.length === 0`.

- [ ] **Step 5: Typecheck + full suite**

  Run: `npm run typecheck && node --test`
  Expected: PASS (no unused-import errors; all tests green)

- [ ] **Step 6: Manual smoke test**

  ```bash
  pi -e ~/repos/pi-navigator/.worktrees/navigator-adoption/index.ts
  ```
  In the session: `/navigator status` shows ready; in a dirty repo confirm the persona line appears in guidance; run `grep -r foo src/` via bash and confirm it is blocked with the redirect reason; run `ps aux | grep node` and confirm it is allowed.

- [ ] **Step 7: Commit**

  ```bash
  git add index.ts
  git commit -m "feat: wire grep-block tool_call hook + thread two-tier guidance flags"
  ```

---

## Open Questions

None. All decisions resolved during brainstorming, spec council, and the writing-plans ground-truth pass (built-in `grep` tool is rg-backed → M3 scoped to shell grep only).

---

## Self-Review

- **Spec coverage:** M1 → Tasks 4 (+7 wiring); M2 → Tasks 3 (+6 wiring); M3 → Tasks 2 (+7 wiring); M4 → Task 1 (+5 README). Every spec §3 mechanism and §5 test maps to a task. ✓
- **Placeholder scan:** no `TODO`/`TBD`/`xxx`/`[fill in]`/`<example>` in the plan. ✓
- **Type/API consistency:** `decideGrepAction(GrepActionInput) → GrepAction`, `isStrongHit(LocateResponse) → boolean`, `personaUsable(NavigatorPromptReadinessFacts) → boolean`, and the two new `buildNavigatorPromptGuidance` args (`enablePersona`, `enableNudge`) are used identically in their defining task and their Wave 2 consumer. ✓
- **Wave disjointness:** Wave 1 file sets — {types.ts, config.ts, config.test.ts}, {grep-guard.ts, .test}, {strong-hit.ts, .test}, {prompt-guidance.ts, .test, persona.md}, {README.md} — pairwise disjoint. Wave 2 — {tools.ts, tools.test.ts} vs {index.ts} — disjoint. ✓
