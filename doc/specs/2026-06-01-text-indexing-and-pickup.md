# Spec: Text/Doc Indexing, Real Pickup, and Multi-Word Query Precision

**Date:** 2026-06-01
**Status:** Draft
**Worktree branch:** `text-indexing-and-pickup`

## 1. Motivation

A replay of 128 real `~/repos/example-monorepo` pi sessions measured the find→read→edit
loop the navigator is built to shorten. Findings:

- **Baseline orient cost is real:** 5.97 orient ops per edit (3.73 searches +
  2.25 reads). `rg` returned 41–418 candidate files per term; navigator answers
  in ~12 ms on a 6057-file index. For **code-symbol → definition** lookups the
  tool already collapses the loop (definition at rank #1 for the clean symbol
  queries tested).
- **Gap 1 — coverage:** 77% of this user's actual edits in those sessions were
  **non-source** files the index cannot locate — **67% Markdown** (AGENTS.md,
  `doc/`, `SKILL.md`), 6% JSON. `langOf` admits only ruby/python/ts/js into FTS,
  and `locate()` queries only `search_index`, so `QUEUE_CONTRACTS.md` returns
  **zero results** even though the query equals the filename stem.
- **Gap 2 — pickup:** given "find where ClassificationResponse is defined" with
  all tools available, the agent used `rg` and **never called navigator** — even
  **with the persona injected**. `injectPersona` defaults off, the persona/tool
  nudges are too weak, and a bare `-e` load does not surface the skill.
- **Gap 3 — multi-word precision:** `buildMatchExpr` OR-combines tokens, so
  "classification response" → `classification OR response` and helper/concern
  files outranked the actual model. Exact single-symbol queries are unaffected.

This spec closes all three gaps. Every change is **deterministic, no LLM**, and
preserves the existing invariants (DB stores only derived tokens; secret and
gitignored files are never indexed).

These three changes share one goal — *close the gap between the benchmark and
real-world value* — but touch three layers (indexer/walk, extension wiring,
locate/rank). They are bundled into one spec because they are navigator-internal
and ship together; each is independently testable.

---

## 2. Scope

**In scope**

1. **Text/doc indexing** — a `prose` language class (`.md`, `.markdown`, `.txt`,
   `.rst`, `.adoc`) whose body is tokenized through the existing keyword
   pipeline and enters FTS.
2. **Pickup** — three reinforcing nudge channels (tool description, persona
   default-on, skill discovery) with an explicit `rg` boundary clause.
3. **Multi-word precision** — AND-first MATCH with OR fallback in `locate()`.

**Out of scope (named, deferred)**

- Structured config indexing (`.yml`/`.json`/`.toml`) — needs its own noise
  controls (size cap + lockfile globs); separate spec.
- Template/SQL indexing (`.slim`/`.erb`/`.sql`) — deserves tree-sitter symbol
  extraction, not prose treatment; separate spec.
- Markdown heading-as-symbol extraction — a refinement on top of prose body
  indexing; not required to fix the miss rate.
- Phrase-tier query matching and rank-time all-terms boosting — AND-first
  fallback is sufficient for the observed failure.
- Embeddings / semantic search — rides the existing `vectors.ts` seam later.

---

## 3. Change 1 — Text/Doc Indexing

### 3.1 Language class

Add a single `prose` member to the `Lang` union (`src/types.ts`):

```ts
export type Lang = "ruby" | "python" | "ts" | "js" | "prose";
```

`langOf` (`src/indexer/walk.ts`) maps the five extensions to `"prose"`:

```ts
case ".md": case ".markdown":
case ".txt": case ".rst": case ".adoc":
  return "prose";
```

A single `prose` tag (not per-extension) is sufficient; per-extension
differentiation has no current consumer.

Because `DEFAULT_STOPLISTS` is typed `Record<Lang, readonly string[]>`, adding
`prose` to the union requires a `prose: []` entry (prose carries no
language-specific stoplist; see §3.3). Persisting `lang="prose"` in the `files`
table has no query consequences: neither `locate()` nor `coverage()` filters on
the `lang` value, so no code path assumes `lang` is a recognized grammar.

### 3.2 No tree-sitter for prose

`config.languages` stays code-only (`["ruby","python","ts","js"]`). The existing
gate in `extractAndStore` —
`isSupported = lang !== null && config.languages.includes(lang)` — therefore
evaluates **false** for `prose`, so `extractSymbols` / `extractText` /
`extractImports` are never called (there is no prose grammar). Prose rows have
empty `symbol_names` and no ref edges.

