# pi-navigator Repository Navigator — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans (or subagent-driven-development) skill to implement this plan task-by-task.

**Goal:** Ship a worktree-aware, self-updating repository index for pi that turns multi-call orientation into one ranked lookup (`navigator_locate`) and whole-file reads into hash-verified slices (`navigator_slice`), indexed by an async, resumable background worker.

**Architecture:** A pi extension (`index.ts`) registers two tools, a `/navigator` command, and lifecycle hooks. On `session_start` it elects a single cross-process writer (advisory lockfile) and spawns a `worker_thread`. The worker derives a resumable backlog from durable DB state and writes a `node:sqlite` (FTS5, WAL) index at `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`. The main thread only reads (read-only handle), posts priority paths on edits, and injects an optional nudge. No file contents are ever persisted; slices read live from the active worktree.

**Tech Stack:** TypeScript (ESM), Node 24 (`node:sqlite`, `node:worker_threads`, native `.ts` type-stripping), `web-tree-sitter` (WASM) + bundled grammars, `node --test`, typebox for tool schemas, `@earendil-works/*` peer deps (typecheck only).

**Spec:** `doc/specs/2026-05-30-repo-navigator-poc.md`

**Linear:** none

---

## Conventions (read before any task)

- **Runtime is Node** (verified `#!/usr/bin/env node`, v24.5). All `.ts` runs via Node native type-stripping — **no enums, no namespaces, no parameter properties**; use `import type` for type-only imports.
- **Module style:** ESM (`"type": "module"`). Relative imports use **no extension** in source; do not add `.js`. (jiti + Node strip-types resolve `./foo` to `./foo.ts`.)
- **Each task is one commit.** Commit messages imperative; no ticket suffix (no Linear).
- **Test runner:** `node --test <file>` → pass shows `✔` + `ℹ pass N` exit 0; fail shows `✖` exit 1.
- **Typecheck:** `npx tsc --noEmit`.
- **Invariants (never violate):** DB stores no file contents; only the lock holder writes; slices read the active worktree; default-ignore secret globs.
- **Git in code:** main thread may use `pi.exec`; shared modules used by the worker use `node:child_process` `execFileSync` (the worker has no `pi`).

---

## Files

**Create — tooling/docs (Phase 0):**
- `package.json`, `tsconfig.json`, `.gitignore`, `.npmignore`
- `AGENTS.md`, `README.md`, `NAVIGATOR.md`, `CHANGELOG.md`
- `.github/workflows/ci.yml`
- `.agents/skills/release/SKILL.md`, `.agents/skills/release/scripts/release.sh`
- `scripts/build-grammars.sh`, `grammars/.gitkeep`

**Create — source (Phases 1-5):**
- `src/types.ts`, `src/config.ts`
- `src/worktree.ts`
- `src/store/db.ts`, `src/store/schema.ts`, `src/store/queries.ts`, `src/store/lock.ts`, `src/store/vectors.ts`
- `src/indexer/hash.ts`, `src/indexer/walk.ts`, `src/indexer/git.ts`, `src/indexer/symbols.ts`, `src/indexer/worker.ts`, `src/indexer/rolling.ts`
- `src/navigator/rank.ts`, `src/navigator/locate.ts`, `src/navigator/slice.ts`, `src/navigator/verified-cache.ts`
- `src/tools.ts`, `src/commands.ts`
- `index.ts`
- `prompts/navigator-persona.md`, `skills/navigator/SKILL.md`

**Create — tests (alongside source):**
- `src/**/*.test.ts` per task; fixtures under `src/__fixtures__/`
- `eval/cases.jsonl`, `eval/run.ts`

**Modify:**
- `CHANGELOG.md` (Phase 6 release)
- `package.json` (version bump at release)

**Delete:** none.

---

## Phase 0 — Scaffolding & tooling

**Checkpoint at end:** `npx tsc --noEmit` passes; `node --test` runs zero tests green; CI workflow lints+typechecks; grammars build script documented.

### Task 0.1: package.json + tsconfig

**TDD scenario:** Trivial config — use judgment (no test).

**Files:**
- Create: `package.json`, `tsconfig.json`

- [ ] **Step 1: Write `package.json`**

  ```json
  {
    "name": "pi-navigator",
    "version": "0.0.0",
    "description": "pi extension: worktree-aware repository navigator for faster find-read-update",
    "type": "module",
    "keywords": ["pi-package", "pi-extension"],
    "license": "MIT",
    "pi": {
      "extensions": ["./index.ts"],
      "skills": ["./skills/navigator/SKILL.md"],
      "prompts": ["./prompts/navigator-persona.md"]
    },
    "dependencies": {
      "web-tree-sitter": "^0.25.0"
    },
    "devDependencies": {
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-tui": "*",
      "@sinclair/typebox": "^0.34.0",
      "tree-sitter-cli": "^0.25.0",
      "tree-sitter-ruby": "^0.23.0",
      "tree-sitter-python": "^0.23.0",
      "tree-sitter-typescript": "^0.23.0",
      "tree-sitter-javascript": "^0.23.0",
      "typescript": "^5.6.0"
    },
    "scripts": {
      "typecheck": "tsc --noEmit",
      "test": "node --test",
      "build:grammars": "bash scripts/build-grammars.sh"
    }
  }
  ```

- [ ] **Step 2: Write `tsconfig.json`**

  The `paths` mapping lets `tsc` resolve the runtime-provided `typebox` specifier to `@sinclair/typebox`.

  ```json
  {
    "compilerOptions": {
      "target": "ES2023",
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "lib": ["ES2023"],
      "types": ["node"],
      "strict": true,
      "noEmit": true,
      "allowImportingTsExtensions": true,
      "verbatimModuleSyntax": true,
      "skipLibCheck": true,
      "paths": { "typebox": ["./node_modules/@sinclair/typebox/build/cjs/index.d.ts"] }
    },
    "include": ["index.ts", "src/**/*.ts", "eval/**/*.ts"]
  }
  ```

- [ ] **Step 3: Install + confirm typecheck**

  Run: `npm install --yes && npx tsc --noEmit`
  Expected: install completes; `tsc` exits 0 (no source files yet → no errors).

- [ ] **Step 4: Commit**

  ```bash
  git add package.json package-lock.json tsconfig.json
  git commit -m "scaffold: package manifest and tsconfig"
  ```

### Task 0.2: .gitignore, .npmignore, grammar build

**TDD scenario:** Trivial — use judgment.

**Files:**
- Create: `.gitignore`, `.npmignore`, `scripts/build-grammars.sh`, `grammars/.gitkeep`

