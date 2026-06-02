# NAVIGATOR - Technical Reference

Deep documentation for the pi-navigator extension. Covers the database schema, ranking algorithm, rolling/resumable indexing design, worktree and lock model, and the vector-embedding expansion seam.

---

## Database Schema

The index lives at `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`. It uses `node:sqlite` with WAL mode and foreign keys enabled. Secret globs and gitignored files are never walked; tracked source is indexed as a keyword inverted index (derived tokens only - no original byte layout).

### `meta`

Key/value store for index-level state.

| key | value |
|---|---|
| `schema_version` | Integer version for migration gating |
| `repo_id` | 12-char root-commit SHA (stable across clones and worktrees) |
| `head_sha_at_index` | HEAD SHA at last index run; drives freshness reporting |
| `indexed_at` | Unix timestamp of last index run |
| `navigator_version` | Extension version that wrote the index |
| `coverage_total` | Total file count in the worktree |
| `coverage_indexed` | Files fully indexed (hash + symbols + FTS) |
| `cochange_scanned_through` | Oldest commit SHA folded into co-change; resume cursor |
| `full_crawl_done` | `"0"` or `"1"` - whether the full walk has completed |

### `files`

One row per tracked file.

```sql
id INTEGER PRIMARY KEY,
path TEXT UNIQUE NOT NULL,      -- repo-relative, POSIX separators
lang TEXT,                      -- "ruby"|"python"|"ts"|"js"|null
size INTEGER,
content_hash TEXT NOT NULL,     -- sha-256 hex of bytes at index time
mtime INTEGER,                  -- file mtime at index time (for change detection)
last_commit_at INTEGER,         -- unix secs of newest commit touching this file
commits_30d INTEGER DEFAULT 0,
commits_90d INTEGER DEFAULT 0,
indexed_at INTEGER NOT NULL,
symbols_done INTEGER DEFAULT 0  -- 0 until symbol/FTS pass completes
```

### `symbols`

Named code constructs extracted by tree-sitter.

```sql
id INTEGER PRIMARY KEY,
file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
name TEXT NOT NULL,
kind TEXT NOT NULL,             -- "class"|"module"|"method"|"function"|"const"
start_line INTEGER,
end_line INTEGER,
start_byte INTEGER,             -- byte offset hints for slice
end_byte INTEGER
```

Byte/line offsets are hints validated against the live file before use. If the file has changed since indexing, `navigator_slice` re-extracts the symbol from the current bytes.

### `cochange`

Recency-decayed co-change weights between file pairs.

```sql
file_a INTEGER NOT NULL,        -- always file_a < file_b (normalized)
file_b INTEGER NOT NULL,
weight REAL NOT NULL,           -- sum of exp(-ageDays/windowDays) over shared commits
PRIMARY KEY (file_a, file_b)
```

Co-change is computed from `git log` by scanning commits that touched multiple files and folding in a recency-decayed weight for each pair. Large commits (> `cochangeMaxFilesPerCommit`) are excluded from co-change to suppress noise from mass reformats or dependency updates.

### `refs`

Import/require edges between files.

```sql
src_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
dst_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
kind TEXT NOT NULL,             -- "import"|"require"|"require_relative"|"ruby_const"
PRIMARY KEY (src_file, dst_file, kind)
```

"Who refers to this file" query: `SELECT src_file FROM refs WHERE dst_file = ?`.

`ruby_const` edges are written for Rails autoloaded constants (see §Ruby Referrers). They are structurally identical to other `refs` edges; the `kind` column enables the df-cap to filter them separately at query time.

### `search_index` (FTS5)

Standard stored FTS5 table (NOT `content=''`). Stores an inverted index over four columns for content-aware BM25 search. **No original file bytes are retained** - only tokenized fragments derived from symbol names, comment/string-literal text, and path segments (a recoverable bag-of-words, never the original byte layout). Secret and gitignored files are never indexed.

