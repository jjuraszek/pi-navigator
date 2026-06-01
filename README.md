# pi-navigator

A [pi coding-agent](https://github.com/earendil-works/pi) extension that gives the agent a persistent, self-updating map of your repository — so it can orient, locate, and read with far fewer round-trips.

## Why

A coding agent rediscovers a repository from scratch every session: multiple exploratory `rg`/`fd`/`read` calls just to find where something lives, before any real work happens. On a large polyglot monorepo this is the dominant source of wasted turns.

pi-navigator attacks this with six ideas:

### 1. First-contact orientation
One call to `navigator_locate("Grid model")` returns ranked entry points — no grep safari, no session warm-up. Search is **deterministic and content-aware** (FTS over path segments, symbol names, and split-identifier keyword tokens from identifiers, comments, and string literals, with porter stemming), not semantic or LLM-driven. Conceptual queries match on extracted terms, not just filenames or exact symbol names.

### 2. Cross-subproject locate
A monorepo with 10+ subdirectories means the agent often burns turns just finding the right service. The index knows the whole tree; one query surfaces the right area regardless of project boundaries.

### 3. Relationship knowledge
`navigator_locate` returns not just the best-matching file but its **co-change neighbors** (files that frequently change together, from git history) and **referrers** (files that import or require it). This is signal that `rg` fundamentally cannot give — it requires git log analysis and import-edge extraction.

### 4. Serve slices
`navigator_slice("app/models/grid.rb", "Grid#sync")` returns the exact bytes of that method — not the whole 800-line file. Smaller reads, lower token cost, same correctness.

### 5. Skip re-reads (worktree-aware)
A slice already read this session is flagged `unchanged_since_last_read: true` when the file hasn't changed, discouraging redundant re-reads. All reads and edits always hit the **active worktree's real bytes** — the index is a navigation aid, not a content cache.

### 6. One fan-out instead of a serial loop
`navigator_locate` returns the anchor file **plus** its co-change cluster and referrers in one response. What would normally be: locate → read → discover related → read each → reason, becomes: locate (one call) → slice targets → reason.

---

## Install

pi-navigator is a private repository. Install requires git SSH access to `jjuraszek/pi-navigator`.

```bash
# Install for all repos (user scope)
pi install git:github.com/jjuraszek/pi-navigator@v0.1.0

# Install for current repo only (committed to .pi/settings.json)
pi install -l git:github.com/jjuraszek/pi-navigator@v0.1.0

# One-shot (no install, current session only)
pi -e git:github.com/jjuraszek/pi-navigator@v0.1.0

# Local checkout (development)
pi -e ~/repos/pi-navigator/index.ts
```

---

## How it stays fresh

Nothing to run. The extension starts a background `worker_thread` on session start that:
1. Catches up on any commits since the last session.
2. Re-indexes files you edit or write immediately (high priority). Bash-driven mutations (`sed`, heredocs, `git checkout`, codegen) are not detected automatically — they are picked up by the next catch-up pass, not instantly.
3. Drains the full-crawl backlog in small batches between turns.

Indexing is **resumable** — if a session is killed mid-index, the next session continues from where it stopped rather than restarting. Progress is derived from the database state, not an in-memory queue.

The index lives at `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`, outside any worktree, shared across all worktrees and parallel subagents for the same repository.

Check progress: `/navigator status`

---

## What it does / does not do

**Does:**
- Speed up orientation in large or unfamiliar codebases (the *find* phase).
- Surface cross-file relationships (co-change, import edges) in one lookup.
- Return smaller, hash-verified slices instead of whole files.
- Flag unchanged files to avoid redundant re-reads.
- Keep the index fresh automatically across the session lifetime.

**Does not:**
- Replace reading the real file bytes before editing. Any mutation requires ground-truth verification — the index never feeds an edit directly.
- Index secret or gitignored file contents. Tracked source files contribute a keyword inverted index (split-identifier fragments from symbol names plus comment/string-literal text; a recoverable bag-of-words, no original byte layout). Secret globs (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`) are never read.
- Provide semantic (LLM/embedding-based) search. Content-aware FTS is deterministic; semantic search remains a deferred follow-up on the `vectors.ts` seam.

---

## Configuration

Settings go under the `navigator` key in your pi agent settings (`$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json`):

```json
{
  "navigator": {
    "enabled": true,
    "injectPersona": false,
    "indexDir": "~/.pi/pi-navigator-cache",
    "languages": ["ruby", "python", "ts", "js"],
    "maxLocateResults": 10,
    "indexBatchSize": 50,
    "indexIdleMs": 25,
    "cochangeWindowDays": 180,
    "cochangeMaxCommits": 4000,
    "cochangeMaxFilesPerCommit": 50,
    "maxFileBytes": 1048576
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `injectPersona` | `false` | Append a ~25-word prompt hint when navigator tools are active. Off by default — tool descriptions carry the nudge at zero ambient cost. |
| `indexDir` | `~/.pi/pi-navigator-cache` | Index location. Filename: `<repo_name>_<repo_id>.db`. |
| `languages` | `["ruby","python","ts","js"]` | Languages for symbol extraction. |
| `maxLocateResults` | `10` | Max results from `navigator_locate`. |
| `indexBatchSize` | `50` | Files committed per worker batch (caps crash-loss). |
| `indexIdleMs` | `25` | Worker sleep between batches (CPU gentleness). |
| `cochangeWindowDays` | `180` | Recency decay window for co-change weights. |
| `cochangeMaxCommits` | `4000` | Commit scan bound for co-change. |
| `cochangeMaxFilesPerCommit` | `50` | Skip mega-commits for co-change (still counted for recency). |
| `maxFileBytes` | `1048576` | Files larger than this are skipped. |

---

## Commands & Tools

### `navigator_locate`
```
navigator_locate({ query: "Grid model", limit?: 10 })
```
Returns ranked files with signal breakdown, top-result symbols, and the co-change/referrer cluster. Use **before** `rg` or `read` to orient.

**Example response shape:**
```jsonc
{
  "results": [
    {
      "path": "app/models/grid.rb",
      "lang": "ruby",
      "score": 9.1,
      "signals": { "fts": 2.1, "path": 3.5, "symbol": 2.0, "recency": 0.4 },
      "symbols": [{ "name": "Grid", "kind": "class", "lines": [1, 120] }]
    }
  ],
  "cluster": {
    "anchor": "app/models/grid.rb",
    "cochange": ["app/services/grid_sync.rb"],
    "referrers": ["app/controllers/grids_controller.rb"]
  },
  "index": { "fresh": true, "head_behind": 0, "coverage": 0.97 }
}
```

See `NAVIGATOR.md` for the full response schema and signal definitions.

### `navigator_slice`
```
navigator_slice({ path: "app/models/grid.rb", symbol: "Grid#sync" })
navigator_slice({ path: "app/models/grid.rb", startLine: 10, endLine: 40 })
```
Returns the exact bytes from the active worktree plus a `content_hash` (for reconciling with the `edit` tool's `oldText` requirement). Flags `unchanged_since_last_read` if the file hasn't changed since the last slice this session.

### `/navigator status`
Shows current coverage, commits behind HEAD, queue depth, and lock owner.

### `/navigator reindex [path]`
Forces a full rebuild, or re-indexes a single path immediately.

---

## Eval

Evaluated against this repository using `eval/cases.jsonl` (8 source-navigation queries):

| Metric | navigator | rg baseline |
|---|---|---|
| hit@1 | 6/8 (75%) | 6/8 (file present, not ranked) |
| hit@5 | 7/8 (87.5%) | — |
| avg candidates | ~top-10 ranked | ~15 unranked files |

The remaining miss (`co-change folding` → `git.ts`) is a documented limitation: queries whose terms appear in no path stem, symbol name, comment, or string literal are outside scope for this deterministic index. See `NAVIGATOR.md` §Limitations.

---

## Deep Documentation

See [`NAVIGATOR.md`](./NAVIGATOR.md) for the database schema, ranking algorithm, rolling/resumable indexing design, worktree/lock model, and the vector-embedding expansion seam.
