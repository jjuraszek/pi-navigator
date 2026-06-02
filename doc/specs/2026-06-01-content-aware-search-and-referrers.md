# Spec: Content-Aware Search, Keyword Ranking & Rails Referrers

**Date:** 2026-06-01
**Status:** Draft (awaiting user review)
**Worktree branch:** `content-search-keywords`
**Source report:** `doc/report.md`

## 1. Goal

Close the gap between what pi-navigator advertises (first-contact orientation that replaces a "grep safari") and what it delivers today (a path + symbol index that only matches when query words appear in a path or symbol name). Make conceptual/domain queries — "database migration", "grid power flow calculation" — return implementation files, not test files or nothing, while staying **fast and fully deterministic (no LLM)**.

LLM/embedding-based semantic search remains a deferred follow-up on the existing `vectors.ts` seam and is explicitly out of scope here.

## 2. Concerns Addressed (from `doc/report.md`)

| # | Report concern | This spec |
|---|---|---|
| 1 | Contentless FTS misses conceptual queries (`db/migrate/...` for "database migration") | §5 content-aware FTS + §6 keyword extraction + §7 porter stemming |
| 2 | Eval set is self-flattering (all terms appear in target filename) | §9 add conceptual/domain cases |
| 3 | Referrer fan-out dead for Rails (autoload, no `require`) | §8 Ruby constant-ref extraction + resolver + df-cap |
| 3b | Test files (`*_spec.rb`) outrank the implementation they cover | §7.3 test-file deprioritization |
| 4 | README headline #1 oversells; §6.1 freshness trigger overstated | §10 doc reframes (claim alignment only) |

## 3. Non-Goals

- **No LLM, no embeddings.** Deferred to the `vectors.ts` seam as a separate spec.
- **No bash-mutation freshness detection.** The §6.1 overstatement is resolved by *reframing the doc claim* (§10), not by implementing `sed`/heredoc/codegen mutation tracking. That remains a separate follow-up.
- **No indexing of gitignored content.** Decided: gitignored files stay **fully excluded** (current `walk.ts` behavior). No path-only indexing of ignored files.
- **No corpus-global token→df table for keywords.** BM25's built-in IDF handles corpus-common terms (§6.4).

## 4. Invariant Rewrite (AGENTS.md / spec §10)

The current hard invariant — **"The DB stores no file contents"** — is rewritten. Content-aware FTS5 stores a full inverted index; the original token stream of a tracked file is recoverable from the postings. The replacement invariant:

> **The DB stores no file contents for secret or gitignored files. Tracked, non-secret source is indexed as a contentless FTS5 inverted index (recoverable bag-of-words, never original byte layout). Slice content is always read live from the active worktree.**

Rationale (user-confirmed): the indexed set is exactly what git does **not** ignore — already in the working tree / on the remote. "If a secret reaches GitHub it is no longer secret." The cache DB lives at `~/.pi/pi-navigator-cache/...` — same local trust boundary as the checkout. Secret globs (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, `*.pfx`) remain excluded from walk regardless of tracked status — they are **never content-read**.

Unchanged invariants: single-writer lock; slices always read the active worktree; secret globs always ignored.

## 5. Content-Aware FTS Schema