**Schema version: 4** (porter stemmer, 4 columns, prose indexing - upgraded from the earlier 3-column `unicode61` table).

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  path,          -- path segments split on / _ - . and camelCase
  symbol_names,  -- tree-sitter symbol names, space-joined
  keywords,      -- filtered keyword tokens from symbol names + comment/string text (see §Keyword Extraction)
  content,       -- full split-identifier stream; catch-all recall, demoted at rank time
  tokenize = 'porter unicode61'
);
```

Rowid == `files.id`. Only files with `lang != null` enter `search_index` (generated artefacts stay out to prevent BM25 score pollution). `bm25(search_index, w1, w2, w3, w4)` is called with per-column weights (see §Ranking). A `summary` column is intentionally absent; adding it is additive if LLM summaries land.

**Migration (v3 → v4):** `migrate()` detects `schema_version < SCHEMA_VERSION`, drops `search_index`, resets `symbols_done = 0` on all files, and clears the co-change/crawl cursors so the worker re-derives every row into the new columns — picking up prose files that were previously skipped. A fresh DB (version 0) skips the reset branch. No DDL change in this bump; only the version constant changed.

---

## Ranking Algorithm

`navigator_locate` scores each candidate with a transparent additive formula using fixed constants. Fully deterministic - no semantic percentages, no ML weights.

```
score = w_fts    * norm(bm25(search_index, w_col_path, w_col_sym, w_col_kw, w_col_content))
      + w_path   * pathMatch(query, path)       // basename/segment exact hit
      + w_symbol * symbolExactMatch(query)      // exact symbol name match
      + w_recency * recencyBoost(file)          // commits_30d, last_commit_at
