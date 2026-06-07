# Changelog

All notable changes are documented here. Newest first.

## [Unreleased]

- **Prompt guidance:** navigator now injects automatic readiness-gated repo-orientation guidance when `navigator_locate` is selected and the index is complete/current/clean; `navigator.injectPersona` is no longer a behavior switch.

## [v0.6.1] - 2026-06-04

### Fixed
- **Telemetry attribution across batched locates.** The correlator kept a single
  `lastLocate` slot, so when multiple `navigator_locate` calls fired before their
  follow-up reads (parallel/batched tool calls — common in `--print` and agent
  turns), the most recent locate clobbered earlier result sets. Ranked and cluster
  files from earlier locates then received no `locate_rank`/`cluster_kind`,
  undercounting hit-rate and zeroing cluster-assist in `/navigator stats`.
  Now keeps a bounded ring of recent locates (cap 8) and attributes a consume to
  the most-recent locate whose ranked/cluster set contains the path (ranked beats
  cluster within a locate). Surfaced by dogfooding v0.6.0 against gridstrong.

## [v0.6.0] - 2026-06-04

### Fixed
- **Telemetry attribution correctness.** Dogfooding v0.5.0 surfaced correlation
  bugs that the synthetic unit tests could not catch; this corrects the
  capture → outcome → judge pipeline end-to-end.
  - **Search detection:** `detect.ts` now splits a bash command into shell
    segments (quote-aware, on unquoted `&&`/`||`/`;`/`|`/newline) and matches
    search tools per segment, so `cd repo && rg foo` and piped searches are
    detected. Trailing shell punctuation is trimmed from the captured pattern.
  - **Outcome model:** strict precedence `hit > cluster-assist > miss-fallback
    > abandoned`. `miss-fallback` is now **search-gated** — an unrelated
    file read no longer mislabels a locate as a fallback. A re-search must
    occur for a fallback to register.
  - **Asymmetric attribution windows:** `FULL_WINDOW_TURNS = 10` for
    hit/cluster-assist; `FALLBACK_WINDOW_TURNS = 3` for search-driven
    fallback, so a late unrelated search no longer steals attribution.

### Added
- **`cluster-assist` outcome + `assist_rate` metric.** Consuming a co-change or
  referrer **cluster** path (surfaced by the locate but not in the ranked
  results) is now first-class: it records `nav_consume.cluster_kind`, resolves
  to a `cluster-assist` outcome, and is reported as `assist_rate` in
  `/navigator stats`. Ranked-only `hit_rate`/`mrr`/`hit@k` are unchanged.
- **Reachable ranking-gap verdict.** `scripts/export-cases.ts` resolves a
  miss-fallback's target from the first read/slice after the triggering search
  and emits the previously-unreachable `indexed` verdict when that target was
  surfaced in the cluster but not ranked — the actionable signal for `rank.ts`
  tuning. `cluster-assist` cases export the same verdict.
- **Golden-trace + invariant test layer.** A `replayTrace` harness drives the
  real correlator from ordered tool-event fixtures (one per regression class);
  a seeded property suite asserts the outcome partition, precedence,
  ranked-wins classification, fallback-window edges, and rate ranges.

### Changed
- **Telemetry schema → v2.** `nav_consume` gains `cluster_kind`
  (`NULL`|`cochange`|`referrer`) with a `CHECK` enforcing mutual exclusion with
  `locate_rank`. Telemetry is disposable dev-only data: the version bump drops
  and rebuilds the telemetry DB — no migration.

## [v0.5.0] - 2026-06-04

