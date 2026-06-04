# Usefulness Telemetry & Offline Quality Judge — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans (or subagent-driven-development) skill to implement this plan task-by-task.

**Goal:** Persist a raw, append-only telemetry event log of navigator usage + the agent's follow-on actions, derive usefulness metrics from it, surface them via `/navigator stats`, and ship an offline judge skill that explains navigation gaps against the live index.

**Architecture:** A separate SQLite telemetry DB (sibling of the index DB, every session writes independently) is fed by a main-thread `TelemetryCorrelator` subscribed to the existing tool-event stream. A pure `stats.ts` derivation layer turns raw rows into metrics (parameterized by an attribution `turnCap`). A `/navigator stats` command and an offline `scripts/export-cases.ts` (joined against the live index DB for recall ground truth) read the DB; neither mutates it.

**Tech Stack:** Node 24 native type-stripping (`.ts` extension imports), `node:sqlite` (WAL, lazy `createRequire`), `node --test`, TypeBox tools, pi extension API (`@earendil-works/pi-coding-agent`, type-only peer dep).

**Spec:** `doc/specs/2026-06-03-usefulness-telemetry.md`

**Linear:** none

---

## Ground-Truth API Notes (verified against installed pi runtime)

These were confirmed by reading the installed package's `.d.ts`; do not re-derive:

- Session id accessor: **`ctx.n.getSessionId(): string`** (`ctx.n` is `ReadonlySessionManager`). There is **no** `ctx.sessionManager`. `getSessionId` and `getSessionFile` both exist on the `Pick`.
- `TurnStartEvent` = `{ type: "turn_start"; turnIndex: number; timestamp: number }`. Subscribe via `pi.on("turn_start", handler)`. Use `event.turnIndex` directly — do **not** maintain a separate turn counter.
- `ToolExecutionStartEvent` = `{ type, toolCallId, toolName, args }`.
- `ToolExecutionEndEvent` = `{ type, toolCallId, toolName, result: any, isError: boolean }`. The tool's returned object (`{ content, details }`) is reachable as `event.result?.details`.
- All `pi.on(...)` handlers receive `(event, ctx)` where `ctx` is `ExtensionContext` (has `ctx.n`, `ctx.cwd`).
- `LocateResponse` (current, `src/types.ts`) has `{ results, cluster, index: {fresh, head_behind, coverage, dirty}, confidence }`. It does **not** yet expose `has_exact_def` / `used_or_fallback` / `top_has_anchor`; Task 1 adds them.
- `tools.ts` returns `details: res` for locate (the raw `LocateResponse`) and `details: r` for slice (the raw `SliceResult` = `{path, range, content, content_hash, stale_index, unchanged_since_last_read}`).

---

## Files

**Create:**
- `src/paths.ts` — shared `toRepoRel(root, p, cwd)` (extracted from `index.ts`)
- `src/paths.test.ts`
- `src/telemetry/types.ts` — telemetry row/result/summary interfaces + enums
- `src/telemetry/db.ts` — telemetry DB open (reuses `openDb`) + retention prune
- `src/telemetry/schema.ts` — `TELEMETRY_SCHEMA_VERSION`, DDL, `migrate()`, `pruneOld()`
- `src/telemetry/queries.ts` — prepared insert/select helpers
- `src/telemetry/detect.ts` — pure `detectSearch()` + `classifyQuery()`
- `src/telemetry/detect.test.ts`
- `src/telemetry/correlator.ts` — `TelemetryCorrelator` (stateful capture)
- `src/telemetry/correlator.test.ts`
- `src/telemetry/stats.ts` — `deriveLocateOutcomes()` + `aggregate()`
- `src/telemetry/stats.test.ts`
- `src/telemetry/schema.test.ts`
- `scripts/export-cases.ts` — judge export (telemetry + index DB join)
- `scripts/export-cases.test.ts`
- `.agents/skills/usefulness-judge/SKILL.md`

**Modify:**
- `src/types.ts` — add telemetry fields to `NavigatorConfig`; add 3 confidence-input booleans to `LocateResponse`
- `src/config.ts` — add telemetry defaults to `DEFAULT_CONFIG`
- `src/config.test.ts` — assert new defaults
- `src/navigator/locate.ts` — populate the 3 confidence-input booleans on every return
- `src/navigator/locate.test.ts` — assert the new fields
- `index.ts` — import `toRepoRel` from `src/paths.ts`; wire correlator lifecycle; add `turn_start`; provide telemetry accessor to the command
- `src/commands.ts` — add `stats` subcommand + extend `NavigatorState`
- `src/commands.test.ts` — assert `parseSub("stats")` + stats rendering

**Delete:** none

---

## Phase 1 — Capture Pipeline (Waves 1–3)

Builds and proves the data layer end-to-end on synthetic events. No live-session wiring yet.

## Wave 1 — Foundations

Parallel-safe: Task 1 and Task 2 own disjoint files (Task 1 = `types.ts`/`config.ts`/`config.test.ts`/`navigator/locate.ts`/`navigator/locate.test.ts`; Task 2 = `paths.ts`/`paths.test.ts`/`index.ts`).

### Task 1: Config fields + surface locate confidence inputs

**TDD scenario:** Modifying tested code — run existing `config.test.ts` and `locate.test.ts` first, extend them.

**Files:**
- Modify: `src/types.ts` (NavigatorConfig, LocateResponse)
- Modify: `src/config.ts:7-21` (DEFAULT_CONFIG)
- Modify: `src/config.test.ts`
- Modify: `src/navigator/locate.ts` (the `empty` literal + final return + add fields)
- Modify: `src/navigator/locate.test.ts`

- [ ] **Step 1: Extend the two interfaces in `src/types.ts`**

  In `NavigatorConfig` (after `keywordMinLength: number;`):
  ```ts
  telemetry: boolean;              // master switch; default false
  telemetryStoreQueries: boolean;  // store raw query text; default true
  telemetryTurnCap: number;        // attribution window cap in assistant turns; default 10
  telemetryRetentionDays: number;  // prune rows older than this on DB open; default 30
  ```
  In `LocateResponse` (after `confidence: "high" | "low";`):
  ```ts
  // raw inputs to the confidence verdict, surfaced for telemetry/judge calibration
  has_exact_def: boolean;
  used_or_fallback: boolean;
  top_has_anchor: boolean;
  ```

