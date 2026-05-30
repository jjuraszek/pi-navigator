# pi-navigator — Repository Navigator (PoC Spec)

- **Status:** Draft for review
- **Date:** 2026-05-30
- **Author:** jjuraszek
- **Scope:** Proof of concept. Core vertical slice only; expansion items explicitly deferred.

### Revision history
- **r3 (2026-05-30):** Bulk indexing moved to an async background `worker_thread`
  (non-blocking turns); indexing is **resumable** across kills via durable
  per-batch progress derived from DB state; dropped the `bun:sqlite` adapter
  branch (`node:sqlite`/Node only, verified working inside a worker).
- **r2 (2026-05-30):** Rolling hook-driven indexing (no CLI); storage switched to
  built-in `node:sqlite` (drop `better-sqlite3`); minimal tool-description nudge
  with persona injection off by default; index path
  `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`; single-writer lock for
  shared index across worktrees and subagents.
- **r1 (2026-05-30):** Initial draft (CLI indexer, better-sqlite3, persona injection).

---

## 1. Problem & Goal

A coding agent rediscovers a repository from scratch every session. On a large
polyglot monorepo (the motivating target: `example-monorepo` — ~6k files, ~8.4k
commits, Rails `dashboard` + several Python services) this means many
exploratory `rg`/`fd`/`read` round-trips before any reasoning happens.

The agent loop is **find → read → update**. That loop has two phases with
different cost profiles:

1. **Find / orient** — "where does X live, what relates to this, where is the
   entry point." Multiple exploratory tool calls. **The index attacks this.**
2. **Read-to-verify** — open the real bytes before reasoning or editing.
   Cannot be skipped without losing correctness. **The index makes this
   cheaper (smaller, hash-verified, batched, non-repeating), not absent.**

**Goal:** a persistent, worktree-aware index that turns multi-call orientation
into a single ranked lookup, and turns whole-file reads into verified slices —
kept fresh **automatically while the session runs**, without ever persisting
file contents or trusting stale data for a mutation.

### Non-goal

Replacing ground-truth reads before edits. The index never feeds an edit
directly from cached data; `navigator_slice` always returns current
working-tree bytes (see §7, §10).

---

## 2. Scope

### In (PoC core)

- **Rolling, hook-driven indexing** owned by the extension: catch-up on session
  start, re-index edited files immediately (high priority), and drain the
  full-crawl backlog in an **async background `worker_thread`** that never blocks
  a turn. **Resumable** — progress is durable, so a killed/restarted session
  continues from where it stopped, not from scratch. **No standalone CLI.**
- Shared `node:sqlite` index at `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`,
  **outside** any worktree, shared across worktrees and subagents.
- `navigator_locate(query)` — ranked entry points fused from FTS + path +
  symbol + recency, expanded with co-change neighbors and referrers (fan-out).
- `navigator_slice(path, symbol|range)` — exact current working-tree bytes +
  content hash (edit-ready, worktree-aware).
- Session verified-cache for slices (suppress re-reads of unchanged spans).
- In-session commands: `/navigator status`, `/navigator reindex [path]`.
- Encourage-use layer: directive **tool descriptions** (primary), `skills/navigator`
  skill, optional minimal persona line (off by default).
- Release script (git-tag-pin model).
- Minimal eval harness (hit@k vs an `rg` baseline).

### Out (deferred, named so they are not silently assumed)

- Standalone CLI / `bin` on PATH (replaced by rolling indexing + commands).
- LSP integration; call graph beyond import edges.
- LLM-generated summaries (retrieval/deep/symbol tiers).
- Embeddings / vector search (the vector concern is kept behind an interface;
  see §5.6).
- OS-level file watcher (rolling is pi-hook-driven, not `fs.watch`).
- Tuned ranking weights (PoC uses transparent additive constants; §8).
- Tracking the built-in `read` tool for the verified-cache (PoC caches only
  `navigator_slice` results; §7.3).
- Rails-aware metadata (routes/associations/jobs as first-class symbols).

---

## 3. Architecture Overview

One extension process owns indexing, querying, and freshness. No external CLI.

