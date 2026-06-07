# Spec: Usefulness Telemetry & Offline Quality Judge

**Date:** 2026-06-03
**Status:** Draft (awaiting review)
**Worktree/branch:** `.worktrees/telemetry-usefulness` / `telemetry-usefulness`

## Problem

Navigator records **nothing** about whether its results are useful. We measure
quality only through `eval/run.ts` — a static, curated `cases.jsonl` benchmark
run by hand. At runtime we are blind to:

- **Hit / miss.** When `navigator_locate` returns ranked files, did the agent
  actually consume one (slice/read it), or did it ignore them and fall back to
  `rg`/`grep`/`find`?
- **Fallback frequency.** How often does the agent bypass navigator entirely, or
  hit a `locate` that returned zero results, or call a tool while navigator is
  `unavailable` (non-git / disabled / still indexing)?
- **Ranking quality.** When a result *is* consumed, what rank was it? (hit@1 vs
  hit@5 is the difference between a great index and a mediocre one.)
- **Flag calibration.** Does the `confidence: "low"` flag actually predict a
  miss? Do `stale_index` slices correlate with churn?

Without this data we cannot tune ranking weights (`rank.ts`), calibrate the
confidence flag, or know whether the tool earns its place in the agent loop.

## Goal

Persist a **raw, append-only event log** of navigator usage and the agent's
follow-on actions, from which usefulness metrics are *derived* — not baked in at
write time. Ship:

1. A **separate telemetry SQLite DB** that every session writes to independently
   (no writer-lock coupling), so non-holder sessions — the ones most likely to
   fall back — are captured.
2. A **passive correlator** (main-thread, zero extra model/LLM cost) that maps
   the existing tool-event stream into normalized rows.
3. A **derivation layer** (`hit` / `miss-fallback` / `abandoned`, MRR,
   fallback counts, flag precision) computed in queries, parameterized by an
   attribution window.
