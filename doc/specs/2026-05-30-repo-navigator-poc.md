# pi-navigator — Repository Navigator (PoC Spec)

- **Status:** Draft for review
- **Date:** 2026-05-30
- **Author:** jjuraszek
- **Scope:** Proof of concept. Core vertical slice only; expansion items explicitly deferred.

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
without ever persisting file contents or trusting stale data for a mutation.

### Non-goal

Replacing ground-truth reads before edits. The index never feeds an edit
directly from cached data; `navigator_slice` always returns current
working-tree bytes (see §7, §10).

---

## 2. Scope

### In (PoC core)

- `pi-navigator index` CLI: file metadata, content hashes, git co-change +
  recency, symbol extraction (Ruby/Python/JS/TS), import edges.
- Shared SQLite index at a repo-keyed cache path **outside** any worktree.
- `navigator_locate(query)` — ranked entry points fused from FTS + path +
  symbol + recency, expanded with co-change neighbors and referrers (fan-out).
- `navigator_slice(path, symbol|range)` — exact current working-tree bytes +
  content hash (edit-ready, worktree-aware).
- Session verified-cache for slices (suppress re-reads of unchanged spans).
- Encourage-use layer: persona system-prompt injection (`before_agent_start`),
  `prompts/` template, `skills/navigator` skill, directive tool descriptions.
- Release script (git-tag-pin model).
- Minimal eval harness (hit@k vs an `rg` baseline).

### Out (deferred, named so they are not silently assumed)

- LSP integration; call graph beyond import edges.
- LLM-generated summaries (retrieval/deep/symbol tiers).
- Embeddings / vector search (the vector concern is kept behind an interface;
  see §5.6).
- Real-time file watcher (PoC uses incremental-on-invoke + git diff).
- Tuned ranking weights (PoC uses transparent additive constants; §8).
- Tracking the built-in `read` tool for the verified-cache (PoC caches only
  `navigator_slice` results; §7.3).
- Rails-aware metadata (routes/associations/jobs as first-class symbols).

---

## 3. Architecture Overview

Three cooperating parts plus shared storage:

```
                ┌─────────────────────────────────────────────┐
                │  pi-navigator CLI  (bun ./cli.ts index ...)   │
                │  walk → git signals → symbols → write index   │
                └───────────────────────┬─────────────────────┘
                                        │ writes (WAL, single writer)
                                        ▼
              ┌───────────────────────────────────────────────────┐
              │  SQLite index  (better-sqlite3 + FTS5)             │
              │  ${XDG_CACHE_HOME:-~/.cache}/pi-navigator/<repo-id>/index.db │
              │  metadata + symbols + co-change + ref edges + FTS  │
              │  NO file contents persisted                        │
              └───────────────────────┬───────────────────────────┘
                                       │ reads (read-only handles)
                ┌──────────────────────┴────────────────────────┐
                │  pi extension  (index.ts)                      │
                │  navigator_locate / navigator_slice tools      │
                │  persona injection (before_agent_start)        │
                │  /navigator status command + staleness notify  │
                │  in-memory session verified-cache              │
                └────────────────────────────────────────────────┘
```

- **Index is a cross-worktree navigation approximation.** It may have been
  built from a different worktree/branch. That is acceptable for *locate*.
- **Slice + verified-cache are always against the active worktree** (ground
  truth). Correctness of any read/edit never depends on index freshness.
- **repo-id** = root commit SHA (`git rev-list --max-parents=0 HEAD | tail -1`),
  stable across clones and worktrees; fallback = hash of the realpath of
  `git rev-parse --git-common-dir` when there are no commits.

---

## 4. Components & Responsibilities

| Component | Path | Responsibility |
|---|---|---|
| Extension entry | `index.ts` | Register tools, inject persona, `/navigator` command, session staleness notify, own the verified-cache. |
| Indexer | `src/indexer/` | Walk (gitignore-aware), collect file metadata + hashes, run git signals, extract symbols + import edges. |
| Git signals | `src/indexer/git.ts` | Recency (last-commit-at, commit counts), co-change edges from `git log`. |
| Symbols | `src/indexer/symbols.ts` | `web-tree-sitter` (WASM) symbol + import extraction per language. |
| Store | `src/store/` | SQLite schema, migrations, FTS5, prepared queries. No file contents. |
| Navigator | `src/navigator/` | `locate` (rank + fan-out), `slice` (ground-truth read), verified-cache. |
| Worktree | `src/worktree.ts` | Active-worktree root + repo-id + index-path resolution. |
| CLI | `src/cli.ts` | `index` / `status` / `query` subcommands. |
| Persona | `prompts/navigator-persona.md` | System-prompt fragment encouraging locate-before-grep. |
| Skill | `skills/navigator/SKILL.md` | When/how the agent should use the navigator. |
| Eval | `eval/` | Fixture queries → expected files; hit@k vs `rg` baseline. |
| Release | `.agents/skills/release/` | Tag-pin release skill + `scripts/release.sh`. |

