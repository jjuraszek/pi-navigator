# Navigator Prompt Guidance Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans or subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make navigator prompt guidance automatic, readiness-gated, and strong enough to nudge broad repo-orientation prompts toward an early `navigator_locate` call.

**Architecture:** Add a pure prompt-guidance helper for classification/readiness/assembly. Then update the extension hook and config in one code-integration task so removing `injectPersona` cannot leave the repo in a typecheck-broken intermediate state. Update docs separately.

**Tech Stack:** Node 24 native TypeScript, `node:test`, `node:sqlite`, pi extension lifecycle hooks.

**Spec:** `doc/specs/2026-06-07-navigator-prompt-guidance.md`

---

## Files

**Create:**
- `src/prompt-guidance.ts` — pure helper for classifier, readiness predicate, and guidance line assembly.
- `src/prompt-guidance.test.ts` — unit tests for classifier, readiness, and prompt assembly.

**Modify:**
- `index.ts` — replace optional `injectPersona` hook logic with readiness-gated automatic prompt guidance.
- `index.test.ts` — integration-style hook tests with mocked/temporary ready repos.
- `src/types.ts` — remove `NavigatorConfig.injectPersona`.
- `src/config.ts` — remove `injectPersona` from defaults and active config behavior; filter unknown config keys.
- `src/config.test.ts` — assert stale `injectPersona` settings are accepted and ignored.
- `src/worktree.ts` — add a small helper for clean/dirty worktree checks if no suitable helper already exists.
- `src/worktree.test.ts` — update the dirty-worktree contract test when the helper becomes conservative on non-git/errors.
- `prompts/navigator-persona.md` — rewrite to the compact repo-orientation rule.
- `README.md` — update install matrix and configuration docs to describe automatic prompt guidance.
- `NAVIGATOR.md` — update technical reference with readiness-gated prompt guidance details.
- `CHANGELOG.md` — add an unreleased note for automatic readiness-gated prompt guidance.

**Delete:**
- No files.

## Wave 1 — Helper foundation

Parallel-safe: no parallel work in this wave. Complete and review Task 1 before any config or hook edits.

### Task 1: Add prompt-guidance helper

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/prompt-guidance.ts`
- Create: `src/prompt-guidance.test.ts`

- [ ] **Step 1: Write classifier tests**

  Create `src/prompt-guidance.test.ts` with imports for:

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import {
    NAVIGATOR_PROMPT_NUDGE,
    buildNavigatorPromptGuidance,
    classifyNavigatorPrompt,
    hasExactLocalPath,
    isExternalOnlyPrompt,
    isNavigatorPromptGuidanceReady,
  } from "./prompt-guidance.ts";
  ```

  Add broad repo-orientation cases that must classify as `likely_orientation`:

  ```ts
  [
    "investigate why navigator is rarely used in gridstrong",
    "review Linear E-1935",
    "what needs changing to support X?",
    "where is fleet readiness implemented?",
    "fix the heatmap behavior",
    "add support for X",
    "look into this behavior",
    "is this actionable?",
    "explain how X works",
    "find where X is handled",
  ]
  ```

  Add exact-path cases that must classify as `skip_nudge` and return `true` from `hasExactLocalPath`:

  ```ts
  [
    "read src/foo.ts",
    "edit doc/specs/2026-06-03-usefulness-telemetry.md",
    "why does test src/foo.test.ts fail?",
    "open ./src/foo.ts:42",
    "inspect ../gridstrong/app/models/user.rb:10:2",
    "summarize README.md",
    "check package.json",
    "summarize `README.md`",
    "read 'AGENTS.md'",
  ]
  ```

  Add external-only cases that must classify as `skip_nudge` and return `true` from `isExternalOnlyPrompt`:

  ```ts
  [
    "summarize https://example.com/post",
    "fetch this URL: https://example.com/post",
    "check GitHub PR comments",
    "check GitHub PR comments without asking for code impact",
    "what branch am I on?",
    "show git status",
    "report git branch information only",
    "send a Slack message to Alice",
    "query sentry for recent errors",
    "inspect the database schema",
  ]
  ```

  Add code-impact external/Git examples that must classify as `likely_orientation` and return `false` from `isExternalOnlyPrompt`:

  ```ts
  [
    "check https://example.com and see what code needs to change",
    "show git status and tell me what code needs to change",
    "review Linear E-1935 and identify implementation changes",
    "look at this PR and see what code needs to change",
    "review GitHub issue 123 and fix the behavior",
  ]
  ```