```

Then multiplied by the test-file penalty (see below), applied last.

### FTS query strategy: AND-first with OR fallback

`locate()` runs an AND-form MATCH first (`classification AND response`). If AND returns zero rows it re-runs with OR (`classification OR response`). Fallback fires **only on emptiness** — a single file containing all terms is the correct answer and is not diluted by an OR retry. Single-token queries have identical AND/OR forms, so one query is issued.

### Signal fusion weights (`DEFAULT_WEIGHTS` in `src/navigator/rank.ts`)

| Weight | Value | Rationale |
|---|---|---|
| `w_fts` | 1.0 | Baseline text match |
| `w_path` | 3.5 | Exact basename-stem match is the strongest locate signal |
| `w_symbol` | 2.0 | Exact symbol name match is strong signal |
| `w_recency` | 0.5 | Recency boost is helpful but shouldn't dominate |

Weights were evaluated against `eval/cases.jsonl`: `w_path=3.5` improved hit@1 from 4/8 to 6/8 without regression to hit@5.

### BM25 column weights (`COLUMN_WEIGHTS` in `src/navigator/rank.ts`)

The FTS5 `bm25()` call receives per-column multipliers so path and symbol hits outweigh body boilerplate.

| Column | Weight | Role |
|---|---|---|
| `path` | 4.0 | Strongest locator (matches today's path-first behavior) |
| `symbol_names` | 3.0 | Definition sites |
| `keywords` | 2.0 | Domain-term recall |
| `content` | 0.5 | Catch-all recall - demoted so large-file noise cannot dominate |

### Porter stemming

`tokenize='porter unicode61'` (was `unicode61` in schema v2). Fixes `migration`↔`migrate`, `calculation`↔`calculate` across all columns. The porter stemmer is applied at index time and query time by FTS5 - no extra work at locate time.

### Test-file deprioritization (`TEST_GLOBS`, `applyTestPenalty`)

A multiplicative penalty (`DEFAULT_TEST_PENALTY = 0.5`) is applied **last**, to the fully fused composite score, for files matching `TEST_GLOBS`:

- `spec/` or `test[s]/` anywhere in path
- `*_spec.*`, `*_test.*` suffixes
- `*.test.ts`, `*.spec.tsx`, etc.
- `test_*.py` prefix

Demotion, not exclusion: test files still surface when they are the only/best match. A definition file with equal FTS match always ranks above its spec file.

**Application order:** `applyTestPenalty(score(signals), path)` is called after `score()`; never applied to individual signals.

### Co-change is not in the primary score

Co-change drives the `cluster` fan-out for the top result only - returning neighbors and referrers alongside the anchor without affecting ranking. This keeps scoring deterministic and avoids amplifying co-change noise into ranking instability.

All constants are tunable against the eval harness (`eval/cases.jsonl` → `eval/run.ts` hit@k).

---

## Keyword Extraction (`src/indexer/keywords.ts`)

Keywords are harvested **at index time** from data already in memory - no extra file reads, no model.

### Token sources

**Source files (ruby/python/ts/js):**
- **Symbol names** from tree-sitter (`extractSymbols`): class/module/function/method/const names.
- **Comment + string-literal text** from tree-sitter (`extractText`): comment nodes and string-literal nodes (`string`, plus `template_string` for ts/js). Comment markers and quote characters act as natural delimiters when the text is split.
- Every source string is split into fragments (`splitIdentifier`) and filtered (see below). Only derived, split, filtered tokens are stored — never the raw literal or comment text.

**Prose files (.md / .markdown / .txt / .rst / .adoc):**
- Indexed by `tokenizeProse` — no tree-sitter, no `splitIdentifier`.
- See §Prose Indexing below.

The `keywords` column receives the **filtered** high-signal fragment set (symbol + comment + string tokens); the `content` column receives the **unfiltered** split-identifier stream (every fragment, deduped) for catch-all recall.

### `splitIdentifier` - camelCase / snake_case / acronym splitting

```
createUser   →  ["create", "user"]
HTTPServer   →  ["http", "server"]
power_flow   →  ["power", "flow"]
Billing::Invoice → ["billing", "invoice"]  (after scope resolution)
```

### Filter pipeline (applied before `keywords` column, in order)

1. Lowercase + dedupe per file.
2. **Length floor:** drop tokens shorter than `keywordMinLength` (default **3**). Drops noise like `i`, `j`, `db`, `os`.
3. **Char-class drop:** pure-numeric, hex strings ≥6 chars, URL-scheme tokens.
4. **Stoplists** (see below).

### Stoplists

Three layers, merged into a `Set<string>` per file:

| Layer | Applied to |
|---|---|
| `DEFAULT_STOPLISTS[lang]` | Language keywords (Ruby `def end class module ...`; Python `def class return ...`; TS/JS `function const let var ...`) |
| `DEFAULT_CROSS_LANG_STOPLIST` | Code-noise (`todo fixme xxx hack tmp temp foo bar baz qux`) + common English stopwords (`the a an and or of to in ...`) |
| `config.keywordStoplist` | User-supplied extras, appended to defaults (never replaces) |

Domain terms (`plant`, `voltage`, `grid`, `invoice`) are **never hardcoded into stoplists**. Corpus-common domain terms are handled by BM25-IDF at query time, not static exclusion.

### Config (`navigator` namespace, all optional)

| Key | Default | Meaning |
|---|---|---|
| `keywordStoplist` | `[]` | Extra stoplist terms appended to defaults |
| `keywordMinLength` | `3` | Drop keyword tokens shorter than this |

---

## Prose Indexing (`src/indexer/keywords.ts`, `src/indexer/worker-core.ts`)

Markdown, plain-text, and lightweight markup files are indexed as first-class citizens alongside source code. This directly addresses the "doc-only terms" gap: a file located only by its prose content (not a path segment or symbol name) is now findable.

### Prose language class

`langOf()` in `src/indexer/walk.ts` maps the following extensions to `lang = "prose"`:

| Extension | Included |
|---|---|
| `.md`, `.markdown` | Markdown |
| `.txt` | Plain text |
| `.rst` | reStructuredText |
| `.adoc` | AsciiDoc |

### `tokenizeProse` algorithm

1. **Lowercase** the entire body.
2. **Split** on any maximal run of characters **not** in `[a-z0-9_]` → raw word tokens. Whitespace, all Markdown/structure punctuation (`#`, `*`, `_`, `` ` ``, `[`, `]`, `(`, `)`, `|`, `>`, `-`) are all delimiters. Heading markers, emphasis, list bullets, link brackets, code-fence ticks, and table pipes never become tokens.
3. **Filter**: apply `keywordStoplist` + `keywordMinLength` (same filter as source keywords).