`SCHEMA_VERSION` bumps `2 → 3`. The `search_index` virtual table is replaced (drop + recreate; existing rows re-derived on next index pass — a full reindex is triggered by the version bump via the existing migrate path).

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  path,          -- path segments, split on / _ - . and camelCase
  symbol_names,  -- tree-sitter symbol names (unchanged source)
  keywords,      -- split identifiers + comment/docstring/string terms, filtered (§6)
  content,       -- full token stream, contentless catch-all
  tokenize = 'porter unicode61'
);
```

- **rowid == files.id** (unchanged).
- Only files with `lang != null` enter `search_index` (unchanged — generated artefacts stay out to avoid BM25 pollution).
- `content` is the contentless catch-all recall column; demoted at rank time (§7) so boilerplate cannot dominate.
- The old metadata-only columns (`path`, `symbol_names`, `kind_tags`) collapse: `kind_tags` is dropped (unused by ranking); `keywords` and `content` are added.

**This is a standard (stored) FTS5 table, NOT an external-content (`content=''`) table.** A standard FTS5 table stores its own inverted index (postings: term → docid list + positions) but does **not** retain the original text rows. The token stream is recoverable as an unordered bag-of-words; the original byte layout is not. This is the precise sense of the §4 invariant rewrite. Do not set `content=''` — that is the older spec design and would require re-supplying text on every query.

`ftsUpsert` signature changes from the current 3-column form to 4 columns:

```ts
// store/queries.ts
export function ftsUpsert(
  db: Db,
  rowid: number,
  path: string,          // space-joined split path segments
  symbolNames: string,   // space-joined symbol names
  keywords: string,      // space-joined filtered keyword set (§6)
  content: string,       // space-joined full token stream
): void;
```

Delete-then-insert by `rowid` (FTS5 has no native upsert): `DELETE FROM search_index WHERE rowid = ?` then `INSERT INTO search_index(rowid, path, symbol_names, keywords, content) VALUES (?,?,?,?,?)`.

## 6. Keyword Extraction (deterministic, no extra I/O)

Extraction reuses bytes already in memory: the indexer already (a) reads each file to hash + detect binary, and (b) parses source files with tree-sitter for symbols. Keyword harvesting is incremental work on that data — no extra file reads, no model.

### 6.1 Sources
- **Identifiers** from tree-sitter nodes, **split** on camelCase / snake_case / kebab (`createUser` → `create`, `user`; `power_flow` → `power`, `flow`).
- **Comment + docstring terms** (tree-sitter comment nodes).
- **Selected string literals** (string-literal nodes).

**String-literal selection rule.** A string literal contributes to `keywords` only if, after splitting on the same camelCase/snake/kebab/whitespace boundaries, it yields ≥1 token that survives the §6.2 filters. Explicitly excluded as whole literals: anything matching a URL pattern (`scheme://…`), absolute/relative filesystem paths (containing `/` with a file-ish tail), pure-numeric or format strings, and single-character literals. The intent is to capture human-meaningful literals (error messages, status names, config keys) while dropping machine strings. Borderline literals contribute their surviving split tokens, not the raw literal.

The `content` column receives the full token stream (pre-filter, post-tokenizer); `keywords` receives the **filtered** high-signal set below.

### 6.2 Storage filters (keep junk OUT of the `keywords` column)
Applied at index time, in order:
1. Lowercase + dedupe per file.
2. **Length floor:** drop tokens shorter than `keywordMinLength` (default **3**). Drops `i j k x db id os`. (Caveat: real 2-char terms like `io os ui db id` survive in `path`/`symbol_names` columns when present there.)
3. **Char-class drop:** pure-numeric, hex, UUID, punctuation-only, single-token URLs.
4. **Identifier split, then filter** — split fragments are themselves subject to all filters.
5. **Stoplists** (§6.3).

### 6.3 Stoplists (defaults carry the value; config is optional/additive)
Static, deterministic. Validated against a large polyglot repo's token-frequency scan (Ruby/Python/SQL) plus general knowledge for popular languages.

| Layer | Contents (defaults) |
|---|---|
| Ruby | `def end class module if unless else elsif when case do yield self nil true false return require include extend attr_accessor attr_reader begin rescue ensure raise next break super freeze new` |
| Python | `def class return if elif else for while in is not and or import from as with assert pass lambda yield self none true false raise try except finally del print len str int list dict` |
| SQL | `select from where create alter table index constraint null not on using only default add by key sequence owner schema public type join group order having insert update values primary foreign btree` |
| JS/TS | `function const let var return if else for while in of new this null undefined true false import export from as default class extends async await typeof instanceof` |
| Popular extras | Go / Rust / Java / C# keyword sets (from knowledge; applied by `lang`) |
| Cross-language code-noise | `todo fixme xxx hack note deprecated tmp temp foo bar baz qux` |
| English (comments/strings only) | `the a an and or of to in is it for on with as at by be this that not from` |

- Language keyword lists are keyed by `lang`; only the matching list applies to a file.
- The code-noise + English lists apply across all languages.
- **Domain terms are never stoplisted.**

**Location & merge order.** Stoplists live in a new `src/indexer/keywords.ts` module:

```ts
export const DEFAULT_STOPLISTS: Record<Lang, readonly string[]>;   // keyed by lang
export const DEFAULT_CROSS_LANG_STOPLIST: readonly string[];       // code-noise + English
```