- [ ] **Step 2: Run classifier tests and confirm failure**

  Run:

  ```bash
  node --test src/prompt-guidance.test.ts
  ```

  Expected: FAIL with an import error for `./prompt-guidance.ts`.

- [ ] **Step 3: Write readiness and prompt-assembly tests**

  Add readiness facts:

  ```ts
  const readyFacts = {
    repoResolved: true,
    selectedTools: ["navigator_locate", "navigator_slice"],
    coverage: { total: 10, indexed: 10 },
    fullCrawlDone: true,
    indexedHead: "abc123",
    currentHead: "abc123",
    dirty: false,
    workerFailed: false,
  };
  ```

  Test readiness:

  - all readiness facts true returns `true`
  - incomplete coverage returns `false`
  - `coverage.total === 0` returns `false`
  - missing/false `fullCrawlDone` returns `false`
  - stale indexed HEAD returns `false`
  - dirty worktree returns `false`
  - missing `navigator_locate` returns `false`
  - `repoResolved: false` returns `false`
  - `currentHead: null` returns `false`
  - `workerFailed: true` returns `false`

  Test prompt assembly:

  - ready broad prompt returns `[persona, NAVIGATOR_PROMPT_NUDGE]`
  - ready exact-path prompt returns `[persona]`
  - not-ready prompt returns `[]`
  - blank persona returns only the nudge for a ready broad prompt if the classifier nudges

- [ ] **Step 4: Run tests and confirm failures**

  Run:

  ```bash
  node --test src/prompt-guidance.test.ts
  ```

  Expected: FAIL with missing exports from `src/prompt-guidance.ts`.

- [ ] **Step 5: Implement `src/prompt-guidance.ts`**

  Export:

  ```ts
  export type NavigatorPromptClassification = "likely_orientation" | "skip_nudge";

  export interface NavigatorPromptReadinessFacts {
    repoResolved: boolean;
    selectedTools: readonly string[] | undefined;
    coverage: { total: number; indexed: number };
    fullCrawlDone: boolean;
    indexedHead: string | undefined;
    currentHead: string | null;
    dirty: boolean;
    workerFailed: boolean;
  }

  export const NAVIGATOR_PROMPT_NUDGE =
    "This request likely needs repo orientation. If no exact path is already known, call `navigator_locate` once before `rg`/`find`/`read`.";
  ```

  Implement:

  - `hasExactLocalPath(prompt: string): boolean`
  - `isExternalOnlyPrompt(prompt: string): boolean`
  - `classifyNavigatorPrompt(prompt: string): NavigatorPromptClassification`
  - `isNavigatorPromptGuidanceReady(facts: NavigatorPromptReadinessFacts): boolean`
  - `buildNavigatorPromptGuidance(args): string[]`

  Classifier requirements:

  - Decision order: external-only, exact path, broad repo trigger, ticket/PR plus code-impact trigger, skip.
  - Exact-path detection covers slash paths, relative paths, line/column suffixes, known filenames, quoted variants, and backticked variants.
  - External-only detection covers URL-only, PR-comments-only, git-info-only, Slack-only, Sentry-only, and database-only prompts when they do not imply repo inspection or implementation changes.
  - The phrase `without asking for code impact` does not itself count as a code-impact request.
  - URL/git prompts that explicitly ask what code needs to change classify as `likely_orientation`.
  - Broad repo triggers include investigation, review, implementation location, fixes, adding support, explain-how, and find-where phrasing.