---

## 5. Data Model (SQLite)

WAL mode. Schema version stored in `meta`. **No table stores file contents** —
only metadata, symbol names, byte/line offsets, and hashes. Slice contents are
read live from disk (privacy + freshness; see §11 secrets).

### 5.1 `meta`
`key TEXT PRIMARY KEY, value TEXT` — `schema_version`, `repo_id`,
`head_sha_at_index`, `indexed_at`, `navigator_version`.

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
indexed_at INTEGER NOT NULL
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
  content='',                      -- contentless; we store tokens only
  tokenize='unicode61'
);
```
`bm25(search_index)` drives the text score. Rowid == `files.id`. A `summary`
column is intentionally omitted now; adding it later is additive.

**Vector seam (future, not built):** embeddings live in a separate concern
behind `src/store/vectors.ts` (interface only in the PoC). When summary
embeddings land, back it with `sqlite-vec` (stay single-store) or a LanceDB
sidecar keyed by `content_hash`. No core schema change required.

---

## 6. Indexing Pipeline

### 6.1 Full (`pi-navigator index --full`)
1. Resolve repo-id + index path; open DB (WAL); run migrations.
2. Walk the worktree honoring `.gitignore` + a default ignore list
   (`.git`, `node_modules`, `vendor`, `dist`, `build`, `tmp`, `.worktrees`)
   + size cap (default 1 MB) + binary detection (skip).
3. Per file: language by extension, sha-256, mtime; tree-sitter symbols +
   import edges for supported languages.
4. Git signals: scan up to `cochangeMaxCommits` (default 4000) of `git log
   --name-only`; accumulate recency and co-change weights (recency-decayed,
   window `cochangeWindowDays` default 180; cap fan-in of huge commits, e.g.
   ignore commits touching > 50 files for co-change to avoid mass-rename noise).
5. Build `refs` by resolving import statements to files (best-effort per
   language).
6. Populate FTS. Write `meta.head_sha_at_index = git rev-parse HEAD`.

### 6.2 Incremental (`pi-navigator index`, default)
1. Read `meta.head_sha_at_index`.
2. `git diff --name-status <last> HEAD` + `git status --porcelain` → changed,
   added, deleted, renamed paths.
3. Re-index changed/added; delete rows for removed paths (cascade).
4. Recompute co-change/recency contributions from commits since `<last>`.
5. Update `meta`.

Indexing is **explicit** (CLI), not automatic, to avoid blocking sessions. The
extension emits a one-line staleness notice on `session_start` when
`HEAD != head_sha_at_index` or no index exists.

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
  "index": { "fresh": false, "head_behind": 12 }
}
```
`index.fresh=false` warns the agent the index lags the working tree.

### 7.2 `navigator_slice`
Input: `{ path: string, symbol?: string, startLine?: number, endLine?: number }`.

Behavior (**ground-truth contract**):
1. Resolve `path` against the **active worktree** root.
2. Read current bytes; compute `content_hash`.
3. If `symbol` given: if file hash matches the indexed hash, use stored offsets;
   else re-run tree-sitter on the live file to locate the symbol (cheap, one
   file). If `startLine/endLine` given, slice those lines from live content.
4. Return `{ path, range: [start,end], content, content_hash, stale_index }`.

The slice content is always live. The hash lets the caller reconcile with the
`edit` tool's exact-match requirement.

### 7.3 Session verified-cache
- In-memory `Map<absWorktreePath, content_hash>`, session-scoped.
- Populated by `navigator_slice`.
- On a repeat slice of an unchanged file, response includes
  `unchanged_since_last_read: true` to discourage redundant re-reads.
- **PoC boundary:** caches only navigator-served slices. Hooking the built-in
  `read` tool is deferred (§2 Out).

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

## 9. Encourage-Use Layer

Four reinforcing mechanisms (all default-on, config-gated):