- [ ] **Step 2: Run typecheck, confirm it fails**

  Run: `npm run typecheck`
  Expected: errors in `locate.ts` (returns missing the 3 new required fields) and `config.ts` (DEFAULT_CONFIG missing 4 keys).

- [ ] **Step 3: Add defaults in `src/config.ts`**

  Append to the `DEFAULT_CONFIG` object literal (before the closing `};`):
  ```ts
  telemetry: false,
  telemetryStoreQueries: true,
  telemetryTurnCap: 10,
  telemetryRetentionDays: 30,
  ```

- [ ] **Step 4: Populate the booleans in `src/navigator/locate.ts`**

  The `empty` response literal (currently `{ results: [], cluster: null, index: indexStatus, confidence: "low" }`) becomes:
  ```ts
  const empty: LocateResponse = {
    results: [],
    cluster: null,
    index: indexStatus,
    confidence: "low",
    has_exact_def: false,
    used_or_fallback: false,
    top_has_anchor: false,
  };
  ```
  The final `return { results, cluster, index: indexStatus, confidence };` becomes:
  ```ts
  return {
    results,
    cluster,
    index: indexStatus,
    confidence,
    has_exact_def: hasExactDef,
    used_or_fallback: usedOrFallback,
    top_has_anchor: topHasAnchor,
  };
  ```
  `hasExactDef`, `usedOrFallback`, `topHasAnchor` already exist as locals in `locate()` (computed at the `confidence` block). No new computation — only expose them.

- [ ] **Step 5: Extend `src/config.test.ts`**

  Add assertions that `DEFAULT_CONFIG.telemetry === false`, `telemetryStoreQueries === true`, `telemetryTurnCap === 10`, `telemetryRetentionDays === 30`, and that `mergeConfig({ telemetry: true }).telemetry === true`.

- [ ] **Step 6: Extend `src/navigator/locate.test.ts`**

  In an existing high-confidence exact-symbol case, assert `res.has_exact_def === true` and `res.top_has_anchor === true`. In an existing empty/no-result case, assert all three are `false`.