The effective stoplist for a file of language `L` is built once and cached as a `Set<string>`:
`DEFAULT_STOPLISTS[L]` ∪ `DEFAULT_CROSS_LANG_STOPLIST` ∪ `config.keywordStoplist`. Merge order is union-then-dedup (order does not matter for a set); all entries are lowercased on construction to match the lowercased tokens from §6.2 step 1. User `keywordStoplist` only ever **adds** terms — there is no removal/override mechanism in this iteration. The scan confirmed that domain-specific nouns (e.g. `plant voltage unit label company section field`) are high-frequency in a given corpus but are legitimate search targets. Hardcoding them would break a domain user. Their corpus-relative frequency is handled by BM25-IDF (§6.4), not the static list.

### 6.4 BM25-IDF handles corpus-common terms (no global bookkeeping)
Tokens that survive the static filters but appear in nearly every file (e.g. `params`, `self` slipping through, or domain-ubiquitous `plant`) score ≈0 via FTS5 BM25's built-in inverse-document-frequency term. This is computed by FTS5 at query time from the index — **no maintained token→df table, no second pass, no re-extraction when df shifts.** This is what keeps the rolling/incremental indexer fast.

Layering summary: **static lexical filters keep junk out of storage; BM25-IDF keeps surviving-but-common terms out of the ranking.**

### 6.5 Config
`settings.json` `navigator` namespace, all optional, defaults carry the value:
- `keywordStoplist: string[]` — **appended** to defaults (never replaces).
- `keywordMinLength: number` — default 3.

`NavigatorConfig` (in `src/types.ts`) gains two optional fields; `loadConfig()` (`src/config.ts`) applies defaults:

```ts
export interface NavigatorConfig {
  // ...existing fields...
  keywordStoplist?: string[];   // default []  — appended to DEFAULT_*_STOPLIST
  keywordMinLength?: number;    // default 3   — §6.2 length floor
}
```

Resolution: `loadConfig()` reads the `navigator` namespace, coerces `keywordMinLength` to a positive integer (fallback 3 on invalid), and normalizes `keywordStoplist` to a lowercased string array (fallback `[]`).

## 7. Ranking Changes (`rank.ts`)

### 7.1 Weighted BM25 across columns
`locate.ts` replaces `bm25(search_index)` with column-weighted BM25:

```
bm25(search_index, w_col_path, w_col_symbols, w_col_keywords, w_col_content)
```

Proposed column weights (transparent constants in `rank.ts`, tunable against eval):

