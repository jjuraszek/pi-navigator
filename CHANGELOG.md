# Changelog

All notable changes are documented here. Newest first.

## [Unreleased]

### Added
- **Content-aware search.** `search_index` widened to four porter-stemmed FTS5
  columns (`path`, `symbol_names`, `keywords`, `content`). Keyword tokens are
  derived deterministically (no LLM) from split identifiers, symbol names, and
  comment/string-literal text, filtered by length floor, numeric/hex/URL drops,
  and layered stoplists (per-language + cross-language + user `keywordStoplist`).
  Terms that appear only in a comment or string are now searchable.
- **Rails-aware referrers.** Ruby constant references are extracted and resolved
  Zeitwerk-style (inflection-free `underscoreConst`) to populate the referrer
  graph for autoloaded code; over-referenced hubs are suppressed by a locate-time
  df-cap.
- **Config:** `navigator.keywordStoplist` (extra stoplist terms, appended to
  defaults) and `navigator.keywordMinLength` (default 3).

### Changed
- **Ranking:** column-weighted BM25 (`COLUMN_WEIGHTS`) plus a multiplicative
  test-file penalty (`TEST_GLOBS`) applied last, so implementation files
  outrank their tests for the same query.
- **Schema v3** with a version-aware migration that drops the old `search_index`
  and forces a full re-derive on upgrade.
- **Invariant clarified:** the index stores only derived, tokenized bag-of-words
  (never raw byte layout); secret and gitignored files are never indexed.

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