```
   pi session (Node 24)                          shared, repo-keyed
 ┌───────────────────────────────────────┐     ┌──────────────────────────────┐
 │ main thread (index.ts)                 │     │ node:sqlite (FTS5)           │
 │  session_start → elect writer (lock)   │     │ ~/.pi/pi-navigator-cache/    │
 │  tool_execution_end → priority enqueue │     │   <repo_name>_<repo_id>.db   │
 │  tools: navigator_locate / _slice      │ ◀── │ metadata+symbols+co-change   │
 │  commands: /navigator status|reindex   │read │ +ref edges+FTS               │
 │  verified-cache (in-memory)            │     │ NO file contents persisted   │
 ├───────────────────────────────────────┤     │ WAL: 1 writer, many readers  │
 │ async worker_thread  (sole writer)     │     │                              │
 │  derive resumable backlog from DB      │ ──▶ │                              │
 │  index off-thread, commit per batch    │write└──────────────────────────────┘
 └───────────────────────────────────────┘
        ▲ read-only — parallel subagents (pi-subagents) share this index;
        │            only the lock holder writes (see §10).
```

- **Index is a cross-worktree navigation approximation.** It may reflect another
  worktree/branch. Acceptable for *locate*.
- **Slice + verified-cache are always against the active worktree** (ground
  truth). Correctness of any read/edit never depends on index freshness.
- **repo-id** = short (12-char) root-commit SHA
  (`git rev-list --max-parents=0 HEAD | tail -1`), stable across clones and
  worktrees; fallback = hash of the realpath of `git rev-parse --git-common-dir`.
- **repo_name** = basename of the worktree top-level (human-readable filename).

---

## 4. Components & Responsibilities

| Component | Path | Responsibility |
|---|---|---|
| Extension entry | `index.ts` | Register hooks, tools, commands; own DB handle, spawn/own the worker, verified-cache. |
| Rolling scheduler | `src/indexer/rolling.ts` | Main-thread coordinator: writer-lock election, priority enqueue (edited files), spawn/own the worker, expose coverage. |
| Async worker | `src/indexer/worker.ts` | `worker_thread` sole writer: derives the resumable backlog from DB state, indexes off-thread, commits per batch. |
| Walk | `src/indexer/walk.ts` | gitignore-aware traversal + filters (size, binary, secret/ignore list). |
| Git signals | `src/indexer/git.ts` | Recency (last-commit-at, counts), co-change edges from `git log`. |
| Symbols | `src/indexer/symbols.ts` | `web-tree-sitter` (WASM) symbols + import edges per language. |
| DB adapter | `src/store/db.ts` | Thin `node:sqlite` wrapper (open, WAL pragma, prepared-statement helpers); suppresses the SQLite ExperimentalWarning. |
| Store | `src/store/{schema,queries}.ts` | DDL, migrations, FTS5, prepared statements. No file contents. |
| Vector seam | `src/store/vectors.ts` | Interface-only placeholder for future embeddings. |
| Navigator | `src/navigator/{locate,slice,rank,verified-cache}.ts` | Rank + fan-out, ground-truth slice, scoring, session cache. |
| Worktree | `src/worktree.ts` | Active-worktree root + repo-id/name + index path. |
| Config | `src/config.ts` | `navigator` settings namespace. |
| Tools/commands | `src/tools.ts`, `src/commands.ts` | Tool registration + `/navigator` command. |
| Persona | `prompts/navigator-persona.md` | Optional minimal system-prompt line (off by default). |
| Skill | `skills/navigator/SKILL.md` | When/how the agent should use the navigator. |
| Eval | `eval/` | Fixture queries → expected files; hit@k vs `rg` baseline. |
| Release | `.agents/skills/release/` | Tag-pin release skill + `scripts/release.sh`. |

---

## 5. Data Model (SQLite via `node:sqlite`)

WAL mode. Schema version in `meta`. **No table stores file contents** — only
metadata, symbol names, byte/line offsets, and hashes. Slice contents are read
live from disk (privacy + freshness; see §11 secrets).

### 5.1 `meta`
`key TEXT PRIMARY KEY, value TEXT` — `schema_version`, `repo_id`,
`head_sha_at_index`, `indexed_at`, `navigator_version`, `coverage_total`,
`coverage_indexed`, and the resume cursors `cochange_scanned_through` (oldest
commit SHA already folded into co-change) and `full_crawl_done` (0/1).