1. **Persona injection** — `before_agent_start` appends a short fragment to the
   system prompt when `config.injectPersona` and an index exists: *"This repo
   has a navigator index. Call `navigator_locate` before grepping to orient;
   use `navigator_slice` to read spans; a slice marked `unchanged_since_last_read`
   need not be re-read."* Kept under ~120 words to limit prompt-cache churn.
2. **Prompt template** — `prompts/navigator-persona.md` (same content, reusable
   via the `pi` manifest `prompts` array).
3. **Skill** — `skills/navigator/SKILL.md`: when/how to use, with examples.
4. **Tool descriptions** — `navigator_locate` description leads with "Use this
   BEFORE ripgrep/read when orienting in this repository."

---

## 10. Worktree-Awareness, Index Location, Concurrency

- **Index path:** `${XDG_CACHE_HOME:-$HOME/.cache}/pi-navigator/<repo-id>/index.db`.
  Outside every worktree; shared by all worktrees of the same repo.
- **Active worktree root:** `git rev-parse --show-toplevel` from cwd. All slice
  reads + verified-cache keys use this root.
- **Concurrency:** WAL. The CLI is the single writer and takes a write lock
  (`BEGIN IMMEDIATE`); the extension opens **read-only** handles. Concurrent
  indexing from two worktrees is serialized; the loser retries or no-ops.
- **Branch divergence:** locate may surface files/paths from another branch;
  results carry `index.fresh`. Slice/verified-cache are always ground truth, so
  divergence never causes an incorrect read or edit.

---

## 11. Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Non-git directory | Degrade: FTS + symbols only; no recency/co-change; warn once. |
| No index yet | `locate`/`slice` return a clear "run `pi-navigator index`" error; `session_start` notifies. |
| Binary / oversized file | Skipped at walk (size cap + binary sniff). |
| Vendored/generated dirs | Default ignore list + `.gitignore`. |
| Deleted file in index | Filtered from `locate`; removed on incremental. |
| Stale symbol offsets | `slice` re-extracts from live file. |
| Slice path outside worktree / missing | Hard error; never read outside the worktree root. |
| Secrets | DB stores **no contents**; default-ignore `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`; symbol/path tokens only. Slices read live and are subject to the same ignore list (no slice of an ignored secret file). |
| Concurrent writers | WAL + `BEGIN IMMEDIATE`; serialized. |
| Corrupt/old schema | Migrate by `schema_version`; on mismatch beyond migration, rebuild. |

---

## 12. Testing Approach

- **Runner:** `bun test src/` (matches sibling pi packages).
- **Unit:** symbol extraction per language on fixtures; co-change from a
  synthetic `git log`; ranking determinism; repo-id/worktree resolution; slice
  staleness re-extraction; secret-ignore enforcement.
- **Integration:** build an index over a fixture repo; assert `locate` ranks
  expected files; assert `slice` returns live bytes + correct hash after an edit.
- **Eval harness (`eval/`):** 10–20 real "where do I start" cases
  (`query → expected target paths`). Report hit@k and tool-call count vs an `rg`
  baseline. This is the gate that decides whether the index beats grep before
  investing further. Marked **should-have** for the PoC (ship even if the case
  set is small).

---

## 13. Repository Scaffold

Mirrors sibling pi packages (`pi-context-prune`, `pi-superpowers`). Created in
the implementation phase; enumerated here as the contract.

