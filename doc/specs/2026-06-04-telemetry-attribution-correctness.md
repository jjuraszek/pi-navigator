# Telemetry Attribution Correctness

**Status:** Draft (awaiting review)
**Date:** 2026-06-04
**Worktree/branch:** `telemetry-attribution-correctness`
**Scope:** Fix the navigator usefulness-telemetry correlation pipeline shipped in v0.5.0. Findings consolidated from a dogfood session into one spec covering search detection, outcome attribution, cluster eligibility, the attribution window, and the offline judge export. Confidence-flag tuning and the stats null-message are explicitly **out of scope** (separate trivial fixes).

---

## 1. Problem

Dogfooding the v0.5.0 telemetry surfaced attribution bugs that the synthetic unit tests could not catch, because those tests feed clean `rg foo` strings and ranked-only consumes. Real agent sessions violate the correlator's assumptions. Consolidated findings:

| # | Finding | Root file | In scope |
|---|---|---|---|
| 1 | `cd … && rg/grep/find` searches never detected (`(?:^\|\|)` anchor) | `src/telemetry/detect.ts` | ✅ |
| 6 | `search_pattern` captures trailing shell cruft (e.g. `"navigator;"`) | `src/telemetry/detect.ts` | ✅ |
| 2 | Unrelated follow-up read labeled `miss-fallback` (often `unjustified`) | `src/telemetry/stats.ts` | ✅ |
| 4 | Co-change/referrer **cluster** paths are not hit-eligible (`rankOf` scans ranked results only) | `src/telemetry/correlator.ts` | ✅ |
| 8 | 10-turn window absorbs unrelated tails (a late search steals attribution) | `src/telemetry/stats.ts` | ✅ |
| 3 | Judge `"indexed"` (ranking-gap) verdict is an unreachable dead branch | `scripts/export-cases.ts` | ✅ |
| 5 | Low-confidence flag fires on a strong, anchored top hit | `src/navigator/locate.ts` | ❌ out of scope |
| 1-step1 | "no data recorded yet" never shows; zeros block instead | `src/commands.ts` / `index.ts` | ❌ out of scope |
| 7 | Read latency occasionally `0 ms` | — | ❌ dropped (best-effort, not a bug) |