### 5.2 `files`
```
id INTEGER PRIMARY KEY,
path TEXT UNIQUE NOT NULL,         -- repo-relative, POSIX separators
lang TEXT,                         -- by extension; null if unknown
size INTEGER,
content_hash TEXT NOT NULL,        -- sha-256 of bytes at index time
mtime INTEGER,
last_commit_at INTEGER,            -- unix secs of newest commit touching file
commits_30d INTEGER DEFAULT 0,
commits_90d INTEGER DEFAULT 0,
indexed_at INTEGER NOT NULL,
symbols_done INTEGER DEFAULT 0     -- 0 until symbol pass completes (rolling)
```

### 5.3 `symbols`
```
id INTEGER PRIMARY KEY,
file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
name TEXT NOT NULL,
kind TEXT NOT NULL,                -- class|module|method|function|const
start_line INTEGER, end_line INTEGER,
start_byte INTEGER, end_byte INTEGER
```
Byte/line offsets are *hints* for slice. Validated against the live file before
use (§7.2).

### 5.4 `cochange`
```
file_a INTEGER NOT NULL,           -- normalized file_a < file_b
file_b INTEGER NOT NULL,
weight REAL NOT NULL,              -- recency-decayed count of shared commits
PRIMARY KEY (file_a, file_b)
```

### 5.5 `refs`
```
src_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
dst_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
kind TEXT NOT NULL,                -- import|require|require_relative
PRIMARY KEY (src_file, dst_file, kind)
```
"Who refers to this file" = `SELECT src_file FROM refs WHERE dst_file = ?`.

### 5.6 `search_index` (FTS5)
```
CREATE VIRTUAL TABLE search_index USING fts5(
  path, symbol_names, kind_tags,
  content='',                      -- contentless; tokens only
  tokenize='unicode61'
);
```
`bm25(search_index)` drives the text score (verified available in `node:sqlite`
on Node 24). Rowid == `files.id`. A `summary` column is intentionally omitted;
adding it later is additive.

**Vector seam (future, not built):** embeddings live behind
`src/store/vectors.ts` (interface only). When summary embeddings land, back it
with `sqlite-vec` or a LanceDB sidecar keyed by `content_hash`. No core schema
change required.

---

## 6. Rolling Indexing (async, resumable, no CLI)

Indexing is owned by the extension and runs in an async background
`worker_thread`, so turns are never blocked. All progress is durable, so a
killed or restarted session resumes from DB state rather than re-indexing from
scratch.

### 6.1 Triggers (main thread)
- **`session_start`:** resolve repo-id/path; open DB (create + migrate if new);
  attempt the writer lock (§10). If acquired, spawn the worker. If held
  elsewhere, run read-only (no worker).
- **`tool_execution_end`:** if the tool was `edit`/`write` (or a `bash` that
  likely mutated files), post the touched paths to the worker as **high
  priority** so long-lived sessions stay fresh; also record targets for the
  verified-cache.
- The main thread never indexes inline; it only elects the writer, posts
  priority paths, and reads.

### 6.2 Resumable backlog (derived from durable state)
The worker does not rely on an in-memory queue surviving a crash. On start it
**derives** remaining work from the DB + working tree, which is idempotent:
1. Walk the worktree (cheap: stat only) → for each file compare `mtime`/size to
   `files`; unchanged → skip, changed/new → needs (re)hash + symbols.
2. Files with `symbols_done = 0` → need the symbol/FTS pass.
3. Co-change: resume the `git log` scan from `meta.cochange_scanned_through`
   toward older commits until `cochangeMaxCommits`; fold in commits since
   `head_sha_at_index` for catch-up. Per-commit folding is additive and bounded
   by the cursor, so it is not double-counted.
Killing the process leaves the DB consistent (WAL + per-batch commits); the next
session re-derives and continues.

### 6.3 Priority order
1. Paths posted by the main thread this session (edited/written files).
2. Working-tree changes + commits since last index (catch-up).
3. Full-crawl backlog (the long tail) until `full_crawl_done = 1`.

### 6.4 Batching & crash safety
The worker commits every `indexBatchSize` files (default 50) in a
`BEGIN IMMEDIATE` transaction, sleeping `indexIdleMs` (default 25 ms) between
batches to stay gentle on CPU. A kill loses at most the in-flight batch.
Coverage counters in `meta` update per batch.