4. A **`/navigator stats`** command surfacing session + lifetime metrics.
5. An **offline judge skill** (`.agents/skills/usefulness-judge/`) whose
   **first iteration** explains navigation patterns and gaps it can prove from
   the data — ranking-position quality, confidence-flag calibration, and
   recall gaps verified by joining the live index — and defers the inferences it
   cannot yet ground (see [Judge skill](#judge-skill--agentsskillsusefulness-judge)).

**Non-goals:**
- No online LLM grading. The judge is offline, human/agent-invoked, dev-only.
- No change to `locate`/`slice` semantics, ranking, or the index DB schema.
- No telemetry by default — this is a **development/debug** instrument
  (config flag, default **off**).

## Design decisions (locked during brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Usefulness model | Hybrid: passive correlation backbone + offline judge skill | No runtime oracle; correlation is free and continuous, judge adds depth offline |
| Storage | Separate telemetry DB, every session writes its own rows | Captures non-holder/subagent/concurrent sessions; a corrupt telemetry file can never harm the index |
| Schema | Rich typed columns first; raw events, derive later (A1) | Lets us re-define "useful" without re-instrumenting |
| Attribution | Until-next-`locate`, **capped at a turn window** | Unbounded windows misattribute reads ~100 calls later (see [Threshold](#attribution-window-the-threshold)) |
| Cap location | Derivation-time parameter, **not** baked into storage | Storage keeps everything; cap is a query knob |
| Surfacing | Separate `/navigator stats` command | Keeps `/navigator status` about index health |
| Config flag | `navigator.telemetry`, default **off**; explicit `true` when pinned locally | Dev/debug tool, stores query text — opt-in |
| Query text | Stored when telemetry on, gated by `telemetryStoreQueries` (default on) | Highest-value field for the judge; local-only trust boundary |
| Judge | Folded into this spec as a repo dev-skill | Sequencing: data first; judge design is informed by real captured fields |
| Council revision (2026-06-03) | Per-result signal capture, index-join recall check, honest first-iteration judge scope | Council found the original schema could not separate recall vs ranking gaps and the judge overclaimed its classification power |

## Invariants preserved (and one deliberate divergence)

| Invariant | Status |
|---|---|
| Index DB stores no secret/gitignored content | **Untouched** — telemetry is a separate file; see [Privacy](#privacy--leakage-control) for telemetry's own rules |
| One index = one git repo identity | **Untouched** — telemetry DB is named by the same `<repoName>_<repoId>` identity |
| Slices read live worktree bytes | **Untouched** |
| **Only the lock holder writes the index** | **Deliberately diverged for telemetry only.** Every session writes the *telemetry* DB. The index DB's single-writer rule is unchanged. Justified: the most valuable signal (misses, fallbacks) comes from read-only/non-holder sessions; gating telemetry on the writer lock would discard it. |

The divergence is safe because telemetry writes are tiny, infrequent (one row
per tool call), and isolated to a file whose corruption cannot affect indexing
or slicing. Concurrency is handled by WAL + `busy_timeout` (same primitives the
index DB already relies on).

## Architecture

```
tool_execution_start ─┐
tool_execution_end   ─┤   ┌──────────────┐    ┌────────────────────┐
turn_start           ─┼──▶│  Correlator  │──▶│  Telemetry DB      │
session_start/shutdown┘   │ (main thread)│    │ <repo>.telemetry.db│
                          └──────────────┘    └─────────┬──────────┘
                                                        │ read-only
                          ┌──────────────┐              │
        /navigator stats ─│ stats.ts     │◀─────────────┤
                          └──────────────┘              │
                          ┌──────────────┐              │
   usefulness-judge skill─│ export script│◀─────────────┤
                          └──────┬───────┘              │
                                 │ read-only join       │
                          ┌──────▼───────┐              │
                          │  index DB    │ (ground truth: was the path indexed?)
                          └──────────────┘
```

- **Correlator** subscribes to the tool-event stream for **all** tools, not just
  `edit`/`write`. It maintains per-session monotonic `seq` and `turn` counters
  and a `toolCallId → startTs` map for latency, then appends one normalized row
  per relevant tool call.
- **Telemetry DB** is append-only at runtime. Derivation never mutates it.
- **stats.ts** computes derived metrics in JS (cap parameterized) for
  `/navigator stats`.
- **Judge skill** runs an export script to pull candidate cases, then walks the
  agent through grading and recommendations.

## Components & responsibilities

### `src/telemetry/db.ts`

- Opens the telemetry DB at `<indexDir>/<repoName>_<repoId>.telemetry.db` (same
  directory and identity as the index DB; distinct filename suffix
  `.telemetry.db`).
- WAL mode + `busy_timeout` (reuse the `openDb` configuration from
  `src/store/db.ts`; if shared, factor the pragma setup into a helper rather than
  duplicating the `createRequire`/warning-suppression dance).
- Returns `null` (telemetry disabled) when `config.telemetry !== true`. All
  call sites must no-op on `null`.
- On open, runs idempotent `migrate()` and an age-based prune (see
  [Retention](#retention)).

### `src/telemetry/schema.ts`

`SCHEMA_VERSION` + idempotent `migrate()`. Tables:

**`nav_session`** — one row per session, for join context.

| col | type | note |
|---|---|---|
| `session_id` | TEXT PK | `ctx.sessionManager.getSessionId()` |
| `started_at` | INTEGER | epoch ms |
| `repo_root` | TEXT | |
| `head_sha` | TEXT | head at session start |
| `is_writer` | INTEGER | 0/1, whether this session held the index lock. Written `0` at `session_start`; updated to `1` on the first coverage/`onPromote` callback if this session wins election (see [is_writer timing](#is_writer-timing)) |
| `used_locate` | INTEGER | 0/1, set to 1 the first time this session calls `navigator_locate`. Lets `aggregate()` count **bypass sessions** (navigator loaded but never invoked) |

**`nav_locate`** — one row per `navigator_locate` call.

| col | type | note |
|---|---|---|
| `id` | INTEGER PK | |
| `session_id` | TEXT | FK → nav_session |
| `seq` | INTEGER | per-session monotonic tool-call counter |
| `turn` | INTEGER | per-session assistant-turn counter at call time |
| `ts` | INTEGER | epoch ms |
| `head_sha` | TEXT | head at call time |
| `query` | TEXT NULL | NULL when `telemetryStoreQueries` off |
| `query_token_count` | INTEGER | term count of the query (stored even when `query` text is NULL); enables single- vs multi-term failure analysis |
| `query_type` | TEXT | `identifier` \| `keyword` \| `open-ended`, classified by the same heuristic the judge uses (see [Judge skill](#judge-skill--agentsskillsusefulness-judge)); lets the judge constrain iteration-1 grading to identifier-shaped queries |
| `limit_n` | INTEGER | effective `maxLocateResults` |
| `result_count` | INTEGER | `details.results.length` |
| `confidence` | TEXT | `high` \| `low` |
| `has_exact_def` | INTEGER | 0/1, a result was an exact symbol-definition match (raw confidence input) |
| `used_or_fallback` | INTEGER | 0/1, ranking fell back to the OR/loose query path (raw confidence input) |
| `top_has_anchor` | INTEGER | 0/1, the top result matched on a symbol/path anchor vs FTS-only (raw confidence input) |
| `coverage` | REAL | `details.index.coverage` (index warmth at query time) |
| `dirty` | INTEGER | `details.index.dirty` |
| `head_behind` | INTEGER | `details.index.head_behind` |
| `fresh` | INTEGER | `details.index.fresh` |
| `latency_ms` | INTEGER | end − start |
| `results_metadata` | TEXT | JSON array of `{path, score, signals:{fts, path, symbol, recency}}` per result, **in rank order**. Supersedes a bare path list and `top_score`: drives hit + MRR **and** lets the judge attribute a ranking to the signal that produced it — the prerequisite for any `rank.ts` weight recommendation. The per-result `signals` come from the same decomposition `src/navigator/rank.ts` already computes |
| `cochange` | TEXT | JSON array, `details.cluster.cochange` |
| `referrers` | TEXT | JSON array, `details.cluster.referrers` |

> **`top_score` and `returned_paths` are subsumed by `results_metadata`.** The
> top score is `results_metadata[0].score`; the rank-ordered path list is its
> `path` projection. Derivation reads `results_metadata`; no redundant columns.

**`nav_consume`** — one row per follow-on action we care about (slice / read /
search). Discriminated by `kind`.

| col | type | note |
|---|---|---|
| `id` | INTEGER PK | |
| `session_id` | TEXT | |
| `seq` | INTEGER | |
| `turn` | INTEGER | |
| `ts` | INTEGER | |
| `kind` | TEXT | `slice` \| `read` \| `search` |
| `path` | TEXT NULL | repo-relative POSIX for slice/read; NULL for search |
| `locate_rank` | INTEGER NULL | for slice/read: the 1-based rank of `path` within the **most recent prior** `nav_locate`'s `results_metadata` in this session, or NULL if not present there. Computed at correlation time (cheap, robust to later re-derivation) so MRR/hit@k never depend on re-parsing JSON in queries |
| `stale_index` | INTEGER NULL | slice only |
| `unchanged` | INTEGER NULL | slice `unchanged_since_last_read` |
| `search_tool` | TEXT NULL | search only: `rg`\|`grep`\|`find`\|`fd`\|`ag`\|`ack`\|`git-grep`\|builtin `grep`\|builtin `find` |
| `search_pattern` | TEXT NULL | search only: the detected pattern arg (see [Privacy](#privacy--leakage-control)) |
| `latency_ms` | INTEGER NULL | |
| `is_error` | INTEGER | 0/1 |

**`nav_unavailable`** — one row when a navigator tool returns the dormant
message (non_git / disabled / booting). Counts "tried navigator, got nothing".

| col | type | note |
|---|---|---|
| `id` | INTEGER PK | |
| `session_id` | TEXT | |
| `seq`, `turn`, `ts` | INTEGER | |
| `tool` | TEXT | `navigator_locate` \| `navigator_slice` |
| `reason` | TEXT | `non_git` \| `disabled` \| `booting` |

> `locate`-returned-zero is **not** its own table — it is `nav_locate` rows with
> `result_count = 0`, derived in queries.

> **`nav_unavailable` attribution.** An unavailable row is attributed to a
> preceding `locate` window the same way `nav_consume` rows are: same session,
> `seq` greater than the locate's, within the turn cap. In practice unavailable
> rows usually *precede* any successful locate (index still booting), so the
> aggregate reports them both standalone (grouped by `reason`) and, when they
> fall inside a window, as a fallback signal. The JOIN pattern is documented in
> [stats.ts](#srctelemetrystatsts).

### `src/telemetry/correlator.ts`

The single stateful object owning capture for a session.

- Constructed in `session_start` when telemetry is enabled; given the telemetry
  DB handle, `session_id`, `repo_root`, `head_sha`, `is_writer`. Writes the
  `nav_session` row immediately.
- Holds: `seq` counter (incremented on every observed tool call), `turn` counter
  (incremented on `turn_start`), and `pendingStart: Map<toolCallId, {ts, ...}>`.
- **`onToolStart(event)`** — records start ts for latency; merges with the
  existing edit/write `pendingArgs` logic (do not regress post-edit re-index
  priority).
- **`onToolEnd(event)`** — dispatch on `toolName`:
  - `navigator_locate`: set `nav_session.used_locate = 1` (first call only). If
    `result.details` present → insert `nav_locate`: serialize
    `results_metadata` from `details.results` (each `{path, score, signals}` —
    the per-result signal decomposition `rank.ts` already computes); copy the
    raw confidence inputs (`has_exact_def`, `used_or_fallback`, `top_has_anchor`)
    from `details`; compute `query_token_count` and `query_type` from
    `event.args.query`; store `query` text only when `storeQueries`. If the
    result is the unavailable message (no `details`) → insert `nav_unavailable`.
    Holds the locate's `results_metadata` in memory as "most recent locate" for
    subsequent `locate_rank` lookups.
  - `navigator_slice`: insert `nav_consume(kind='slice', …)` from
    `result.details` (`path`, `stale_index`, `unchanged`), with `locate_rank`
    resolved against the most-recent-locate's `results_metadata`; on the error
    branch `is_error=1`. Unavailable → `nav_unavailable`.
  - `read`: insert `nav_consume(kind='read', path=resolveRepoRel(args.path))`
    with `locate_rank` resolved. Skip if path escapes repo root (`toRepoRel`
    returns undefined).
  - `bash`: pass `args.command` to `detectSearch()` (see
    [search-detector](#srctelemetrysearch-detectorts)); if it returns a hit,
    insert `nav_consume(kind='search', search_tool, search_pattern)`. Otherwise
    ignore.
  - builtin `grep` / `find` / `ls`: insert `nav_consume(kind='search', …)`.
  - all else: ignore.
- All inserts wrapped in try/catch → telemetry failures never surface to the
  agent or break the tool. A logged-once warning on first failure.

`resolveRepoRel` reuses the existing `toRepoRel(root, p, cwd)` from `index.ts`
(factor it into a shared util if the correlator needs it).

`query_type` classification (shared with the judge so capture and grading agree):
`identifier` when the query is a single token matching `[A-Za-z_][A-Za-z0-9_]*`
or a dotted/`::` path (one symbol-shaped term); `keyword` when 2–3 plain terms;
`open-ended` otherwise. Iteration-1 grading trusts only `identifier` cases
(unambiguous expected target); the rest are captured but excluded from precision
claims.

### `src/telemetry/search-detector.ts`

Pure `detectSearch(command: string) → { tool, pattern } | null`. Recognizes a
fixed allowlist of search executables and extracts the pattern argument without
storing the rest of the command line:

| tool | match | pattern extracted |
|---|---|---|
| `rg` | leading/post-pipe `rg ` | first non-flag arg (the regex) |
| `grep` | `grep`, `egrep`, `fgrep`, `git grep` (→`git-grep`) | first non-flag arg |
| `find` | `find ` | the `-name`/`-iname`/`-path` value |
| `fd` / `fdfind` | `fd ` | first non-flag arg |
| `ag` / `ack` | `ag `/`ack ` | first non-flag arg |

Returns `null` for everything else — the gate that keeps non-search bash
(`curl`, `psql`, env-bearing commands) out of the DB entirely. Flag-only tokens
(`-i`, `-n`, `--glob`) are skipped; only the bare pattern argument is captured.
This module is unit-tested in isolation (table of command → expected result).

### `src/telemetry/stats.ts`

Pure functions over the telemetry DB, parameterized by `turnCap`
(`config.telemetryTurnCap`, default 10). The derivation engine:

- **`deriveLocateOutcomes(db, {turnCap}) → LocateOutcome[]`** — for each
  `nav_locate` row L:
  - Window = `nav_consume`/`nav_unavailable` rows in the same session with
    `seq > L.seq`, bounded by the lesser of (next `nav_locate`'s seq) and
    (`turn <= L.turn + turnCap`).
  - `hit` if any windowed `slice`/`read` has a non-NULL `locate_rank` (its path
    was in L's `results_metadata`). Record the **earliest such rank** (→ MRR)
    and **turns-to-consume**.
  - else `miss-fallback` if any windowed `search`, or a `slice`/`read` of a path
    not in L's results (`locate_rank IS NULL`).
  - else `abandoned`.
  - **`justified_fallback`** is an orthogonal boolean on each `miss-fallback`,
    not a fourth outcome: `true` when `L.confidence='low' OR L.result_count=0`
    — i.e. navigator itself signalled low confidence or returned nothing, so
    falling back was the correct move. Splitting miss-fallback into
    justified vs **unjustified** (confident, populated result the agent still
    bypassed) is the single most actionable ranking signal; unjustified misses
    are the judge's primary recall/ranking-gap candidates.
- **`aggregate(db, {turnCap, scope}) → StatsSummary`** where `scope` is a
  session id or `"lifetime"`:

| metric | definition |
|---|---|
| `locate_total` | count of `nav_locate` |
| `hit_rate` | hits / locate_total |
| `miss_fallback` | count of miss-fallback outcomes |
| `miss_fallback_unjustified` | miss-fallback with `justified_fallback=false` (confident result bypassed) |
| `abandoned` | count of abandoned outcomes |
| `zero_result_locates` | `nav_locate` with `result_count=0` |
| `fallback_searches` | `nav_consume` searches attributed to a miss-fallback window |
| `unavailable_total` | `nav_unavailable` rows, grouped by `reason` (standalone + windowed; see attribution note) |
| `sessions_total` | distinct `nav_session` rows in scope |
| `sessions_with_locate` | `nav_session` with `used_locate=1` |
| `bypass_session_rate` | `1 − sessions_with_locate / sessions_total` (navigator loaded but never invoked) |
| `mrr` | mean reciprocal rank over hits |
| `hit_at_1`, `hit_at_3`, `hit_at_5` | hits whose consumed rank ≤ k / locate_total |
| `low_conf_precision` | of `confidence='low'` locates, hit-rate (does the flag predict misses?) |
| `high_conf_precision` | same for `confidence='high'` (contrast) |
| `median_turns_to_useful` | median turns-to-consume over hits |
| `stale_slice_rate` | slices with `stale_index=1` / total slices |
| `unchanged_reads_avoided` | slices with `unchanged=1` |

An optional SQL view `v_locate_outcome` materializes the default-`turnCap`
derivation for ad-hoc `sqlite3` querying; the authoritative path is `stats.ts`.

### `src/commands.ts` — `/navigator stats`

New subcommand alongside `status`/`reindex`. Prints two blocks (session,
lifetime) from `aggregate()`. When telemetry is disabled, prints a one-liner:
`navigator telemetry is off (set navigator.telemetry: true to record)`.
`/navigator status` is **unchanged** (index health only).

### `index.ts` wiring

- `session_start`: if `config.telemetry`, open telemetry DB and construct the
  correlator after repo resolution. Write `nav_session.is_writer = 0`; if this
  session wins lock election, update it to `1` on the first coverage/`onPromote`
  callback. Early rows therefore reflect the pre-election state, which is
  acceptable — `is_writer` is a coarse session attribute, not per-row truth.
- Extend the **existing** `tool_execution_start` / `tool_execution_end` handlers
  to also call `correlator.onToolStart/onToolEnd` — preserving the current
  edit/write re-index-priority path.
- `turn_start`: `correlator.bumpTurn()`. (Add the hook; currently only
  `turn_end` is used.)
- `session_shutdown`: close the telemetry DB handle.

### Config (`src/config.ts`, `src/types.ts`)

Add to `NavigatorConfig` + `DEFAULT_CONFIG`:

| key | type | default | meaning |
|---|---|---|---|
| `telemetry` | boolean | **false** | master switch; no DB opened, no rows written when false |
| `telemetryStoreQueries` | boolean | true | when telemetry on, store raw `query` text; false → `query` NULL but counters intact |
| `telemetryTurnCap` | number | 10 | attribution window cap, in assistant turns (derivation knob) |
| `telemetryRetentionDays` | number | 30 | prune rows older than this on DB open |

When pinning the extension locally for development, set
`navigator.telemetry: true` explicitly in `settings.json`.

### Judge skill — `.agents/skills/usefulness-judge/`

Dev-only skill (sibling of `.agents/skills/release/`), **not** shipped via the
`pi.skills` manifest.

**First-iteration scope (deliberately bounded).** The judge explains only what
the data can *prove*; it does not guess. The council's core finding: passive
correlation alone cannot separate a recall gap (right file never indexed) from a
ranking gap (indexed but ranked too low) from a justified fallback. Iteration 1
closes that by joining the **live index DB** for ground truth, and is explicit
about what it defers.

*Iteration 1 answers (grounded):*
- **Ranking-position quality** — from `results_metadata` + `locate_rank`: when a
  file was consumed, what rank was it, and which `signals` component dominated
  its score? Aggregated into per-signal lift, this is the direct input to
  `rank.ts` weight recommendations.
- **Confidence-flag calibration** — `low_conf_precision` vs `high_conf_precision`
  plus the raw inputs (`has_exact_def`, `used_or_fallback`, `top_has_anchor`):
  does `low` predict misses, and which trigger fires on false alarms?
- **Recall gap vs ranking gap** — for each unjustified miss-fallback, the export
  joins the index DB (`--index-db`) and checks whether the fallback-consumed
  path was indexed at all:
  - not indexed → **recall gap** (walk/symbol-extraction miss) — proven, not
    inferred.
  - indexed but absent from `results_metadata` → **retrieval/ranking gap**
    (FTS query or scoring) — proven.
  - indexed and present but ranked below what the agent used → **ranking gap** —
    proven, with the exact rank.
- **Bypass rate** — `bypass_session_rate`: sessions that never called locate.

*Iteration 1 explicitly defers (named, not silently dropped):*
- Grading queries that are not `query_type='identifier'`. Keyword/open-ended
  queries have ambiguous "expected" targets; they are exported for inspection but
  excluded from precision/recall claims until a labelled set exists.
- Distinguishing "agent ignored a correct result for unrelated reasons" from a
  genuine ranking failure. The proxy cannot read intent; the judge flags these as
  *low-confidence cases* rather than asserting a gap.
- Any recommendation requiring a counterfactual re-rank. Recorded as a
  follow-up: replay captured queries against a candidate weight set offline
  (a future `eval/` integration).

**Two parts:**

1. **`scripts/export-cases.ts`** — deterministic extraction. Reads the telemetry
   DB **and** the live index DB (`--index-db`, read-only) and runs
   `deriveLocateOutcomes`. Emits a JSON sample prioritizing (in order):
   **unjustified** miss-fallback, then justified miss-fallback, `abandoned`,
   `confidence='low'` cases, then a random `hit` sample for contrast. Each case
   carries: `query` (or `null` + `query_token_count`/`query_type` when query
   storage was off), full `results_metadata` (ranks + scores + per-signal
   decomposition), raw confidence inputs, the windowed consumption sequence with
   `locate_rank` on each slice/read, index-warmth fields, and — for each
   fallback-consumed path — an **`indexed` verdict** from the index-DB join
   (`indexed` / `not_indexed` / `indexed_not_returned`). Flags: `--limit`,
   `--outcome`, `--query-type`, `--repo`, `--index-db`.
   **Secret redaction:** before emitting, drop or mask any `path` matching the
   secret globs (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`) or absent from the
   index because gitignored; the judge never reads file contents.
2. **`SKILL.md`** — walks the agent through: run the export with `--index-db`;
   for each *identifier* case, read the proven `indexed` verdict and classify the
   gap (recall / retrieval / ranking / justified-fallback / low-confidence);
   then emit:
   - a per-case grade tagged with the gap class and its evidence (the rank, the
     dominant signal, the index verdict),
   - aggregate ranking-position and flag-calibration tables,
   - concrete, evidence-backed recommendations against `src/navigator/rank.ts`
     weights (`w_fts`/`w_path`/`w_symbol`/`w_recency`) and the `confidence`
     threshold — each tied to the cases that motivate it,
   - an **explicit "insufficient evidence" list**: patterns seen but not
     gradeable in iteration 1, feeding the next spec,
   - a written report under `build/eval/reports/<date>-usefulness.md`.

The judge consumes only what the correlator persisted plus the live index for
ground truth; it adds no new runtime capture.

## Attribution window: the threshold

Measured against real sessions (`~/.pi/agent/sessions`, all sessions containing
`navigator_locate`):

- **Unbounded until-next-locate is unsafe.** Tool-calls between consecutive
  `locate` calls reach **72–117** (agent locates, does a long unrelated
  sub-task, locates again). A naive window misattributes a read ~100 calls later.
- **Real follow-through is tight.** Every observed consumption of a returned path
  happened within **≤10 tool calls / ≤8 assistant turns** of the `locate`
  (n=8 follow-throughs; navigator is freshly adopted, so the sample is small).

Decision: **`turnCap = 10` assistant turns** (margin over the observed max of 8).
Because storage is raw (A1), the cap is a derivation parameter — re-runnable with
any value as telemetry volume grows. The small current sample is acceptable
precisely because we are building the instrument that will enlarge it.

## Privacy & leakage control

Telemetry is **local-only** (same machine, same `~/.pi/pi-navigator-cache/`
trust boundary as the index) and **off by default**.

- **Query text** (`nav_locate.query`): stored when `telemetryStoreQueries`
  (default on). Disable to keep counters without query strings.
- **Bash commands are never stored verbatim.** Only `bash` invocations matching
  the search-tool detector produce a row, and only the **detected tool name and
  its pattern argument** are stored — not the full command line, headers, env, or
  piped data. This bounds accidental secret capture (e.g. `curl -H "Authorization…"`
  is never a search and is never recorded).
- **No file contents.** `nav_consume` stores paths and slice flags, never bytes.
- **Secret/gitignored paths.** Reads/slices of secret-glob or gitignored paths
  may appear as `path` strings (navigator's index-content invariant is about the
  *index* DB; telemetry records the agent's actions). `export-cases.ts` masks
  paths matching the secret globs (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`)
  and never reads file contents for any path. Documented in `SKILL.md`.

## Retention

On telemetry-DB open, delete `nav_locate` / `nav_consume` / `nav_unavailable` /
`nav_session` rows with `ts`/`started_at` older than
`telemetryRetentionDays` (default 30). Cheap, bounded growth, no background job.

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Telemetry disabled | No DB opened; correlator is `null`; every hook no-ops |
| Telemetry DB open fails | Log once, disable for the session; navigator tools unaffected |
| Insert fails (lock/disk) | try/catch swallow, log once; never surfaces to agent |
| `result.details` missing on locate (unavailable) | Route to `nav_unavailable` |
| `slice` error branch | `nav_consume(kind='slice', is_error=1)` |
| `read`/`slice` path escapes repo root | Skip the row (no `toRepoRel`) |
| Subagent / forked session | Distinct `session_id`; own rows; correct by construction |
| Concurrent sessions writing | WAL + `busy_timeout` serialize; inserts are tiny |
| Non-git cwd | Navigator dormant; no telemetry DB (named by repo identity) |
| Session has no `getSessionId` | Fall back to a per-process UUID; still groups correctly |

## Testing approach

- **`src/telemetry/schema.test.ts`** — migrate idempotency, retention prune.
- **`src/telemetry/correlator.test.ts`** — feed synthetic
  `tool_execution_start/end` + `turn_start` sequences; assert the exact rows
  written. Cover: locate→slice hit, locate→rg miss-fallback, locate→nothing
  abandoned, unavailable routing, bash-search detection vs non-search bash,
  path-escape skip, latency, seq/turn monotonicity.
- **`src/telemetry/stats.test.ts`** — seed rows, assert derived metrics
  (hit_rate, MRR, hit@k, low_conf_precision, turnCap boundary: a consumption at
  `turn = L.turn + turnCap` counts; at `+turnCap+1` does not; a consumption past
  the next locate does not).
- **`src/telemetry/search-detector.test.ts`** — table of `command → {tool,
  pattern}|null`: rg/grep/git-grep/find/fd positives, `curl`/`psql`/env-bearing
  negatives, post-pipe `… | rg foo`, flag-only-arg skipping.
- **`scripts/export-cases.ts`** — golden-sample test on a seeded telemetry DB +
  a seeded index DB: assert the `indexed` verdict (`not_indexed` →
  recall gap; `indexed_not_returned` → retrieval gap; present-but-low → ranking
  gap), secret-path masking, and `--query-type identifier` filtering.
- All run under `node --test`; CI unchanged (`npm run typecheck && node --test`).

## Build conventions honored

- Relative imports use `.ts` extensions.
- `node:sqlite` loaded via the shared lazy `createRequire` path (no new static
  import that fires `ExperimentalWarning`).
- New source files follow the `src/<area>/` layout; tests colocated.

## Open questions

None.

Resolved at review:
- **Judge skill location** — `.agents/skills/usefulness-judge/`, a local repo
  dev-skill (sibling of `release`), **not** listed in the `pi.skills` manifest.

Resolved during council review:
- **`is_writer` timing** — write `0` at `session_start`, update to `1` on the
  first coverage/`onPromote` callback. Coarse session attribute; early-row
  staleness accepted.
- **Recall vs ranking gap** — resolved by the `export-cases.ts` index-DB join,
  not inference.
- **Per-result signal capture** — `results_metadata` JSON makes weight
  recommendations structurally possible.