### Added
- **Usefulness telemetry & offline quality judge.** Opt-in passive-correlation
  telemetry that records `navigator_locate` calls and the agent's follow-on
  actions (slice/read/search) to a **separate** SQLite DB
  (`<repo>_<id>.telemetry.db`), then derives usefulness metrics from the raw
  event log. Every session writes its own rows, so the index's single-writer
  invariant is untouched; all telemetry writes are guarded and can never throw
  into the session.
  - **Capture:** `TelemetryCorrelator` subscribes to the tool-event stream and
    links each locate to what the agent did next within an attribution window
    (until-next-locate, capped at 10 turns). Records per-result signal
    decomposition (`fts`/`path`/`symbol`/`recency`), confidence inputs, query
    type/token count, and index warmth at query time.
  - **Derivation:** outcomes (`hit` / `miss-fallback` / `abandoned`),
    `justified_fallback`, MRR, hit@k, low/high-confidence precision, bypass-session
    rate, and stale-slice rate.
  - **`/navigator stats`:** session + lifetime metrics in-session (distinguishes
    telemetry-off from on-but-no-data).
  - **Offline judge:** `scripts/export-cases.ts` joins telemetry against the live
    index to emit a *proven* per-fallback verdict — `not_indexed` (recall gap) /
    `indexed_not_returned` (retrieval gap) / `indexed` (ranking gap) — plus the
    `usefulness-judge` dev-skill that explains navigation gaps and recommends
    `rank.ts` weight changes.
  - **Config:** `navigator.telemetry` (default **off**; dev/debug tool),
    `telemetryStoreQueries`, `telemetryTurnCap`, `telemetryRetentionDays`.
  - **Privacy:** secret paths (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`) are
    dropped from the export via the existing `isSecret` filter; the judge reads
    paths only, never file contents.

## [v0.4.0] - 2026-06-03

### Added
- **Self-healing writer-lock election.** Read-only sessions no longer stay
  stuck on `navigator: (read-only)` until restart. `RollingIndexer` now runs a
  20s `.unref()`'d heartbeat that refreshes the lock while it holds writer role
  and re-acquires/promotes when it does not — so when the writer session ends,
  a surviving read-only session self-promotes within one heartbeat and its
  worker resumes indexing. `onPromote(cb)` fires on promotion; `index.ts`
  flips the status footer to `"indexing…"`.
- **pid-liveness lock reclaim.** `acquire()` reclaims a confirmed-dead
  *same-host* holder via `process.kill(pid, 0)` before the 60s TTL, so a
  crashed/killed writer no longer blocks indexing for up to a minute. The
  lockfile gains a `host` field; cross-host or host-absent lockfiles fall back
  to mtime/TTL-only (pids are meaningless across machines). `isProcessAlive`
  treats `ESRCH` as dead and any other error (`EPERM`, Windows
  `ERR_UNKNOWN_SIGNAL`) as alive — never reclaiming on an ambiguous probe.

### Changed
- **Crash recovery for the indexing worker.** On worker `error`/non-zero
  `exit`, `RollingIndexer` releases the lock and drops writer role so the next
  heartbeat re-acquires and respawns; `_workerError` clears on successful
  respawn; last-known-good coverage is preserved. `start()` rolls back on a
  synchronous spawn throw and always arms the heartbeat; double-`start()` is a
  no-op. Lock refresh moved off `turn_end` onto the heartbeat timer, closing
  the idle-holder steal window.

## [v0.3.2] - 2026-06-03

### Fixed
- **Worker crash (`ENOBUFS`) on large trees.** `gitFiles()` ran
  `execFileSync("git", ["ls-files", …])` with Node's default 1MB `maxBuffer`.
  Running from a directory whose tracked/untracked file list exceeds 1MB killed
  the child with `SIGTERM` and threw `ENOBUFS`, taking down the indexer worker.
  Both `ls-files` invocations now pass a 512MB `maxBuffer` (matching the
  existing `git log` cap in `git.ts`).

## [v0.3.1] - 2026-06-03

### Fixed
- **Status footer stuck on "indexing…".** The footer label was only recomputed
  in `turn_end`, so when background indexing finished while the user was idle the
  widget never left the static `"navigator: indexing…"` set at `session_start`.
  `RollingIndexer` now exposes `onCoverage(cb)` and fires it on every worker
  coverage message; `index.ts` subscribes to push status reactively, switching to
  `"N% indexed"` the moment the crawl completes.

## [v0.3.0] - 2026-06-02

### Added
- **Repo-isolation gating with a `disabled` state.** `RepoStatus` is now
  `"booting" | "non_git" | "disabled" | "ready"`. `navigator_locate` /
  `navigator_slice` return a **terminal** "use rg/fd/read" message outside a git
  work tree (`non_git`) or when the extension is config-disabled (`disabled`),
  and a **retryable** "try again shortly" message only while `booting`. Closes
  the gap where a genuine navigator miss could read as "this does not exist."
- **Working-tree-aware freshness.** `navigator_locate`'s `index` status gained a
  `dirty` field; `fresh = headMatch && !dirty` (HEAD match AND a clean working
  tree). `head_behind` now reports true commit distance (keyed off HEAD match,
  so a dirty-but-on-HEAD tree reports `0`). Slices still always read live
  worktree bytes — dirtiness only annotates locate ranking, never reads.
- **Index footnote.** `session_start` emits `navigator loaded — <dbPath>
  (N/M indexed)` once the index is ready; `/navigator status` gained a
  `db: <dbPath>` line.
- **Zero-result fallback nudge.** An empty `navigator_locate` result now says
  "navigator may not cover this query — fall back to rg/fd/read before concluding
  it doesn't exist" instead of a bare "No results found."
- **Runtime-seam integration test** (`index.test.ts`) driving the real extension
  export through `session_start → shutdown` for disabled / non-git / git-ready
  cycles.

### Changed
- **One index = one git repository identity (root-commit sha).** `resolveRepo`
  returns `dbPath: ""` outside a git work tree so no phantom index file is ever
  named; all worktrees of a repo continue to share the one index. Documented as
  a hard invariant in `NAVIGATOR.md` and `AGENTS.md`.
- **Honest freshness messaging.** The locate footer no longer prints the
  self-contradictory "100% — still building"; coverage and behind-HEAD are now
  reported as independent lines.

### Fixed
- **DB-handle leak on failed init.** `migrate` + `initParsers` are wrapped so a
  failure closes the DB and leaves status retryable; the "navigator loaded"
  notify now fires only after the index is actually `ready`.

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
- **Pickup:** prompt guidance now defaulted on; the tool description,
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
