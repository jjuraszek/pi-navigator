# Guidance Availability, Telemetry Completeness, and Shared Repo Identity - Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans (or subagent-driven-development) skill to implement this plan task-by-task.

**Goal:** Make navigator guidance fire whenever the tool is selected (index state becomes caveat text, never suppression), stop the grep guard from blocking single-file greps, complete telemetry (guard events, availability split, pipe-aware search counts), and collapse per-worktree index/telemetry DBs into one shared pair per repo identity.

**Architecture:** Five mechanically independent changes (M1-M5) in the pi-navigator extension. Pure logic lives in `src/*.ts` modules with colocated `*.test.ts`; the extension entry `index.ts` wires the modules into pi hooks (`before_agent_start`, `tool_call`, `session_start`). No index schema or ranking change. No GC/migration code for stale DBs.

**Tech Stack:** TypeScript on Node 24 native type-stripping (relative imports MUST carry `.ts`), `node:sqlite` (telemetry + index), `node:test`, web-tree-sitter (unaffected here).

**Spec:** `doc/specs/2026-06-11-guidance-availability-and-shared-index.md`

**Linear:** none

---

## Open Questions

None. The 0.9 coverage threshold for the strong directive tier is a fixed constant in this plan (`STRONG_COVERAGE_THRESHOLD = 0.9`); tuning is out of scope.

---

## Files

**Modify:**
- `src/prompt-guidance.ts` - availability-gated guidance builder; strong/weak directive; caveat lines (M1)
- `src/prompt-guidance.test.ts` - state-matrix coverage (M1)
- `src/grep-guard.ts` - statement segmentation; per-segment classify (M2)
- `src/grep-guard.test.ts` - single-file-in-multi-statement allow cases (M2)
- `src/telemetry/schema.ts` - schema v3; ALTER-based migration; `nav_guard`; `tools_selected` (M3)
- `src/telemetry/schema.test.ts` - v2->v3 ALTER migration; new table/column (M3)
- `src/telemetry/detect.ts` - pipe-aware `detectSearch` (M3c)
- `src/telemetry/detect.test.ts` - pipe-downstream exclusion (M3c)
- `src/telemetry/replay.test.ts` - pipe-grep fixture now yields no search consume (M3c)
- `src/telemetry/types.ts` - `GuardRowInput`; `StatsSummary` guard/availability fields (M3)
- `src/telemetry/queries.ts` - `recordGuard`; `markToolsSelected`; `ensureSession` unchanged (M3)
- `src/telemetry/correlator.ts` - `recordGuard()` + `recordToolsSelected()` methods (M3)
- `src/telemetry/correlator.test.ts` - recordGuard/recordToolsSelected (M3) *(create if absent)*
- `src/telemetry/stats.ts` - guard counts + availability split aggregation (M3)
- `src/telemetry/stats.test.ts` - new aggregate fields (M3)
- `src/commands.ts` - `formatStats` adds guard + availability lines (M3)
- `src/worktree.ts` - `repoName` from main worktree (`--git-common-dir` parent) (M4)
- `src/worktree.test.ts` - linked-worktree/bare-repo resolution (M4)
- `index.ts` - wire M1 gate change, M2 cwd-aware probe + recordGuard, M3 tools_selected (integration)
- `NAVIGATOR.md` - guidance model, naming rule, guard posture (M5)
- `README.md` - environment prerequisite + optional AGENTS.md snippet (M5)

**Create:** none (all modules already exist).

**Delete:** none.

---

## Wave 1 - Pure modules