### 6.5 Coverage & freshness
`meta.coverage_indexed/coverage_total`, `full_crawl_done`, and
`head_sha_at_index` let `locate` report `index.fresh`/`coverage` and let
`/navigator status` show live progress. Partial coverage is usable; recent and
edited files are indexed first by design.

### 6.6 Manual control
- `/navigator status` — coverage, head-behind, queue depth, lock owner.
- `/navigator reindex` — clear + re-derive a full rebuild. `/navigator reindex
  <path>` re-indexes one path immediately (posted as top priority).

There is **no external `pi-navigator` binary**.

---

## 7. Navigator Tools

### 7.1 `navigator_locate`
Input: `{ query: string, limit?: number (default config.maxLocateResults=10) }`.

Behavior: query FTS + path match + symbol-name match; score (§8); for the top
result, attach its **co-change neighbors** and **referrers** (the fan-out) so
the agent gets the working cluster in one call.

Output (shape):
```jsonc
{
  "results": [
    {
      "path": "dashboard/app/models/grid.rb",
      "lang": "ruby",
      "score": 8.42,
      "signals": { "fts": 5.1, "path": 1.0, "symbol": 2.0, "recency": 0.32 },
      "symbols": [{ "name": "Grid", "kind": "class", "lines": [1, 240] }]
    }
  ],
  "cluster": {
    "anchor": "dashboard/app/models/grid.rb",
    "cochange": ["dashboard/app/services/grid_sync.rb"],
    "referrers": ["dashboard/app/controllers/grids_controller.rb"]
  },
  "index": { "fresh": false, "head_behind": 12, "coverage": 0.74 }
}
```

Tool description (the primary nudge): *"Use BEFORE ripgrep/read to orient in
this repository: returns ranked files plus what changes with them and what
refers to them."*

### 7.2 `navigator_slice`
Input: `{ path: string, symbol?: string, startLine?: number, endLine?: number }`.

Behavior (**ground-truth contract**):
1. Resolve `path` against the **active worktree** root.
2. Read current bytes; compute `content_hash`.
3. If `symbol` given: if file hash matches the indexed hash, use stored offsets;
   else re-run tree-sitter on the live file to locate the symbol. If
   `startLine/endLine` given, slice those lines from live content.
4. Return `{ path, range: [start,end], content, content_hash, stale_index }`.

Slice content is always live. The hash lets the caller reconcile with the
`edit` tool's exact-match requirement.

### 7.3 Session verified-cache
- In-memory `Map<absWorktreePath, content_hash>`, session-scoped.
- Populated by `navigator_slice` (and by edit/write paths seen at
  `tool_execution_end`).
- On a repeat slice of an unchanged file, response includes
  `unchanged_since_last_read: true` to discourage redundant re-reads.
- **PoC boundary:** does not intercept the built-in `read` tool's output (§2 Out).

---

## 8. Ranking (transparent, untuned)

PoC uses documented additive constants, **not** tuned weights and **no**
semantic percentages:

```
score = w_fts * norm(bm25)
      + w_path * pathMatch(query, path)        // basename/segment hit
      + w_symbol * symbolExactMatch(query)     // exact symbol name
      + w_recency * recencyBoost(file)         // commits_30d, last_commit_at
```
Defaults: `w_fts=1.0, w_path=1.0, w_symbol=2.0, w_recency=0.5`. Co-change is
**not** in the primary score; it drives the `cluster` fan-out only. Weights are
constants in `src/navigator/rank.ts`, tuned later against the eval harness (§12).

---

## 9. Encourage-Use Layer (prompt-cost aware)

Ordered by cost, cheapest first. The default config adds **zero ambient tokens**
to agents that do not hold the navigator tools.

1. **Tool descriptions (primary).** The "use before ripgrep/read" guidance lives
   in the `navigator_locate`/`navigator_slice` descriptions, so it is only paid
   when the tool is in that agent's toolset. This is the main behavior driver.
2. **Skill** — `skills/navigator/SKILL.md`: when/how, with examples; loaded on
   demand, not ambient.
3. **Optional persona line — OFF by default.** When `config.injectPersona` is
   true, `before_agent_start` appends **one ~25-word sentence**, and only if the
   navigator tools are active for that agent (guarded via `getActiveTools`). No
   multi-paragraph fragment.

