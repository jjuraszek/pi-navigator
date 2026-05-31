# Changelog

All notable changes are documented here. Newest first.

## [Unreleased]

## [v0.1.0] - 2026-05-31

Proof of concept.

### Added
- **Async, resumable indexing** in a background `worker_thread`: single-writer
  advisory lock, per-batch commits, backlog derived from durable DB state so a
  killed session resumes instead of restarting. Turns never block.
- **`navigator_locate(query)`** — FTS5/bm25 + path + symbol + recency fusion;
  returns ranked files plus a fan-out cluster of co-change neighbors and
  referrers for the top hit.
- **`navigator_slice(path, symbol?|startLine?,endLine?)`** — exact current
  worktree bytes + content hash; session verified-cache flags
  `unchanged_since_last_read`. Refuses secret files; rejects path traversal.
- **Storage:** built-in `node:sqlite` (FTS5, WAL) at
  `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`, shared across worktrees.
  No file contents persisted — only paths, symbols, offsets, hashes.
- **Signals:** git co-change + recency; tree-sitter symbols + import/require
  edges for Ruby, Python, TS, JS (bundled WASM grammars).
- **`/navigator status|reindex`** command; optional one-line persona nudge
  (off by default) injected only when the navigator tools are active.
- Eval harness (hit@k vs ripgrep baseline); `node --test` suite; tag-pin
  release script.

### Known limitations (PoC)
- Symbol/path index, not full-content — purely descriptive queries can miss.
- Co-change is a full re-scan when HEAD changes (bounded by `cochangeMaxCommits`).
- No LSP, no summaries, no embeddings (a vector-store seam is stubbed for later).