Parallel-safe: Tasks 1-5 own pairwise-disjoint files (see each task's Files block). No task in this wave imports another's changes.

### Task 1: M1 - guidance builder, availability-gated with caveats

**TDD scenario:** Modifying tested code - run existing `prompt-guidance.test.ts` first, then extend.

**Files:**
- Modify: `src/prompt-guidance.ts`
- Test: `src/prompt-guidance.test.ts`

**Context (ground truth):**
- `buildNavigatorPromptGuidance` (`src/prompt-guidance.ts`) currently gates the nudge on `isNavigatorPromptGuidanceReady` (full coverage AND `fullCrawlDone` AND HEAD-match AND clean tree) and the persona on `personaUsable` (`coverage.indexed > 0 && tool selected && !workerFailed`).
- `classifyNavigatorPrompt` already returns `"skip_nudge"` for exact-path and external-only prompts and `"likely_orientation"` otherwise. Keep using it to suppress the **directive** (not the persona).
- `NavigatorPromptReadinessFacts` already carries `coverage {total, indexed}`, `fullCrawlDone`, `indexedHead`, `currentHead`, `dirty`, `selectedTools`, `workerFailed`.

- [ ] **Step 1: Write failing tests** for the new builder behavior.

  Append to `src/prompt-guidance.test.ts`:

  ```ts
  import {
    buildNavigatorPromptGuidance,
    NAVIGATOR_PROMPT_NUDGE,
    NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX,
    NAVIGATOR_BOOT_CAVEAT,
    NAVIGATOR_LAG_CAVEAT,
  } from "./prompt-guidance.ts";

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
    prompt,
    persona: "PERSONA",
    enablePersona: true,
    enableNudge: true,
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
    assert.ok(!g.includes("PERSONA"), "persona suppressed until at least one file indexed");
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
    const g = buildNavigatorPromptGuidance(args({ selectedTools: ["read", "grep"] }));
    assert.deepEqual(g, []);
  });

  test("exact-path prompt -> persona kept, directive + caveats suppressed", () => {
    const g = buildNavigatorPromptGuidance(args({ dirty: true }, "open src/worktree.ts and fix it"));
    assert.ok(g.includes("PERSONA"));
    assert.ok(!g.includes(NAVIGATOR_PROMPT_NUDGE));
    assert.ok(!g.some((l) => l.startsWith(NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX)));
    assert.ok(!g.includes(NAVIGATOR_LAG_CAVEAT), "no directive -> no caveats");
  });

  test("external-only prompt -> persona only, no directive", () => {
    const g = buildNavigatorPromptGuidance(args({}, "show git status"));
    assert.ok(g.includes("PERSONA"));
    assert.ok(!g.includes(NAVIGATOR_PROMPT_NUDGE));
  });

  test("enablePersona=false drops persona but keeps directive", () => {
    const g = buildNavigatorPromptGuidance({ ...args({}), enablePersona: false });
    assert.ok(!g.includes("PERSONA"));
    assert.ok(g.includes(NAVIGATOR_PROMPT_NUDGE));
  });
  ```

- [ ] **Step 2: Run, confirm failure**

  Run: `node --test src/prompt-guidance.test.ts`
  Expected: FAIL - `NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX` / `NAVIGATOR_BOOT_CAVEAT` / `NAVIGATOR_LAG_CAVEAT` are not exported; weak-tier and caveat branches do not exist.

- [ ] **Step 3: Implement the builder**

  In `src/prompt-guidance.ts`, add constants near `NAVIGATOR_PROMPT_NUDGE` and a strong-tier threshold:

  ```ts
  export const STRONG_COVERAGE_THRESHOLD = 0.9;
  export const NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX =
    "navigator is available; the index is still building";
  export const NAVIGATOR_BOOT_CAVEAT =
    "If a navigator tool reports it is still booting, retry once before falling back to rg/fd.";
  export const NAVIGATOR_LAG_CAVEAT =
    "Navigator's ranking may lag recent edits - verify candidates with `read` or `navigator_slice` before relying on them.";

  function weakDirective(coverage: { total: number; indexed: number }): string {
    const pct = coverage.total === 0 ? 0 : Math.round((coverage.indexed / coverage.total) * 100);
    return `${NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX} (${pct}% indexed) - try \`navigator_locate\` first and fall back to \`rg\`/\`fd\` if results look thin.`;
  }

  function directiveTier(facts: NavigatorPromptReadinessFacts): "strong" | "weak" {
    const ratio = facts.coverage.total === 0 ? 0 : facts.coverage.indexed / facts.coverage.total;
    return ratio >= STRONG_COVERAGE_THRESHOLD && facts.fullCrawlDone ? "strong" : "weak";
  }
  ```

  Replace `buildNavigatorPromptGuidance` with:

  ```ts
  export function buildNavigatorPromptGuidance(args: BuildNavigatorPromptGuidanceArgs): string[] {
    const guidance: string[] = [];
    const persona = args.persona.trim();
    const facts = args.readiness;

    // Terminal state (no repo / tool not selected): inject nothing. personaUsable
    // already encodes `coverage.indexed > 0 && tool selected && !workerFailed`, so
    // the boot state (indexed === 0) correctly suppresses the persona.
    if (args.enablePersona && persona && personaUsable(facts)) {
      guidance.push(persona);
    }

    const toolSelected = facts.selectedTools?.includes("navigator_locate") === true;
    if (
      args.enableNudge &&
      toolSelected &&
      facts.repoResolved &&
      !facts.workerFailed &&
      classifyNavigatorPrompt(args.prompt) === "likely_orientation"
    ) {
      guidance.push(directiveTier(facts) === "strong" ? NAVIGATOR_PROMPT_NUDGE : weakDirective(facts.coverage));

      // Caveats qualify the directive; emit only alongside it.
      if (facts.coverage.indexed === 0) guidance.push(NAVIGATOR_BOOT_CAVEAT);
      const headDrift =
        typeof facts.indexedHead === "string" &&
        typeof facts.currentHead === "string" &&
        facts.indexedHead !== facts.currentHead;
      if (facts.dirty || headDrift) guidance.push(NAVIGATOR_LAG_CAVEAT);
    }

    return guidance;
  }
  ```

  Keep `isNavigatorPromptGuidanceReady` exported (index.ts no longer calls it for the directive, but `personaUsable`, `classifyNavigatorPrompt`, and the readiness type stay). Do not delete `isNavigatorPromptGuidanceReady` in this task - a later cleanup can remove it once index.ts is confirmed not to reference it.

- [ ] **Step 4: Run, confirm pass**

  Run: `node --test src/prompt-guidance.test.ts`
  Expected: PASS (new + pre-existing tests).

- [ ] **Step 5: Commit**

  ```bash
  git add src/prompt-guidance.ts src/prompt-guidance.test.ts
  git commit -m "M1: availability-gated guidance with strong/weak tiers and caveats"
  ```

### Task 2: M2 - grep guard statement segmentation

**TDD scenario:** Modifying tested code - run existing `grep-guard.test.ts` first, then extend.

**Files:**
- Modify: `src/grep-guard.ts`
- Test: `src/grep-guard.test.ts`

**Context (ground truth, verified live):** `classifyGrepCommand` today does `command.split("|")[0]` and parses that one segment as a single grep. Because it scans **all** tokens for a recursive flag, flags from a *following* statement leak into the grep classification. Verified false positives that must become `allow`:
- `grep -n pat file.md; ls -R somedir` -> currently `isRepoScan: true` (the `-R` belongs to `ls`).
- `grep -n pat file.md && cat -R other.md` -> currently `isRepoScan: true` (the `-R` belongs to `cat`).
Verified still-correct (must stay): `grep -r foo src/` blocks; `grep foo .` blocks; `ps aux | grep node` allows; `cat f | grep x` allows.

- [ ] **Step 1: Write failing tests**

  Append to `src/grep-guard.test.ts`:

  ```ts
  test("single-file grep followed by another statement's -R flag is allowed", () => {
    assert.equal(decideGrepAction({ command: "grep -n pat file.md; ls -R somedir", ...base }).action, "allow");
    assert.equal(decideGrepAction({ command: "grep -n pat file.md && cat -R other.md", ...base }).action, "allow");
  });
  test("single-file grep beside a non-grep rg scan is allowed (rg is not guarded)", () => {
    assert.equal(decideGrepAction({ command: "grep -n x file.md && rg -r foo .", ...base }).action, "allow");
  });
  test("a real scan inside a multi-statement command is still blocked", () => {
    assert.equal(decideGrepAction({ command: "echo hi; grep -r foo src/", ...base }).action, "block");
    assert.equal(decideGrepAction({ command: "grep -n a f.md && grep -r b src/", ...base }).action, "block");
  });
  test("scan inside a command substitution is still blocked", () => {
    assert.equal(decideGrepAction({ command: "x=$(grep -r foo src/)", ...base }).action, "block");
  });
  test("single-file grep inside a command substitution is allowed", () => {
    assert.equal(decideGrepAction({ command: "x=$(grep -n foo README.md)", ...base }).action, "allow");
  });
  ```

- [ ] **Step 2: Run, confirm failure**

  Run: `node --test src/grep-guard.test.ts`
  Expected: FAIL - `grep -n pat file.md; ls -R somedir` and `grep -n pat file.md && cat -R other.md` currently block; `x=$(grep -r foo src/)` currently allows (head `x=$(grep` fails the grep-head test).

- [ ] **Step 3: Implement segmentation**

  In `src/grep-guard.ts`, add a quote-aware segmenter that splits on `|`, `;`, `&&`, `||`, newline and lifts `$(...)` / backtick contents into their own segments, then classify each segment as a single grep. Replace the body of `classifyGrepCommand`:

  ```ts
  /**
   * Split a command into candidate single-command segments. Splits on unquoted
   * | ; && || and newlines; lifts $(...) and `...` bodies into separate segments
   * so a grep inside a substitution is classified on its own. Quoted regions are
   * opaque. Conservative: anything unparseable yields the original string as one
   * segment (callers bias to allow on a non-grep head).
   */
  function splitCommandSegments(command: string): string[] {
    const segments: string[] = [];
    let seg = "";
    let inSingle = false;
    let inDouble = false;
    let i = 0;
    const push = () => { if (seg.trim().length > 0) segments.push(seg); seg = ""; };

    while (i < command.length) {
      const ch = command[i]!;
      if (inSingle) { seg += ch; if (ch === "'") inSingle = false; i++; continue; }
      if (inDouble) { seg += ch; if (ch === '"') inDouble = false; i++; continue; }
      if (ch === "'") { inSingle = true; seg += ch; i++; continue; }
      if (ch === '"') { inDouble = true; seg += ch; i++; continue; }
      // $( ... ) - capture the inner command as its own segment, drop the wrapper.
      if (ch === "$" && command[i + 1] === "(") {
        let depth = 1; let inner = ""; i += 2;
        while (i < command.length && depth > 0) {
          const c = command[i]!;
          if (c === "(") depth++;
          else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
          inner += c; i++;
        }
        for (const s of splitCommandSegments(inner)) segments.push(s);
        continue;
      }
      if (ch === "`") {
        let inner = ""; i++;
        while (i < command.length && command[i] !== "`") { inner += command[i]; i++; }
        i++; // closing backtick
        for (const s of splitCommandSegments(inner)) segments.push(s);
        continue;
      }
      if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) { push(); i += 2; continue; }
      if (ch === ";" || ch === "|" || ch === "\n") { push(); i++; continue; }
      seg += ch; i++;
    }
    push();
    return segments;
  }

  function classifySingleGrep(segment: string, probeDir: (p: string) => boolean): GrepClassification {
    const noScan: GrepClassification = { isRepoScan: false, patternKind: null };
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return noScan;
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

  export function classifyGrepCommand(command: string, probeDir: (p: string) => boolean): GrepClassification {
    for (const seg of splitCommandSegments(command)) {
      const c = classifySingleGrep(seg, probeDir);
      if (c.isRepoScan) return c; // any scanning grep in the pipeline blocks
    }
    return { isRepoScan: false, patternKind: null };
  }
  ```

  `decideGrepAction` is unchanged. Keep `stripQuotes`, `GREP_HEAD_RE`, `RECURSIVE_RE`, `SYMBOL_RE` as-is.

- [ ] **Step 4: Run, confirm pass**

  Run: `node --test src/grep-guard.test.ts`
  Expected: PASS (new + all pre-existing block/allow cases).

- [ ] **Step 5: Commit**

  ```bash
  git add src/grep-guard.ts src/grep-guard.test.ts
  git commit -m "M2: segment grep commands so single-file greps are never blocked"
  ```

### Task 3: M3 - telemetry schema v3 (ALTER migration, nav_guard, tools_selected)

**TDD scenario:** Modifying tested code - run existing `schema.test.ts` first, then extend.

**Files:**
- Modify: `src/telemetry/schema.ts`
- Test: `src/telemetry/schema.test.ts`

**Context (ground truth):** `TELEMETRY_SCHEMA_VERSION = 2`. `migrate()` calls `needsRebuild(stored, current)` and, when true, **drops all `nav_*` tables**. The spec forbids dropping v2 data on the 2->3 bump: use additive ALTER/CREATE-IF-NOT-EXISTS for `stored >= 2`, reserve the drop path for `stored == 1`.

- [ ] **Step 1: Write failing tests**

  Append to `src/telemetry/schema.test.ts`:

  ```ts
  test("v2->v3 migration preserves nav_session rows (ALTER, not drop)", () => {
    const dbPath = makeTmpPath();
    try {
      const db = openDb(dbPath);
      // Simulate a v2 DB: build v2 tables and stamp version 2, with one row.
      db.exec("CREATE TABLE IF NOT EXISTS tmeta (key TEXT PRIMARY KEY, value TEXT)");
      db.exec("CREATE TABLE IF NOT EXISTS nav_session (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, repo_root TEXT, head_sha TEXT, is_writer INTEGER DEFAULT 0, used_locate INTEGER DEFAULT 0)");
      db.prepare("INSERT INTO nav_session (session_id, started_at) VALUES ('keep-me', 123)").run();
      db.prepare("INSERT INTO tmeta (key, value) VALUES ('schema_version', '2')").run();

      migrate(db); // -> v3

      const row = db.prepare("SELECT session_id, tools_selected FROM nav_session WHERE session_id = 'keep-me'").get() as any;
      assert.ok(row, "v2 row must survive the v2->v3 migration");
      assert.equal(row.tools_selected, 0, "tools_selected backfills to default 0");
      const ver = db.prepare("SELECT value FROM tmeta WHERE key='schema_version'").get() as any;
      assert.equal(ver.value, "3");
    } finally { cleanup(dbPath); }
  });

  test("migrate creates nav_guard with the expected columns", () => {
    const dbPath = makeTmpPath();
    try {
      const db = openDb(dbPath);
      migrate(db);
      const cols = (db.prepare("PRAGMA table_info(nav_guard)").all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of ["session_id", "ts", "action", "pattern_kind", "reason"]) {
        assert.ok(cols.includes(c), `nav_guard missing column ${c}; got ${cols.join(", ")}`);
      }
    } finally { cleanup(dbPath); }
  });

  test("nav_session has tools_selected after a fresh migrate", () => {
    const dbPath = makeTmpPath();
    try {
      const db = openDb(dbPath);
      migrate(db);
      const cols = (db.prepare("PRAGMA table_info(nav_session)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("tools_selected"));
    } finally { cleanup(dbPath); }
  });
  ```

  Update the existing `needsRebuild returns correct results` test to assert the v2-floor behavior of the new `needsRebuild`:

  ```ts
  test("needsRebuild only rebuilds for pre-v2 stored versions", () => {
    assert.equal(needsRebuild(0, 3), false, "fresh DB (0) never rebuilds");
    assert.equal(needsRebuild(1, 3), true, "pre-v2 stored triggers rebuild");
    assert.equal(needsRebuild(2, 3), false, "v2->v3 is additive, no rebuild");
    assert.equal(needsRebuild(3, 3), false, "same version no rebuild");
  });
  ```

  Remove the old `needsRebuild returns correct results` test body (it asserted `needsRebuild(1,2)===true` and `needsRebuild(2,2)===false`; the v2->v3 semantics replace it).

- [ ] **Step 2: Run, confirm failure**

  Run: `node --test src/telemetry/schema.test.ts`
  Expected: FAIL - `nav_guard` does not exist; `tools_selected` column missing; `needsRebuild(2,3)` currently returns `true`.

- [ ] **Step 3: Implement schema v3**

  In `src/telemetry/schema.ts`:

  ```ts
  export const TELEMETRY_SCHEMA_VERSION = 3;
  ```

  Add `nav_guard` to `DDL` (after `nav_unavailable`):

  ```sql
  CREATE TABLE IF NOT EXISTS nav_guard (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, action TEXT NOT NULL, pattern_kind TEXT, reason TEXT);
  CREATE INDEX IF NOT EXISTS idx_guard_session ON nav_guard(session_id);
  ```

  Add `tools_selected` to the `nav_session` DDL definition for fresh DBs:

  ```sql
  CREATE TABLE IF NOT EXISTS nav_session (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, repo_root TEXT, head_sha TEXT, is_writer INTEGER DEFAULT 0, used_locate INTEGER DEFAULT 0, tools_selected INTEGER DEFAULT 0);
  ```

  Change `needsRebuild` to a v2 floor (only drop for pre-v2 stored versions):

  ```ts
  // Drop/rebuild only when upgrading from a pre-v2 schema. v2->v3 (and later) is
  // additive (ALTER + CREATE IF NOT EXISTS) and must preserve recorded rows.
  export function needsRebuild(storedVersion: number, currentVersion: number): boolean {
    return storedVersion > 0 && storedVersion < 2 && storedVersion < currentVersion;
  }
  ```

  In `migrate()`, after `db.exec(DDL)` (which creates `nav_guard` and a fresh `nav_session` that already has the column), add an idempotent ALTER for DBs whose `nav_session` predates the column:

  ```ts
  db.exec(DDL);

  // Additive column for v2 DBs that already had nav_session without tools_selected.
  const sessionCols = (db.prepare("PRAGMA table_info(nav_session)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!sessionCols.includes("tools_selected")) {
    db.exec("ALTER TABLE nav_session ADD COLUMN tools_selected INTEGER DEFAULT 0");
  }
  ```

  Add `nav_guard` to the `pruneOld` cleanup so guard rows are retention-bounded too:

  ```ts
  db.prepare("DELETE FROM nav_guard WHERE ts < ?").run(cutoff);
  ```
  and include `nav_guard` in the orphan-cleanup loop list (`["nav_locate", "nav_consume", "nav_unavailable", "nav_guard"]`).

- [ ] **Step 4: Run, confirm pass**

  Run: `node --test src/telemetry/schema.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/telemetry/schema.ts src/telemetry/schema.test.ts
  git commit -m "M3: telemetry schema v3 - ALTER migration, nav_guard, tools_selected"
  ```

### Task 4: M4 - shared repo identity from main worktree

**TDD scenario:** Modifying tested code - run existing `worktree.test.ts` first, then extend.

**Files:**
- Modify: `src/worktree.ts`
- Test: `src/worktree.test.ts`

**Context (ground truth):** `resolveRepo` sets `repoName = basename(root)` where `root = git rev-parse --show-toplevel` - different per linked worktree. `repoId` (root-commit sha) is already shared. `telemetryPathFor` derives the telemetry DB from `dbPath`, so fixing `repoName` shares both DBs automatically. `git rev-parse --git-common-dir` returns the main repo's `.git` dir; its parent dir's basename is the canonical repo name.

- [ ] **Step 1: Write failing tests**

  Append to `src/worktree.test.ts` (extend the existing `tmpRepo` helper usage):

  ```ts
  test("linked worktree resolves to the main worktree's repoName and dbPath", () => {
    const main = tmpRepo();
    const wtParent = mkdtempSync(join(tmpdir(), "nav-wt-linked-"));
    const linked = join(wtParent, "feature");
    execFileSync("git", ["worktree", "add", "-q", linked, "-b", "feature"], { cwd: main });

    const rMain = resolveRepo(main, DEFAULT_CONFIG);
    const rLinked = resolveRepo(linked, DEFAULT_CONFIG);

    assert.equal(rLinked.repoName, rMain.repoName, "linked worktree must share the main repoName");
    assert.equal(rLinked.repoId, rMain.repoId, "repoId already shared");
    assert.equal(rLinked.dbPath, rMain.dbPath, "one DB file shared across worktrees");

    execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: main });
    rmSync(wtParent, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  });

  test("non-git directory still yields empty dbPath (no regression)", () => {
    const d = mkdtempSync(join(tmpdir(), "nav-nogit2-"));
    const r = resolveRepo(d, DEFAULT_CONFIG);
    assert.equal(r.isGit, false);
    assert.equal(r.dbPath, "");
    rmSync(d, { recursive: true, force: true });
  });
  ```

  Keep the existing `resolveRepo yields root, name, stable id, and cache db path` test, but change its `repoName` assertion: in a plain (non-worktree) repo the common-dir parent basename equals `basename(root)`, so the existing equality `r.repoName === r.root.split("/").pop()` still holds. Leave it as-is to prove the main-checkout case is unchanged.

- [ ] **Step 2: Run, confirm failure**

  Run: `node --test src/worktree.test.ts`
  Expected: FAIL - linked worktree currently gets `repoName = "feature"` (its own toplevel basename), so `rLinked.dbPath !== rMain.dbPath`.

- [ ] **Step 3: Implement canonical repoName**

  In `src/worktree.ts`, add a helper and use it for `repoName`:

  ```ts
  /**
   * Canonical repo name = basename of the main worktree, derived from the parent
   * of `git rev-parse --git-common-dir`. All linked worktrees of a repo resolve
   * to the same name so they share one index + telemetry DB. Bare repos and parse
   * failures fall back to basename(root).
   */
  function canonicalRepoName(cwd: string, root: string): string {
    try {
      if (git(cwd, ["rev-parse", "--is-bare-repository"]) === "true") {
        return basename(git(cwd, ["rev-parse", "--git-dir"]));
      }
      const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
      const abs = isAbsolute(commonDir) ? commonDir : join(root, commonDir);
      // commonDir is the main repo's .git directory; its parent is the main worktree.
      return basename(dirname(abs));
    } catch {
      return basename(root);
    }
  }
  ```

  Update imports: `import { basename, dirname, isAbsolute, join } from "node:path";`

  Replace `const repoName = basename(root);` with:

  ```ts
  const repoName = isGit ? canonicalRepoName(cwd, root) : basename(root);
  ```

  (Non-git keeps `basename(root)`; `dbPath` is already `""` for non-git, so the value is cosmetic there.)

- [ ] **Step 4: Run, confirm pass**

  Run: `node --test src/worktree.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/worktree.ts src/worktree.test.ts
  git commit -m "M4: derive repoName from main worktree so worktrees share one DB"
  ```

### Task 5: M3c - pipe-aware detectSearch

**TDD scenario:** Modifying tested code - run existing `detect.test.ts` and `replay.test.ts` first, then change.

**Files:**
- Modify: `src/telemetry/detect.ts`
- Test: `src/telemetry/detect.test.ts`
- Test: `src/telemetry/replay.test.ts`

**Context (ground truth):** `detectSearch` calls `splitSegments` (splits on unquoted `&&`/`||`/`;`/`|`/newline, quotes opaque) and returns the first segment that matches a tool. Existing tests lock in that a **pipe-downstream** match counts: `detectSearch("cat foo | rg baz") === {rg, baz}` and `detectSearch("ls | grep -v telemetry | head -1") === {grep, telemetry}`. The spec reclassifies these as filters. A search match in a segment that is downstream of a `|` is excluded; segments that are first, or follow `;`/`&&`/`||`/newline, stay eligible.

- [ ] **Step 1: Write/adjust failing tests**

  In `src/telemetry/detect.test.ts`, change the two pipe-downstream expectations and add explicit exclusion/inclusion cases:

  ```ts
  // was: assert.deepEqual(detectSearch("cat foo | rg baz"), { tool: "rg", pattern: "baz" });
  assert.equal(detectSearch("cat foo | rg baz"), null, "pipe-downstream rg is a filter, not a search");
  // was: assert.deepEqual(detectSearch("ls | grep -v telemetry | head -1"), { tool: "grep", pattern: "telemetry" });
  assert.equal(detectSearch("ls | grep -v telemetry | head -1"), null, "pipe-downstream grep is a filter");
  ```

  Add a focused test:

  ```ts
  test("detectSearch excludes pipe-downstream filters but keeps first-segment and &&/; searches", () => {
    assert.deepEqual(detectSearch("rg foo | head"), { tool: "rg", pattern: "foo" }, "first-segment search counts even when piped onward");
    assert.deepEqual(detectSearch("grep -r x src | wc -l"), { tool: "grep", pattern: "x" });
    assert.equal(detectSearch("ps aux | grep node"), null, "downstream grep filter excluded");
    assert.deepEqual(detectSearch("cd x && rg foo"), { tool: "rg", pattern: "foo" });
    assert.deepEqual(detectSearch("rg navigator; echo done"), { tool: "rg", pattern: "navigator" });
  });
  ```

  In `src/telemetry/replay.test.ts`, replace the `pipe-grep` test (the `ls | grep -v x | head` fixture now records **no** search consume -> outcome `abandoned`):

  ```ts
  test("pipe-grep: locate then ls|grep|head bash -> grep is a pipe filter, no search consume -> abandoned", () => {
    const events = loadFixture("pipe-grep.json");
    const { telemetryDb, sessionId } = replayTrace(events);

    const consumeRows = telemetryDb
      .prepare("SELECT * FROM nav_consume WHERE session_id = ?")
      .all(sessionId) as any[];
    assert.equal(consumeRows.length, 0, "pipe-downstream grep must not record a search consume");

    const stats = aggregate(telemetryDb, { scope: sessionId });
    assert.equal(stats.locateTotal, 1);
    assert.equal(stats.missFallback, 0);
    assert.equal(stats.abandoned, 1);
  });
  ```

- [ ] **Step 2: Run, confirm failure**

  Run: `node --test src/telemetry/detect.test.ts src/telemetry/replay.test.ts`
  Expected: FAIL - current `detectSearch` returns the downstream match; pipe-grep currently records a grep search consume.

- [ ] **Step 3: Implement pipe-awareness**

  In `src/telemetry/detect.ts`, change `splitSegments` to also report whether each segment was reached via a pipe, and have `detectSearch` skip piped segments. Replace the `splitSegments` return type and `detectSearch`:

  ```ts
  interface Segment { text: string; piped: boolean }

  // `piped` = the operator immediately before this segment was a single `|`.
  // Segments after ; && || newline (and the first segment) are not piped.
  function splitSegments(command: string): Segment[] {
    const segments: Segment[] = [];
    let seg = "";
    let pipedInto = false; // applies to the segment currently being built
    let inSingle = false;
    let inDouble = false;
    let i = 0;
    const flush = (nextPiped: boolean) => {
      segments.push({ text: seg, piped: pipedInto });
      seg = "";
      pipedInto = nextPiped;
    };

    while (i < command.length) {
      const ch = command[i]!;
      if (inSingle) { seg += ch; if (ch === "'") inSingle = false; i++; continue; }
      if (inDouble) { seg += ch; if (ch === '"') inDouble = false; i++; continue; }
      if (ch === "'") { inSingle = true; seg += ch; i++; continue; }
      if (ch === '"') { inDouble = true; seg += ch; i++; continue; }
      if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) { flush(false); i += 2; continue; }
      if (ch === ";" || ch === "\n") { flush(false); i++; continue; }
      if (ch === "|") { flush(true); i++; continue; } // single pipe -> next segment is piped
      seg += ch; i++;
    }
    segments.push({ text: seg, piped: pipedInto });
    return segments;
  }

  export function detectSearch(command: string): { tool: SearchTool; pattern: string } | null {
    for (const segment of splitSegments(command)) {
      if (segment.piped) continue; // downstream of a pipe -> filter, not a search
      for (const { tool, re } of TOOL_PATTERNS) {
        const m = segment.text.match(re);
        if (m) {
          const pattern = extractPattern(tool, m[1]);
          if (pattern !== null) return { tool, pattern };
        }
      }
    }
    return null;
  }
  ```

  Leave `extractPattern`, `unquote`, `TOOL_PATTERNS`, `classifyQuery` unchanged.

- [ ] **Step 4: Run, confirm pass**

  Run: `node --test src/telemetry/detect.test.ts src/telemetry/replay.test.ts`
  Expected: PASS. Then `node --test` for the full telemetry suite to confirm no other fixture regressed (`cd-rg-fallback`, `multi-search`, `pattern-clean` use `&&`/`;`/first-segment and stay counted).

- [ ] **Step 5: Commit**

  ```bash
  git add src/telemetry/detect.ts src/telemetry/detect.test.ts src/telemetry/replay.test.ts
  git commit -m "M3c: exclude pipe-downstream greps from search detection"
  ```

---

## Wave 2 - Telemetry write path

Depends on Wave 1: Task 6 inserts into `nav_guard` and sets `tools_selected` (Task 3 schema), and its outcome counts assume Task 5's pipe-aware detection.

### Task 6: M3 - recordGuard + tools_selected write path

**TDD scenario:** Modifying tested code - extend telemetry query/correlator tests.

**Files:**
- Modify: `src/telemetry/types.ts`
- Modify: `src/telemetry/queries.ts`
- Modify: `src/telemetry/correlator.ts`
- Test: `src/telemetry/correlator.test.ts`

**Context (ground truth):** `GrepAction` (`src/grep-guard.ts`) is `{ action: "allow" | "block"; reason?; warn? }` - no native `allow_fallback`. The telemetry `action` derives: `block` <- `action==="block"`; `warn` <- `action==="allow" && warn===true`; `allow_fallback` <- an allow emitted on the navigator-inactive / rg-unavailable fallback path (decided at the call site in index.ts, Task 8). `ensureSession` (queries.ts) runs in the `TelemetryCorrelator` constructor at `session_start`; `selectedTools` is only known later in `before_agent_start`, so `tools_selected` is written by a separate UPDATE, not at session creation.

- [ ] **Step 1: Write failing tests**

  Read `src/telemetry/correlator.test.ts` if present; otherwise create it following `schema.test.ts` setup (openDb + migrate on a tmp path). Add:

  ```ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { unlinkSync, existsSync } from "node:fs";
  import { openDb } from "../store/db.ts";
  import { migrate } from "./schema.ts";
  import { recordGuard, markToolsSelected, ensureSession } from "./queries.ts";

  function tmp(): string { return join(tmpdir(), `nav-corr-${process.pid}-${Date.now()}.db`); }
  function cleanup(p: string) { for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) unlinkSync(p + s); }

  test("recordGuard inserts a nav_guard row with mapped action", () => {
    const p = tmp();
    try {
      const db = openDb(p); migrate(db);
      db.prepare("INSERT INTO nav_session (session_id, started_at) VALUES ('s1', 1)").run();
      recordGuard(db, { sessionId: "s1", ts: 10, action: "block", patternKind: "symbol", reason: "scan blocked" });
      recordGuard(db, { sessionId: "s1", ts: 11, action: "warn", patternKind: null, reason: "rg missing" });
      const rows = db.prepare("SELECT action, pattern_kind, reason FROM nav_guard WHERE session_id='s1' ORDER BY ts").all() as any[];
      assert.equal(rows.length, 2);
      assert.equal(rows[0].action, "block");
      assert.equal(rows[0].pattern_kind, "symbol");
      assert.equal(rows[1].action, "warn");
      assert.equal(rows[1].pattern_kind, null);
    } finally { cleanup(p); }
  });

  test("markToolsSelected updates nav_session.tools_selected", () => {
    const p = tmp();
    try {
      const db = openDb(p); migrate(db);
      ensureSession(db, { sessionId: "s2", startedAt: 1, repoRoot: "/r", headSha: null, isWriter: false });
      markToolsSelected(db, "s2", true);
      const row = db.prepare("SELECT tools_selected FROM nav_session WHERE session_id='s2'").get() as any;
      assert.equal(row.tools_selected, 1);
      markToolsSelected(db, "s2", false);
      assert.equal((db.prepare("SELECT tools_selected FROM nav_session WHERE session_id='s2'").get() as any).tools_selected, 0);
    } finally { cleanup(p); }
  });
  ```

- [ ] **Step 2: Run, confirm failure**

  Run: `node --test src/telemetry/correlator.test.ts`
  Expected: FAIL - `recordGuard` / `markToolsSelected` are not exported from `queries.ts`.

- [ ] **Step 3: Implement types + queries + correlator methods**

  In `src/telemetry/types.ts` add:

  ```ts
  export type GuardAction = "block" | "warn" | "allow_fallback";
  export interface GuardRowInput {
    sessionId: string; ts: number; action: GuardAction;
    patternKind: GrepPatternKind | null; reason: string | null;
  }
  ```
  Import the kind: `import type { GrepPatternKind } from "../grep-guard.ts";` (type-only - runtime-erased).

  In `src/telemetry/queries.ts` add:

  ```ts
  import type { LocateRowInput, ConsumeRowInput, UnavailableRowInput, GuardRowInput } from "./types.ts";

  export function recordGuard(db: Db, row: GuardRowInput): void {
    db.prepare(
      `INSERT INTO nav_guard (session_id, ts, action, pattern_kind, reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.sessionId, row.ts, row.action, row.patternKind ?? null, row.reason ?? null);
  }

  export function markToolsSelected(db: Db, sessionId: string, selected: boolean): void {
    db.prepare("UPDATE nav_session SET tools_selected = ? WHERE session_id = ?").run(selected ? 1 : 0, sessionId);
  }
  ```

  In `src/telemetry/correlator.ts` import the new helpers and add guarded methods (same `this.guard(...)` wrapper used elsewhere):

  ```ts
  import { recordGuard, markToolsSelected } from "./queries.ts";
  import type { GuardAction } from "./types.ts";
  import type { GrepPatternKind } from "../grep-guard.ts";

  recordGuard(action: GuardAction, patternKind: GrepPatternKind | null, reason: string | null): void {
    this.guard(() => recordGuard(this.db, { sessionId: this.sessionId, ts: Date.now(), action, patternKind, reason }));
  }

  recordToolsSelected(selected: boolean): void {
    this.guard(() => markToolsSelected(this.db, this.sessionId, selected));
  }
  ```

  (The method and the imported function share the name `recordGuard` across module boundaries; the class method calls the imported query helper - no conflict since the import is referenced inside the method body. If the tool's linter objects to shadowing, alias the import as `recordGuardRow` and call that.)

- [ ] **Step 4: Run, confirm pass**

  Run: `node --test src/telemetry/correlator.test.ts`
  Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/telemetry/types.ts src/telemetry/queries.ts src/telemetry/correlator.ts src/telemetry/correlator.test.ts
  git commit -m "M3: recordGuard + tools_selected write path"
  ```

---

## Wave 3 - Telemetry consumers

Depends on Wave 2: stats aggregation reads `nav_guard` and `nav_session.tools_selected` written by Task 6.

### Task 7: M3 - stats aggregation + /navigator stats rendering

**TDD scenario:** Modifying tested code - extend `stats.test.ts`.

**Files:**
- Modify: `src/telemetry/types.ts` (extend `StatsSummary`)
- Modify: `src/telemetry/stats.ts`
- Modify: `src/telemetry/stats.test.ts`
- Modify: `src/commands.ts`

**Note on file ownership:** `types.ts` is also touched by Task 6 (Wave 2). This task runs in a later wave, so the edits are sequential, not concurrent - no wave-disjointness violation. Task 6 adds `GuardRowInput`/`GuardAction`; Task 7 adds fields to `StatsSummary`. Distinct symbols.

**Context (ground truth):** `aggregate(db, {scope})` already computes `sessionsTotal`/`sessionsWithLocate`/`bypassSessionRate` from `nav_session`. Add: a guard-fire count and the availability split (`tools_selected`).

- [ ] **Step 1: Write failing tests**

  Append to `src/telemetry/stats.test.ts` (match the existing tmp-DB + migrate setup used there):

  ```ts
  test("aggregate reports guard fire counts and availability split", () => {
    const p = tmp(); // existing helper in this file
    try {
      const db = openDb(p); migrate(db);
      // two sessions: one with the tool available, one without
      db.prepare("INSERT INTO nav_session (session_id, started_at, tools_selected, used_locate) VALUES ('avail', 1, 1, 0)").run();
      db.prepare("INSERT INTO nav_session (session_id, started_at, tools_selected, used_locate) VALUES ('unavail', 1, 0, 0)").run();
      db.prepare("INSERT INTO nav_guard (session_id, ts, action, pattern_kind, reason) VALUES ('avail', 1, 'block', 'symbol', 'x')").run();
      db.prepare("INSERT INTO nav_guard (session_id, ts, action, pattern_kind, reason) VALUES ('avail', 2, 'warn', NULL, 'y')").run();

      const s = aggregate(db, { scope: "lifetime" });
      assert.equal(s.guardBlocks, 1);
      assert.equal(s.guardWarns, 1);
      assert.equal(s.sessionsToolAvailable, 1);
      assert.equal(s.sessionsToolUnavailable, 1);
    } finally { cleanup(p); }
  });
  ```

  (If `stats.test.ts` lacks `tmp`/`cleanup` helpers, copy the four-line helpers from `schema.test.ts`.)

- [ ] **Step 2: Run, confirm failure**

  Run: `node --test src/telemetry/stats.test.ts`
  Expected: FAIL - `guardBlocks`/`guardWarns`/`sessionsToolAvailable`/`sessionsToolUnavailable` are not on `StatsSummary`.

- [ ] **Step 3: Implement aggregation + rendering**

  In `src/telemetry/types.ts`, extend `StatsSummary` with:

  ```ts
  guardBlocks: number; guardWarns: number; guardAllowFallback: number;
  sessionsToolAvailable: number; sessionsToolUnavailable: number;
  ```

  In `src/telemetry/stats.ts` `aggregate`, after the existing session query, add scope-aware guard + availability queries (mirror the `scope === "lifetime" ? ... : ... WHERE session_id = ?` pattern already used):

  ```ts
  const guardRows = (
    scope === "lifetime"
      ? db.prepare("SELECT action, COUNT(*) AS cnt FROM nav_guard GROUP BY action").all()
      : db.prepare("SELECT action, COUNT(*) AS cnt FROM nav_guard WHERE session_id = ? GROUP BY action").all(scope)
  ) as Array<{ action: string; cnt: number }>;
  const guardBy: Record<string, number> = {};
  for (const r of guardRows) guardBy[r.action] = r.cnt;
  const guardBlocks = guardBy["block"] ?? 0;
  const guardWarns = guardBy["warn"] ?? 0;
  const guardAllowFallback = guardBy["allow_fallback"] ?? 0;

  const availRow = (
    scope === "lifetime"
      ? db.prepare("SELECT COALESCE(SUM(tools_selected),0) AS avail, COUNT(*) AS total FROM nav_session").get()
      : db.prepare("SELECT COALESCE(SUM(tools_selected),0) AS avail, COUNT(*) AS total FROM nav_session WHERE session_id = ?").get(scope)
  ) as { avail: number; total: number };
  const sessionsToolAvailable = availRow?.avail ?? 0;
  const sessionsToolUnavailable = (availRow?.total ?? 0) - sessionsToolAvailable;
  ```

  Add all five to the returned object literal.

  In `src/commands.ts` `formatStats`, add lines (after `bypass_session_rate`):

  ```ts
    `  sessions_tool_available   ${s.sessionsToolAvailable}`,
    `  sessions_tool_unavailable ${s.sessionsToolUnavailable}`,
    `  guard_blocks              ${s.guardBlocks}`,
    `  guard_warns               ${s.guardWarns}`,
  ```

- [ ] **Step 4: Run, confirm pass**

  Run: `node --test src/telemetry/stats.test.ts`
  Expected: PASS. Then `npm run typecheck` (StatsSummary is constructed in `aggregate` only; confirm no other constructor of the type exists - `rg -n "StatsSummary" src` shows it is only returned by `aggregate` and consumed by `formatStats`).

- [ ] **Step 5: Commit**

  ```bash
  git add src/telemetry/types.ts src/telemetry/stats.ts src/telemetry/stats.test.ts src/commands.ts
  git commit -m "M3: aggregate guard counts + availability split; render in /navigator stats"
  ```

---

## Wave 4 - Integration + docs

Depends on all prior waves: `index.ts` wires the new module behavior into pi hooks.

### Task 8: Integration in index.ts + M5 docs

**TDD scenario:** Modifying integration glue with no unit-test seam - verify by typecheck + full suite + manual load. `index.ts` has no colocated test (it is the pi entrypoint); the behavior it wires is unit-tested in Tasks 1-7.

**Files:**
- Modify: `index.ts`
- Modify: `NAVIGATOR.md`
- Modify: `README.md`

**Context (ground truth, `index.ts`):**
- `grepProbeDir(p)` calls `statSync(p)` against the extension process cwd, not `sessionCwd` (captured in `session_start`). M2 requires probing relative to the session cwd.
- `before_agent_start` early-returns `if (!state || repoStatus !== "ready") return;`. M1 drops the `repoStatus !== "ready"` clause (keep `!state` -> terminal non_git/disabled inject nothing).
- The `tool_call` handler computes `decision = decideGrepAction(...)`; M3 requires recording the guard decision there.
- `correlator` is created in `session_start`; `tools_selected` must be written in `before_agent_start` via `correlator.recordToolsSelected(...)`.

- [ ] **Step 1: M2 - cwd-aware grep probe**

  Make `grepProbeDir` resolve relative paths against the active session cwd. Change it from a free function to a cwd-bound closure built per tool call (the handler already has access to module-scoped `sessionCwd`). Replace the free `grepProbeDir` with a factory:

  ```ts
  import { isAbsolute, resolve } from "node:path";

  function makeGrepProbeDir(cwd: string): (p: string) => boolean {
    return (p: string) => {
      try {
        const abs = isAbsolute(p) ? p : resolve(cwd, p);
        return statSync(abs).isDirectory();
      } catch {
        return false; // allow-on-unknown: unparseable / missing path is not a scan
      }
    };
  }
  ```

  In the `tool_call` handler, build the probe with `sessionCwd`:

  ```ts
  const probeDir = makeGrepProbeDir(sessionCwd);
  const classification = classifyGrepCommand(event.input.command, probeDir);
  if (!classification.isRepoScan) return;
  // ... existing rgAvailable check ...
  const decision = decideGrepAction({
    command: event.input.command,
    probeDir,
    rgAvailable,
    navigatorActive,
    classification,
  });
  ```

  Note the behavior change: the old fallback guessed `p === "." || p.endsWith("/")` as a directory when stat failed; the new probe returns `false` on stat failure (allow-on-unknown, per spec M2 "bias to allow"). `.`/`..`/existing dirs still stat as directories against `sessionCwd`, so real scans (`grep -r x .`, `grep x src/`) keep blocking when the cwd is the repo.

- [ ] **Step 2: M3 - record the guard decision**

  In the `tool_call` handler, after computing `decision` and before returning, map and record (only when telemetry/correlator is live). Map `GrepAction` -> `GuardAction`:

  ```ts
  if (correlator) {
    const action = decision.action === "block" ? "block" : decision.warn ? "warn" : null;
    // A plain allow (not warn) on a classified repo-scan only reaches here when
    // navigatorActive is false or rg is unavailable -> the fallback-path allow.
    const guardAction = action ?? "allow_fallback";
    correlator.recordGuard(guardAction, classification.patternKind, decision.reason ?? null);
  }
  ```

  Place this after the `decision.warn && !rgWarnedOnce` notify block. The handler still returns `{ block: true, reason }` for blocks and `undefined` otherwise.

  Note: this records a guard row for **every** classified repo-scan that reaches the decision (block, warn, or fallback-allow). Non-repo-scan greps return earlier and are not recorded - correct, they were never guard candidates.

- [ ] **Step 3: M1 - relax the before_agent_start gate + write tools_selected**

  Change the early return:

  ```ts
  // was: if (!state || repoStatus !== "ready") return;
  if (!state) return; // terminal (non_git / disabled): inject nothing
  ```

  Inside `before_agent_start`, after computing `selectedTools`, record availability unconditionally:

  ```ts
  const selectedTools = event.systemPromptOptions?.selectedTools;
  correlator?.recordToolsSelected(selectedTools?.includes("navigator_locate") === true);
  ```

  The existing `buildNavigatorPromptGuidance({...})` call already passes `selectedTools`, `coverage`, `fullCrawlDone`, `indexedHead`, `currentHead`, `dirty`, `workerFailed` - no change to the args object. The builder (Task 1) now internally handles boot/weak/strong + caveats, so removing the `repoStatus` gate is the only logic change here.

- [ ] **Step 4: Verify integration**

  Run: `npm run typecheck`
  Expected: clean.
  Run: `node --test`
  Expected: all green (Tasks 1-7 suites + unchanged suites).
  Manual smoke (optional, post-merge): `pi -e $(pwd)/index.ts` in this worktree; `/navigator status` shows the shared DB path; issue an orientation prompt and confirm guidance appears while indexing; run `grep -n x README.md; ls -R .` and confirm it is NOT blocked.

- [ ] **Step 5: M5 - docs**

  In `NAVIGATOR.md`:
  - Rewrite the **Prompt Guidance Readiness** section (currently asserts persona fires only when "coverage is complete, full_crawl_done, head matches, tree clean"). Replace with the availability-gated model: guidance presence depends solely on `navigator_locate` being selected; index state controls tier (strong at `coverage >= 0.9 && full_crawl_done`, weak otherwise) and caveat text (booting, ranking-lag); persona suppressed until `coverage.indexed > 0`; terminal states (non-git/disabled) inject nothing.
  - In **Index Location**, change the `repo_name` bullet from "basename of the worktree top-level directory" to: "basename of the **main worktree** (parent of `git rev-parse --git-common-dir`); all linked worktrees resolve to the same name and share one index + telemetry DB. Bare repos and parse failures fall back to `basename(root)`."
  - Add a short **Grep Guard** note (or extend an existing section): single-file greps are never blocked, including inside `;`/`&&`/`$(...)`; only a grep that scans a directory (recursive flag or a directory path arg, probed against the session cwd) is blocked; allow-on-unknown.

  In `README.md`:
  - Under **Prerequisites** (or a new short note), add the environment prerequisite: user-global agent-instruction files must not hardcode search-tool preferences (e.g. "prefer rg/fd") with no navigator mention; navigator owns search-tool routing where installed.
  - Add the optional per-repo AGENTS.md snippet from the spec M5:

    > Repo orientation: prefer `navigator_locate` for finding where code or docs live before broad rg/find/read; use rg/fd for regex or content scans, and as fallback when navigator is unavailable.

- [ ] **Step 6: Commit**

  ```bash
  git add index.ts NAVIGATOR.md README.md
  git commit -m "Integration: wire M1/M2/M3 in index.ts; M5 docs"
  ```

---

## Post-Implementation Verification

After Task 8:

```bash
npm run typecheck
node --test
```

Both must be green. Then confirm spec coverage:
- M1 -> Tasks 1, 8 (builder + gate removal + tools_selected unconditional).
- M2 -> Tasks 2, 8 (segmentation + cwd-aware probe + recordGuard mapping of allow_fallback).
- M3 -> Tasks 3, 5, 6, 7, 8 (schema v3, pipe-aware detect, write path, consumers, call sites).
- M4 -> Task 4 (shared repoName; telemetry DB shares automatically via `telemetryPathFor`).
- M5 -> Task 8 (NAVIGATOR.md + README.md).

Stale per-worktree DB files are deleted manually post-release (no code; spec Non-Goal).
