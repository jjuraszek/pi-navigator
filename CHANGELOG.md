# Changelog

All notable changes are documented here. Newest first.

## [Unreleased]

## [v0.2.2] - 2026-06-02

### Changed
- **Git-gated activation.** The navigator now stays fully dormant outside a git
  repository: `session_start` checks `repo.isGit` and, when false, sets an
  `inactive (not a git repo)` status and returns before opening the DB, spawning
  the worker, or initialising parsers. `navigator_locate` / `navigator_slice`
  report inactive, and `/navigator status|reindex` short-circuit with an
  `inactive` notice. Prevents an unguarded crawl of an arbitrary cwd (e.g.
  `$HOME`, `/tmp`) where `.gitignore` offers no protection and the repo-id /
  co-change / recency signals are undefined.
- **Non-git fallback removed.** `enumerateFiles` is now a no-op (`[]`) outside a
  git repo instead of recursively walking the directory tree; the manual
  `walkDir` enumerator is deleted. This is defense-in-depth behind the
  `session_start` gate above.

## [v0.2.1] - 2026-06-02

### Added
- **Exact symbol-definition recall.** `navigator_locate` now does a direct
  `symbols`-table lookup (`findSymbolDefs`, backed by `idx_symbols_name`) for
  identifier-shaped query tokens (CamelCase / snake_case / digit-bearing),
  bypassing the FTS porter tokenizer. The FTS columns split and stem
  identifiers, so a CamelCase query token (`ClassificationResponse`) could never
  retrieve its own definition site through `MATCH` — prose docs that spell the
  name out won the OR fallback instead. Matched definition files are now pinned
  above pure-FTS hits and make the result `confidence: "high"`, even when the FTS
  arm fell back to OR on surrounding prose tokens.

### Changed
- **Identifier-gated, not word-gated.** Bare lowercase dictionary tokens
  (`bus`, `parser`) deliberately do **not** trigger exact-def pinning: they may
  also be class names, but treating them as exact anchors would flood results
  across subsystems and re-introduce the over-trust trap. Verified against the
  eval suite: P1 (`ClassificationResponse`) collapses to a single
  high-confidence `navigator_locate` call returning both definition sites; the
  conceptual P2/P3 queries stay low-confidence and fall back as before.

## [v0.2.0] - 2026-06-02

### Fixed
- **Symlinks are never indexed.** `gitFiles` reads `git ls-files --stage` and drops
  modes `120000` (symlink) and `160000` (gitlink); untracked entries are
  `lstat`-filtered and `walkDir` skips symbolic links. Fixes a worker busy-loop
  where symlinked directories (`.pi`, `.claude/skills`) re-enqueued every pass
  forever (`readFileSync` → EISDIR, no row written) so the indexer never idled,
  and stops symlinked files (`CLAUDE.md` → `AGENTS.md`) from polluting FTS with
  duplicate content.

### Added
- **Low-confidence fallback.** `navigator_locate` returns
  `confidence: "high" | "low"`. Low when a multi-term query had no single file
  containing all terms (OR-fallback) or the top hit has no symbol/path anchor.
  Tool output surfaces a `[low-confidence: … verify or fall back to rg/find/read]`
  hint so the standard `rg`/`find`/`read` loop stays available when recall is weak
  instead of being suppressed by navigator-first guidance.
- **Verify-before-asserting guidance.** Tool prompt guidelines now state results
  are ranked candidates (not verified answers) and to open the top candidate via
  `read`/`navigator_slice` before asserting on "where is X / where do I start".

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
- **Prose/doc indexing.** A `prose` language class (`.md`, `.markdown`, `.txt`,
  `.rst`, `.adoc`) indexes document bodies into FTS via `tokenizeProse`
  (lowercase, split on non-`[a-z0-9_]`, URL-stripped, stoplist + `keywordMinLength`
  filtered, no identifier-splitting). Prose rows carry empty `symbol_names` and
  never reach tree-sitter — selected by `lang === "prose"` independent of
  `config.languages`. Docs are now locatable by filename and by body term.

### Changed
- **Pickup:** `navigator.injectPersona` now defaults on; the tool description,
  persona, and skill all lead with navigator-first guidance for "where is X" /
  "what's related" queries, with an explicit `rg` boundary (regex/full-content
  scans stay with `rg`).
- **Multi-word queries:** `locate` runs an AND-first FTS match and falls back to
  OR only when AND returns zero rows, so all-terms files outrank either-term
  files without losing recall.
- **Schema v4** — version bump forces a one-time re-derive so existing indexes
  pick up prose files (no DDL change).
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