**Unifying root cause:** the correlator encodes assumptions about agent behavior — that searches appear at command start, that only ranked results get consumed, and that any in-window consume signals a fallback — which real sessions routinely break. The bugs interlock: a missed search (#1) changes outcome classification (#2), which changes which cases the judge surfaces (#3).

### Invariants preserved (must not regress)

- The telemetry DB stores **no file contents** and **no secret paths**. Only paths (non-secret), scores, signal decomposition, and (when `telemetryStoreQueries: true`) locate query strings and search patterns.
- Telemetry is **disposable, dev-only** data: a `TELEMETRY_SCHEMA_VERSION` bump drops and rebuilds the telemetry DB. No data migration is owed.
- Telemetry remains off by default; this spec changes only behavior when `navigator.telemetry: true`.

---

## 2. Outcome model (source of truth)

Each `nav_locate` row resolves to **exactly one** outcome. Resolution is by strict precedence:

```
hit  >  cluster-assist  >  miss-fallback  >  abandoned
```

| Outcome | Definition |
|---|---|
| **hit** | A **ranked-result** path (a path in this locate's returned results list, `locate_rank` set) was consumed (read or sliced) within the **full window**. |
| **cluster-assist** *(new)* | A **co-change or referrer cluster** path (surfaced by the locate but not in the ranked results) was consumed within the **full window**, and no ranked-result consume occurred. |
| **miss-fallback** | A **search** (`rg`/`grep`/`find`/`fd`/`ag`/`ack`) ran within the **fallback sub-window**, and neither a hit nor a cluster-assist applies. |
| **abandoned** | None of the above within the window. |

Precedence resolves multi-signal windows deterministically:
- Search **then** open a ranked result → **hit** (ranked consume wins over search).
- Cluster-assist **then** a later search → stays **cluster-assist** (positive outcome wins over fallback).
- Zero-result locate followed by a search → **miss-fallback**.

### Windows (asymmetric)

Two named module constants in `stats.ts` (not user-configurable in this spec):

| Constant | Value | Applies to |
|---|---|---|
| `FULL_WINDOW_TURNS` | `10` | hit and cluster-assist attribution |
| `FALLBACK_WINDOW_TURNS` | `3` | search → miss-fallback attribution |

Both windows are bounded by "until the next locate in the same session" (a later locate always closes the prior locate's window) **and** the turn cap above, whichever is smaller. Rationale: a genuine "navigator failed me" re-search happens fast; a search 8 turns later is new work. A legitimate hit can arrive later (the agent reasons, then opens the file), so positive outcomes keep the generous window.

### Metrics

- `hit_rate`, `mrr`, `hit@1/3/5` stay **ranked-only** — cluster-assists do **not** inflate them.
- Add **`assist_rate`** = cluster-assist locates / total locates.
- `miss_fallback` is now search-gated; the v0.5.0 "read CHANGELOG = unjustified fallback" mislabel disappears because an unrelated read with no search resolves to `abandoned`.
- All rates remain in `[0,1]`; denominators of zero yield `0`, never `NaN`/`Infinity`.

### Type changes (`src/telemetry/types.ts`)

The existing `Outcome` union and `StatsSummary` must be widened or TypeScript will not compile:

```ts
export type Outcome = "hit" | "cluster-assist" | "miss-fallback" | "abandoned";

export interface StatsSummary {
  // ...existing fields...
  assistRate: number;       // cluster-assist locates / total locates
}
```

`ConsumeKind` (internal to `deriveInternal`) classifies a consume as `"ranked" | "cluster" | "search" | "neither"` from the row's populated fields.

---

## 3. Component changes

### 3.1 Detection — `src/telemetry/detect.ts` (fixes #1, #6)

- **Segment splitting.** Split each bash command string on `&&`, `||`, `;`, `|`, and newlines into segments; trim each. Test **every** segment against the search-tool patterns. `cd repo && rg foo` and `ls | grep -v x | head` both match.
- **Cardinality.** Record **one** search consume per bash call; the primary is the **first** matching segment (left to right). Multiple searches in one compound command do not produce multiple consumes.
- **Pattern extraction.** From the matching segment, strip the tool token and leading flags, then trim trailing shell operators and punctuation (`;`, `&`, `|`, redirections, stray quotes). `rg navigator; echo done` records pattern `navigator`, not `navigator;`.
- **Tools recognized:** `rg`, `grep`, `find`, `fd`, `fdfind`, `ag`, `ack` (superset of current set; confirm against current list before editing).
- **Quoted delimiters.** Split on **unquoted** delimiters only — a `&&`, `;`, or `|` inside single/double quotes (e.g. `rg 'a && b'`) is not a segment boundary. `$(...)` command substitution and heredocs are handled best-effort (treated as opaque within their span); perfect shell parsing is a non-goal — the detector favors recall on the common `cd … && <search>` form over exhaustive POSIX correctness.

### 3.2 Schema — `src/telemetry/schema.ts`

- Bump `TELEMETRY_SCHEMA_VERSION`. The existing `migrate()` drops and rebuilds the telemetry DB on version mismatch — **no `ALTER TABLE`, no backfill**; existing dev-only rows are discarded by design.
- `nav_consume` gains a `cluster_kind` column with a mutual-exclusion `CHECK`:

```sql
ALTER ... -- not used; the column ships in the CREATE TABLE rebuilt by migrate()
cluster_kind TEXT,  -- NULL | 'cochange' | 'referrer'
CHECK (locate_rank IS NULL OR cluster_kind IS NULL)
```

  A consume row is classified as **ranked** (`locate_rank` non-null), **cluster** (`cluster_kind` non-null), or **neither**. The `CHECK` enforces the §2 invariant that the two are never both set.
- `ConsumeRowInput` (the insert type in `types.ts`/`queries.ts`) gains `clusterKind: 'cochange' | 'referrer' | null`.
- `nav_locate.cochange` and `nav_locate.referrers` already persist at locate time — no locate-side schema change.

### 3.3 Correlator — `src/telemetry/correlator.ts` (enables #4)

- At locate time, `lastLocate` holds **both** the ranked result paths **and** the cluster paths (co-change + referrers), with the cluster kind retained per path. Replace the ranked-only `ResultMeta[]` field with an explicit state object:

```ts
interface LocateState {
  locateId: number;
  turn: number;
  ranked: string[];                               // result paths, index = rank-1
  cluster: Array<{ path: string; kind: "cochange" | "referrer" }>;
}
// correlator field: private lastLocate: LocateState | null
```

- `rankOf(path)` becomes `classifyConsume(path) → { rank: number | null, clusterKind: 'cochange' | 'referrer' | null }`:
  - path in ranked results → `{ rank: idx+1, clusterKind: null }`.
  - else path in cluster → `{ rank: null, clusterKind }`.
  - else → `{ rank: null, clusterKind: null }`.
- Consume rows are written with whichever field applies. Search detection delegates to the updated `detect.ts`.

### 3.4 Stats — `src/telemetry/stats.ts` (fixes #2, #8)

- Rewrite `deriveInternal` to the precedence model in §2 with the asymmetric windows.
- A consume attributes to a locate only if (a) it falls in that locate's window, and (b) the window kind matches the consume kind: ranked/cluster consumes use `FULL_WINDOW_TURNS`; search consumes use `FALLBACK_WINDOW_TURNS`.
- **Insert-time vs query-time.** `locate_rank` and `cluster_kind` are populated at **insert time** by the correlator (`classifyConsume`); `deriveInternal` reads the stored columns directly and never re-derives consume kind via a query-time join against `nav_locate`. The window/precedence logic is the only thing computed at aggregate time.
- Emit `assist_rate`; keep `hit_rate`/`mrr`/`hit@k` ranked-only.

### 3.5 Judge export — `scripts/export-cases.ts` (fixes #3)

- **Fallback target resolution algorithm.** For a `miss-fallback` locate, iterate its in-window consumes in turn order and pick the **first read/slice consume whose turn is ≥ the triggering search's turn**; its path is the target. Concretely:
  1. Identify the triggering search consume (first `search` consume within `FALLBACK_WINDOW_TURNS`).
  2. Scan forward for the first `read`/`slice` consume at turn ≥ the search's turn.
  3. If found → that path is the target. If **no following read/slice** exists (the agent searched and never opened anything in-window) → `target: null`, verdict **`not_indexed`** (we have no path to check; treat as a recall miss).
  - Multiple searches: only the first triggering search defines the window anchor; the first qualifying read after it wins.
  (Reads are still recorded as consumes; they no longer *define* the outcome but the judge mines them for the target path.)
- **Verdicts** (computed against the live index DB):
  - target path in this locate's **cluster** (cochange/referrers) → **`indexed`** (ranking gap — surfaced but unranked; now reachable).
  - target path indexed but **not** in this locate's results or cluster → **`indexed_not_returned`** (recall gap).
  - target path **not** in the index → **`not_indexed`**.
- **Cluster-assist cases** also export with the **`indexed`** / ranking-gap verdict: the path was surfaced in the cluster and deserved a rank → actionable signal for `rank.ts` weight tuning.
- **Privacy unchanged:** secret-path redaction stays; no file contents are ever emitted; output is paths + scores + signal decomposition + (opt-in) query/pattern strings only.

---

## 4. Data flow

```
bash/read/slice tool event
        │
        ▼
detect.ts ──(segment split, per-segment match)──► consume kind: ranked | cluster | search | neither
        │
        ▼
correlator.classifyConsume(path) ──► { rank, clusterKind }   (ranked/cluster)
        │                              detect.ts pattern       (search)
        ▼
nav_consume row  { locate_rank?, cluster_kind?, search_pattern?, turn, latency_ms }
        │
        ▼
stats.deriveInternal  ──(precedence + asymmetric windows)──► one outcome per nav_locate
        │                                                     hit | cluster-assist | miss-fallback | abandoned
        ├──► aggregate() → formatStats()  (/navigator stats)
        └──► export-cases.ts → per-case fallback target + index verdict (offline judge JSON)
```

---

## 5. Edge cases

| Case | Resolution |
|---|---|
| `cd repo && rg foo` | Detected (segment split). One search consume, pattern `foo`. |
| `ls \| grep -v telemetry \| head` | Detected via pipe segment; pattern `telemetry`. |
| Search then opens a ranked result | **hit** (precedence over fallback). |
| Cluster-assist then a later unrelated search | **cluster-assist** (positive precedence). |
| Zero-result locate then search | **miss-fallback**; judge target likely `not_indexed`/`indexed_not_returned`. |
| Multiple searches in one compound command | One consume (first matching segment). |
| Unrelated file read, no search | **abandoned** (no longer mislabeled fallback). |
| Late search beyond `FALLBACK_WINDOW_TURNS` | Does **not** create a fallback; prior locate stays hit/assist/abandoned. |
| Terminal locate (last in session) | Window bounded by session end and the turn cap. |
| Existing telemetry rows at upgrade | Dropped on `TELEMETRY_SCHEMA_VERSION` bump (dev-only data). |
| `ranked` and `cluster` both match a path | Ranked wins (path is in results → `locate_rank` set, `cluster_kind` null). |

---

## 6. Testing

### 6.1 Golden event-trace fixtures

A `replayTrace(events, db)` helper in a new `src/telemetry/test-utils.ts` feeds hand-authored ordered tool-event streams through the **real** correlator entry points — `onToolStart`/`onToolEnd` (the only code path that exercises `detect.ts`); tests must **not** insert `nav_consume` rows directly, or they bypass the very detection logic under test. Fixtures live in `src/telemetry/fixtures/*.json` as ordered event arrays. Each is replayed, then `aggregate()` and the `export-cases.ts` core are asserted against expected outcomes, consume classification, and judge verdicts. One named regression case per bug class:

- `cd && rg` fallback detection (was undetected) → miss-fallback recorded.
- pipe-chained `grep` detection.
- pattern cleanliness: `rg navigator; echo` → pattern `navigator` (no trailing `;`).
- cluster-assist: open a co-change path with no ranked consume → `cluster-assist`, not `abandoned`.
- post-search-read judge target → `indexed` (ranking-gap) verdict reachable.
- late search beyond `FALLBACK_WINDOW_TURNS` → prior hit/abandoned preserved (no fallback steal).
- search → ranked-result consume → **hit** precedence.
- multi-search compound command → exactly one search consume.
- unrelated read after a hit → stays **hit**; unrelated read with no prior consume → **abandoned** (not unjustified fallback).

### 6.2 Invariant layer

Property assertions over generated event sequences:

- **Partition:** every `nav_locate` resolves to exactly one outcome.
- **Precedence:** `hit > cluster-assist > miss-fallback > abandoned` holds for any multi-signal window.
- **Range:** every rate ∈ `[0,1]`; no `NaN`/`Infinity`; zero denominators → `0`.
- **Mutual exclusion:** no consume row has both `locate_rank` and `cluster_kind` set.

### 6.3 Verification commands

```bash
npm run typecheck
node --test                 # includes new detect/stats/correlator/export tests
node --test src/telemetry/  # focused telemetry suite
```

---

## 7. Out of scope (tracked separately)

- **#5 — confidence flag false positive.** The low-confidence flag fires via the `usedOrFallback && queryTokenCount >= 2` arm even when the top hit is a strong, anchored result. Independent tuning change in `src/navigator/locate.ts`.
- **#1-step1 — stats null-message.** "telemetry on, no data recorded yet" is effectively unreachable in a healthy session (a zeros block shows instead); `telemetryStats()` returns `null` only pre-boot. UX fix in `src/commands.ts` / `index.ts`.
- **#7 — read latency 0 ms.** Best-effort same-millisecond timing; not a correctness bug. No action.

---

## 8. Open questions

None. All design forks resolved during brainstorming:
- Fallback definition = **re-search only** (reads do not flip outcome).
- Cluster paths = **distinct `cluster-assist` outcome** (not folded into `hit_rate`).
- Judge fallback target = **first post-search read/slice** in window.
- Window model = **asymmetric** (`FULL_WINDOW_TURNS=10` for hit/assist, `FALLBACK_WINDOW_TURNS=3` for fallback).
- Testing = **golden traces + invariant layer**.