- [ ] **Step 7: Run typecheck + tests, confirm green**

  Run: `npm run typecheck && node --test src/config.test.ts src/navigator/locate.test.ts`
  Expected: PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add src/types.ts src/config.ts src/config.test.ts src/navigator/locate.ts src/navigator/locate.test.ts
  git commit -m "feat(telemetry): config flags + surface locate confidence inputs"
  ```

### Task 2: Extract `toRepoRel` into `src/paths.ts`

**TDD scenario:** New module — full TDD cycle.

**Files:**
- Create: `src/paths.ts`
- Create: `src/paths.test.ts`
- Modify: `index.ts:36-43` (remove local `toRepoRel`, import from `./src/paths.ts`)

- [ ] **Step 1: Write the failing test (`src/paths.test.ts`)**

  ```ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { toRepoRel } from "./paths.ts";

  test("toRepoRel returns POSIX repo-relative path for in-repo file", () => {
    assert.equal(toRepoRel("/repo", "src/a.ts", "/repo"), "src/a.ts");
    assert.equal(toRepoRel("/repo", "/repo/src/a.ts", "/anywhere"), "src/a.ts");
  });

  test("toRepoRel returns undefined when path escapes the repo root", () => {
    assert.equal(toRepoRel("/repo", "../outside.ts", "/repo"), undefined);
  });
  ```

- [ ] **Step 2: Run test, confirm failure**

  Run: `node --test src/paths.test.ts`
  Expected: FAIL — cannot find module `./paths.ts`.

- [ ] **Step 3: Create `src/paths.ts`** — move the exact body from `index.ts`:

  ```ts
  import { relative, resolve, sep, posix } from "node:path";

  /**
   * Converts an absolute or cwd-relative path to a repo-relative POSIX path.
   * Returns undefined if the resolved path escapes the repo root.
   */
  export function toRepoRel(root: string, p: string, cwd: string): string | undefined {
    const abs = resolve(cwd, p);
    const rel = relative(root, abs);
    const posixRel = rel.split(sep).join(posix.sep);
    if (posixRel.startsWith("..")) return undefined;
    return posixRel;
  }
  ```

- [ ] **Step 4: Update `index.ts`** — delete the local `toRepoRel` function (lines 36–43) and its `relative, resolve, sep` / `posix` imports if now unused, then add:
  ```ts
  import { toRepoRel } from "./src/paths.ts";
  ```
  Keep any other `node:path` imports `index.ts` still needs.

- [ ] **Step 5: Run test + typecheck, confirm green**

  Run: `node --test src/paths.test.ts && npm run typecheck`
  Expected: PASS; `index.ts` still compiles.

- [ ] **Step 6: Commit**

  ```bash
  git add src/paths.ts src/paths.test.ts index.ts
  git commit -m "refactor: extract toRepoRel into src/paths.ts"
  ```

## Wave 2 — Storage & detectors

Depends on Wave 1: Task 3 reads the new `NavigatorConfig.telemetry*` fields. Parallel-safe: Task 3 owns `src/telemetry/{types,db,schema,queries}.ts` + `schema.test.ts`; Task 4 owns `src/telemetry/detect.ts` + `detect.test.ts`.

### Task 3: Telemetry storage layer

**TDD scenario:** New modules — full TDD cycle (schema/migrate/retention tested; types & queries are exercised by later waves).

**Files:**
- Create: `src/telemetry/types.ts`
- Create: `src/telemetry/db.ts`
- Create: `src/telemetry/schema.ts`
- Create: `src/telemetry/queries.ts`
- Create: `src/telemetry/schema.test.ts`

- [ ] **Step 1: Write `src/telemetry/types.ts`** (types only, no runtime):

  ```ts
  export type Outcome = "hit" | "miss-fallback" | "abandoned";
  export type ConsumeKind = "slice" | "read" | "search";
  export type UnavailableReason = "non_git" | "disabled" | "booting";
  export type QueryType = "identifier" | "keyword" | "open-ended";
  export type SearchTool = "rg" | "grep" | "find" | "fd" | "ag" | "ack" | "git-grep";

  export interface ResultMeta {
    path: string;
    score: number;
    signals: { fts: number; path: number; symbol: number; recency: number };
  }

  export interface LocateRowInput {
    sessionId: string;
    seq: number;
    turn: number;
    ts: number;
    headSha: string | null;
    query: string | null;
    queryTokenCount: number;
    queryType: QueryType;
    limitN: number;
    resultCount: number;
    confidence: "high" | "low";
    hasExactDef: boolean;
    usedOrFallback: boolean;
    topHasAnchor: boolean;
    coverage: number;
    dirty: boolean;
    headBehind: number;
    fresh: boolean;
    latencyMs: number;
    resultsMetadata: ResultMeta[];
    cochange: string[];
    referrers: string[];
  }

  export interface ConsumeRowInput {
    sessionId: string;
    seq: number;
    turn: number;
    ts: number;
    kind: ConsumeKind;
    path: string | null;
    locateRank: number | null;
    staleIndex: boolean | null;
    unchanged: boolean | null;
    searchTool: SearchTool | null;
    searchPattern: string | null;
    latencyMs: number | null;
    isError: boolean;
  }

  export interface UnavailableRowInput {
    sessionId: string;
    seq: number;
    turn: number;
    ts: number;
    tool: "navigator_locate" | "navigator_slice";
    reason: UnavailableReason;
  }

  export interface LocateOutcome {
    locateId: number;
    sessionId: string;
    confidence: "high" | "low";
    resultCount: number;
    outcome: Outcome;
    justifiedFallback: boolean;
    consumedRank: number | null;
    turnsToConsume: number | null;
  }

  export interface StatsSummary {
    scope: string;
    locateTotal: number;
    hitRate: number;
    missFallback: number;
    missFallbackUnjustified: number;
    abandoned: number;
    zeroResultLocates: number;
    fallbackSearches: number;
    unavailableByReason: Record<string, number>;
    sessionsTotal: number;
    sessionsWithLocate: number;
    bypassSessionRate: number;
    mrr: number;
    hitAt1: number;
    hitAt3: number;
    hitAt5: number;
    lowConfPrecision: number;
    highConfPrecision: number;
    medianTurnsToUseful: number;
    staleSliceRate: number;
    unchangedReadsAvoided: number;
  }
  ```

- [ ] **Step 2: Write `src/telemetry/schema.ts`**

  ```ts
  import type { Db } from "../store/db.ts";

  export const TELEMETRY_SCHEMA_VERSION = 1;

  const DDL = `
  CREATE TABLE IF NOT EXISTS tmeta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS nav_session (
    session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, repo_root TEXT,
    head_sha TEXT, is_writer INTEGER DEFAULT 0, used_locate INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS nav_locate (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
    turn INTEGER NOT NULL, ts INTEGER NOT NULL, head_sha TEXT,
    query TEXT, query_token_count INTEGER, query_type TEXT,
    limit_n INTEGER, result_count INTEGER, confidence TEXT,
    has_exact_def INTEGER, used_or_fallback INTEGER, top_has_anchor INTEGER,
    coverage REAL, dirty INTEGER, head_behind INTEGER, fresh INTEGER,
    latency_ms INTEGER, results_metadata TEXT, cochange TEXT, referrers TEXT);
  CREATE INDEX IF NOT EXISTS idx_locate_session_seq ON nav_locate(session_id, seq);
  CREATE TABLE IF NOT EXISTS nav_consume (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
    turn INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
    path TEXT, locate_rank INTEGER, stale_index INTEGER, unchanged INTEGER,
    search_tool TEXT, search_pattern TEXT, latency_ms INTEGER, is_error INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS idx_consume_session_seq ON nav_consume(session_id, seq);
  CREATE TABLE IF NOT EXISTS nav_unavailable (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
    turn INTEGER NOT NULL, ts INTEGER NOT NULL, tool TEXT NOT NULL, reason TEXT NOT NULL);
  `;

  export function migrate(db: Db): void {
    db.exec("CREATE TABLE IF NOT EXISTS tmeta (key TEXT PRIMARY KEY, value TEXT)");
    const stored = (db.prepare("SELECT value FROM tmeta WHERE key='schema_version'").get() as
      | { value: string } | undefined)?.value;
    const storedVersion = stored ? parseInt(stored, 10) : 0;
    if (storedVersion > 0 && storedVersion < TELEMETRY_SCHEMA_VERSION) {
      // Telemetry is disposable: on a breaking bump, drop and rebuild empty.
      db.exec("BEGIN IMMEDIATE");
      db.exec("DROP TABLE IF EXISTS nav_locate");
      db.exec("DROP TABLE IF EXISTS nav_consume");
      db.exec("DROP TABLE IF EXISTS nav_unavailable");
      db.exec("DROP TABLE IF EXISTS nav_session");
      db.exec("COMMIT");
    }
    db.exec(DDL);
    db.prepare(
      "INSERT INTO tmeta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(TELEMETRY_SCHEMA_VERSION));
  }

  export function pruneOld(db: Db, retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    db.prepare("DELETE FROM nav_locate WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM nav_consume WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM nav_unavailable WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM nav_session WHERE started_at < ?").run(cutoff);
  }
  ```

- [ ] **Step 3: Write `src/telemetry/db.ts`**

  ```ts
  import { openDb, type Db } from "../store/db.ts";
  import { migrate, pruneOld } from "./schema.ts";

  /** Telemetry DB path = index dbPath with `.db` → `.telemetry.db`. */
  export function telemetryPathFor(indexDbPath: string): string {
    return indexDbPath.replace(/\.db$/, ".telemetry.db");
  }

  /** Open + migrate + prune. Returns null on any failure (telemetry must never break the session). */
  export function openTelemetryDb(indexDbPath: string, retentionDays: number): Db | null {
    try {
      const db = openDb(telemetryPathFor(indexDbPath));
      migrate(db);
      pruneOld(db, retentionDays);
      return db;
    } catch {
      return null;
    }
  }
  ```

- [ ] **Step 4: Write `src/telemetry/queries.ts`** — prepared insert/update helpers + the reads `stats.ts` needs. Each insert maps an input interface to a row; booleans stored as `0|1`, arrays/objects as `JSON.stringify`.

  Required exports (exact signatures):
  ```ts
  import type { Db } from "../store/db.ts";
  import type {
    LocateRowInput, ConsumeRowInput, UnavailableRowInput,
  } from "./types.ts";

  export function ensureSession(db: Db, row: {
    sessionId: string; startedAt: number; repoRoot: string; headSha: string | null; isWriter: boolean;
  }): void;                                   // INSERT OR IGNORE into nav_session
  export function markWriter(db: Db, sessionId: string): void;        // UPDATE is_writer=1
  export function markUsedLocate(db: Db, sessionId: string): void;    // UPDATE used_locate=1
  export function insertLocate(db: Db, row: LocateRowInput): number;  // RETURNING id
  export function insertConsume(db: Db, row: ConsumeRowInput): void;
  export function insertUnavailable(db: Db, row: UnavailableRowInput): void;
  ```
  Implementation notes: `b(v: boolean): 0|1` helper; `JSON.stringify(resultsMetadata|cochange|referrers)`; mirror the `upsertFile` RETURNING pattern from `src/store/queries.ts` for `insertLocate`.

- [ ] **Step 5: Write `src/telemetry/schema.test.ts`**

  Use an in-memory or tmp-file DB via `openDb` (tmp file under `os.tmpdir()`, deleted in a `finally`). Assert:
  - `migrate` is idempotent: run twice, then insert a `nav_session` row and read it back.
  - `pruneOld(db, 30)` deletes a `nav_locate` row with `ts = Date.now() - 31*86400000` and keeps one with `ts = Date.now()`.
  - `tmeta.schema_version === "1"` after migrate.

- [ ] **Step 6: Run tests + typecheck, confirm green**

  Run: `node --test src/telemetry/schema.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add src/telemetry/types.ts src/telemetry/db.ts src/telemetry/schema.ts src/telemetry/queries.ts src/telemetry/schema.test.ts
  git commit -m "feat(telemetry): storage layer (schema, db open, queries)"
  ```

### Task 4: Pure input detectors (`detectSearch` + `classifyQuery`)

**TDD scenario:** New module — full TDD cycle.

**Files:**
- Create: `src/telemetry/detect.ts`
- Create: `src/telemetry/detect.test.ts`

- [ ] **Step 1: Write the failing test (`src/telemetry/detect.test.ts`)** — table-driven:

  ```ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { detectSearch, classifyQuery } from "./detect.ts";

  test("detectSearch recognizes search tools and extracts the pattern", () => {
    assert.deepEqual(detectSearch("rg -n foo src/"), { tool: "rg", pattern: "foo" });
    assert.deepEqual(detectSearch("grep -ri Bar ."), { tool: "grep", pattern: "Bar" });
    assert.deepEqual(detectSearch("git grep needle"), { tool: "git-grep", pattern: "needle" });
    assert.deepEqual(detectSearch("fd widget"), { tool: "fd", pattern: "widget" });
    assert.deepEqual(detectSearch("find . -name '*.ts'"), { tool: "find", pattern: "*.ts" });
    assert.deepEqual(detectSearch("cat foo | rg baz"), { tool: "rg", pattern: "baz" });
  });

  test("detectSearch returns null for non-search bash", () => {
    assert.equal(detectSearch("curl -H 'Authorization: x' https://h"), null);
    assert.equal(detectSearch("psql -c 'select 1'"), null);
    assert.equal(detectSearch("npm run typecheck"), null);
  });

  test("classifyQuery splits identifier / keyword / open-ended", () => {
    assert.deepEqual(classifyQuery("RollingIndexer"), { type: "identifier", tokenCount: 1 });
    assert.deepEqual(classifyQuery("Foo::Bar"), { type: "identifier", tokenCount: 1 });
    assert.deepEqual(classifyQuery("rolling indexer"), { type: "keyword", tokenCount: 2 });
    assert.deepEqual(classifyQuery("where do we open the db"), { type: "open-ended", tokenCount: 6 });
  });
  ```

- [ ] **Step 2: Run test, confirm failure**

  Run: `node --test src/telemetry/detect.test.ts`
  Expected: FAIL — cannot find module `./detect.ts`.

- [ ] **Step 3: Implement `src/telemetry/detect.ts`**

  ```ts
  import type { QueryType, SearchTool } from "./types.ts";

  const TOOL_PATTERNS: { tool: SearchTool; re: RegExp }[] = [
    { tool: "git-grep", re: /(?:^|\|)\s*git\s+grep\s+(.+)$/ },
    { tool: "rg", re: /(?:^|\|)\s*rg\s+(.+)$/ },
    { tool: "grep", re: /(?:^|\|)\s*(?:e|f)?grep\s+(.+)$/ },
    { tool: "fd", re: /(?:^|\|)\s*fd(?:find)?\s+(.+)$/ },
    { tool: "ag", re: /(?:^|\|)\s*ag\s+(.+)$/ },
    { tool: "ack", re: /(?:^|\|)\s*ack\s+(.+)$/ },
    { tool: "find", re: /(?:^|\|)\s*find\s+(.+)$/ },
  ];

  /** Strip surrounding single/double quotes from a token. */
  function unquote(t: string): string {
    return t.replace(/^['"]|['"]$/g, "");
  }

  /** First non-flag argument; for `find`, the value following -name/-iname/-path. */
  function extractPattern(tool: SearchTool, rest: string): string | null {
    const toks = rest.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    if (tool === "find") {
      for (let i = 0; i < toks.length - 1; i++) {
        if (/^-(i?name|path)$/.test(toks[i])) return unquote(toks[i + 1]);
      }
      return null;
    }
    for (const t of toks) {
      if (t.startsWith("-")) continue;
      return unquote(t);
    }
    return null;
  }

  export function detectSearch(command: string): { tool: SearchTool; pattern: string } | null {
    for (const { tool, re } of TOOL_PATTERNS) {
      const m = command.match(re);
      if (m) {
        const pattern = extractPattern(tool, m[1]);
        if (pattern !== null) return { tool, pattern };
      }
    }
    return null;
  }

  export function classifyQuery(query: string): { type: QueryType; tokenCount: number } {
    const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0);
    const tokenCount = tokens.length;
    if (tokenCount === 1) {
      const t = tokens[0];
      const identifierLike =
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) || /[.:]/.test(t);
      return { type: identifierLike ? "identifier" : "open-ended", tokenCount };
    }
    if (tokenCount <= 3) return { type: "keyword", tokenCount };
    return { type: "open-ended", tokenCount };
  }
  ```
  Note: `git-grep` must be matched before `grep`; `rg`/`fd` before generic fallbacks. The `(?:^|\|)` anchor catches post-pipe usage.

- [ ] **Step 4: Run test, confirm pass**

  Run: `node --test src/telemetry/detect.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/telemetry/detect.ts src/telemetry/detect.test.ts
  git commit -m "feat(telemetry): pure detectSearch + classifyQuery"
  ```

## Wave 3 — Correlator & derivation

Depends on Wave 2: Task 5 imports `queries.ts`, `detect.ts`, `types.ts`, `src/paths.ts`, `src/worktree.ts`; Task 6 imports `types.ts` + reads the schema's tables. Parallel-safe: Task 5 owns `correlator.{ts,test.ts}`; Task 6 owns `stats.{ts,test.ts}`.

### Task 5: `TelemetryCorrelator`

**TDD scenario:** New module — full TDD cycle with synthetic events.

**Files:**
- Create: `src/telemetry/correlator.ts`
- Create: `src/telemetry/correlator.test.ts`

- [ ] **Step 1: Write the failing test (`src/telemetry/correlator.test.ts`)**

  Open a tmp telemetry DB (`openDb` + `migrate`). Construct the correlator, feed synthetic events, then assert rows via direct SQL. Event shapes mirror the runtime:
  ```ts
  const startEv = (id: string, toolName: string, args: any) => ({ toolCallId: id, toolName, args });
  const endEv = (id: string, toolName: string, details: any, isError = false) =>
    ({ toolCallId: id, toolName, result: { details }, isError });
  ```
  Cover these cases (each its own `test(...)`):
  1. **locate→slice hit:** feed a `navigator_locate` end whose `details.results = [{path:"a.ts",score:9,signals:{...}}, {path:"b.ts",...}]`; then a `navigator_slice` end with `details.path="b.ts"`. Assert one `nav_locate` row, one `nav_consume(kind='slice', path='b.ts', locate_rank=2)`, and `nav_session.used_locate=1`.
  2. **locate→rg miss-fallback:** locate end, then a `bash` end with `args.command="rg foo"`. Assert `nav_consume(kind='search', search_tool='rg', search_pattern='foo')`.
  3. **read of returned path:** locate returning `["x.ts"]`, then `read` end with `args.path` absolute inside root. Assert `nav_consume(kind='read', path='x.ts', locate_rank=1)`.
  4. **read escaping root:** `read` with `args.path="../outside"` → no `nav_consume` row.
  5. **unavailable routing:** locate end with `result.details` undefined (the dormant text result) → `nav_unavailable(tool='navigator_locate', reason=...)`, no `nav_locate`.
  6. **slice error branch:** `navigator_slice` end with `isError=true` → `nav_consume(kind='slice', is_error=1)`.
  7. **non-search bash ignored:** `bash` end with `args.command="npm test"` → no row.
  8. **seq/turn monotonicity:** after `bumpTurn(3)`, a subsequent locate row has `turn=3`; `seq` strictly increases across successive ends.
  9. **storeQueries=false:** locate row has `query IS NULL` but `query_token_count` populated.

- [ ] **Step 2: Run test, confirm failure**

  Run: `node --test src/telemetry/correlator.test.ts`
  Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/telemetry/correlator.ts`**

  Class with this contract (constructor records the session row immediately):
  ```ts
  import type { Db } from "../store/db.ts";
  import { headSha } from "../worktree.ts";
  import { toRepoRel } from "../paths.ts";
  import { detectSearch, classifyQuery } from "./detect.ts";
  import {
    ensureSession, markWriter, markUsedLocate,
    insertLocate, insertConsume, insertUnavailable,
  } from "./queries.ts";
  import type { ResultMeta, UnavailableReason } from "./types.ts";

  export interface CorrelatorOpts {
    db: Db; sessionId: string; root: string; sessionCwd: string;
    headSha: string | null; isWriter: boolean; storeQueries: boolean;
  }

  interface ToolEndLike { toolCallId: string; toolName: string; result: any; isError: boolean; }
  interface ToolStartLike { toolCallId: string; toolName: string; args: any; }

  export class TelemetryCorrelator {
    private seq = 0;
    private turn = 0;
    private warned = false;
    private pendingStart = new Map<string, number>();   // toolCallId → start ts
    private lastLocate: ResultMeta[] | null = null;
    constructor(private o: CorrelatorOpts) {
      this.guard(() => ensureSession(o.db, {
        sessionId: o.sessionId, startedAt: Date.now(), repoRoot: o.root,
        headSha: o.headSha, isWriter: o.isWriter,
      }));
    }
    bumpTurn(turnIndex: number): void { this.turn = turnIndex; }
    markWriter(): void { this.guard(() => markWriter(this.o.db, this.o.sessionId)); }
    onToolStart(ev: ToolStartLike): void { this.pendingStart.set(ev.toolCallId, Date.now()); }
    onToolEnd(ev: ToolEndLike): void { this.guard(() => this.dispatch(ev)); }
    close(): void { /* db handle owned by index.ts; nothing to do */ }

    private latency(id: string): number {
      const t = this.pendingStart.get(id); this.pendingStart.delete(id);
      return t ? Date.now() - t : 0;
    }
    private guard(fn: () => void): void {
      try { fn(); } catch (e) {
        if (!this.warned) { this.warned = true; console.warn("navigator telemetry: capture failed, disabling warnings", e); }
      }
    }
    private rankOf(path: string): number | null {
      if (!this.lastLocate) return null;
      const i = this.lastLocate.findIndex((r) => r.path === path);
      return i >= 0 ? i + 1 : null;
    }
    private dispatch(ev: ToolEndLike): void {
      this.seq += 1;
      const base = { sessionId: this.o.sessionId, seq: this.seq, turn: this.turn, ts: Date.now() };
      switch (ev.toolName) {
        case "navigator_locate": return this.onLocate(ev, base);
        case "navigator_slice":  return this.onSlice(ev, base);
        case "read":             return this.onRead(ev, base);
        case "bash":             return this.onBash(ev, base);
        case "grep": case "find": case "ls": return this.onBuiltinSearch(ev, base);
        default: return;
      }
    }
    // onLocate: details missing → insertUnavailable(reason via mapUnavailable(text)); else
    //   markUsedLocate, classifyQuery(args.query), build resultsMetadata from details.results
    //   (map each to {path, score, signals}), insertLocate(...), set this.lastLocate.
    // onSlice: details missing → unavailable; else insertConsume(kind='slice', path=toRepoRel(...),
    //   locateRank=rankOf(path), staleIndex, unchanged, isError=ev.isError).
    // onRead: rel = toRepoRel(root, args.path|args.file_path, sessionCwd); skip if undefined;
    //   insertConsume(kind='read', path=rel, locateRank=rankOf(rel)).
    // onBash: d = detectSearch(args.command); if d insertConsume(kind='search', searchTool, searchPattern).
    // onBuiltinSearch: insertConsume(kind='search', searchTool=ev.toolName as SearchTool, searchPattern=
    //   args.pattern ?? args.query ?? null).
  }
  ```
  Fill in the commented method bodies per the spec's correlator section. `mapUnavailable(text)`: if text includes "not inside a git" → `"non_git"`; "disabled" → `"disabled"`; else `"booting"`. Head sha per locate: `headSha(this.o.root)`. Detecting "unavailable": `ev.result?.details === undefined` for navigator tools.

- [ ] **Step 4: Run test, confirm pass**

  Run: `node --test src/telemetry/correlator.test.ts`
  Expected: PASS (all 9 cases).

- [ ] **Step 5: Commit**

  ```bash
  git add src/telemetry/correlator.ts src/telemetry/correlator.test.ts
  git commit -m "feat(telemetry): TelemetryCorrelator passive capture"
  ```

### Task 6: Derivation engine (`stats.ts`)

**TDD scenario:** New module — full TDD cycle with seeded rows.

**Files:**
- Create: `src/telemetry/stats.ts`
- Create: `src/telemetry/stats.test.ts`

- [ ] **Step 1: Write the failing test (`src/telemetry/stats.test.ts`)**

  Seed a tmp telemetry DB directly via the `queries.ts` insert helpers (or raw SQL), then assert. Cover:
  - **hit + MRR + hit@k:** locate(seq=1,turn=0,result_count=3,confidence=high) then slice(seq=2,turn=1,locate_rank=2). `deriveLocateOutcomes` → outcome `hit`, `consumedRank=2`. `aggregate` → `hitRate=1`, `mrr=0.5`, `hitAt1=0`, `hitAt3=1`.
  - **miss-fallback unjustified:** locate(confidence=high,result_count=5) then search(seq+1). outcome `miss-fallback`, `justifiedFallback=false`; `missFallbackUnjustified=1`.
  - **justified fallback:** locate(confidence=low) then search. `justifiedFallback=true`; counts in `missFallback` but not `missFallbackUnjustified`.
  - **abandoned:** locate then nothing in window. outcome `abandoned`.
  - **turnCap boundary:** consumption at `turn = L.turn + turnCap` counts as hit; at `+turnCap+1` → abandoned; a consumption after the *next* locate's seq is not attributed to the first.
  - **low/high conf precision:** mixed set; assert `lowConfPrecision` and `highConfPrecision`.
  - **bypass rate:** seed two `nav_session` rows, one with `used_locate=0`; assert `bypassSessionRate=0.5`.
  - **scope:** `aggregate(db,{turnCap:10,scope:"<sid>"})` restricts to one session.

- [ ] **Step 2: Run test, confirm failure**

  Run: `node --test src/telemetry/stats.test.ts`
  Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/telemetry/stats.ts`**

  ```ts
  import type { Db } from "../store/db.ts";
  import type { LocateOutcome, StatsSummary } from "./types.ts";

  export function deriveLocateOutcomes(db: Db, opts: { turnCap: number }): LocateOutcome[];
  export function aggregate(db: Db, opts: { turnCap: number; scope: string }): StatsSummary;
  ```
  Algorithm for `deriveLocateOutcomes` per the spec:
  - Load all `nav_locate` rows ordered by `(session_id, seq)`; per session, also load `nav_consume` + `nav_unavailable` ordered by `seq`.
  - Window for locate L = rows in same session with `seq > L.seq`, bounded by `min(nextLocate.seq, rows with turn <= L.turn + turnCap)`.
  - `hit` if any windowed slice/read has non-null `locate_rank` → `consumedRank` = earliest such rank; `turnsToConsume = consumeTurn - L.turn`.
  - else `miss-fallback` if any windowed `search` OR slice/read with `locate_rank IS NULL`.
  - else `abandoned`.
  - `justifiedFallback = L.confidence === 'low' || L.result_count === 0`.
  `aggregate` computes the `StatsSummary` table from the outcomes + raw counts. `scope`: when not `"lifetime"`, filter every query by `session_id = scope`. `medianTurnsToUseful`: median of `turnsToConsume` over hits (0 when none). `mrr`: mean of `1/consumedRank` over hits (0 when none). `fallbackSearches`: count of `nav_consume(kind='search')` rows that fall in a miss-fallback window. `unavailableByReason`: `GROUP BY reason`.

- [ ] **Step 4: Run test, confirm pass**

  Run: `node --test src/telemetry/stats.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/telemetry/stats.ts src/telemetry/stats.test.ts
  git commit -m "feat(telemetry): derivation engine (outcomes + aggregate)"
  ```

### ✅ Phase 1 Checkpoint

Run the full telemetry suite + typecheck before starting Phase 2:
```bash
npm run typecheck && node --test 'src/telemetry/*.test.ts'
```
(Node 24.5 `node --test` needs a glob, not a bare directory.)
Expected: all telemetry tests green. Capture (correlator) and derivation (stats) are proven on synthetic data. **Pause for review.**

---

## Phase 2 — Surfacing & Judge (Waves 4–6)

Wires the proven data layer into the live session, the `/navigator stats` command, and the offline judge.

## Wave 4 — Stats command

Depends on Wave 3 (`stats.ts`). Single task (owns `src/commands.ts` + `src/commands.test.ts`). Defines the `NavigatorState` contract that Wave 5 fulfils.

### Task 7: `/navigator stats` command

**TDD scenario:** Modifying tested code — run `src/commands.test.ts` first.

**Files:**
- Modify: `src/commands.ts`
- Modify: `src/commands.test.ts`

- [ ] **Step 1: Extend `parseSub` + write failing tests**

  In `src/commands.test.ts` assert `parseSub("stats").sub === "stats"`. Add a test that the handler, given a `getState()` whose `telemetryStats()` returns a known `{ session, lifetime }` pair, calls `ctx.ui.notify` with a string containing `hit_rate` and the numbers. Use a fake `ctx.ui.notify` capture (mirror existing command tests).

- [ ] **Step 2: Run test, confirm failure**

  Run: `node --test src/commands.test.ts`
  Expected: FAIL — `"stats"` not handled; `telemetryStats` not on `NavigatorState`.

- [ ] **Step 3: Implement**

  - `parseSub` return type becomes `{ sub: "status" | "reindex" | "stats"; path?: string }`; add `if (sub === "stats") return { sub: "stats" };`.
  - Extend `NavigatorState`:
    ```ts
    telemetryStats: (() => { session: StatsSummary; lifetime: StatsSummary } | null) | null;
    ```
    (import `StatsSummary` from `./telemetry/types.ts`.)
  - In the handler, before the `status` branch:
    ```ts
    if (parsed.sub === "stats") {
      const stats = state.telemetryStats?.();
      if (!stats) {
        ctx.ui.notify("navigator telemetry is off (set navigator.telemetry: true to record)", "info");
        return;
      }
      ctx.ui.notify(formatStats("session", stats.session) + "\n\n" + formatStats("lifetime", stats.lifetime), "info");
      return;
    }
    ```
  - Add a pure `formatStats(label: string, s: StatsSummary): string` helper (exported for the test) rendering the key metrics as aligned lines: `locate_total`, `hit_rate`, `mrr`, `hit@1/3/5`, `miss_fallback` (+ unjustified), `abandoned`, `zero_result_locates`, `low_conf_precision`, `bypass_session_rate`, `stale_slice_rate`, `unavailable_by_reason`.
  - `/navigator status` branch stays byte-for-byte unchanged.

- [ ] **Step 4: Run test, confirm pass**

  Run: `node --test src/commands.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/commands.ts src/commands.test.ts
  git commit -m "feat(telemetry): /navigator stats subcommand"
  ```

## Wave 5 — Live wiring

Depends on Wave 3 (correlator), Wave 4 (`NavigatorState.telemetryStats` contract), Wave 1 (`src/paths.ts`). Single task (owns `index.ts`).

### Task 8: Wire correlator + stats into `index.ts`

**TDD scenario:** Modifying integration glue — no unit test for `index.ts` (consistent with the current repo: `index.ts` has no test). Verification is typecheck + a manual smoke note. The logic it calls is unit-tested in Waves 3–4.

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Add imports + module state**

  ```ts
  import { openTelemetryDb } from "./src/telemetry/db.ts";
  import { TelemetryCorrelator } from "./src/telemetry/correlator.ts";
  import { aggregate } from "./src/telemetry/stats.ts";
  import type { Db } from "./src/store/db.ts";
  ```
  Add module-scoped `let correlator: TelemetryCorrelator | null = null;` and `let telemetryDb: Db | null = null;`.

- [ ] **Step 2: Construct the correlator in `session_start`**

  After `state`/`rolling` are set up (telemetry needs `repo.root`, `repo.dbPath`, and a session id), and only when `config.telemetry === true`:
  ```ts
  if (config.telemetry) {
    telemetryDb = openTelemetryDb(repo.dbPath, config.telemetryRetentionDays);
    if (telemetryDb) {
      let sessionId: string;
      try { sessionId = ctx.n.getSessionId(); }
      catch { sessionId = randomUUID(); }   // import { randomUUID } from "node:crypto"
      correlator = new TelemetryCorrelator({
        db: telemetryDb, sessionId, root: repo.root, sessionCwd: ctx.cwd,
        headSha: headSha(repo.root), isWriter: rolling.isWriter,
        storeQueries: config.telemetryStoreQueries,
      });
    }
  }
  ```
  In the existing `rolling.onPromote(...)` callback add `correlator?.markWriter();`.

- [ ] **Step 3: Feed the tool-event stream**

  - In the existing `tool_execution_start` handler (which currently early-returns for non-edit/write), call `correlator?.onToolStart(event)` **before** the edit/write early return so latency is captured for all tools.
  - In the existing `tool_execution_end` handler, call `correlator?.onToolEnd(event)` (in addition to the existing re-index-priority logic; do not disturb it).
  - Add a new handler:
    ```ts
    pi.on("turn_start", async (event) => { correlator?.bumpTurn(event.turnIndex); });
    ```

- [ ] **Step 4: Provide stats to the command + teardown**

  - In the `registerNavigatorCommand(pi, () => ({ ... }))` state object, add:
    ```ts
    telemetryStats: telemetryDb
      ? () => ({
          session: aggregate(telemetryDb!, { turnCap: config.telemetryTurnCap, scope: currentSessionId }),
          lifetime: aggregate(telemetryDb!, { turnCap: config.telemetryTurnCap, scope: "lifetime" }),
        })
      : null,
    ```
    Capture `currentSessionId` in a module var when the correlator is built (or `null`-guard and fall back to `"lifetime"` for both if unavailable).
  - In `session_shutdown`: `try { telemetryDb?.close(); } catch {}` then `telemetryDb = null; correlator = null;`.

- [ ] **Step 5: Typecheck + manual smoke**

  Run: `npm run typecheck`
  Expected: PASS.
  Manual smoke (document in the commit body, not automated): with `navigator.telemetry: true` in a scratch `settings.json`, `pi -e ./index.ts`, run a `navigator_locate` then read a returned file, then `/navigator stats` shows `locate_total: 1` and a hit.

- [ ] **Step 6: Commit**

  ```bash
  git add index.ts
  git commit -m "feat(telemetry): wire correlator + stats into session lifecycle"
  ```

## Wave 6 — Offline judge

Depends on Wave 3 (`deriveLocateOutcomes`) + Wave 2 (telemetry schema, `store/queries.getFileByPath`). Parallel-safe: Task 9 owns `scripts/export-cases.{ts,test.ts}`; Task 10 owns the SKILL doc.

### Task 9: `scripts/export-cases.ts`

**TDD scenario:** New script — full TDD cycle against seeded telemetry + index DBs.

**Files:**
- Create: `scripts/export-cases.ts`
- Create: `scripts/export-cases.test.ts`

- [ ] **Step 1: Write the failing test (`scripts/export-cases.test.ts`)**

  Seed a tmp **telemetry** DB and a tmp **index** DB (the latter via `src/store/db.ts` `openDb` + `src/store/schema.ts` `migrate` + `upsertFile`). Import the exported `exportCases(telemetryDb, indexDb, opts)` function (the CLI `main()` wraps it). Assert:
  - A miss-fallback whose consumed search path is **absent** from the index → case `indexed` verdict `"not_indexed"` (recall gap).
  - A path present in the index but **not** in the locate's `results_metadata` → `"indexed_not_returned"` (retrieval gap).
  - A path present in `results_metadata` at a worse rank than consumed → verdict `"indexed"` with the rank recorded (ranking gap).
  - **Secret masking:** a consumed path `.env.local` is masked/omitted from output.
  - `--query-type identifier` filtering excludes a `keyword` locate case.

- [ ] **Step 2: Run test, confirm failure**

  Run: `node --test scripts/export-cases.test.ts`
  Expected: FAIL — module missing.

- [ ] **Step 3: Implement `scripts/export-cases.ts`**

  - Exported `exportCases(telemetryDb, indexDb, opts: { limit; outcome?; queryType?; })` returns the JSON-able case array. Uses `deriveLocateOutcomes` for outcome labels; joins each locate's window consumptions; for each fallback-consumed path calls `getFileByPath(indexDb, path)`:
    - undefined → `"not_indexed"`.
    - present but path not in `results_metadata` → `"indexed_not_returned"`.
    - present and in `results_metadata` → `"indexed"` (+ its rank).
  - Prioritize order: unjustified miss-fallback, justified miss-fallback, abandoned, low-confidence, then a random `hit` sample.
  - Secret redaction: drop/mask any path matching `SECRET_GLOBS = [/(^|\/)\.env(\.|$)/, /\.pem$/, /\.key$/, /(^|\/)id_[^/]*$/, /\.p12$/]` (mirrors `src/indexer/walk.ts`; comment the source). Never read file contents.
  - `main()`: parse `--limit`, `--outcome`, `--query-type`, `--repo`, `--index-db`; resolve the telemetry DB via `telemetryPathFor(resolveRepo(cwd, config).dbPath)` when `--repo`/cwd given, and the index DB via `--index-db` (default = the sibling index DB). Open both read-only via `openDb`. Print JSON to stdout. Guard `main()` with `if (import.meta.url === ...)` so the test can import without executing.

- [ ] **Step 4: Run test, confirm pass**

  Run: `node --test scripts/export-cases.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/export-cases.ts scripts/export-cases.test.ts
  git commit -m "feat(telemetry): export-cases judge extraction with index-join"
  ```

### Task 10: `usefulness-judge` skill doc

**TDD scenario:** Documentation — no test. Verification is a content checklist.

**Files:**
- Create: `.agents/skills/usefulness-judge/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`** with YAML frontmatter (`name: usefulness-judge`, one-line `description`) and these sections, lifted from the spec's "Judge skill" section:
  - **When to use** — offline, dev-only, after telemetry has accumulated.
  - **First-iteration scope** — the grounded "answers" list and the explicit "defers" list (verbatim intent from spec).
  - **How to run** — `node scripts/export-cases.ts --index-db <path> --query-type identifier --limit N`, then for each case read the `indexed` verdict and classify the gap (recall / retrieval / ranking / justified-fallback / low-confidence).
  - **What to emit** — per-case grade with evidence (rank, dominant signal, index verdict); aggregate ranking-position + flag-calibration tables; evidence-backed recommendations against `src/navigator/rank.ts` weights (`w_fts`/`w_path`/`w_symbol`/`w_recency` — note actual names are `DEFAULT_WEIGHTS.{fts,path,symbol,recency}`) and the `confidence` threshold; an explicit "insufficient evidence" list; a report under `eval/reports/<date>-usefulness.md`.
  - **Privacy note** — paths only, never contents; secret paths are masked by the export.

- [ ] **Step 2: Verify it is not in the shipped manifest**

  Run: `rg -n "usefulness-judge" package.json || echo "correctly absent from manifest"`
  Expected: absent (dev-only skill, like `.agents/skills/release/`).

- [ ] **Step 3: Commit**

  ```bash
  git add .agents/skills/usefulness-judge/SKILL.md
  git commit -m "docs(telemetry): usefulness-judge dev skill"
  ```

### ✅ Phase 2 Checkpoint

```bash
npm run typecheck && node --test
```
Expected: full suite green (CI parity). Manual smoke from Task 8 Step 5 confirmed. **Done.**

---

## Self-Review (completed before handoff)

- **Spec coverage.** Every spec component maps to a task: telemetry DB/schema/retention → T3; correlator (incl. search detection, query-type, locate_rank, used_locate, is_writer) → T4/T5/T8; stats incl. justified_fallback + bypass + all summary metrics → T6; `/navigator stats` → T7; config flags → T1; index wiring + turn_start + session id → T8; judge export with index-join + secret redaction + query-type filter → T9; SKILL first-iteration scope → T10; LocateResponse confidence inputs (`results_metadata.signals` source + `has_exact_def`/`used_or_fallback`/`top_has_anchor`) → T1.
- **Placeholder scan.** No TODO/TBD/`<fill in>`. Method-body fill-ins in T5 Step 3 are specified by adjacent comments + the spec's correlator section (acceptable: the contract, signatures, and per-branch behavior are fully named).
- **Type/API consistency.** `StatsSummary`/`LocateOutcome`/`ResultMeta` defined once in `src/telemetry/types.ts` (T3), consumed by T5/T6/T7/T9. `telemetryStats` signature identical in T7 (definition) and T8 (provider). `toRepoRel` signature unchanged across T2 and T5/T9 consumers. API names (`ctx.n.getSessionId`, `event.turnIndex`, `event.result.details`) verified against the installed runtime.
- **Wave disjointness.** W1: {types,config,config.test,locate,locate.test} ∩ {paths,paths.test,index} = ∅. W2: {telemetry types,db,schema,queries,schema.test} ∩ {detect,detect.test} = ∅. W3: {correlator*} ∩ {stats*} = ∅. W6: {export-cases*} ∩ {SKILL.md} = ∅. W4/W5 single-task. `index.ts` is touched by T2 (W1) and T8 (W5) — different waves, sequential, no conflict.
