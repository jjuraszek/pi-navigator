# pi-navigator

A [pi coding-agent](https://github.com/earendil-works/pi) extension that gives the agent a persistent, self-updating map of your repository — so it can orient, locate, and read with far fewer round-trips.

## Why

A coding agent rediscovers a repository from scratch every session: multiple exploratory `rg`/`fd`/`read` calls just to find where something lives, before any real work happens. On a large polyglot monorepo this is the dominant source of wasted turns.

pi-navigator attacks this with six ideas:

### 1. First-contact orientation
One call to `navigator_locate("Grid model")` returns ranked entry points — no grep safari, no session warm-up. Search covers **code and docs**: FTS over path segments, symbol names, split-identifier keyword tokens from identifiers/comments/string literals, **and prose body tokens from Markdown/text/RST/AsciiDoc files** — with porter stemming. Fully deterministic, not semantic or LLM-driven. Conceptual queries match on extracted terms, not just filenames or exact symbol names.

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

## Prerequisites

- **`rg` (ripgrep) on `PATH`** — required. Navigator treats ripgrep as the sanctioned raw-search tool: the grep block (see [Configuration](#configuration) → `grepBlock`) redirects slow repo-scanning shell `grep` to `rg`. If `rg` is absent the block degrades to a one-time warning and never fires, but recall-fallback guidance still assumes `rg` is present. Install: `brew install ripgrep` / `apt-get install -y ripgrep` / `cargo install ripgrep`.

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

### What each install path loads

| Path | Tools | Guidance | Skill |
|---|---|---|---|
| `pi install` / `pi install -l` (package in settings.json) | ✅ `navigator_locate`, `navigator_slice` | ✅ automatic when index is complete/current/clean | ✅ `navigator` skill auto-discovered via `pi.skills` in package.json |
| `pi -e index.ts` (bare `-e`) | ✅ tools loaded | ✅ automatic when index is complete/current/clean | ❌ skill **not** auto-discovered (no settings.json entry) |
| `pi -e git:...` (one-shot) | ✅ tools loaded | ✅ automatic when index is complete/current/clean | ❌ skill **not** auto-discovered |

For full skill discovery (so the agent auto-consults the `navigator` SKILL.md), use the package-install path. With bare `-e`, the tools and automatic prompt guidance are active but the skill file requires explicit loading.

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
- Index secret or gitignored file contents. Tracked source and prose files contribute a keyword inverted index (split-identifier fragments from symbol names plus comment/string-literal text; for prose files, `tokenizeProse` lowercases and splits on non-identifier boundaries — a recoverable bag-of-words, no original byte layout). Secret globs (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`) are never read.
- Provide semantic (LLM/embedding-based) search. Content-aware FTS is deterministic; semantic search remains a deferred follow-up on the `vectors.ts` seam.

---

## Configuration

Settings go under the `navigator` key in your pi agent settings (`$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json`):

```json
{
  "navigator": {
    "enabled": true,
    "indexDir": "~/.pi/pi-navigator-cache",
    "languages": ["ruby", "python", "ts", "js"],
    "maxLocateResults": 10,
    "indexBatchSize": 50,
    "indexIdleMs": 25,
    "cochangeWindowDays": 180,
    "cochangeMaxCommits": 4000,
    "cochangeMaxFilesPerCommit": 50,
    "maxFileBytes": 1048576,
    "persona": true,
    "promptNudge": true,
    "strongHitDirective": true,
    "grepBlock": true
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `indexDir` | `~/.pi/pi-navigator-cache` | Index location. Filename: `<repo_name>_<repo_id>.db`. |
| `languages` | `["ruby","python","ts","js"]` | Languages for symbol extraction. |
| `maxLocateResults` | `10` | Max results from `navigator_locate`. |
| `indexBatchSize` | `50` | Files committed per worker batch (caps crash-loss). |
| `indexIdleMs` | `25` | Worker sleep between batches (CPU gentleness). |
| `cochangeWindowDays` | `180` | Recency decay window for co-change weights. |
| `cochangeMaxCommits` | `4000` | Commit scan bound for co-change. |
| `cochangeMaxFilesPerCommit` | `50` | Skip mega-commits for co-change (still counted for recency). |
| `maxFileBytes` | `1048576` | Files larger than this are skipped. |
| `persona` | `true` | Always-on orientation line in the system prompt while the index is usable (`coverage.indexed > 0`, worker healthy) — fires even on a dirty or behind-HEAD worktree. Set `false` to suppress. |
| `promptNudge` | `true` | Per-prompt orientation nudge; gated on a fresh index (complete, current, clean) **and** an orientation-style prompt. Set `false` to suppress. |
| `strongHitDirective` | `true` | Appends a "slice rank 1, don't re-search" directive to `navigator_locate` output on a high-confidence exact match. Set `false` to suppress. |
| `grepBlock` | `true` | Blocks slow repo-scanning shell `grep` (recursive or directory path) via the bash hook, redirecting to `rg`/`navigator_locate`. Pipes, stdin, single-file grep, and `git grep` are always allowed; auto-disabled when `rg` is absent. Set `false` to disable. |

Prompt guidance is two-tier. The **persona** line (`persona`) fires whenever navigator is enabled, `navigator_locate` is selected, and the index is merely *usable* — it stays on for a dirty or behind-HEAD worktree, so orientation help survives active editing. The per-prompt **nudge** (`promptNudge`) is stricter: it needs a fresh index (complete, current, clean) **and** a broad repo-orientation prompt; exact-path and external-only prompts get no nudge. `navigator.injectPersona` is ignored and no longer a supported behavior switch. Use `/navigator status` to inspect readiness.

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
