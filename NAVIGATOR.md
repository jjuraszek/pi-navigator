# NAVIGATOR — Technical Reference

Deep documentation for the pi-navigator extension. Covers the database schema, ranking algorithm, rolling/resumable indexing design, worktree and lock model, and the vector-embedding expansion seam.

---

## Database Schema

The index lives at `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`. It uses `node:sqlite` with WAL mode and foreign keys enabled. **No table stores file contents** — only metadata, symbol names, byte/line offsets, and hashes.

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
| `full_crawl_done` | `"0"` or `"1"` — whether the full walk has completed |

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
kind TEXT NOT NULL,             -- "import"|"require"|"require_relative"
PRIMARY KEY (src_file, dst_file, kind)
```

"Who refers to this file" query: `SELECT src_file FROM refs WHERE dst_file = ?`.

### `search_index` (FTS5)

Contentless full-text index for BM25 search.

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  path,
  symbol_names,
  kind_tags,
  content='',                   -- contentless: tokens only, no stored content
  tokenize='unicode61'
);
```

Rowid corresponds to `files.id`. `bm25(search_index)` is verified available in `node:sqlite` on Node 24 (including inside a `worker_thread` with WAL). A `summary` column is intentionally absent; adding it is additive if LLM summaries land.

---

## Ranking Algorithm

`navigator_locate` scores each candidate with a transparent additive formula using fixed constants. No semantic percentages; no tuned ML weights.

```
score = w_fts    * norm(bm25(search_index))    // FTS full-text match
      + w_path   * pathMatch(query, path)       // basename/segment exact hit
      + w_symbol * symbolExactMatch(query)      // exact symbol name match
      + w_recency * recencyBoost(file)          // commits_30d, last_commit_at
```

**Default constants** (in `src/navigator/rank.ts`):

| Weight | Value | Rationale |
|---|---|---|
| `w_fts` | 1.0 | Baseline text match |
| `w_path` | 1.0 | Path segment hit carries equal weight to FTS |
| `w_symbol` | 2.0 | Exact symbol match is strong signal — double weight |
| `w_recency` | 0.5 | Recency boost is helpful but shouldn't dominate |

**Co-change is not in the primary score.** It drives the `cluster` fan-out for the top result only — returning neighbors and referrers alongside the anchor without affecting ranking. This keeps scoring deterministic and avoids amplifying co-change noise into ranking instability.

Constants are tuned against the eval harness (`eval/cases.jsonl` → `eval/run.ts` hit@k) as the index matures.

---

## Rolling / Resumable Indexing

Indexing runs in an async `worker_thread` — the main thread is never blocked. Progress is durable: a killed session resumes from database state, not an in-memory queue.

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

### Batching & Crash Safety

The worker commits every `indexBatchSize` files (default 50) in a `BEGIN IMMEDIATE` transaction, then sleeps `indexIdleMs` (default 25 ms) before the next batch. A kill loses at most the in-flight batch. Coverage counters in `meta` (`coverage_indexed`, `coverage_total`) update per batch.

### Coverage & Freshness Reporting

`navigator_locate` responses include:

```json
{ "index": { "fresh": false, "head_behind": 12, "coverage": 0.74 } }
```

- `fresh`: `true` if `meta.head_sha_at_index` == current HEAD.
- `head_behind`: number of commits since last index.
- `coverage`: `coverage_indexed / coverage_total`.

`/navigator status` shows these values plus queue depth and lock owner.

---

## Worktree & Lock Model

### Index Location

```
~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db
```

- Located outside every worktree so it is shared across all worktrees and all agents/subagents of the same repository.
- **`repo_id`** = 12-char prefix of the root commit SHA (`git rev-list --max-parents=0 HEAD`). Stable across clones and worktrees. Fallback (non-git): SHA-256 of the realpath of the common git dir.
- **`repo_name`** = basename of the worktree top-level directory (human-readable filename).

### Single-Writer Advisory Lock

A `<db>.lock` file carries `{ pid, mtime }`. Lock acquisition:

- If no lock file or lock is stale (mtime older than TTL) → write the lock file, become the writer, spawn the worker.
- If a fresh lock exists from another process → read-only mode.
- On session shutdown → release the lock, terminate the worker.
- On `turn_end` → refresh the lock's mtime to prevent stale reclaim while the session is active.

Writers use `BEGIN IMMEDIATE` transactions to avoid write contention. Readers (`locate`, `slice`) always proceed without locking under WAL. N parallel subagents on the same repo produce one indexer (the lock holder) and N-1 read-only consumers — no duplicate indexing, no prompt-tax amplification.

### Branch Divergence

The index reflects the worktree it was most recently built from. When another worktree on a different branch is active, `locate` may surface files from that branch. Results carry `index.fresh` to signal this. Slice and the verified-cache are always against the **active worktree's real bytes** — divergence never causes an incorrect read or edit.

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

When summary embeddings land (out of scope for v0.1.0), back this with `sqlite-vec` (stay single-store) or a LanceDB sidecar keyed by `content_hash`. The core schema requires no changes — `content_hash` in `files` is the stable key. Embeddings would add a new dimension to `navigator_locate` scoring (semantic similarity alongside BM25 + co-change) without displacing the existing relational model.