### pi-subagents interaction
pi-navigator is **orthogonal** to pi-subagents (tool+index vs orchestration; no
code coupling). The relationship is pure synergy and one guard rail:

- **Shared index:** parent and all parallel subagents on the same repo read the
  same DB (same repo-id). WAL → concurrent reads are safe and fast.
- **Single writer:** only the lock holder (typically the root session) runs
  rolling indexing; subagents read-only (§10). N subagents do **not** spawn N
  indexers.
- **No prompt tax:** because the nudge is tool-description-based and persona
  injection is off by default and guarded, spinning up many subagents does not
  multiply ambient system-prompt tokens.

---

## 10. Worktree-Awareness, Index Location, Concurrency

- **Index path:** `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`
  (configurable via `indexDir`). Outside every worktree; shared by all worktrees
  and all agents/subagents of the same repo.
- **Active worktree root:** `git rev-parse --show-toplevel` from cwd. All slice
  reads + verified-cache keys use this root.
- **Single-writer lock:** an advisory lock (`<db>.lock` carrying pid + mtime,
  reclaimed if stale) elects one indexer across processes/worktrees/subagents.
  Writers use `BEGIN IMMEDIATE`; readers (`locate`/`slice`) always proceed under
  WAL. This is robust without needing to detect "am I a subagent."
- **Branch divergence:** `locate` may surface files from another branch; results
  carry `index.fresh`. Slice/verified-cache are always ground truth, so
  divergence never causes an incorrect read or edit.

---

## 11. Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Non-git directory | Degrade: FTS + symbols only; no recency/co-change; warn once. |
| No/partial index | `locate` works on what's indexed and reports `coverage`; the worker fills the rest. |
| Binary / oversized file | Skipped at walk (size cap + binary sniff). |
| Vendored/generated dirs | Default ignore list + `.gitignore`. |
| Deleted file in index | Filtered from `locate`; removed on catch-up. |
| Stale symbol offsets | `slice` re-extracts from live file. |
| Slice path outside worktree / missing | Hard error; never read outside the worktree root. |
| Secrets | DB stores **no contents**; default-ignore `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`; tokens only; slices honor the same ignore list. |
| Writer-lock contention | Non-holders read-only; no duplicate indexing; stale lock reclaimed by mtime. |
| Process killed mid-index | DB stays consistent (WAL + per-batch commits); next session re-derives the backlog and resumes (§6.2). |
| `node:sqlite` ExperimentalWarning | Suppressed once at DB-adapter load (filter that one warning). |
| Corrupt/old schema | Migrate by `schema_version`; rebuild if beyond migration. |

---

## 12. Testing Approach

- **Runner:** `node --test` (built-in; keeps the package dependency-free; `bun
  test` also works for local dev).
- **Unit:** symbol extraction per language on fixtures; co-change from a
  synthetic `git log`; ranking determinism; repo-id/worktree resolution; slice
  staleness re-extraction; secret-ignore enforcement; lock election.
- **Integration:** build an index over a fixture repo via the rolling scheduler
  (drained synchronously in tests); assert `locate` ranks expected files; assert
  `slice` returns live bytes + correct hash after an edit.
- **Eval harness (`eval/`):** 10–20 "where do I start" cases
  (`query → expected target paths`). Report hit@k and tool-call count vs an `rg`
  baseline — the gate that decides whether the index beats grep. **Should-have**
  for `v0.1.0` (ship even with a small case set).

---

## 13. Repository Scaffold

Mirrors sibling pi packages (`pi-context-prune`, `pi-superpowers`). Created in
the implementation phase; enumerated here as the contract.

