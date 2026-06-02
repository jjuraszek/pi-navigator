# Navigator Trust & Isolation Hardening

**Status:** Draft (awaiting review)
**Date:** 2026-06-02
**Branch / worktree:** `navigator-trust-isolation`
**Baseline:** v0.2.2 — typecheck clean, 99/99 tests pass

## 1. Problem

Navigator can silently mislead the LLM about what the index knows. Three distinct
failure modes, one theme — *never present absence-of-coverage as absence-of-fact*:

1. **Hard miss is a dead end (A).** When `locate()` returns zero results,
   `tools.ts` emits a bare `"No results found."` with **no** fallback hint. The
   existing fallback nudge (`tools.ts`) is gated on `res.results.length > 0`, so
   it never fires on a genuine miss. Combined with prompt guidance that narrows
   `rg`'s role ("use rg only for regex/full-content scans"), an LLM can read
   "No results found" as *"X does not exist"* rather than *"navigator missed it;
   try rg."*

2. **Freshness signal is coarse (B).** `locate()` computes
   `index.fresh = (indexHeadSha === currentHead)` — HEAD-sha only. It ignores a
   dirty working tree: `fresh` can read `true` with uncommitted edits present, or
   `false` right after a commit until co-change rebuilds. Slices always read live
   bytes (correctness preserved), but the *freshness label on locate ranking* is
   misleading.

3. **Repo isolation is not crystal-clear (C).** v0.2.2 already hard-disables
   outside a git work tree (`index.ts` `session_start` early-returns when
   `!repo.isGit` — no DB, no worker). But two gaps remain:
   - The tool cannot distinguish **"not a git repo"** from **"still booting"**;
     both surface as `state === null` → the same `NOT_READY_RESULT`
     ("still indexing **or** not a git repo — try again"). The non-git case is
     terminal and must not say "try again", and must point at `rg`/`fd`.
   - `resolveRepo()` still contains a latent non-git fallback (`root = cwd`,
     `repoId = sha256(cwd)`, a computed `dbPath`) that is now dead code but
     contradicts the "single index = single repo" invariant and is a footgun.

Additionally, the user wants a **footnote (D)** surfacing the exact index path and
entry count, mirroring `pi-context-prune`'s load-time notify + status line.

## 2. Goals / Non-Goals

### Goals
- G1. A zero-result `locate` tells the LLM to fall back to `rg`/`fd`/`read`.
- G2. `index.fresh` reflects working-tree dirtiness, not just HEAD.
- G3. Repo isolation is crystal-clear and enforced: **one index = one repo
  identity (root-commit sha), shared across that repo's worktrees, git-only.**
  Outside a git work tree navigator is fully dormant and says so terminally,
  pointing at `rg`/`fd`.
- G4. A load-time footnote shows the exact index path + `N/M` indexed; `/navigator
  status` shows the index path.

### Non-Goals
- **No count-based fallback threshold** (the rejected "fall back if < N files"
  idea). See §4.1 for the rationale. Quality (`confidence`), not quantity, gates
  the "found but weak" case — and that nudge already exists.
- **No per-worktree index isolation.** Worktrees of one repo intentionally share
  one repo-identity index (root-commit sha). This is the documented worktree-aware
  design; it is not changed.
- **No debounce/TTL cache for the dirty check** (§4.2). One `git status` per
  `locate` is acceptable; revisit only if profiling shows a hot path.
- **No persistent footer widget** for the footnote — load notify + `/navigator
  status` line only.

## 3. Affected Files

| File | Change |
|---|---|
| `src/tools.ts` | A: zero-result + booting fallback nudge. C: terminal non-git message via status getter. |
| `src/navigator/locate.ts` | B: fold working-tree dirtiness into `fresh`; add `dirty`. |
| `src/types.ts` | B: add `dirty: boolean` to the locate index-status shape. |
| `src/worktree.ts` | C: neutralize the dead non-git phantom-path branch (sentinel `dbPath`). |
| `index.ts` | C: expose repo status to tools. D: load-time footnote notify; thread `dbPath` into command state. |
| `src/commands.ts` | D: add `db: <path>` line to `/navigator status`; `NavigatorState.dbPath`. |
| `NAVIGATOR.md` / `AGENTS.md` | C: document the one-index-per-repo invariant crisply. |
| `src/tools.test.ts`, `src/navigator/locate.test.ts`, `src/worktree.test.ts`, `src/commands.test.ts` | tests for A/B/C/D. |

## 4. Design

### 4.1 A — Zero-result fallback nudge (and booting nudge)

**`tools.ts`, `navigator_locate` text builder.** Replace the bare empty branch:

```ts
if (res.results.length === 0) {
  lines.push(
    "No results found — navigator may not cover this query. " +
    "Fall back to rg/fd/read before concluding it doesn't exist.",
  );
}
```