`tokenizeProse` does **not** call `splitIdentifier` — prose is natural language, so camelCase and snake_case words are kept whole (lowercased). A term like `StateMachine` in a doc becomes the single token `statemachine`.

### FTS columns for prose rows

| Column | Value |
|---|---|
| `path` | Path segments (same as source files) |
| `symbol_names` | **empty** (no tree-sitter, no symbols) |
| `keywords` | `tokenizeProse` output joined by spaces |
| `content` | Same as `keywords` for prose (no separate split-identifier stream) |

FTS5 BM25 scores an empty `symbol_names` column as zero contribution, not an error. A prose row matching only on `path` ranks normally.

### Invariants preserved

- Gitignored files are still fully excluded (the `git ls-files`-based walker excludes them before `langOf` is called).
- Secret globs (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`) are still dropped by `isSecret()` before any read.
- The 1 MB / binary file gates in `worker-core.ts` apply to prose files identically to source files.
- `config.languages` stays `["ruby","python","ts","js"]`; adding `"prose"` to it has no effect (the prose branch is selected by `lang === "prose"` independent of `config.languages`, so tree-sitter can never be reached for prose).

---

## Ruby Referrers & Cluster Fan-out

Rails autoloads (Zeitwerk) - models/controllers are never `require`d. Before this feature, `refs` was effectively empty for Rails repos, so the referrer half of the cluster never fired.

### Constant-reference extraction (`src/indexer/symbols.ts`)

`extractImports` emits `{ toPathHint, kind: "ruby_const" }` for tree-sitter `constant` and `scope_resolution` (`Foo::Bar`) nodes in Ruby files. The raw constant name is the hint; resolution happens in the indexer.

### Resolution-as-filter (`src/indexer/worker-core.ts`)

A `ruby_const` edge is written **only when the constant resolves to a file in the index**. This drops `Time`, `Logger`, `Rails`, `ActiveRecord`, and all stdlib/gem constants for free - no denylist needed.

**Algorithm (`underscoreConst` + suffix match):**
1. Underscore the constant name without pluralization (`User` → `user`, `UsersController` → `users_controller`, `Billing::Invoice` → `billing/invoice`, `HTTPServer` → `http_server`).
2. Form candidate path `<underscored>.rb`.
3. Match against `files` rows by suffix: `path === candidate || path.endsWith('/' + candidate)`.
4. Zero matches → no edge. Multiple matches → emit an edge to each (subject to df-cap).

### df-cap at locate time (`src/navigator/locate.ts`, `refFanIn`)

Hub constants like `ApplicationRecord` and `ApplicationController` resolve to real files but are referenced by nearly every model/controller. Listing every caller as a referrer is noise, not signal.

**Cap:** when a cluster anchor's `ruby_const` fan-in exceeds `REF_DF_CAP_PCT` (20%) of all files, the referrer list is suppressed entirely for that anchor.

- `refFanIn(db, anchorId)` - `COUNT(DISTINCT src_file)` over `refs WHERE dst_file = ? AND kind = 'ruby_const'`.
- Computed live at query time from the current `refs` state; no maintained global table, no re-extraction when fan-in shifts.
- The cap applies only to `ruby_const` edges. TS/JS `import`/`require` referrers are unaffected in this iteration.

---

## Rolling / Resumable Indexing

Indexing runs in an async `worker_thread` - the main thread is never blocked. Progress is durable: a killed session resumes from database state, not an in-memory queue.

### Main Thread Triggers

- **`session_start`:** resolve repo-id and index path; open the DB (create + migrate if new); attempt the writer lock. If acquired → spawn the worker. If held elsewhere → read-only mode (no worker spawned).
- **`tool_execution_end`:** if the tool was `edit`/`write` (or a `bash` likely to have mutated files), post the touched paths to the worker as high-priority items so long-lived sessions stay fresh. Also update the verified-cache.
- **`turn_end`:** refresh the lock TTL.

The main thread never indexes inline. It elects the writer, posts priority paths, and reads.

### Resumable Backlog (derived from DB state)

The worker derives remaining work idempotently on every start:

1. **Walk the worktree** (stat-only, cheap) → compare each file's `mtime`/size to the `files` row.
   - Unchanged → skip.
   - Changed or new → needs hash + symbols.
2. **`symbols_done = 0`** → needs the symbol/FTS pass (e.g., hash completed before a prior kill).
3. **Co-change:** resume the `git log` scan from `meta.cochange_scanned_through` toward older commits; fold in commits since `meta.head_sha_at_index` for catch-up. The cursor prevents double-counting.

A kill mid-index leaves the DB consistent (WAL + per-batch `BEGIN IMMEDIATE` commits). The next session re-derives and continues from exactly where the last batch committed.

### Priority Order

1. Paths posted by the main thread this session (files just edited/written).
2. Working-tree changes + commits since last index (catch-up).
3. Full-crawl backlog until `full_crawl_done = "1"`.

### Two-Phase Index Pass (ref correctness)

Each batch is processed in two phases to ensure import edges resolve correctly regardless of file ordering within the batch:

- **Phase A** (inside a transaction): stat each file, read bytes, hash, upsert the `files` row, populate `pathToId` / `pathIndex` with the file's id. Oversized/binary files are marked `symbols_done=1` and skipped in Phase B.
- **Phase B** (same transaction): for each text file, run tree-sitter symbol extraction, resolve import hints against the fully-populated `pathToId`, write symbols + ref edges + FTS tokens, set `symbols_done=1`.

Without the two-phase split, a file that imports another file later in the same batch would fail ref resolution because the destination's id wasn't in `pathToId` yet.

### Batching & Crash Safety

The worker commits every `indexBatchSize` files (default 50) in a `BEGIN IMMEDIATE` transaction, then sleeps `indexIdleMs` (default 25 ms) before the next batch. A kill loses at most the in-flight batch. Coverage counters in `meta` (`coverage_indexed`, `coverage_total`) update per batch.

### Coverage & Freshness Reporting

`navigator_locate` responses include:

```json
{ "index": { "fresh": false, "head_behind": 12, "coverage": 0.74, "dirty": true } }
```

- `fresh`: `true` only when `meta.head_sha_at_index` == current HEAD **and** the working tree is clean (not dirty). Both conditions must hold.
- `dirty`: `true` when `git status --porcelain` is non-empty — includes uncommitted tracked edits and untracked files (a new untracked source file is genuinely uncovered by an index keyed on committed state). Slices always read live worktree bytes, so a dirty tree never causes an incorrect read or edit; only locate ranking can lag.
- `head_behind`: number of commits the indexed HEAD is behind the current HEAD. `0` when HEAD matches, regardless of working-tree dirtiness. Computed via `git rev-list` commit counting.
- `coverage`: `coverage_indexed / coverage_total`.

`/navigator status` shows these values plus queue depth and lock owner.

---

## Worktree & Lock Model

### Index Location

```
~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db
```

- Located outside every worktree so it is shared across all worktrees and all agents/subagents of the same repository.
- **`repo_id`** = 12-char prefix of the root commit SHA (`git rev-list --max-parents=0 HEAD`). Stable across clones and worktrees. Fallback for a **git repo with no commits** (fresh `git init` before the first commit): SHA-256 of `git rev-parse --git-common-dir`. Navigator does **not** operate outside a git work tree — when cwd is not inside a git repo, `resolveRepo` returns `dbPath: ""`, no index file is created, and the tools return a terminal "not inside a git repository — use rg/fd/read" message.
- **`repo_name`** = basename of the worktree top-level directory (human-readable filename).

### Single-Writer Advisory Lock

A `<db>.lock` file carries `{ pid, mtime }`. Lock acquisition:

- If no lock file or lock is stale (mtime older than TTL) → write the lock file, become the writer, spawn the worker.
- If a fresh lock exists from another process → read-only mode.
- On session shutdown → release the lock, terminate the worker.
- On `turn_end` → refresh the lock's mtime to prevent stale reclaim while the session is active.

Writers use `BEGIN IMMEDIATE` transactions to avoid write contention. Readers (`locate`, `slice`) always proceed without locking under WAL. N parallel subagents on the same repo produce one indexer (the lock holder) and N-1 read-only consumers - no duplicate indexing, no prompt-tax amplification.

### One Index Per Repository (Isolation Invariant)

Navigator maintains exactly one index per repository identity, keyed by the repository's root-commit sha (`repoId`). All worktrees of that repository share the one index. Navigator operates only inside a git work tree; outside one it is fully dormant — no DB, no worker — and `navigator_locate`/`navigator_slice` return a terminal "not inside a git repository — use rg/fd/read" message. The freshness flag reported by `navigator_locate` reflects both HEAD distance (`head_behind`) and working-tree dirtiness (`dirty`); slices always read live worktree bytes, so isolation and ground-truth reads hold regardless of index state.

### Branch Divergence

The index reflects the worktree it was most recently built from. When another worktree on a different branch is active, `locate` may surface files from that branch. Results carry `index.fresh` to signal this. Slice and the verified-cache are always against the **active worktree's real bytes** - divergence never causes an incorrect read or edit.

---

## Vector-Embedding Expansion Seam

`src/store/vectors.ts` defines an interface-only placeholder:

```ts
export interface VectorStore {
  upsert(contentHash: string, embedding: Float32Array): void;
  query(embedding: Float32Array, k: number): { contentHash: string; score: number }[];
}
export const NO_VECTORS: VectorStore | null = null;
```

When summary embeddings land (out of scope for v0.1.0), back this with `sqlite-vec` (stay single-store) or a LanceDB sidecar keyed by `content_hash`. The core schema requires no changes - `content_hash` in `files` is the stable key. Embeddings would add a new dimension to `navigator_locate` scoring (semantic similarity alongside BM25 + co-change) without displacing the existing relational model.

---

## Limitations (PoC)

**Token sources: symbol names + comment/string-literal text + path segments + prose bodies.** The `keywords` and `content` FTS columns are derived from split-identifier fragments of tree-sitter symbol names plus the text of comment and string-literal nodes (`extractText`) for source files, and from `tokenizeProse` for `.md/.txt/.rst/.adoc` files. A query whose terms appear in none of those sources remains out of scope for this deterministic index. Semantic/embedding search is still deferred to the `vectors.ts` seam.

**Co-change is a full re-scan on HEAD change.** When `head_sha_at_index` != current HEAD, the entire `git log` is re-scanned up to `cochangeMaxCommits`. There is no incremental co-change update (only the cursor for the initial full-build is incremental). On large repos with many commits this takes a few seconds in the background.

**`head_behind` is not computed.** The `index.head_behind` field in `navigator_locate` responses is always `0` in v0.1.0. Staleness is indicated by `index.fresh: false`. Commit counting is deferred.

**Rails-aware metadata is out of scope.** Routes, associations, jobs, and callbacks are DSL macros — not LSP symbols. Generic tree-sitter extraction does not surface them as first-class symbols. A future Rails plugin would need runtime introspection or a custom parser.