```
pi-navigator/
├── index.ts                      # extension entry: tools, persona, command, staleness
├── cli.ts                        # thin shim → src/cli.ts (bin target)
├── src/
│   ├── indexer/
│   │   ├── walk.ts               # gitignore-aware traversal + filters
│   │   ├── git.ts                # recency + co-change
│   │   ├── symbols.ts            # web-tree-sitter symbols + import edges
│   │   └── index.ts             # orchestration (full + incremental)
│   ├── store/
│   │   ├── schema.ts             # DDL + migrations
│   │   ├── queries.ts            # prepared statements
│   │   └── vectors.ts            # interface-only seam for future embeddings
│   ├── navigator/
│   │   ├── locate.ts             # rank + fan-out
│   │   ├── slice.ts              # ground-truth slice
│   │   ├── rank.ts               # transparent scoring constants
│   │   └── verified-cache.ts     # session slice cache
│   ├── worktree.ts               # repo-id + worktree root + index path
│   ├── config.ts                 # `navigator` settings namespace
│   └── tools.ts                  # navigator_locate / navigator_slice registration
├── prompts/
│   └── navigator-persona.md
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
├── NAVIGATOR.md                  # deep doc: schema, ranking, algorithms, rationale
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
2. **Communication style (inlined verbatim, not referenced)** — suppress
   process narration; outcomes over status; bullets over prose; match
   recipient register for human-facing text; keep LLM-readable artifacts
   (specs, AGENTS.md, README, skills) structured.
3. **Shell behavior** — non-interactive bash; banned commands; non-interactive
   flag table; prefer `rg`/`fd`. (Inlined so the repo stands alone.)
4. **Ground truth before reasoning** — type imports are runtime-erased; target
   `@earendil-works/*`; verify the live extension API surface against the
   installed pi version before relying on it.
5. **Project layout** — the §13 tree with one-line responsibilities.
6. **Routing / verification commands** — `bun test src/`, `pi-navigator index`,
   how to load locally (`pi -e ./index.ts`).
7. **Code & doc discipline** — no comments restating code; no commented-out
   code; the DB never stores file contents (invariant).

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
   flagged unchanged so the agent does not re-read it; reads/edits always hit
   the active worktree's real bytes.
6. **One fan-out instead of a serial loop** — locate returns the target plus its
   co-change neighbors and referrers together.

Then: **Install** (§17), **Build the index** (`pi-navigator index`),
**What it does/does not do** (honest: speeds find + read, never replaces the
read-before-edit), **Configuration**, **Commands/Tools**, link to `NAVIGATOR.md`.

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

# then build the index once per repo:
pi-navigator index            # incremental (default)
pi-navigator index --full     # first time / rebuild
```

Private-repo note: requires git ssh access to `jjuraszek/pi-navigator`.

Config under the `navigator` key in `<agent-dir>/settings.json`
(`$PI_CODING_AGENT_DIR` or `~/.pi/agent`):

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `injectPersona` | `true` | Append the locate-before-grep fragment. |
| `indexPath` | cache path | Override index location. |
| `languages` | `["ruby","python","js","ts"]` | Symbol extraction set. |
| `maxLocateResults` | `10` | Result cap. |
| `cochangeWindowDays` | `180` | Recency decay window. |
| `cochangeMaxCommits` | `4000` | Commit scan bound. |
| `cochangeMaxFilesPerCommit` | `50` | Ignore mega-commits for co-change. |
| `maxFileBytes` | `1048576` | Skip larger files. |

---

## 18. Dependencies

- **Runtime:** `better-sqlite3` (native, ships prebuilt binaries — no compiler
  on supported platforms), `web-tree-sitter` (WASM — no node-gyp) + bundled
  `*.wasm` grammars for Ruby/Python/TS/JS.
- **Peer (typecheck only; runtime-erased type imports):**
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-tui`, `@sinclair/typebox`.
- **Why these choices:** §1 storage decision (SQLite for relational co-change +
  FTS5 BM25; vectors deferred). web-tree-sitter chosen over native tree-sitter
  to keep `pi install` free of compilation.

---

## 19. Build Order (milestones)

1. Scaffold + `package.json` manifest + AGENTS.md/README/CHANGELOG + release
   script + CI typecheck.
2. Store layer (schema, migrations, queries) + worktree/repo-id resolution.
3. Indexer: walk + hashes + git signals (recency, co-change). CLI `index`.
4. Symbols + import edges (web-tree-sitter). FTS population.
5. `navigator_locate` + ranking + fan-out. `/navigator status` + staleness.
6. `navigator_slice` + verified-cache + persona injection.
7. Eval harness; tune ranking constants; first tagged release `v0.1.0`.

---

## 20. Open Questions

1. **CLI distribution.** `bin` entry (`pi-navigator` on PATH) vs documented
   `bun run`/`pi -e` invocation vs a `/navigator index` command that spawns a
   child indexer. Lean: `bin` + `/navigator status`; confirm pi package `bin`
   support.
2. **node:sqlite alternative.** Node 24 ships an experimental built-in
   `node:sqlite` (zero native dep). Worth evaluating to drop `better-sqlite3`
   entirely if FTS5 is compiled in and the experimental flag is acceptable.
3. **Auto-index trigger.** PoC keeps indexing explicit + a staleness notice.
   Confirm we do not want a debounced auto-reindex on `session_start`.
4. **Eval scope.** Must-have vs should-have for `v0.1.0`. Spec assumes
   should-have (ship a small case set).
5. **Persona aggressiveness.** Default-on persona injection adds ~120 words to
   every system prompt (prompt-cache cost). Confirm default-on is desired.
```