- [ ] **Step 6: Run helper tests and typecheck**

  Run:

  ```bash
  node --test src/prompt-guidance.test.ts
  npm run typecheck
  ```

  Expected: PASS.

- [ ] **Step 7: Review and commit helper**

  Request a review of the Task 1 patch before integrating if using subagents. The review must explicitly check the external-only Sentry/database examples, backticked path examples, and code-impact URL/git examples.

  Commit:

  ```bash
  git add src/prompt-guidance.ts src/prompt-guidance.test.ts
  git commit -m "test: add navigator prompt guidance helper"
  ```

## Wave 2 — Code integration

Depends on Wave 1. Do not split config removal from hook wiring; they must land in the same task so typecheck never fails because `index.ts` still reads `config.injectPersona`.

### Task 2: Wire automatic guidance and remove `injectPersona` config behavior

**TDD scenario:** Modifying tested code — update tests first.

**Files:**
- Modify: `index.ts`
- Modify: `index.test.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `src/worktree.ts` if a dirty-worktree helper is needed
- Modify: `src/worktree.test.ts` if `workingTreeDirty()` becomes conservative on non-git/errors
- Modify: `prompts/navigator-persona.md`

- [ ] **Step 1: Update config tests**

  In `src/config.test.ts`, remove assertions that `DEFAULT_CONFIG.injectPersona` exists or can be disabled. Add/replace tests so they assert:

  - defaults still include `indexDir` ending in `pi-navigator-cache`
  - defaults still include languages `["ruby", "python", "ts", "js"]`
  - `loadConfig()` reads known navigator settings from `settings.json`
  - stale `navigator.injectPersona: false` is ignored and does not appear on the returned config object
  - `mergeConfig({ injectPersona: false, maxLocateResults: 3 } as ...)` returns a config without `injectPersona`
  - unknown config keys do not survive the returned config object
  - existing `keywordStoplist` and `keywordMinLength` normalization behavior remains covered

- [ ] **Step 2: Add hook tests**

  In `index.test.ts`, add or extend tests using temporary git repos and temporary `indexDir` settings. Reuse existing test helpers where possible.

  Add a helper that creates a clean git repo with one committed recognized source file:

  ```ts
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
  ```

  Add a polling helper so the tests wait for the tiny worker crawl to finish without assuming a fixed delay:

  ```ts
  async function waitForPromptResult(pi: ReturnType<typeof fakePi>, event: any): Promise<any> {
    const deadline = Date.now() + 3_000;
    let last: any;
    while (Date.now() < deadline) {
      last = await pi.fire("before_agent_start", event, undefined);
      if (last !== undefined) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return last;
  }
  ```

  Add tests for:

  - ready broad prompt appends persona and nudge even when settings contain stale `injectPersona: false`
  - ready exact-path prompt appends persona only
  - missing `navigator_locate` selected tool appends no guidance
  - dirty worktree appends no guidance
  - stale indexed HEAD appends no guidance if practical to simulate cheaply; otherwise cover stale HEAD in helper tests only and leave hook coverage to readiness unit tests

  If `workingTreeDirty()` is changed or added, update `src/worktree.test.ts` so the contract matches the approved readiness rule: non-git paths and git command errors are treated as dirty/not-ready rather than safe.

- [ ] **Step 3: Run focused tests and confirm expected failures**

  Run:

  ```bash
  node --test src/config.test.ts index.test.ts
  ```

  Expected: FAIL before implementation because `injectPersona` still exists and the hook does not append the conditional nudge.

- [ ] **Step 4: Remove `injectPersona` from config type/defaults and filter unknown keys**

  In `src/types.ts`, delete `injectPersona` from `NavigatorConfig`.

  In `src/config.ts`:

  - remove `injectPersona` from `DEFAULT_CONFIG`
  - type raw settings input so stale `injectPersona` can be parsed and ignored
  - replace broad config spreading with a known-key merge
  - keep keyword stoplist/min-length normalization
  - ensure unknown keys do not appear on returned config objects

  The returned `NavigatorConfig` must not have an `injectPersona` property at runtime.

- [ ] **Step 5: Add dirty-worktree helper if needed**

  In `src/worktree.ts`, add a helper if no equivalent exists:

  ```ts
  export function workingTreeDirty(root: string): boolean {
    try {
      const out = execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim().length > 0;
    } catch {
      return true;
    }
  }
  ```

  Keep this helper conservative: errors and non-git paths mean dirty/not-ready. Update existing `src/worktree.test.ts` expectations accordingly so the full suite remains green.

- [ ] **Step 6: Rewrite persona prompt**

  Replace the full contents of `prompts/navigator-persona.md` with:

  ```md
  Repo orientation rule: when a task requires finding code/docs and no exact path is already known, call `navigator_locate` once before broad `rg`/`find`/`read`; use `rg` for regex or full-content scans.
  ```

- [ ] **Step 7: Wire `before_agent_start`**

  In `index.ts`, import:

  ```ts
  import { buildNavigatorPromptGuidance } from "./src/prompt-guidance.ts";
  ```

  Also import `workingTreeDirty` from `src/worktree.ts` if it was added there.

  Replace the existing optional persona-injection branch. The new hook must:

  - run only when session state exists and repo status is ready
  - read `event.prompt`
  - read `event.systemPromptOptions?.selectedTools`
  - read persona text from `prompts/navigator-persona.md`
  - read live coverage via `getCoverage(state.db)`
  - read `full_crawl_done` and `head_sha_at_index` via `getMeta`
  - read current head via `headSha(state.root)`
  - read dirty state via `workingTreeDirty(state.root)` or equivalent
  - include `rolling?.workerFailed ?? false`
  - append no prompt guidance when `buildNavigatorPromptGuidance()` returns `[]`
  - append guidance lines to `event.systemPrompt` separated by blank lines when ready
  - catch readiness/prompt errors and return `undefined`

- [ ] **Step 8: Run focused tests and typecheck**

  Run:

  ```bash
  node --test src/prompt-guidance.test.ts src/config.test.ts index.test.ts
  npm run typecheck
  ```

  Expected: PASS.

- [ ] **Step 9: Review and commit code integration**

  Request a review of the Task 2 patch before integrating if using subagents. The review must verify there is no remaining `config.injectPersona` consumer and typecheck passes.

  Commit:

  ```bash
  git add index.ts index.test.ts src/types.ts src/config.ts src/config.test.ts src/worktree.ts src/worktree.test.ts prompts/navigator-persona.md
  git commit -m "feat: gate navigator prompt guidance on readiness"
  ```

## Wave 2 — Documentation

Depends on the approved spec. Parallel-safe with Task 2 only if docs owner does not edit code/test files.

### Task 3: Update documentation

**TDD scenario:** Documentation-only change — run docs grep and full tests after editing.

**Files:**
- Modify: `README.md`
- Modify: `NAVIGATOR.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update README install matrix**

  In `README.md`, replace the install matrix persona column text so it no longer mentions `injectPersona`. The row text should say:

  ```md
  | `pi install` / `pi install -l` (package in settings.json) | ✅ `navigator_locate`, `navigator_slice` | ✅ automatic when index is complete/current/clean | ✅ `navigator` skill auto-discovered via `pi.skills` in package.json |
  | `pi -e index.ts` (bare `-e`) | ✅ tools loaded | ✅ automatic when index is complete/current/clean | ❌ skill **not** auto-discovered (no settings.json entry) |
  | `pi -e git:...` (one-shot) | ✅ tools loaded | ✅ automatic when index is complete/current/clean | ❌ skill **not** auto-discovered |
  ```

- [ ] **Step 2: Update README configuration example and table**

  Remove this JSON line from the README configuration example:

  ```json
  "injectPersona": false,
  ```

  Remove the `injectPersona` table row. Add this paragraph after the table:

  ```md
  Prompt guidance is automatic when navigator is enabled, `navigator_locate` is selected, and the index is complete, current, and clean for the active worktree. Broad repo-orientation prompts get a short additional nudge; exact-path and external-only prompts do not. Use `/navigator status` to inspect readiness.
  ```

- [ ] **Step 3: Update NAVIGATOR technical reference**

  In `NAVIGATOR.md`, add a short section near the freshness/status discussion:

  ```md
  ## Prompt Guidance Readiness

  Navigator prompt guidance is automatic rather than user-configured. During `before_agent_start`, the extension appends the persona line only when `navigator_locate` is selected and the index is ready: coverage is non-empty and complete, `full_crawl_done = "1"`, `head_sha_at_index` matches the active repo `HEAD`, the worktree is clean, and the worker is not in a known failed state. Broad repo-orientation prompts receive one additional nudge to call `navigator_locate` before broad filesystem search.

  This guidance is soft and non-blocking: it does not force the first tool call or replace `rg` for regex/full-content scans. If readiness cannot be proven, the extension injects no prompt guidance. `/navigator status` remains the user-facing place to inspect indexing state.
  ```

- [ ] **Step 4: Add changelog entry**

  At the top of `CHANGELOG.md`, add an unreleased entry if one exists, or add a new top section:

  ```md
  ## Unreleased

  - **Prompt guidance:** navigator now injects automatic readiness-gated repo-orientation guidance when `navigator_locate` is selected and the index is complete/current/clean; `navigator.injectPersona` is no longer a behavior switch.
  ```

- [ ] **Step 5: Check docs no longer advertise `injectPersona` as configurable**

  Run:

  ```bash
  rg -n "injectPersona" README.md NAVIGATOR.md CHANGELOG.md
  ```

  Expected: matches only state that `navigator.injectPersona` is no longer a supported behavior switch.

- [ ] **Step 6: Commit docs**

  Run:

  ```bash
  git add README.md NAVIGATOR.md CHANGELOG.md
  git commit -m "docs: document automatic navigator prompt guidance"
  ```

## Wave 3 — Final verification

Depends on Wave 2: all code and docs are in place.

### Task 4: Full verification and telemetry follow-up note

**TDD scenario:** Final verification — no implementation edits expected.

**Files:**
- Modify: `doc/plans/2026-06-07-navigator-prompt-guidance.md` only if execution reveals a plan correction before this task starts.

- [ ] **Step 1: Run typecheck**

  Run:

  ```bash
  npm run typecheck
  ```

  Expected: PASS.

- [ ] **Step 2: Run all tests**

  Run:

  ```bash
  node --test
  ```

  Expected: PASS.

- [ ] **Step 3: Confirm no unintended changes**

  Run:

  ```bash
  git status --short --branch
  ```

  Expected: branch `navigator-persona-prompt-guidance` with a clean working tree.

- [ ] **Step 4: Record manual follow-up for telemetry validation**

  Do not run telemetry analysis during implementation. Add this note to the handoff summary after tests pass:

  ```md
  Follow-up after the change has live GridStrong sessions: compare broad repo-orientation prompts before/after for first repo-navigation action, first-turn `navigator_locate` lift, false-positive nudges, and readiness-suppressed opportunities.
  ```

- [ ] **Step 5: Commit only if plan corrections were made during execution**

  If Task 4 changed `doc/plans/2026-06-07-navigator-prompt-guidance.md`, run:

  ```bash
  git add doc/plans/2026-06-07-navigator-prompt-guidance.md
  git commit -m "docs: update navigator prompt guidance plan"
  ```

  Expected: no commit is needed when Task 4 makes no file changes.

## Self-review checklist

- Spec coverage: Tasks cover automatic guidance, no config gate, readiness predicate, hook integration, classifier behavior, docs, and telemetry follow-up.
- Dependency correction: `injectPersona` removal is merged with hook wiring so typecheck is not expected to pass after a config-only partial change.
- Classifier correction: Task 1 includes explicit external-service-only tests and code-impact URL/git counterexamples.
- Wave disjointness: Wave 1 helper is standalone; Wave 2 code/docs tasks own disjoint file sets; Wave 3 verifies everything.
- Verification: focused tests, typecheck, full `node --test`, and review checkpoints are included.