```
pi-navigator/
├── index.ts                      # extension entry: hooks, tools, commands, queue, cache
├── src/
│   ├── indexer/
│   │   ├── rolling.ts            # main-thread coordinator: lock, priority enqueue, owns worker
│   │   ├── worker.ts             # worker_thread sole writer: resumable backlog, batched commits
│   │   ├── walk.ts               # gitignore-aware traversal + filters
│   │   ├── git.ts                # recency + co-change
│   │   ├── symbols.ts            # web-tree-sitter symbols + import edges
│   │   └── index.ts             # shared indexing helpers
│   ├── store/
│   │   ├── db.ts                 # node:sqlite wrapper (WAL, prepared stmts); warning suppress
│   │   ├── schema.ts             # DDL + migrations
│   │   ├── queries.ts            # prepared statements
│   │   └── vectors.ts            # interface-only seam for future embeddings
│   ├── navigator/
│   │   ├── locate.ts             # rank + fan-out
│   │   ├── slice.ts              # ground-truth slice
│   │   ├── rank.ts               # transparent scoring constants
│   │   └── verified-cache.ts     # session slice cache
│   ├── worktree.ts               # repo-id/name + worktree root + index path
│   ├── config.ts                 # `navigator` settings namespace
│   ├── tools.ts                  # navigator_locate / navigator_slice registration
│   └── commands.ts               # /navigator status | reindex
├── prompts/
│   └── navigator-persona.md      # optional, off by default
├── skills/
│   └── navigator/SKILL.md
├── eval/
│   ├── cases.jsonl
│   └── run.ts                    # hit@k vs rg baseline
├── grammars/                     # bundled *.wasm tree-sitter grammars
├── .agents/skills/release/
│   ├── SKILL.md
│   └── scripts/release.sh
├── doc/specs/                    # this spec + future specs/plans
├── AGENTS.md                     # §14
├── README.md                     # §15
├── NAVIGATOR.md                  # deep doc: schema, ranking, rolling algorithm, rationale
├── CHANGELOG.md                  # newest-first, tag-aligned
├── package.json                  # pi manifest, keywords ["pi-package"], peerDeps @earendil-works/*
├── tsconfig.json
├── .gitignore
└── .npmignore
```

---

## 14. AGENTS.md Outline (communication style inlined)

The repo's `AGENTS.md` must be self-contained — it does **not** rely on the
user-global `~/.pi/agent*/AGENTS.md`. Sections:

1. **Project overview** — what pi-navigator is, the find→read→update thesis.
2. **Communication style (inlined verbatim, not referenced)** — suppress process
   narration; outcomes over status; bullets over prose; match recipient register
   for human-facing text; keep LLM-readable artifacts (specs, AGENTS.md, README,
   skills) structured.
3. **Shell behavior** — non-interactive bash; banned commands; non-interactive
   flag table; prefer `rg`/`fd`. (Inlined so the repo stands alone.)
4. **Ground truth before reasoning** — type imports are runtime-erased; target
   `@earendil-works/*`; verify the live extension API surface against the
   installed pi version before relying on it.
5. **Project layout** — the §13 tree with one-line responsibilities.
6. **Routing / verification commands** — `node --test`, how to load locally
   (`pi -e ./index.ts`), `/navigator status` to confirm indexing.
7. **Code & doc discipline** — no comments restating code; no commented-out code;
   **invariants:** the DB never stores file contents; only the lock holder writes;
   slices always read the active worktree.

---

## 15. README.md Outline (human-readable)

Audience: a human deciding whether to install and how. Leads with the six core
ideas, in plain language:

1. **First-contact orientation** — one call to find the entry points in a large
   or unfamiliar codebase, instead of a grep safari.
2. **Cross-subproject locate** — find the right service/area in a monorepo.
3. **Relationship knowledge** — what files change together (git co-change) and
   who refers to a file (import edges) — signals grep cannot give.
4. **Serve slices** — read the exact symbol span, not the whole file.
5. **Skip re-reads (worktree-aware)** — a slice already read this session is
   flagged unchanged; reads/edits always hit the active worktree's real bytes.
6. **One fan-out instead of a serial loop** — locate returns the target plus its
   co-change neighbors and referrers together.

Then: **Install** (§17), **How it stays fresh** (rolling indexing — nothing to
run), **What it does/does not do** (honest: speeds find + read, never replaces
the read-before-edit), **Configuration**, **Commands/Tools**, link to
`NAVIGATOR.md`.

---

## 16. Release Process

Git-tag-pin, no npm publish (private repo). `.agents/skills/release/scripts/release.sh`:

1. Require clean tree on `main` (configurable).
2. Bump `package.json` version (`patch|minor|major` or explicit `vX.Y.Z`).
3. Prepend a `CHANGELOG.md` entry.
4. Commit `release: vX.Y.Z`, `git tag vX.Y.Z`, `git push --follow-tags`.
5. Optionally rewrite git-pins in `~/.pi/agent*/settings.json` to the new tag.