**Misconfiguration safety:** the prose body branch is selected by an explicit
`lang === "prose"` test (§3.3), *independent* of `config.languages`. Even if a
user wrongly adds `"prose"` to `config.languages`, prose is still routed to
`tokenizeProse`, never to tree-sitter. As defense in depth, tree-sitter
initialization is guarded by grammar availability, so a `prose` value can never
reach a parser. A test asserts `prose ∉ DEFAULT_CONFIG.languages` and that
`extractSymbols` is never invoked for a `.md` file even when `prose` is forced
into `config.languages`.

### 3.3 Prose body tokenization

The FTS-entry block in `extractAndStore` is gated by `lang !== null`, which is
true for prose. Add a prose branch that populates `textTokens` from the whole
body (the code path populates it from comments/strings via `extractText`):

```ts
let textTokens: string[] = [];
if (isSupported && lang !== null) {
  // ...existing code path: symbols, extractText, imports...
} else if (lang === "prose") {
  textTokens = tokenizeProse(text);
}
```

`tokenizeProse(text: string): string[]` (new, in `src/indexer/keywords.ts`) is
defined precisely as:

1. Lowercase the entire body.
2. Split on any maximal run of characters **not** in `[a-z0-9_]` → raw word
   tokens. (Whitespace and all Markdown/structure punctuation — `#`, `*`, `_`,
   `` ` ``, `[`, `]`, `(`, `)`, `|`, `>`, `-` — are delimiters, so heading
   markers, emphasis, list bullets, link brackets, code-fence ticks, and table
   pipes never become tokens.)
3. Apply the stoplist + `keywordMinLength` filter (the same filter step used by
   `extractKeywords`).

`tokenizeProse` does **not** call `splitIdentifier` — prose is natural language,
so there is no camelCase/snake_case to re-split, and skipping it avoids
fragmenting words like `StateMachine` mentioned in prose. The output tokens feed
the same `keywords` and `content` columns as code tokens.

The `prose` lang has no language-specific stoplist (`DEFAULT_STOPLISTS.prose =
[]`); `buildStoplist("prose", user)` therefore yields
`DEFAULT_CROSS_LANG_STOPLIST ∪ user keywordStoplist`. That cross-language list
already includes the English stopwords (it is the combined code-noise + English
set documented at `keywords.ts:28`); there is no separate "English stoplist"
constant.

**Link URLs** in Markdown (`[text](https://host/path)`) are stripped before
tokenizing: `tokenizeProse` removes any `scheme://…` run first, so no
`https`/`host`/`path` scheme fragments enter the index. This is required because
the non-`[a-z0-9_]` split would discard the `://` separator and leave a bare
`https` token that no after-the-fact filter could distinguish from prose. It also
mirrors `extractKeywords`, which already drops URL tokens for code, keeping prose
and code keyword behavior consistent.

### 3.4 Safeguards (already present, no new knobs)

- Files over `config.maxFileBytes` (1 MB) and binary files are skipped before
  Phase B (`worker-core.ts:212`). Large generated docs never enter FTS.
- Gitignored and secret-glob files are excluded by the walker upstream
  (unchanged).

### 3.5 Ranking interaction

Prose files contribute only `path` + `keywords` + `content` (no symbols). Under
the shipped column weights (`path 4 > symbol 3 > keywords 2 > content 0.5`), a
code file matching on a symbol still outranks a doc that merely mentions the
term — the correct bias (definition over prose mention). `QUEUE_CONTRACTS.md`
becomes findable by its path tokens and body keywords. No weight change.

Prose rows have empty `symbol_names` (§3.2). FTS5 BM25 scores an empty column as
zero contribution, not an error; a prose row matching only on `path` ranks
normally. A test covers a prose file that matches solely via path tokens
(empty `keywords`/`content`).

### 3.6 Re-derive trigger

`search_index` columns are unchanged, so there is **no DDL change**. But existing
DBs hold prose files as `lang=null, symbols_done=1` (previously skipped), so they
will not be reprocessed without a trigger. Bump `SCHEMA_VERSION` (3 → 4) to reuse
the existing version-aware migration that clears FTS and resets re-derive state,
forcing a one-time full re-index that picks up prose files. **No new migration
code is written** — the existing `storedVersion < SCHEMA_VERSION` branch in
`migrate()` already performs the FTS-clear + `symbols_done` reset; bumping the
constant is the entire change.

---

## 4. Change 2 — Real Pickup

The replay showed under-nudging: the persona alone did not move the agent off
`rg`. Three reinforcing channels at different layers, plus an honest boundary so
the agent does not cannibalize `rg`'s real strengths.

### 4.1 Channel A — tool description (always present)

Rewrite `navigator_locate`'s `description` + `promptGuidelines` (`src/tools.ts`)
to state the preference and the boundary explicitly:

- Lead: "**First step** for locating anything in this repo — code *or* docs.
  Call `navigator_locate` before `rg`/`find`/`read` for 'where is X', 'where do
  I start', 'what's related to Y'."
- Boundary: "Use `rg` for regex or full-content scans across many files;
  navigator returns ranked entry points, co-change, and referrers in one call."

This channel is present even under a bare `-e` load (it is part of the tool
registration).

### 4.2 Channel B — persona default-on (session level)

Flip `injectPersona` default to `true` (`src/config.ts`). The existing
`before_agent_start` guard (only inject when `navigator_locate` is in
`selectedTools`) is preserved, so the line is never injected when the tool is
absent. A `navigator.injectPersona: false` setting still opts out.

The current persona line proved too weak (the replay agent ignored it). Replace
`prompts/navigator-persona.md` with this concrete wording:

> This repo has a navigator index covering code **and** docs. For any "where is
> X", "where do I start", or "what's related to Y" question, call
> `navigator_locate` **before** `rg`/`find`/`read`. Use `navigator_slice` to
> read exact spans; a slice marked `unchanged_since_last_read` needs no
> re-read. Use `rg` only for regex or full-content scans across many files.

The key strengthening vs. today: names `rg`/`find`/`read` explicitly, asserts
"before", states the docs coverage, and draws the `rg` boundary.

### 4.3 Channel C — skill discovery (task triggered)

`package.json` already declares `pi.skills`. In the normal install path
(package installed / `skills` dir configured in settings) the skill is
discovered; the bare `-e index.ts` dev path does not surface it. Actions:

- Strengthen `skills/navigator/SKILL.md` so that when loaded it gives concrete
  when/how guidance and the same `rg` boundary.
- Document in `README.md` the install path that loads the skill (settings.json
  package entry) versus bare `-e` (tools + persona only).
- Verify discovery in the package-install path with this explicit procedure:
  1. Add the package to a scratch project's `.pi/settings.json` (package entry,
     not bare `-e`).
  2. Start a pi session; run `/skill` (or the session's skill listing) and
     confirm `navigator` appears.
  3. Confirm `navigator_locate` is present in `selectedTools` (it must be, for
     persona injection to fire — see §8).
  4. Issue a "where is X" prompt and observe the agent calls `navigator_locate`.
  This is a manual acceptance step (skill auto-load is integration-level, not
  unit-testable).

Channels A and B guarantee a nudge even when C (skill) is not loaded.

### 4.4 Boundary clause (shared wording)

All three channels carry the same boundary so behavior is consistent:
> Prefer `navigator_locate` to locate code or docs (where is X / where to
> start / what's related). Use `rg` for regex matching or scanning full file
> contents across many files.

---

## 5. Change 3 — Multi-Word Query Precision

### 5.1 AND-first with OR fallback

`buildMatchExpr` gains a joiner parameter:

```ts
function buildMatchExpr(query: string, joiner: "AND" | "OR"): string | null
```

`locate()` runs the AND form first; it falls back to the OR form **only when AND
returns zero rows**:

```ts
let rows = runFts(buildMatchExpr(query, "AND"));
if (rows.length === 0) {
  const orExpr = buildMatchExpr(query, "OR");
  if (orExpr) rows = runFts(orExpr);
}
```

Fallback is on **emptiness, not sparsity** — a single precise file containing all
terms is the correct answer and must not be diluted by re-running OR. There is
**no `MULTI_TERM_FALLBACK_MIN` constant**; emptiness is the only trigger.

- **Single-token queries:** AND and OR forms are identical → one query, no
  fallback, no behavior change. Exact-symbol lookups are unaffected.
- **Multi-token queries:** AND narrows to files containing *all* terms (fixes
  the "classification response" noise); the zero-result fallback guarantees a
  too-narrow AND never strands the query with no results.

### 5.2 No phrase tier

Adjacent-phrase matching is deferred (§2). Identifier-style multi-word queries
do not benefit enough to justify the extra tier.

---

## 6. Data Flow Summary

1. **Walk:** `langOf` now returns `prose` for the five extensions; prose files
   are enumerated like any tracked, non-secret, non-ignored file.
2. **Phase A:** prose files ≤ 1 MB, non-binary, get a `files` row with
   `lang="prose"`, `symbols_done=0`.
3. **Phase B (`extractAndStore`):** `isSupported` is false for prose → no
   tree-sitter; prose branch sets `textTokens = tokenizeProse(text)`; the shared
   FTS block writes `path` + filtered `keywords` + `content` (empty
   `symbol_names`).
4. **Locate:** AND-first MATCH over `search_index` (now including prose rows);
   OR fallback only when AND returns zero rows; column-weighted BM25 + test
   penalty + df-cap unchanged.
5. **Pickup:** tool description + (default-on) persona + skill assert
   navigator-first with the `rg` boundary.

---

## 7. Error & Edge Cases

- **Prose file, all-stopword body:** `keywords`/`content` empty after filtering;
  the row still carries `path` tokens, so it is findable by name. Acceptable.
- **Query of only stopwords / punctuation:** AND expr empty → OR fallback also
  empty → no results, returned gracefully (current behavior).
- **Oversized/binary `.md`:** skipped by the existing 1 MB / binary guard; no FTS
  row. Acceptable.
- **`prose` forced into `config.languages`:** cannot reach tree-sitter — the
  prose body branch is selected by `lang === "prose"` independent of
  `config.languages` (§3.2), and tree-sitter init is guarded by grammar
  availability. A test forces `prose` into `config.languages` and asserts
  `extractSymbols` is still never invoked for a `.md` file.
- **Prose row matching only on `path` (empty `keywords`/`content`):** FTS5 BM25
  scores an empty column as zero, not an error; the row ranks normally (§3.5).
- **Stale DB without re-index:** the `SCHEMA_VERSION` bump forces a one-time full
  re-derive; until it completes, prose coverage ramps with the rolling worker
  (same behavior as any reindex).
- **Persona injected but tool absent:** prevented by the existing
  `selectedTools` guard.

---

## 8. Testing Approach

**Change 1 — prose indexing**
- `tokenizeProse` splits a Markdown body into expected tokens; stoplist/min-length
  filtering applies (unit, `keywords.test.ts`).
- End-to-end: index a fixture repo with `doc/QUEUE_CONTRACTS.md` containing
  "queue contracts"; `locate("QUEUE_CONTRACTS")` and `locate("queue contracts")`
  both return it in top-5 (the exact miss from the replay).
- A prose body term not present in any path/symbol becomes locatable (proves body
  indexing, non-tautological).
- Oversized `.md` (> `maxFileBytes`) yields no FTS row.
- `prose` is not in `DEFAULT_CONFIG.languages`; `extractSymbols` is not called for
  a `.md` file.

- A prose file matching solely via path tokens (empty `keywords`/`content`)
  ranks normally — guards the empty-column BM25 path.

**Change 2 — pickup**
- `DEFAULT_CONFIG.injectPersona === true`.
- `navigator.injectPersona: false` opts out.
- Tool description and persona contain the navigator-first lead and the `rg`
  boundary clause (string assertions guard against regression).
- `navigator_locate` is present in `selectedTools` under both a bare `-e` load
  and the package-install path (so persona injection actually fires).
- Skill discovery in the package-install path verified via the §4.3 manual
  procedure (integration-level, not unit-testable).

**Change 3 — multi-word**
- Multi-word query ranks an all-terms file above an either-term file.
- AND returning **zero** rows falls back to OR (non-empty); a multi-word query
  with exactly one all-terms file keeps that single precise result (no fallback).
- Single-token query path is unchanged (one query, identical results to today).

**Regression:** existing tests stay green; new tests are added per change. Eval
harness gains prose cases (e.g. a doc-locate query) to track doc-coverage.

---

## 9. Files Touched

| File | Change |
|---|---|
| `src/types.ts` | add `"prose"` to `Lang` |
| `src/indexer/walk.ts` | `langOf` maps 5 prose extensions |
| `src/indexer/keywords.ts` | add `tokenizeProse`; `buildStoplist` handles `prose` |
| `src/indexer/worker-core.ts` | prose branch sets `textTokens` from body |
| `src/store/schema.ts` | bump `SCHEMA_VERSION` 3→4 (no DDL, no new migration code) |
| `src/navigator/locate.ts` | `buildMatchExpr(query, joiner)`; AND-first with OR fallback on zero rows |
| `src/config.ts` | `injectPersona` default `true` |
| `src/tools.ts` | rewrite `navigator_locate` description + guidelines |
| `prompts/navigator-persona.md` | strengthen, add `rg` boundary |
| `skills/navigator/SKILL.md` | concrete when/how + boundary |
| `README.md` / `NAVIGATOR.md` | document prose indexing, pickup channels, install path |
| `eval/cases.jsonl` | add prose-locate case(s) |

---

## 10. Acceptance Criteria

1. `locate("QUEUE_CONTRACTS")` and `locate("queue contracts")` return the
   Markdown file in top-5 on a fixture repo (was zero before).
2. A term living only in a Markdown body is locatable.
3. `DEFAULT_CONFIG.injectPersona === true`; persona, tool description, and
   `SKILL.md` all carry the navigator-first lead and `rg` boundary.
4. Multi-word query ranks the all-terms file above either-term files; a
   single all-terms file is kept (no OR dilution); single-token queries are
   byte-identical to current results.
5. `npm run typecheck` clean; `node --test` green (existing + new); eval prose
   case hits.