The existing weak-recall nudge (`res.results.length > 0 && res.confidence === "low"`)
is unchanged: it already covers the "found but unreliable" case. Together they
span both axes — **nothing found** (empty → rg/fd) and **found but weak**
(low confidence → verify or rg/fd).

**Why not a count threshold N (the rejected idea).** A raw result-count gate is a
proxy for quality measured in quantity and fails both directions:
- *Punishes precision:* an exact symbol-definition hit (the highest-confidence
  path) legitimately returns 1–2 files; `< N` would fire needless `rg` fan-out
  exactly when navigator did its job.
- *Rewards noise:* a vague query hits the OR-fallback arm and returns 10 weakly
  matched wrong files (`> N`); count says "great", reality says "garbage".
The codebase already computes the right signal (`confidence`, derived from
`usedOrFallback`, `topHasAnchor`, `hasExactDef`). Effective threshold is **N = 0**
(nudge only on a true empty) plus the pre-existing confidence nudge.

**Booting nudge.** The `NOT_READY` path (git repo, index not yet ready) should also
mention the fallback so a still-indexing session is never a dead end. See §4.3 for
the message split.

### 4.2 B — Working-tree-aware freshness

**`src/types.ts`.** Extend the locate index-status shape:

```ts
// the object returned as LocateResponse.index
{ fresh: boolean; head_behind: number; coverage: number; dirty: boolean }
```

**`src/navigator/locate.ts`.** After computing `headMatch`:

```ts
const headMatch = Boolean(indexHeadSha && currentHead && indexHeadSha === currentHead);
const dirty = workingTreeDirty(root);           // git status --porcelain → non-empty
const fresh = headMatch && !dirty;
const head_behind = headMatch ? 0 : countCommitsBetween(root, indexHeadSha ?? "");
const indexStatus = { fresh, head_behind, coverage, dirty };
```

**New helper — committed location `src/worktree.ts`** (sits beside `resolveRepo`;
`locate.ts` already imports from `worktree.ts`, so no new module/import graph):

```ts
export function workingTreeDirty(root: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: root, encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return false;            // never throw out of locate(); non-git/error → "not dirty"
  }
}
```
Untracked files are included (default `git status --porcelain` behavior): a new
untracked source file is genuinely uncovered, so it should count as dirty.

**`tools.ts` freshness messaging.** Split the current `if (!res.index.fresh)`
branch so the LLM gets the right reason. The two conditions are **independent and
can co-occur** (dirty tree *and* behind HEAD); when both hold, emit **both** lines,
dirty first:
- `res.index.dirty` → "index may not yet reflect uncommitted working-tree edits —
  slices read live bytes, but locate ranking can lag; the writer refreshes in the
  background within ~1s."
- `res.index.head_behind > 0` (coverage building) → keep the existing
  "[index coverage: NN% — still building]" line.

**Cost.** One `git status --porcelain` per `locate` call. `locate` is invoked a
handful of times per task, not in a tight loop — acceptable. No caching (Non-Goal).

### 4.3 C — Crystal-clear repo isolation

**Invariant (documented in NAVIGATOR.md + AGENTS.md):**
> Navigator maintains exactly **one index per repository identity**, keyed by the
> repository's **root-commit sha** (`repoId`). All worktrees of that repository
> share the one index. Navigator operates **only inside a git work tree**; outside
> one it is fully dormant — no DB, no worker, and the tools return a terminal
> "use rg/fd" message.

**`index.ts` — expose repo status to tools.** Add a module-level status the tool
getter can read, independent of `state`:

```ts
type RepoStatus = "booting" | "non_git" | "ready";
let repoStatus: RepoStatus = "booting";
```
- Set `repoStatus = "non_git"` in the `!repo.isGit` early-return branch.
- Set `repoStatus = "ready"` once `state` is assigned.
- `registerTools` gains a third parameter — a late-bound status getter. Signature
  changes from `registerTools(pi: PiLike, getCtx: () => NavigatorCtx | null)` to:
  ```ts
  export function registerTools(
    pi: PiLike,
    getCtx: () => NavigatorCtx | null,
    getStatus: () => RepoStatus,
  ): void
  ```
  `index.ts` call site changes from `registerTools(pi, () => state)` to
  `registerTools(pi, () => state, () => repoStatus)`. (`RepoStatus` is exported
  from `index.ts` or a shared `types.ts` so `tools.ts` can type the getter; the
  command-side `PiLike` interface is unrelated and unchanged.)

**`tools.ts` — terminal vs retryable message.** Delete the module-level
`NOT_READY_RESULT` constant and replace its two call sites
(`if (!navCtx) return NOT_READY_RESULT;` in both `navigator_locate` and
`navigator_slice`) with `if (!navCtx) return unavailable(getStatus());`, where
`unavailable` is a status-aware builder:

```ts
function unavailable(status: RepoStatus) {
  const text = status === "non_git"
    ? "navigator is unavailable here: not inside a git repository. Use rg/fd/read to search."
    : "navigator is still indexing — try again shortly, or use rg/fd/read meanwhile.";
  return { content: [{ type: "text" as const, text }] };
}
```
`execute` calls `getStatus()` when `getCtx()` returns null and branches. The
non-git message is **terminal** (no "try again"); the booting message is
retryable **and** offers the fallback.

**`src/worktree.ts` — neutralize the phantom path.** When `!isGit`, return a
sentinel `dbPath` (empty string) instead of a `<cwd-hash>.db` filename, so a
non-git resolution can never name a real DB file:

```ts
} catch { root = cwd; isGit = false; }
// ... repoId computation stays (still used for the no-root-commit git case) ...
const dbPath = isGit ? join(config.indexDir, `${repoName}_${repoId}.db`) : "";
return { root, repoName, repoId, dbPath, isGit };
```
The `repoId` sha256 fallback remains for the legitimate **git repo with no commits**
case (fresh repo); only the non-git phantom `dbPath` is removed. `index.ts` already
guards on `repo.isGit`, so no caller regresses.

### 4.4 D — Index footnote

**`index.ts` `session_start`, after `migrate(db)`** (so persisted coverage from a
prior session is available immediately):

```ts
import { getCoverage } from "./src/store/queries.ts";   // add to index.ts imports
// ...
const cov0 = getCoverage(db);   // { total, indexed }; empty DB → { total: 0, indexed: 0 }
ctx.ui.notify(`navigator loaded — ${repo.dbPath} (${cov0.indexed}/${cov0.total} indexed)`, "info");
```
`getCoverage` already exists in `src/store/queries.ts` and returns
`{ total: number; indexed: number }` (indexed coalesced to 0); it must be **added
to `index.ts`'s import list**. Exact path only (repo name is already encoded in the
filename). On a first-ever load `cov0` is `{0,0}` → footnote reads `(0/0 indexed)`
— honest; the status widget and `/navigator status` update as the worker progresses. This notify is **in addition to** the existing
"index is behind HEAD" notify, not a replacement.

**`src/commands.ts` — `/navigator status` path line.** Extend the
`NavigatorState` interface (currently `{ active, coverage, isWriter, reindex }`)
with `dbPath: string`:

```ts
export interface NavigatorState {
  active: boolean;
  coverage: Coverage | null;
  isWriter: boolean;
  dbPath: string;            // "" when inactive (non-git)
  reindex(path?: string): void;
}
```
Then append a second line to the status output:

```
navigator: 72/72 indexed (100%), full crawl done, writer=yes
  db: /Users/.../pi-navigator-cache/pi-navigator_ab12cd34ef56.db
```
`index.ts` supplies `dbPath: repo.dbPath` when building the command state; when
inactive (non-git) the command keeps its existing "inactive (not a git
repository)" message (no path).

## 5. Edge Cases

| Case | Behavior |
|---|---|
| Booting window (git repo, `state` null during `initParsers` await) | `getStatus()` → `"booting"` → retryable + fallback message. |
| Read-only (non-writer) session, dirty tree | No local worker; `dirty` stays true until another writer process updates the shared DB → `fresh=false` correctly signals lag. |
| Fresh git repo, no commits | `repoId` via sha256 fallback; still git → indexes normally; `dbPath` valid. |
| Huge repo `git status` cost | Accepted; one call per `locate`. Documented, not cached. |
| First-ever load, empty DB | Footnote shows `(0/0 indexed)`. |
| Non-git cwd | `dbPath = ""`, no DB opened, tools terminal-disable, `/navigator status` reports inactive. |

## 6. Testing

- **A — `tools.test.ts`:** zero-result output contains an `rg`/`fd` fallback hint;
  weak-but-nonempty still emits the confidence nudge (regression).
- **B — `locate.test.ts`:** clean tree + HEAD match → `fresh=true, dirty=false`;
  then dirty the fixture repo (`writeFileSync` a tracked file *after* the commit
  that seeded the index, assert `fresh=false, dirty=true, head_behind=0`, then
  restore via `rmSync`/rewrite so the test is self-cleaning). `workingTreeDirty`
  swallows errors (non-git path → returns `false`, no throw).
- **C — `worktree.test.ts`:** non-git dir → `isGit=false`, `dbPath===""` (no
  cwd-hash leak); git-no-commits → `isGit=true`, non-empty `dbPath`.
  **`tools.test.ts`:** `getStatus()==="non_git"` → terminal message containing
  "not inside a git repository" and **not** "try again"; `"booting"` → contains
  "try again" and a fallback hint.
- **D — `commands.test.ts`:** `/navigator status` output includes a `db:` line with
  the path. Extract the footnote string builder into a pure helper for a unit
  assertion on the `navigator loaded — <path> (N/M indexed)` format.
- **Full suite + typecheck** green before ship.

## 7. Open Questions

None. Count-threshold rejected with rationale (§4.1); worktree-shared isolation and
no-cache dirty check are explicit Non-Goals (§2).