- [ ] **Step 1: Write `.gitignore`**

  ```
  node_modules/
  *.log
  .DS_Store
  ```
  (Note: `grammars/*.wasm` are committed — they are runtime assets, not ignored.)

- [ ] **Step 2: Write `.npmignore`**

  ```
  src/**/*.test.ts
  src/__fixtures__/
  eval/
  doc/
  .github/
  scripts/
  ```

- [ ] **Step 3: Write `scripts/build-grammars.sh`**

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  out="grammars"
  mkdir -p "$out"
  for lang in ruby python typescript javascript; do
    pkg="tree-sitter-$lang"
    echo "building $pkg → $out/$pkg.wasm"
    npx --yes tree-sitter build --wasm "node_modules/$pkg" -o "$out/$pkg.wasm"
  done
  # tree-sitter-typescript ships two grammars; the typescript dir builds tree-sitter-typescript.wasm
  echo "done: $(ls -1 $out/*.wasm)"
  ```

- [ ] **Step 4: Create grammars dir placeholder + build**

  Run: `mkdir -p grammars && touch grammars/.gitkeep && chmod +x scripts/build-grammars.sh && npm run build:grammars`
  Expected: four `grammars/tree-sitter-<lang>.wasm` files produced. If `tree-sitter build` errors on a grammar, confirm the grammar package version exposes a `grammar.js`/`src`; pin a known-good version.

- [ ] **Step 5: Commit (including built wasm)**

  ```bash
  git add .gitignore .npmignore scripts/build-grammars.sh grammars/
  git commit -m "scaffold: ignore files and prebuilt tree-sitter grammars"
  ```

### Task 0.3: Doc stubs (AGENTS.md, README.md, NAVIGATOR.md, CHANGELOG.md)

**TDD scenario:** Trivial — use judgment. Content per spec §14, §15.

**Files:**
- Create: `AGENTS.md`, `README.md`, `NAVIGATOR.md`, `CHANGELOG.md`

- [ ] **Step 1: Write `AGENTS.md`** — self-contained, communication style inlined verbatim (spec §14). Sections: Project overview; Communication style (suppress narration, outcomes over status, bullets, match register, keep LLM-readable artifacts structured); Shell behavior (non-interactive bash, banned commands, prefer `rg`/`fd`); Ground truth before reasoning (`@earendil-works/*`, verify live API); Project layout (the Files tree); Verification commands (`npm run typecheck`, `node --test`, `pi -e ./index.ts`, `/navigator status`); Code & doc discipline + invariants (DB stores no contents; single writer; slices read worktree).

- [ ] **Step 2: Write `README.md`** — human-readable (spec §15): lead with the six core ideas in plain language (first-contact orientation; cross-subproject locate; relationship knowledge; serve slices; skip re-reads worktree-aware; one fan-out). Then Install (spec §17), "How it stays fresh" (rolling worker — nothing to run), "What it does/does not do" (honest), Configuration table, Commands/Tools, link to `NAVIGATOR.md`.

- [ ] **Step 3: Write `NAVIGATOR.md`** — deep doc: schema (spec §5), ranking (§8), rolling/resumable algorithm (§6), worktree/lock model (§10), rationale and the vector seam (§5.6).

- [ ] **Step 4: Write `CHANGELOG.md`**

  ```markdown
  # Changelog

  All notable changes are documented here. Newest first.

  ## [Unreleased]
  - Initial proof of concept: rolling worker index, navigator_locate, navigator_slice.
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add AGENTS.md README.md NAVIGATOR.md CHANGELOG.md
  git commit -m "docs: AGENTS, README, NAVIGATOR, CHANGELOG"
  ```

### Task 0.4: CI + release skill

**TDD scenario:** Trivial — use judgment.

**Files:**
- Create: `.github/workflows/ci.yml`, `.agents/skills/release/SKILL.md`, `.agents/skills/release/scripts/release.sh`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

  ```yaml
  name: ci
  on: [push, pull_request]
  jobs:
    check:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: "24" }
        - run: npm install --yes
        - run: npm run typecheck
        - run: node --test
  ```

- [ ] **Step 2: Write `.agents/skills/release/scripts/release.sh`** (spec §16)

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  bump="${1:-patch}"; dry="${DRY_RUN:-0}"
  git diff --quiet || { echo "tree dirty"; exit 1; }
  [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "not on main"; exit 1; }
  cur=$(node -p "require('./package.json').version")
  next=$(node -e "const s='$cur'.split('.').map(Number);const b='$bump';if(b==='major'){s[0]++;s[1]=0;s[2]=0}else if(b==='minor'){s[1]++;s[2]=0}else if(/^[0-9]/.test(b)){console.log(b.replace(/^v/,''));process.exit(0)}else{s[2]++}console.log(s.join('.'))")
  echo "release $cur → $next"
  [ "$dry" = "1" ] && { echo "dry-run"; exit 0; }
  node -e "const p=require('./package.json');p.version='$next';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
  tmp=$(mktemp); { echo "## [v$next] - $(date +%F)"; echo; sed '1,/^## /!d;/^## /d' CHANGELOG.md >/dev/null 2>&1 || true; } >/dev/null
  node -e "const fs=require('fs');const c=fs.readFileSync('CHANGELOG.md','utf8').replace('## [Unreleased]','## [Unreleased]\n\n## [v$next] - '+new Date().toISOString().slice(0,10));fs.writeFileSync('CHANGELOG.md',c)"
  git add package.json CHANGELOG.md
  git commit -m "release: v$next"
  git tag "v$next"
  git push --follow-tags
  echo "tagged v$next"
  ```

- [ ] **Step 3: Write `.agents/skills/release/SKILL.md`** — short: how to run `DRY_RUN=1 bash .agents/skills/release/scripts/release.sh minor`, what it does (tag-pin, private-repo ssh install), and the install pin format `git:github.com/jjuraszek/pi-navigator@vX.Y.Z`.

- [ ] **Step 4: Commit**

  ```bash
  chmod +x .agents/skills/release/scripts/release.sh
  git add .github .agents
  git commit -m "ci: typecheck+test workflow and tag-pin release skill"
  ```

---

## Phase 1 — Types, config, storage, worktree

**Checkpoint:** unit tests green for config defaults, db open+WAL, schema migrate, repo-id/worktree resolution.

### Task 1.1: Shared types

**TDD scenario:** Trivial type module — covered indirectly; no standalone test.

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`** (the plan's type contract; all later tasks reference these names)

  ```ts
  export type Lang = "ruby" | "python" | "ts" | "js";

  export interface NavigatorConfig {
    enabled: boolean;
    injectPersona: boolean;
    indexDir: string;            // default ~/.pi/pi-navigator-cache
    languages: Lang[];
    maxLocateResults: number;
    indexBatchSize: number;
    indexIdleMs: number;
    cochangeWindowDays: number;
    cochangeMaxCommits: number;
    cochangeMaxFilesPerCommit: number;
    maxFileBytes: number;
  }

  export interface FileRecord {
    id: number;
    path: string;                // repo-relative, POSIX
    lang: Lang | null;
    size: number;
    content_hash: string;
    mtime: number;
    last_commit_at: number | null;
    commits_30d: number;
    commits_90d: number;
    indexed_at: number;
    symbols_done: 0 | 1;
  }

  export interface SymbolRecord {
    name: string;
    kind: "class" | "module" | "method" | "function" | "const";
    start_line: number;
    end_line: number;
    start_byte: number;
    end_byte: number;
  }

  export interface ImportEdge { fromPath: string; toPathHint: string; kind: "import" | "require" | "require_relative"; }

  export interface LocateSignals { fts: number; path: number; symbol: number; recency: number; }
  export interface LocateResult {
    path: string; lang: Lang | null; score: number;
    signals: LocateSignals; symbols: { name: string; kind: string; lines: [number, number] }[];
  }
  export interface LocateCluster { anchor: string; cochange: string[]; referrers: string[]; }
  export interface LocateResponse {
    results: LocateResult[]; cluster: LocateCluster | null;
    index: { fresh: boolean; head_behind: number; coverage: number };
  }

  export interface SliceResult {
    path: string; range: [number, number]; content: string;
    content_hash: string; stale_index: boolean; unchanged_since_last_read: boolean;
  }

  export interface Coverage { total: number; indexed: number; fullCrawlDone: boolean; headBehind: number; }

  // worker <-> main messages
  export type WorkerInbound =
    | { type: "priority"; paths: string[] }
    | { type: "reindex"; path?: string }
    | { type: "stop" };
  export type WorkerOutbound =
    | { type: "coverage"; coverage: Coverage }
    | { type: "log"; level: "info" | "warn"; msg: string };
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/types.ts
  git commit -m "types: shared navigator interfaces"
  ```

### Task 1.2: Config loader

**TDD scenario:** New feature — full TDD.

**Files:**
- Create: `src/config.ts`, `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { DEFAULT_CONFIG, mergeConfig } from "./config";

  test("defaults: persona off, sqlite cache dir", () => {
    assert.equal(DEFAULT_CONFIG.injectPersona, false);
    assert.ok(DEFAULT_CONFIG.indexDir.endsWith("pi-navigator-cache"));
    assert.deepEqual(DEFAULT_CONFIG.languages, ["ruby", "python", "ts", "js"]);
  });

  test("mergeConfig overlays partial user settings", () => {
    const merged = mergeConfig({ injectPersona: true, maxLocateResults: 3 });
    assert.equal(merged.injectPersona, true);
    assert.equal(merged.maxLocateResults, 3);
    assert.equal(merged.indexBatchSize, DEFAULT_CONFIG.indexBatchSize);
  });
  ```

- [ ] **Step 2: Run, confirm fail**

  Run: `node --test src/config.test.ts`
  Expected: FAIL (`Cannot find module './config'`).

- [ ] **Step 3: Implement `src/config.ts`**

  ```ts
  import { homedir } from "node:os";
  import { join } from "node:path";
  import { readFileSync } from "node:fs";
  import type { NavigatorConfig } from "./types";

  export const DEFAULT_CONFIG: NavigatorConfig = {
    enabled: true,
    injectPersona: false,
    indexDir: join(homedir(), ".pi", "pi-navigator-cache"),
    languages: ["ruby", "python", "ts", "js"],
    maxLocateResults: 10,
    indexBatchSize: 50,
    indexIdleMs: 25,
    cochangeWindowDays: 180,
    cochangeMaxCommits: 4000,
    cochangeMaxFilesPerCommit: 50,
    maxFileBytes: 1048576,
  };

  export function mergeConfig(partial: Partial<NavigatorConfig>): NavigatorConfig {
    return { ...DEFAULT_CONFIG, ...partial };
  }

  function agentDir(): string {
    return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  }

  export function loadConfig(): NavigatorConfig {
    try {
      const raw = readFileSync(join(agentDir(), "settings.json"), "utf8");
      const settings = JSON.parse(raw) as { navigator?: Partial<NavigatorConfig> };
      return mergeConfig(settings.navigator ?? {});
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  ```

- [ ] **Step 4: Run, confirm pass**

  Run: `node --test src/config.test.ts`
  Expected: PASS (`ℹ pass 2`).

- [ ] **Step 5: Commit**

  ```bash
  git add src/config.ts src/config.test.ts
  git commit -m "config: defaults + settings.json loader (navigator namespace)"
  ```

### Task 1.3: DB adapter (node:sqlite + WAL + warning suppression)

**TDD scenario:** New feature — full TDD.

**Files:**
- Create: `src/store/db.ts`, `src/store/db.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { mkdtempSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { openDb } from "./db";

  test("openDb yields a WAL database with fts5+bm25", () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-db-"));
    const db = openDb(join(dir, "t.db"));
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    db.exec("CREATE VIRTUAL TABLE s USING fts5(x)");
    db.exec("INSERT INTO s VALUES('grid sync')");
    const row = db.prepare("SELECT bm25(s) AS b FROM s WHERE s MATCH ?").get("grid");
    assert.equal(typeof row.b, "number");
    db.close();
  });
  ```

- [ ] **Step 2: Run, confirm fail**

  Run: `node --test src/store/db.test.ts` → FAIL (no `./db`).

- [ ] **Step 3: Implement `src/store/db.ts`**

  ```ts
  import { DatabaseSync } from "node:sqlite";
  import { mkdirSync } from "node:fs";
  import { dirname } from "node:path";

  let warningSuppressed = false;
  function suppressSqliteWarning(): void {
    if (warningSuppressed) return;
    warningSuppressed = true;
    const original = process.emitWarning.bind(process);
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning?.message ?? "";
      if (text.includes("SQLite is an experimental feature")) return;
      return (original as (...a: unknown[]) => void)(warning, ...rest);
    }) as typeof process.emitWarning;
  }

  export type Db = DatabaseSync;

  export function openDb(path: string): Db {
    suppressSqliteWarning();
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    return db;
  }
  ```

- [ ] **Step 4: Run, confirm pass** — `node --test src/store/db.test.ts` → PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/store/db.ts src/store/db.test.ts
  git commit -m "store: node:sqlite WAL adapter with experimental-warning suppression"
  ```

### Task 1.4: Schema + migrations

**TDD scenario:** New feature — full TDD.

**Files:**
- Create: `src/store/schema.ts`, `src/store/schema.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { mkdtempSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { openDb } from "./db";
  import { migrate, SCHEMA_VERSION } from "./schema";

  test("migrate creates all tables and is idempotent", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-sch-")), "t.db"));
    migrate(db);
    migrate(db); // idempotent
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r: any) => r.name);
    for (const t of ["meta", "files", "symbols", "cochange", "refs", "search_index"]) assert.ok(tables.includes(t), `missing ${t}`);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION));
  });
  ```

- [ ] **Step 2: Run, confirm fail** → FAIL (no `./schema`).

- [ ] **Step 3: Implement `src/store/schema.ts`** (DDL from spec §5; `meta` resume cursors included)

  ```ts
  import type { Db } from "./db";
  export const SCHEMA_VERSION = 1;

  const DDL = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, lang TEXT, size INTEGER,
    content_hash TEXT NOT NULL, mtime INTEGER, last_commit_at INTEGER,
    commits_30d INTEGER DEFAULT 0, commits_90d INTEGER DEFAULT 0,
    indexed_at INTEGER NOT NULL, symbols_done INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER, end_line INTEGER,
    start_byte INTEGER, end_byte INTEGER);
  CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
  CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
  CREATE TABLE IF NOT EXISTS cochange (
    file_a INTEGER NOT NULL, file_b INTEGER NOT NULL, weight REAL NOT NULL,
    PRIMARY KEY (file_a, file_b));
  CREATE TABLE IF NOT EXISTS refs (
    src_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    dst_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, PRIMARY KEY (src_file, dst_file, kind));
  CREATE INDEX IF NOT EXISTS idx_refs_dst ON refs(dst_file);
  CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    path, symbol_names, kind_tags, content='', tokenize='unicode61');
  `;

  export function migrate(db: Db): void {
    db.exec(DDL);
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(SCHEMA_VERSION));
  }
  ```

- [ ] **Step 4: Run, confirm pass** → PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/store/schema.ts src/store/schema.test.ts
  git commit -m "store: schema DDL + idempotent migrate"
  ```

### Task 1.5: Worktree / repo-id resolution

**TDD scenario:** New feature — full TDD against a temp git repo.

**Files:**
- Create: `src/worktree.ts`, `src/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { mkdtempSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { execFileSync } from "node:child_process";
  import { resolveRepo } from "./worktree";
  import { DEFAULT_CONFIG } from "./config";

  function tmpRepo(): string {
    const d = mkdtempSync(join(tmpdir(), "nav-wt-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: d });
    git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
    writeFileSync(join(d, "f.txt"), "hi"); git(["add", "."]); git(["commit", "-qm", "init"]);
    return d;
  }

  test("resolveRepo yields root, name, stable id, and cache db path", () => {
    const d = tmpRepo();
    const r = resolveRepo(d, DEFAULT_CONFIG);
    assert.equal(r.root, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: d }).toString().trim());
    assert.equal(r.repoName, r.root.split("/").pop());
    assert.match(r.repoId, /^[0-9a-f]{12}$/);
    assert.equal(r.dbPath, join(DEFAULT_CONFIG.indexDir, `${r.repoName}_${r.repoId}.db`));
    assert.equal(resolveRepo(d, DEFAULT_CONFIG).repoId, r.repoId); // stable
  });
  ```

- [ ] **Step 2: Run, confirm fail** → FAIL.

- [ ] **Step 3: Implement `src/worktree.ts`**

  ```ts
  import { execFileSync } from "node:child_process";
  import { createHash } from "node:crypto";
  import { basename, join } from "node:path";
  import type { NavigatorConfig } from "./types";

  export interface RepoInfo { root: string; repoName: string; repoId: string; dbPath: string; isGit: boolean; }

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  }

  export function resolveRepo(cwd: string, config: NavigatorConfig): RepoInfo {
    let root: string, isGit = true, repoId: string;
    try {
      root = git(cwd, ["rev-parse", "--show-toplevel"]);
    } catch { root = cwd; isGit = false; }
    try {
      const rootCommit = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]).split("\n").pop()!.trim();
      repoId = rootCommit.slice(0, 12);
    } catch {
      const common = isGit ? git(cwd, ["rev-parse", "--git-common-dir"]) : root;
      repoId = createHash("sha256").update(common).digest("hex").slice(0, 12);
    }
    const repoName = basename(root);
    return { root, repoName, repoId, dbPath: join(config.indexDir, `${repoName}_${repoId}.db`), isGit };
  }

  export function headSha(cwd: string): string | null {
    try { return git(cwd, ["rev-parse", "HEAD"]); } catch { return null; }
  }
  ```

- [ ] **Step 4: Run, confirm pass** → PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/worktree.ts src/worktree.test.ts
  git commit -m "worktree: repo root, stable repo-id, cache db path"
  ```

**CHECKPOINT 1:** Run `npm run typecheck && node --test`. Expect all green. Stop for review.

---

## Phase 2 — Hashing, walk, git signals

**Checkpoint:** unit tests green for hashing, walk filtering (incl. secret ignore), recency + co-change folding.

### Task 2.1: Content hashing

**TDD scenario:** New feature — full TDD.

**Files:** Create `src/indexer/hash.ts`, `src/indexer/hash.test.ts`

- [ ] **Step 1: Failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { hashBuffer } from "./hash";
  test("hashBuffer is stable sha-256 hex", () => {
    assert.equal(hashBuffer(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  ```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/indexer/hash.ts`**

  ```ts
  import { createHash } from "node:crypto";
  export function hashBuffer(buf: Buffer): string { return createHash("sha256").update(buf).digest("hex"); }
  export function isBinary(buf: Buffer): boolean {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  }
  ```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git add src/indexer/hash.ts src/indexer/hash.test.ts && git commit -m "indexer: content hashing + binary sniff"`

### Task 2.2: Walk (git-aware enumeration + filters)

**TDD scenario:** New feature — full TDD against a temp git repo.

**Files:** Create `src/indexer/walk.ts`, `src/indexer/walk.test.ts`

Design (spec §6.2.1, §11): enumerate via `git ls-files` ∪ `git ls-files --others --exclude-standard` (git handles `.gitignore`); fall back to manual recursive walk for non-git. Then filter: drop secret globs (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`), unknown-extension files keep `lang=null` but still walked, oversized (> maxFileBytes), binary (sniffed by caller). Returns repo-relative POSIX paths + lang.

- [ ] **Step 1: Failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { execFileSync } from "node:child_process";
  import { enumerateFiles, langOf } from "./walk";

  test("langOf maps known extensions", () => {
    assert.equal(langOf("a/b.rb"), "ruby");
    assert.equal(langOf("a/b.py"), "python");
    assert.equal(langOf("a/b.tsx"), "ts");
    assert.equal(langOf("a/b.unknown"), null);
  });

  test("enumerateFiles skips secrets and respects gitignore", () => {
    const d = mkdtempSync(join(tmpdir(), "nav-walk-"));
    const git = (a: string[]) => execFileSync("git", a, { cwd: d });
    git(["init", "-q"]);
    writeFileSync(join(d, ".gitignore"), "ignored.rb\n");
    writeFileSync(join(d, "app.rb"), "class A; end");
    writeFileSync(join(d, "ignored.rb"), "x");
    writeFileSync(join(d, ".env"), "SECRET=1");
    mkdirSync(join(d, "node_modules")); writeFileSync(join(d, "node_modules/x.js"), "1");
    const paths = enumerateFiles(d).map((f) => f.path).sort();
    assert.ok(paths.includes("app.rb"));
    assert.ok(!paths.includes("ignored.rb"));
    assert.ok(!paths.includes(".env"));
    assert.ok(!paths.some((p) => p.startsWith("node_modules/")));
  });
  ```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/indexer/walk.ts`** (full code: `git ls-files` union, secret-glob filter, `langOf`, default-ignore fallback for non-git). Export `enumerateFiles(root): { path: string; lang: Lang | null }[]` and `langOf(path): Lang | null`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "indexer: git-aware file enumeration with secret + ignore filters"`

### Task 2.3: Git signals — recency + co-change folding

**TDD scenario:** New feature — full TDD. Split the **pure folding logic** (testable without git) from the git invocation.

**Files:** Create `src/indexer/git.ts`, `src/indexer/git.test.ts`

Design (spec §6.3): `parseLog(raw)` → `Commit[] = { sha, ts, files }`. `foldSignals(commits, opts)` → `{ recency: Map<path,{last,c30,c90}>, cochange: Map<"a\0b", weight> }`. Skip commits with `files.length > cochangeMaxFilesPerCommit` for co-change (still count recency). Weight decays by age vs `cochangeWindowDays`. `now` injected for deterministic tests.

- [ ] **Step 1: Failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { parseLog, foldSignals } from "./git";

  const RAW = [
    "__C__ aaa 1000",
    "app/grid.rb",
    "app/grid_sync.rb",
    "",
    "__C__ bbb 900",
    "app/grid.rb",
    "README.md",
  ].join("\n");

  test("parseLog groups files per commit", () => {
    const commits = parseLog(RAW);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0], { sha: "aaa", ts: 1000, files: ["app/grid.rb", "app/grid_sync.rb"] });
  });

  test("foldSignals: co-change pairs + recency counts", () => {
    const now = 1000 + 5 * 86400;
    const { recency, cochange } = foldSignals(parseLog(RAW), {
      now, windowDays: 180, maxFilesPerCommit: 50,
    });
    assert.ok((cochange.get("app/grid.rb\u0000app/grid_sync.rb") ?? 0) > 0);
    assert.equal(recency.get("app/grid.rb")!.c90, 2);
    assert.equal(recency.get("README.md")!.c90, 1);
  });
  ```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/indexer/git.ts`** — `parseLog`, `foldSignals` (pure), plus `readLog(root, maxCommits, sinceSha?)` using `execFileSync("git", ["log","--no-merges",`--pretty=format:__C__ %H %ct`,"--name-only", ...])`. Pair key normalizes `a < b` joined by `\u0000`. Decay `weight += exp(-ageDays/windowDays)`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "indexer: recency + co-change folding from git log"`

**CHECKPOINT 2:** `npm run typecheck && node --test` green. Stop for review.

---

## Phase 3 — Symbols + import edges (web-tree-sitter)

**Checkpoint:** symbol extraction passes on Ruby + Python fixtures; import edges resolved.

### Task 3.1: Tree-sitter symbol + import extraction

**TDD scenario:** New feature — full TDD with fixtures.

**Files:** Create `src/indexer/symbols.ts`, `src/indexer/symbols.test.ts`, `src/__fixtures__/sample.rb`, `src/__fixtures__/sample.py`

Design (spec §5.3, §5.5): `initParsers(grammarDir, langs)` loads `web-tree-sitter` once (`await Parser.init()`), `Language.load(<grammarDir>/tree-sitter-<lang>.wasm)`. `extractSymbols(lang, source)` walks `tree.rootNode`, mapping node types per language to `SymbolRecord` (Ruby: `class`,`module`,`method`,`singleton_method`,`assignment`→const; Python: `class_definition`,`function_definition`; TS/JS: `class_declaration`,`function_declaration`,`method_definition`,`lexical_declaration`). `extractImports(lang, source)` collects `require`/`require_relative`/`import`/`from`. Grammar dir resolved via `fileURLToPath(new URL("../../grammars", import.meta.url))`.

- [ ] **Step 1: Write fixtures**

  `src/__fixtures__/sample.rb`:
  ```ruby
  require "json"
  require_relative "grid_sync"
  module Grids
    class Grid
      def sync; end
    end
  end
  ```
  `src/__fixtures__/sample.py`:
  ```python
  import os
  from .grid_sync import Sync
  class Grid:
      def sync(self):
          pass
  ```

- [ ] **Step 2: Write the failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  import { initParsers, extractSymbols, extractImports } from "./symbols";

  const fx = (n: string) => readFileSync(join(import.meta.dirname, "__fixtures__", n), "utf8");

  test("ruby symbols + imports", async () => {
    await initParsers(["ruby"]);
    const src = fx("sample.rb");
    const names = extractSymbols("ruby", src).map((s) => s.name);
    assert.ok(names.includes("Grid"));
    assert.ok(names.includes("Grids"));
    assert.ok(names.includes("sync"));
    const imps = extractImports("ruby", src).map((i) => i.toPathHint);
    assert.ok(imps.includes("grid_sync"));
  });

  test("python symbols", async () => {
    await initParsers(["python"]);
    const names = extractSymbols("python", fx("sample.py")).map((s) => s.name);
    assert.ok(names.includes("Grid") && names.includes("sync"));
  });
  ```

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement `src/indexer/symbols.ts`** using the verified web-tree-sitter API (`Parser.init()`, `Language.load`, `parser.setLanguage`, `parser.parse`, recursive `node.children` walk reading `node.startPosition.row`, `node.endPosition.row`, `node.startIndex`, `node.endIndex`, and the name child via `node.childForFieldName("name")`). Cache `Parser`/`Language` instances in a module map. Map node types per language as above.

- [ ] **Step 5: Run → PASS.** (Note: first run loads WASM; allow a few hundred ms.)

- [ ] **Step 6: Commit** — `git commit -m "indexer: web-tree-sitter symbol + import extraction (ruby/python/ts/js)"`

**CHECKPOINT 3:** `npm run typecheck && node --test` green (TS/JS mappings covered by adding `sample.ts` fixture if time permits). Stop for review.

---

## Phase 4 — Async resumable worker + coordinator + lock

**Checkpoint:** worker boots in a `worker_thread`, indexes a fixture repo, persists per batch; resume test confirms a half-built index continues; lock prevents a second writer.

### Task 4.1: Prepared queries + upsert helpers

**TDD scenario:** New feature — full TDD.

**Files:** Create `src/store/queries.ts`, `src/store/queries.test.ts`

Design: thin functions over `Db` — `upsertFile`, `getFileByPath`, `setSymbolsDone`, `replaceSymbols(fileId, SymbolRecord[])`, `upsertCochange(aId,bId,w)`, `replaceRefs`, `ftsUpsert(fileId, path, symbolNames, kindTags)`, `setMeta/getMeta`, `coverage()`. FTS contentless table: delete-then-insert by rowid for upsert.

- [ ] **Step 1: Failing test** — open db+migrate, `upsertFile` then `getFileByPath` returns the row; `ftsUpsert` then `MATCH` finds it; second `upsertFile` same path updates not duplicates.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/store/queries.ts`** (full prepared-statement wrappers).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "store: prepared queries + FTS/file/symbol/cochange upserts"`

### Task 4.2: Writer lock (advisory lockfile)

**TDD scenario:** New feature — full TDD.

**Files:** Create `src/store/lock.ts`, `src/store/lock.test.ts`

Design (spec §10): `acquire(dbPath, ttlMs)` writes `<dbPath>.lock` with `{pid, mtime}` if absent or stale (mtime older than ttl); returns a handle with `refresh()` and `release()`. Second `acquire` while held + fresh returns null.

- [ ] **Step 1: Failing test** — first acquire returns handle; second returns null; after `release()`, acquire succeeds; a lock with mtime older than ttl is reclaimable.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/store/lock.ts`** (atomic create via `open(..., "wx")`; stale reclaim by `statSync().mtimeMs`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "store: advisory single-writer lock with stale reclaim"`

### Task 4.3: Worker — resumable backlog + batched commits

**TDD scenario:** New feature — full TDD. The worker's **core loop is a pure-ish function** `runIndexPass(db, root, config, opts)` tested by driving it directly (no thread); a thin `worker.ts` wraps it for `worker_threads`.

**Files:** Create `src/indexer/worker-core.ts`, `src/indexer/worker.ts`, `src/indexer/worker-core.test.ts`

Design (spec §6.2–§6.5):
- `deriveBacklog(db, root, config)` → `{ files: string[]; needsCochange: boolean }`: enumerate via `enumerateFiles`; for each, compare `mtime`/size to `files` row → include if new/changed or `symbols_done=0`; `needsCochange` if `head_sha_at_index` != HEAD or cursor unset.
- `runIndexPass(db, root, config, { batchSize, priority })`: process priority paths first, then backlog; for each batch wrap `BEGIN IMMEDIATE … COMMIT`; per file: read bytes, `isBinary`→skip, `hashBuffer`, `upsertFile`, `extractSymbols`+`extractImports`→`replaceSymbols`/`replaceRefs`/`ftsUpsert`, `setSymbolsDone(1)`; update `coverage_*` in `meta`. Co-change folded in commit batches advancing `meta.cochange_cursor`. Returns `Coverage`.
- Idempotent + resumable: re-running after a partial pass processes only remaining files (proven by test).

- [ ] **Step 1: Write the failing test**

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { mkdtempSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { execFileSync } from "node:child_process";
  import { openDb } from "../store/db";
  import { migrate } from "../store/schema";
  import { initParsers } from "./symbols";
  import { deriveBacklog, runIndexPass } from "./worker-core";
  import { DEFAULT_CONFIG } from "../config";

  async function fixtureRepo() {
    const d = mkdtempSync(join(tmpdir(), "nav-wc-"));
    const git = (a: string[]) => execFileSync("git", a, { cwd: d });
    git(["init", "-q"]); git(["config", "user.email", "a@b.c"]); git(["config", "user.name", "t"]);
    writeFileSync(join(d, "grid.rb"), "class Grid; def sync; end; end");
    writeFileSync(join(d, "grid_sync.rb"), "require_relative 'grid'");
    git(["add", "."]); git(["commit", "-qm", "init"]);
    await initParsers(["ruby"]);
    return d;
  }

  test("runIndexPass indexes all files and is resumable", async () => {
    const d = await fixtureRepo();
    const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-db-")), "i.db"));
    migrate(db);
    // First pass limited to 1 file (simulate interruption)
    const c1 = runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 1, maxFiles: 1, priority: [] });
    assert.equal(c1.indexed, 1);
    // Resume: backlog excludes the already-indexed file
    const backlog = deriveBacklog(db, d, DEFAULT_CONFIG);
    assert.equal(backlog.files.length, 1);
    const c2 = runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });
    assert.equal(c2.indexed, 2);
    // FTS finds Grid
    const hit = db.prepare("SELECT path FROM search_index WHERE search_index MATCH ?").all("Grid").map((r: any) => r.path);
    assert.ok(hit.includes("grid.rb"));
  });
  ```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/indexer/worker-core.ts`** (full `deriveBacklog`, `runIndexPass` with `maxFiles` option for the test).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Implement `src/indexer/worker.ts`** — `worker_thread` entry: read `workerData {dbPath, root, config}`, `openDb`, `migrate`, `await initParsers(config.languages)`, loop: drain `priority` queue from `parentPort` messages, `runIndexPass`, post `{type:"coverage"}`, sleep `indexIdleMs` between batches until backlog empty + no priority, then idle awaiting messages. Handle `{type:"stop"}`.
- [ ] **Step 6: Worker smoke test** (manual, documented): a `worker-core.test.ts` covers logic; add a comment in `worker.ts` describing `node --test` cannot easily host the thread — Phase 5 integration (Task 5.7) boots it via `index.ts` under `pi -e`.
- [ ] **Step 7: Commit** — `git add src/indexer/worker-core.ts src/indexer/worker.ts src/indexer/worker-core.test.ts && git commit -m "indexer: resumable index pass core + worker_thread wrapper"`

### Task 4.4: Rolling coordinator (main thread)

**TDD scenario:** Modifying/assembling tested units — light test for lock+spawn decision; thread lifecycle verified in Phase 5 integration.

**Files:** Create `src/indexer/rolling.ts`, `src/indexer/rolling.test.ts`

Design (spec §6.1, §10): class `RollingIndexer` with `start(repo)` → `acquire` lock; if held, spawn `Worker(fileURLToPath(new URL("./worker.ts", import.meta.url)), { workerData })`; track latest `Coverage`; `postPriority(paths)`; `reindex(path?)`; `refreshLock()` (call on turn_end); `stop()` (terminate worker, release lock). If lock not acquired → read-only mode (`worker=null`).

- [ ] **Step 1: Failing test** — instantiate two `RollingIndexer` on the same dbPath in-process; first `start()` becomes writer (`isWriter===true`), second `start()` is read-only (`isWriter===false`). (Spawn is stubbed via an injected `spawn` fn so the test avoids real threads.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `src/indexer/rolling.ts`** with an injectable `spawn` for testability (default uses real `Worker`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "indexer: rolling coordinator with lock election and worker ownership"`

**CHECKPOINT 4:** `npm run typecheck && node --test` green. Stop for review.

---

## Phase 5 — Navigator tools, command, wiring

**Checkpoint:** `navigator_locate` ranks the expected file on the fixture repo; `navigator_slice` returns live bytes + correct hash after an edit; extension loads under `pi -e ./index.ts` and `/navigator status` reports coverage.

### Task 5.1: Ranking

**TDD scenario:** New feature — full TDD (pure function).

**Files:** Create `src/navigator/rank.ts`, `src/navigator/rank.test.ts`

Design (spec §8): `score(signals, weights)` with defaults `w_fts=1, w_path=1, w_symbol=2, w_recency=0.5`; helpers `pathMatch(query, path)`, `recencyBoost(file, now)`. Deterministic.

- [ ] **Step 1: Failing test** — exact-symbol match outranks path-only; weights applied as documented; deterministic ordering.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "navigator: transparent additive ranking"`

### Task 5.2: Locate (FTS + fusion + fan-out)

**TDD scenario:** New feature — full TDD against an indexed fixture db.

**Files:** Create `src/navigator/locate.ts`, `src/navigator/locate.test.ts`

Design (spec §7.1): `locate(db, root, query, config)` → query `search_index` via `bm25`, join `files`, compute signals, rank, take top-N; for top result attach `cluster` (co-change neighbors from `cochange`, referrers from `refs`); compute `index.fresh`/`head_behind`/`coverage` from `meta` + `headSha(root)`.

- [ ] **Step 1: Failing test** — build a fixture db (reuse `runIndexPass` on the Phase 4 fixture repo), `locate(db, root, "Grid", config)` → `results[0].path === "grid.rb"`; `cluster.referrers` includes `grid_sync.rb` (it `require_relative`s grid).
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "navigator: locate with bm25 fusion and co-change/referrer fan-out"`

### Task 5.3: Slice (ground-truth) + verified-cache

**TDD scenario:** New feature — full TDD.

**Files:** Create `src/navigator/slice.ts`, `src/navigator/verified-cache.ts`, `src/navigator/slice.test.ts`

Design (spec §7.2, §7.3): `VerifiedCache` = `Map<absPath, hash>`. `slice(db, root, cache, { path, symbol?, startLine?, endLine? })`: resolve under `root` (reject escapes), read live bytes, `hashBuffer`; if `symbol` and file hash matches indexed → use stored offsets, else re-extract via tree-sitter; if `startLine/endLine` slice those; set `unchanged_since_last_read` if cache hash matches; update cache; `stale_index` if indexed hash differs.

- [ ] **Step 1: Failing test** — slice a symbol returns its body + hash; second identical slice sets `unchanged_since_last_read:true`; after rewriting the file, slice returns new bytes, new hash, `unchanged_since_last_read:false`; path escape (`../x`) throws.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement both files.** **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "navigator: ground-truth slice + session verified-cache"`

### Task 5.4: Tool registration

**TDD scenario:** New feature — light unit (schema + handler wiring); behavior covered by 5.2/5.3.

**Files:** Create `src/tools.ts`, `src/tools.test.ts`

Design (spec §7, §9): `registerTools(pi, getCtx)` where `getCtx()` returns `{ db, root, cache, config }` (late-bound; null before index ready). `navigator_locate` and `navigator_slice` via `pi.registerTool` with typebox params, `promptSnippet`, and `promptGuidelines` naming the tool ("Use navigator_locate BEFORE ripgrep/read to orient…"). On null ctx, throw "run is still indexing / not a git repo". Truncate locate/slice output with `truncateHead` (spec: import from `@earendil-works/pi-coding-agent`).

- [ ] **Step 1: Failing test** — call `registerTools` with a fake `pi` capturing definitions; assert both tools registered with correct names, `promptGuidelines` mention the tool name, and `parameters` validate a sample input.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement `src/tools.ts`.** **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "tools: register navigator_locate and navigator_slice"`

### Task 5.5: /navigator command

**TDD scenario:** New feature — light unit on arg parsing.

**Files:** Create `src/commands.ts`, `src/commands.test.ts`

Design (spec §6.6): `registerNavigatorCommand(pi, getState)`; handler parses `args` first word: `status` → notify coverage/head-behind/lock owner/queue; `reindex [path]` → `state.rolling.reindex(path)`; default → status. Export `parseSub(args)` for the test.

- [ ] **Step 1: Failing test** — `parseSub("status")`→`{sub:"status"}`; `parseSub("reindex app/x.rb")`→`{sub:"reindex",path:"app/x.rb"}`; `parseSub("")`→`{sub:"status"}`.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "commands: /navigator status|reindex"`

### Task 5.6: Persona prompt + skill

**TDD scenario:** Trivial content — use judgment.

**Files:** Create `prompts/navigator-persona.md`, `skills/navigator/SKILL.md`

- [ ] **Step 1: Write `prompts/navigator-persona.md`** — one ~25-word sentence (spec §9): "This repo has a navigator index. Call navigator_locate before grepping to find entry points; use navigator_slice to read spans; a slice marked unchanged_since_last_read need not be re-read."
- [ ] **Step 2: Write `skills/navigator/SKILL.md`** — front-matter `name: navigator`, `description`; body: when to use (orientation, cross-subproject, relationship discovery), examples of `navigator_locate`/`navigator_slice`, and the honest boundary (does not replace read-before-edit).
- [ ] **Step 3: Commit** — `git commit -m "prompts+skill: minimal navigator nudge and usage skill"`

### Task 5.7: Extension entry wiring (index.ts)

**TDD scenario:** Assembling tested units — verified by load test under `pi -e`.

**Files:** Create `index.ts`

Design (spec §3, §6.1, §9): default factory:
- closure state `{ config, repo, db (read-only), cache, rolling }`.
- `session_start`: `loadConfig()`; `resolveRepo(ctx.cwd, config)`; if `enabled`: open read-only `db` (after ensuring file exists — if absent, create+migrate so the worker can attach), construct `VerifiedCache`, `rolling = new RollingIndexer(...)`, `rolling.start(repo)`; `registerTools`/command already registered at load; `ctx.ui.setStatus("navigator", "indexing…")`; notify staleness if `headSha != meta.head_sha_at_index`.
- `tool_execution_end`: if `event.toolName` in {`edit`,`write`} → `rolling.postPriority([resolvedPath])`; record into `cache` if `read`/slice.
- `turn_end`: `rolling.refreshLock()`; update `setStatus` with coverage.
- `before_agent_start`: if `config.injectPersona` and `pi.getActiveTools().includes("navigator_locate")` → append the one-sentence persona to `event.systemPrompt`.
- `session_shutdown`: `rolling.stop()`, close db.
- Register tools + command at factory top (so they exist even pre-index; they throw a friendly error until ctx ready).

- [ ] **Step 1: Implement `index.ts`** per the design (full code).
- [ ] **Step 2: Load test**

  Run: `cd <a git repo with ruby/py files> && pi -e ~/repos/pi-navigator/index.ts -p "/navigator status"`
  Expected: prints coverage line (e.g., `navigator: coverage 0/… building…` or a count); no crash; `~/.pi/pi-navigator-cache/<name>_<id>.db` created.

- [ ] **Step 3: Manual locate smoke**

  Run: `pi -e ~/repos/pi-navigator/index.ts -p "Use navigator_locate to find where Grid is defined"`
  Expected: tool returns a ranked path. (Allow a few turns for the worker to index.)

- [ ] **Step 4: Commit** — `git add index.ts && git commit -m "extension: wire hooks, tools, command, rolling worker, persona"`

**CHECKPOINT 5:** `npm run typecheck && node --test` green + manual `pi -e` smoke verified. Stop for review.

---

## Phase 6 — Eval, vector seam, release

**Checkpoint:** eval harness reports hit@k vs rg on the sample cases; `v0.1.0` tagged.

### Task 6.1: Vector seam (interface only)

**TDD scenario:** Trivial — use judgment (spec §5.6).

**Files:** Create `src/store/vectors.ts`

- [ ] **Step 1: Implement interface-only `src/store/vectors.ts`**

  ```ts
  // Future expansion seam (spec §5.6). No implementation in the PoC.
  export interface VectorStore {
    upsert(contentHash: string, embedding: Float32Array): void;
    query(embedding: Float32Array, k: number): { contentHash: string; score: number }[];
  }
  export const NO_VECTORS: VectorStore | null = null;
  ```

- [ ] **Step 2: Commit** — `git commit -m "store: vector store seam (interface only)"`

### Task 6.2: Eval harness

**TDD scenario:** New feature — the harness itself is the test artifact (spec §12).

**Files:** Create `eval/cases.jsonl`, `eval/run.ts`

Design: each line `{ "query": "...", "expect": ["path/a.rb"] }`. `eval/run.ts` builds an index over a target repo (arg `--repo <path>`, default cwd), runs `locate` per case, computes hit@1/hit@5, and runs an `rg`-based baseline (`rg -l <query terms>`) counting whether expected files appear and how many candidate files rg returns. Prints a table.

- [ ] **Step 1: Write `eval/cases.jsonl`** with 8–12 real cases for a chosen repo (document which repo in a header comment line `# repo: example-monorepo`).
- [ ] **Step 2: Write `eval/run.ts`** (full: arg parse, build index via `runIndexPass`, loop cases, compute metrics, print).
- [ ] **Step 3: Run**

  Run: `node eval/run.ts --repo <path>`
  Expected: prints `hit@1`, `hit@5`, and rg-baseline comparison without throwing.

- [ ] **Step 4: Commit** — `git commit -m "eval: hit@k harness vs rg baseline + sample cases"`

### Task 6.3: Tune ranking + finalize docs

**TDD scenario:** Modifying tested code — run rank/locate tests after each weight change.

**Files:** Modify `src/navigator/rank.ts`, `README.md`, `NAVIGATOR.md`

- [ ] **Step 1: Run eval, adjust the four weights in `rank.ts` if a case regresses; re-run `node --test src/navigator/rank.test.ts src/navigator/locate.test.ts` (must stay green) and `node eval/run.ts`.**
- [ ] **Step 2: Fill any README/NAVIGATOR gaps (final config table, real example output).**
- [ ] **Step 3: Commit** — `git commit -m "navigator: tune ranking weights against eval; finalize docs"`

### Task 6.4: Release v0.1.0

**TDD scenario:** Trivial — release flow.

**Files:** Modify `CHANGELOG.md`, `package.json`

- [ ] **Step 1: Full green gate**

  Run: `npm run typecheck && node --test`
  Expected: all pass.

- [ ] **Step 2: Update `CHANGELOG.md` Unreleased → summary of PoC features.**
- [ ] **Step 3: Dry-run then release**

  Run: `DRY_RUN=1 bash .agents/skills/release/scripts/release.sh minor` (review), then `bash .agents/skills/release/scripts/release.sh minor`
  Expected: `package.json` → `0.1.0`, tag `v0.1.0` pushed.

- [ ] **Step 4: Verify install pin**

  Run: `pi -e git:github.com/jjuraszek/pi-navigator@v0.1.0 -p "/navigator status"` (requires ssh access)
  Expected: extension loads from the tag.

**FINAL CHECKPOINT:** All tests green; `v0.1.0` tagged; manual install verified.

---

## Open Questions

None. All spec-level decisions are resolved in `doc/specs/2026-05-30-repo-navigator-poc.md` §20. Two implementation risks to watch (not blockers):

1. **Worker loads `.ts` via Node native strip-types.** `new Worker(new URL("./worker.ts", …))` relies on Node 24 type-stripping for the worker entry (verified for `node --test`; confirm for `Worker` in Task 5.7's smoke run). If it fails in the target env, ship a sibling `worker.mjs` thin bootstrap that imports the core. 
2. **`tree-sitter build --wasm`** version drift across grammar packages (Task 0.2). Pin grammar versions that build cleanly; the built `.wasm` are committed so this is a one-time cost.