Flags: `--dry-run`, `--no-update-pins`, version selector. Private-repo installs
resolve over ssh (the maintainer's gh auth uses ssh).

---

## 17. Install & Configuration

```bash
# user scope (all repos)
pi install git:github.com/jjuraszek/pi-navigator@v0.1.0
# project scope (current repo, committable via .pi/settings.json)
pi install -l git:github.com/jjuraszek/pi-navigator@v0.1.0
# one-shot, no install
pi -e git:github.com/jjuraszek/pi-navigator@v0.1.0
# local checkout (hacking)
pi -e ~/repos/pi-navigator/index.ts
```

No indexing command to run: the index builds and stays fresh automatically while
you work (§6). `/navigator status` shows progress; `/navigator reindex` forces a
rebuild. Private-repo note: requires git ssh access to `jjuraszek/pi-navigator`.

Config under the `navigator` key in `<agent-dir>/settings.json`
(`$PI_CODING_AGENT_DIR` or `~/.pi/agent`):

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `injectPersona` | `false` | Off by default; tool descriptions carry the nudge. |
| `indexDir` | `~/.pi/pi-navigator-cache` | Index location (filename `<repo_name>_<repo_id>.db`). |
| `languages` | `["ruby","python","js","ts"]` | Symbol extraction set. |
| `maxLocateResults` | `10` | Result cap. |
| `indexBatchSize` | `50` | Files per worker commit (crash-loss bound). |
| `indexIdleMs` | `25` | Worker sleep between batches (CPU gentleness). |
| `cochangeWindowDays` | `180` | Recency decay window. |
| `cochangeMaxCommits` | `4000` | Commit scan bound. |
| `cochangeMaxFilesPerCommit` | `50` | Ignore mega-commits for co-change. |
| `maxFileBytes` | `1048576` | Skip larger files. |

---

## 18. Dependencies

- **Storage:** built-in **`node:sqlite`** (Node ≥ 22.5; verified unflagged on
  Node 24.5 with FTS5 + `bm25()`, including inside a `worker_thread` with WAL).
  **No `better-sqlite3`, no `bun:sqlite` branch** (Node is pi's runtime). The
  single ExperimentalWarning is suppressed at adapter load.
- **Runtime dep (only one):** `web-tree-sitter` (WASM — no node-gyp) + bundled
  `*.wasm` grammars for Ruby/Python/TS/JS.
- **Peer (typecheck only; runtime-erased type imports):**
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-tui`, `@sinclair/typebox`.
- **Why:** §1 storage decision (relational co-change + FTS5 BM25; vectors
  deferred) plus the goal of a compile-free, near-zero-dependency `pi install`.

---

## 19. Build Order (milestones)

1. Scaffold + `package.json` manifest + AGENTS.md/README/CHANGELOG + release
   script + CI (`node --test`, typecheck).
2. Store layer (`db.ts` adapter, schema, migrations, queries) + worktree/repo-id.
3. Writer lock + async worker (`worker_thread`) with resumable backlog +
   per-batch commits; main-thread hooks (session_start election, edit-trigger
   priority enqueue) + git signals (recency, co-change).
4. Symbols + import edges (web-tree-sitter). FTS population.
5. `navigator_locate` + ranking + fan-out. `/navigator status|reindex` +
   staleness reporting.
6. `navigator_slice` + verified-cache + tool-description nudges (+ optional
   persona).
7. Eval harness; tune ranking constants; first tagged release `v0.1.0`.

---

## 20. Resolved Review Decisions

All r1–r2 open questions are resolved (review, 2026-05-30):

1. **Initial-build / async (r3).** Bulk indexing runs in an async background
   `worker_thread` (non-blocking) and is **resumable across kills** via durable
   per-batch progress derived from DB state (§6.2, §6.4). Not main-thread ticks.
2. **`node:sqlite` ExperimentalWarning.** Suppressed once at adapter load.
3. **Eval harness.** Should-have for `v0.1.0` — ship with a small case set (§12).
4. **Subagent safety.** Advisory writer-lock only; no subagent-context detection
   (§10).
5. **Bun runtime.** Out of scope — `node:sqlite`/Node only; no `bun:sqlite`
   branch (§18).

No open questions remain for the PoC. Future expansion (summaries, embeddings,
LSP, Rails-aware metadata, worker pool) is tracked in §2 Out and §5.6.
```