| Column | Weight | Role |
|---|---|---|
| `path` | high | strongest locator (matches today's behavior) |
| `symbol_names` | high | definition sites |
| `keywords` | medium | recall the raw tokenizer misses + precision |
| `content` | low | catch-all recall, demoted so boilerplate can't dominate |

The existing composite `score()` signals (`fts`, `path`, `symbol`, `recency`) and weights (`fts 1.0 / path 3.5 / symbol 2.0 / recency 0.5`) are retained; the FTS signal now derives from the column-weighted bm25. Both weight sets stay as named, commented constants.

### 7.2 Porter stemming
`tokenize='porter unicode61'` (was `unicode61`). Fixes `migration`↔`migrate`, `calculation`↔`calculate` across all columns. The `db/migrate/` "database migration" miss is resolved by the combination of stemming (migrate↔migration) + content column (the word "database" appearing in file body) + path token expansion.

### 7.3 Test-file deprioritization
A multiplicative penalty applied to the composite score for files matching test conventions:
- Path matches a test glob in `TEST_GLOBS` (named constant in `rank.ts`): `*_spec.rb`, `*_test.rb`, `**/spec/**`, `**/test/**`, `**/tests/**`, `*.test.ts`, `*.test.js`, `*.spec.ts`, `*.test.tsx`, `*.spec.tsx`, `test_*.py`, `*_test.py`.
- Penalty factor `testPenalty` (default e.g. **0.5**), a tunable constant in `rank.ts`.
- **Application point & order:** the penalty is applied **last**, multiplicatively, to the final fused composite score from `score()` (after `fts`/`path`/`symbol`/`recency` fusion) — never to individual signals. A single matched-flag (`isTestPath(path)`) is computed once per candidate and multiplied in: `final = composite * (isTestPath ? testPenalty : 1)`.
- **No exemptions:** even an exact basename-stem match on a test file is demoted (`foo_spec.rb` still ranks below `foo.rb` when both match equally). The penalty is a demotion, not exclusion — test files still surface when they are the only/best match.

## 8. Ruby Referrers (constant-ref extraction + resolver + df-cap)

Today `extractImports` emits Ruby edges only for `require`/`require_relative`. Rails autoloads (Zeitwerk), so models/controllers are never required → `refs` is effectively empty for the dominant Ruby subproject → `referrers=[]`. Co-change (git-derived) already compensates for relatedness, but the referrer half of the cluster never fires.

### 8.1 Extraction
Add a Ruby constant-reference pass to `extractImports` (`symbols.ts`): tree-sitter capture of `constant` and `scope_resolution` (`Foo::Bar`) nodes. Optionally capture `has_many`/`belongs_to`/`has_one` symbol arguments as association references.

### 8.2 Resolution-as-filter (free noise removal)
A referrer edge is emitted **only when the constant resolves to a file in our `files` table**.

**Resolution algorithm (Zeitwerk-style, inflection-free):**
1. **Underscore the constant name as-is. No pluralization/singularization.** Zeitwerk performs a pure name↔path mapping: the constant carries its own plurality. `User` → `user`; `UsersController` → `users_controller`; `APIClient`/`HTTPServer` → acronym-aware underscore (`api_client`, `http_server`). `Foo::Bar` → path segments `foo/bar`. (This corrects the council's "singularize + underscore" — singularizing would wrongly map `UsersController` → `user_controller`.)
2. Form the candidate relative path `<underscored>.rb` (for `Foo::Bar`, `foo/bar.rb`).
3. Match against the `files` table by **relative-path suffix**: a file resolves if its repo-relative path ends with the candidate path under any autoload root present in the index (`app/**`, `lib/**`, or repo root). Implemented as an indexed suffix/basename lookup over `files`, not a load-path config parse — we only ever match paths that already exist in the index.
4. **Zero matches → no edge** (drops `Time`, `Logger`, `Rails`, `ActiveRecord`, and any stdlib/gem constant for free — no maintained denylist).
5. **Multiple matches → emit an edge to each**, subject to the §8.3 df-cap (ambiguity is acceptable; the cluster is approximate).

Examples: `User` → `app/models/user.rb` (edge); `Billing::Invoice` → `app/models/billing/invoice.rb` (edge); `Time` → no candidate file (no edge).

### 8.3 df-cap (ubiquitous app constants)
`ApplicationRecord` / `ApplicationController` resolve to real files but are referenced by nearly every model/controller. Drop referrer edges whose **target** (`dst_file`) is referenced by more than `refDfCapPct` of files (default e.g. **20%**).

**When/how computed (no global recompute pass):**
- The cap is evaluated **at query time in the referrer fan-out** (`locate.ts`), not during indexing. The referrer lookup already queries `refs` for a candidate's incoming edges; it additionally checks each source constant's target fan-in.
- Fan-in is `COUNT(DISTINCT src_file)` grouped by `dst_file` over the `refs` table where `kind = 'ruby_const'`, compared against `totalFiles` (already available from `coverage()`). A single grouped query (or a small prepared statement keyed by `dst_file`) supplies the ratio; targets over `refDfCapPct` are excluded from the fan-out.
- This keeps the **writer/indexer path unchanged** — the worker just writes edges as it extracts them. No batch-boundary snapshot, no cross-pass bookkeeping, no re-extraction when fan-in shifts. The ratio is always read live from the current `refs` state at locate time, consistent with how coverage/freshness are already computed.

Edge explosion — the failure mode that made naive constant extraction net-negative — is bounded by §8.2 (resolution filter) + §8.3 (df-cap) together.

### 8.4 Edge kind
New `refs.kind` value `'ruby_const'` (existing schema supports arbitrary `kind`). No schema change to `refs`.

## 9. Eval (`eval/cases.jsonl`, `eval/run.ts`)

Add conceptual/domain cases that **currently fail** so the harness measures the thing this spec fixes. Queries whose terms do **not** appear in the target filename. At least three new `cases.jsonl` entries (paths to be confirmed against the eval repo during implementation):

```jsonl
{"query": "database migration create table", "expect_prefix": "db/migrate/"}
{"query": "grid power flow calculation", "expect_not_suffix": "_spec.rb"}
{"query": "csv import parsing", "expect_contains": "import"}
```

Matcher semantics: `expect_prefix` = top-k contains a path with that prefix; `expect_not_suffix` = the #1 result must not end with that suffix (test-penalty regression guard); `expect_contains` = top-k path contains substring. `run.ts` gains these matcher kinds alongside the existing exact-path expectation.

- **Target:** the new conceptual cases reach **hit@3** (target file in top 3); existing path/symbol cases stay green as regression guards.
- Keep existing path/symbol cases unchanged.
- Document the expected hit@k delta in the report/CHANGELOG so the eval can fail if ranking regresses.

`eval/run.ts` continues to measure hit@k vs the `rg` baseline; only matcher kinds are added — no harness redesign.

## 10. Docs

Claim-alignment only (no behavior beyond §3):
- **README headline #1** — reframe "first-contact orientation instead of a grep safari" to reflect content-aware (deterministic, non-semantic) search; drop the implication of conceptual understanding.
- **README #5 / §6.1 freshness** — state plainly that priority re-index fires on `edit`/`write`; bash-driven mutations (`sed`, heredocs, `git checkout`, codegen, `mv`) are picked up by the next catch-up pass, not instantly. No claim of bash-mutation detection.
- **AGENTS.md** — apply the §4 invariant rewrite in the invariants table (replace the "DB stores no file contents" row).
- **NAVIGATOR.md** — specific sections to update: **schema** (new 4-column `search_index`, version 3, porter tokenizer); **ranking** (column-weighted bm25 constants, `testPenalty`, `TEST_GLOBS`); a new **keyword extraction** subsection (sources, filter pipeline, stoplist layers + config); the **referrer/cluster** section (Ruby constant resolution, df-cap at locate time). Note the deliberate divergence from the original contentless-FTS design and why.
- **README** — the two reframes above (#1 headline, #5 freshness).

## 11. Config Summary (`navigator` namespace, all optional)

| Key | Default | Meaning |
|---|---|---|
| `keywordStoplist` | `[]` | extra stoplist terms, appended to defaults |
| `keywordMinLength` | `3` | drop keyword tokens shorter than this |

Ranking constants (`w_col_*`, `testPenalty`, `refDfCapPct`) live as commented constants in `rank.ts` / indexer, tuned against eval — not user config in this iteration.

## 12. Error & Edge Cases

- **Schema migration:** version `2→3` drops/recreates `search_index`; the version-bump path forces a full reindex. No content migration needed (DB never stored content).
- **Empty keyword set:** a file with no surviving keywords inserts an empty `keywords` column — valid, contributes nothing to ranking.
- **FTS syntax safety:** existing `ftsEscape` / `buildMatchExpr` token escaping retained; porter tokenizer does not change escaping needs.
- **Unresolvable Ruby constant:** no edge (by §8.2) — never an error.
- **Constant resolving to multiple files:** emit edges to all matches under the df-cap; ambiguity is acceptable (cluster is approximate).
- **Binary/secret files:** unchanged — never read, never indexed.

## 13. Testing Approach

- **Keyword extraction unit tests:** identifier splitting, each filter layer, per-language stoplists, length floor, config append. Fixture strings per language.
- **Stoplist tests:** assert domain terms (`plant`, `voltage`) are NOT dropped; assert language keywords ARE dropped.
- **Schema/migration test:** `2→3` rebuilds `search_index` with new columns; round-trip insert/query.
- **Ranking tests:** weighted bm25 ordering; test-penalty demotes `foo_spec.rb` below `foo.rb`; porter stemming matches `migration`↔`migrate`.
- **Ruby referrer tests:** `User` resolves to `user.rb` (edge); `Time` does not (no edge); df-cap drops `ApplicationRecord`.
- **Eval:** new conceptual cases pass at target hit@k; existing cases remain green.
- **Full suite:** `npm run typecheck` + `node --test` green. The current baseline (60 tests) must stay green as a regression guard; this spec **adds** tests (keyword extraction, stoplists, migration, weighted ranking, test penalty, Ruby referrers), so the final count is higher — "60/60" is the floor that must not regress, not the target.

## 14. Open Questions

None blocking. Tunable constants (`w_col_*`, `testPenalty` 0.5, `refDfCapPct` 20%, `keywordMinLength` 3) are starting values to be calibrated against the expanded eval during implementation.
