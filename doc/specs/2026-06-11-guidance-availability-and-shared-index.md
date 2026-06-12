# Guidance Availability, Telemetry Completeness, and Shared Repo Identity

Status: Draft (awaiting review)
Supersedes the readiness model of `doc/specs/2026-06-08-navigator-adoption-hardening.md` (M1 tier gates and M3 guard precision are revised here; M2 strong-hit directive and M4 config keys are unchanged).
Companion spec: a separate spec in the subagent-definitions repo enables extension tools (navigator) for orientation-oriented subagents. This spec makes pi-navigator apply correctly once those tools are present.

## 1. Problem & Evidence

Telemetry from a large active repo (414 sessions, Jun 4-11, spanning v0.7.0 and v0.8.0) shows the adoption-hardening release did not move invocation:

| metric | pre v0.8.0 (~5d) | post v0.8.0 (~2.2d) |
|---|---|---|
| `navigator_locate` calls | 7 | 7 |
| `navigator_slice` calls | 5 | 13 |
| native searches | 1935 | 2304 |

97.1% of sessions never called locate. Ranking is fine when invoked (rank-1 consumed 14x; co-change cluster 6x). The bottleneck is reaching the tool. Root causes, confirmed by code reading and live observation:

1. **Guidance absent in unavailable sessions, and the absence is invisible.** Subagent definitions whitelist `read, grep, find, ls, bash` - navigator tools are not in `selectedTools`, so injection is (correctly) skipped, but telemetry counts these sessions identically to bypassed ones. The headline 97% conflates *cannot call* with *chose not to call* and is unactionable as measured.
2. **Boot-window dropout.** `before_agent_start` returns nothing while `repoStatus !== "ready"`. The session's first prompt - the orientation-heavy one - gets zero guidance during worker boot. 7 "booting" `nav_unavailable` events confirm tools were attempted in this window.
3. **Nudge over-gated.** The tier-2 nudge requires full coverage AND `fullCrawlDone` AND `indexedHead == HEAD` AND a clean tree. Active development repos are almost always dirty or a commit ahead, so the strong directive is suppressed in exactly the sessions that matter.
4. **Instruction conflict at the environment level.** A user-global agent-instructions file hardcoded "prefer rg/fd" with no navigator mention; project instructions outrank a persona line at the prompt tail. (Resolved at source during brainstorming - the section was removed. Recorded here as an environment prerequisite, not a code change.)
5. **Grep guard false positive observed live.** `grep -n "<pattern>" /abs/path/file.md` (single explicit file, inside a command substitution) was blocked, violating the guard's own "single file args always allowed" rule from the predecessor spec.
6. **Telemetry blind spots.** Guard blocks happen in `tool_call` and never reach `tool_execution_start` - block frequency is unrecorded. `detectSearch` counts pipe-filter greps (`ps aux | grep foo`) as searches, inflating the search totals the bypass analysis relies on.
7. **Index duplication across worktrees.** `resolveRepo()` sets `repoName = basename(git rev-parse --show-toplevel)`, which differs per linked worktree, so each worktree/branch checkout builds its own `<name>_<repoId>.db` (10+ redundant ~24MB indexes observed for one repo). This contradicts the AGENTS.md invariant "all worktrees of a repo share one index". It also fragments telemetry into per-checkout DB files. Zero locates were recorded from any worktree session despite each having a fully built local index.

## 2. Goals / Non-Goals

**Goals**

- Guidance presence depends on tool availability, not index state. Index state becomes caveat text inside the guidance.
- The strong directive fires in real (dirty, evolving) repos when the index is usable.
- Telemetry distinguishes *unavailable* from *available-but-bypassed* sessions, records guard decisions, and counts only genuine searches - so the next adoption re-measurement is trustworthy.
- One index DB and one telemetry DB per repo identity, shared across all worktrees and branch checkouts.
- Grep guard never blocks a single-file grep.

**Non-Goals**

- No `rank.ts` or schema changes to the index itself. n=14 locates remains too small for ranking tuning.
- No removal of the rg/fd/read fallback path.
- No GC or migration code for stale per-worktree DB files - manual deletion post-release.
- No retroactive correction of pre-v3 telemetry rows.
- No changes to subagent definitions (separate repo, companion spec).
- No changes to walk/index/secret invariants.

## 3. Design

### M1 — Guidance injection: availability-gated, caveat-carrying

`before_agent_start` injects whenever `event.systemPromptOptions.selectedTools` includes `navigator_locate`. That is the **sole** presence precondition. The `repoStatus === "ready"` early-return, the clean-tree requirement, and the HEAD-match requirement are removed as gates.

**Guidance state matrix.** Tool-selection is necessary but not sufficient; the emitted fragments depend on the index lifecycle state:

| State | Condition | Persona | Directive | Caveat |
|---|---|---|---|---|
| terminal | `non_git` or `disabled` | none | none | none (inject nothing regardless of `selectedTools`; the tools themselves return the existing "disabled / use rg/fd" terminal message) |
| boot | `coverage.indexed == 0` (worker booting, nothing indexed yet) | suppressed | weak directive | booting caveat |
| normal | `coverage.indexed > 0` | persona (when `config.persona`) | strong or weak per threshold | per-fact caveats |

Persona is gated on `personaUsable()`, which already requires `facts.coverage.indexed > 0` (`src/prompt-guidance.ts`). Removing the `repoStatus === "ready"` gate does **not** override this: persona stays suppressed until at least one file is indexed. The boot state therefore emits the weak directive + booting caveat only - no persona.

`buildNavigatorPromptGuidance` emits, in order:

1. **Persona line** (existing ~25-word orientation identity) - when `config.persona` and `coverage.indexed > 0`.
2. **Directive** (when `config.promptNudge`), one of two strengths:
   - *Strong* - index usable: `coverage >= 0.9 && fullCrawlDone`. Current strong wording: call `navigator_locate` before rg/find/read when no exact path is known.
   - *Weak* - below threshold or worker booting (incl. `coverage.indexed == 0`): "navigator is available; index still building (N% coverage) - try `navigator_locate` first, fall back to rg/fd if results are thin."
3. **Caveat lines**, each appended independently when its fact holds:
   - worker booting: "if a navigator tool reports booting, retry once before falling back."
   - dirty worktree or `indexedHead != HEAD`: "ranking may lag recent edits - verify candidates with read/slice."

The `likely_orientation` classifier is retained but only **upgrades emphasis** on orientation-looking prompts; it no longer decides presence. `isExternalOnlyPrompt()` detection is **retained**: external-only prompts (git status, PR/issue comments, Slack, Sentry, etc.) emit the persona only - no directive - consistent with predecessor behavior; the relaxed gating must not leak the locate directive into non-agent contexts. The existing exact-path suppression stays: if the prompt already names a concrete path, the directive (not the persona) is suppressed - orientation is done, nudging is noise.

Config: `persona` / `promptNudge` keep their meaning (off = fragment omitted). No new config keys. New behavior is the default.

### M2 — Grep-guard precision

Fix in `classifyGrepCommand` / `decideGrepAction` (`src/grep-guard.ts`):

- A grep with explicit path arguments is a repo-scan only if at least one argument is a **directory** (stat check). Single existing-file arguments are never a scan, never blocked - including inside command substitutions and multi-statement commands.
- `-r`/`-R` with only file arguments is not a scan. The recursive flag alone never forces a scan classification; it only matters when no path is given (GNU grep then recurses the cwd). Exact rule: `scansDir = paths.some(isDirectory) || (recursive && paths.length === 0)`. Therefore `grep -r foo file.ts` allows, `grep -r foo` (no path -> cwd) blocks, `grep -r foo src/` blocks, and `grep -r foo file.ts src/` (mixed) blocks on the directory arg.
- **Command-substitution and multi-statement contexts (`$(...)`, `a; b`).** `classifyGrepCommand` today only splits on `|` - no `$(...)` or `;` parser exists. Add conservative segmentation: match any bare `grep`/`egrep` head within these contexts and classify each independently; allow unless a resolved head segment would itself be blocked as a directory scan. When the structure cannot be parsed cleanly, allow.
- **Stat base path.** `grepProbeDir()` currently calls `statSync(p)` against the extension process cwd, not the session cwd. Path probes must resolve relative to `ctx.cwd`, threaded through `classifyGrepCommand` / `decideGrepAction`. When `ctx.cwd` is unavailable or `statSync` throws, `probeDir` returns `false` (allow-on-unknown).
- Guard errors (stat failure, unparseable command) fall through to **allow**. False negatives cost one redundant grep; false positives block legitimate work and erode trust. Bias to allow.
- Existing allowances unchanged: pipe-filter greps, stdin greps, `git grep`, non-grep heads, built-in `grep` tool.

### M3 — Telemetry completeness (schema v3)

Migration v2 -> v3 in `src/telemetry/schema.ts`. **Must be ALTER-based, not drop-based.** `migrate()` today sets `needsRebuild` true on any version bump and drops all `nav_*` tables - that would erase v2 data and contradicts the "old exports remain readable" claim. For the 2->3 increment specifically: skip the drop path; apply `ALTER TABLE nav_session ADD COLUMN tools_selected INTEGER DEFAULT 0` and `CREATE TABLE IF NOT EXISTS nav_guard (...)`. Reserve the drop/rebuild path for schemas older than v2. The migration is idempotent (ALTER guarded by column presence, CREATE IF NOT EXISTS).

**(a) Guard events - new `nav_guard` table.** Written from the `tool_call` hook at decision time, via `telemetry.recordGuard({ session_id, ts, action, pattern_kind, reason })`, called immediately after `decideGrepAction` and before returning the block/allow response. Columns: `session_id`, `ts`, `action` (`block` | `warn` | `allow_fallback`), `pattern_kind` (`symbol` | `regex`, NULL when the command is unparseable), `reason`. No raw command text - pattern kind and reason only, consistent with the paths-not-contents privacy posture.

  **Mapping to existing `GrepAction`.** `GrepAction` returns `action: "allow" | "block"` with an optional `warn?: boolean` - there is no native `allow_fallback`. The telemetry `action` column derives:
  - `block` <- `action === "block"`.
  - `warn` <- `action === "allow" && warn === true` (scan-ish but not blocked).
  - `allow_fallback` <- allow emitted because navigator is inactive / rg unavailable (the fallback-path allow), carrying its reason.

**(b) Session availability - `nav_session` gains `tools_selected` (0/1).** Written **unconditionally** in `before_agent_start`, regardless of whether `navigator_locate` is present: `1` if `selectedTools.includes("navigator_locate")`, else `0`. Semantics: "was `navigator_locate` in `selectedTools` at the first agent start of this session" (subsequent restarts overwrite). `ensureSession` gains a `toolsSelected: boolean` parameter and upserts the column. The `0` path is the load-bearing signal - it splits the bypass metric into *unavailable* (tooling/whitelist problem) vs *available-but-bypassed* (guidance problem) - so it must be written even when the tool is absent.

**(c) Search precision - `detectSearch` becomes pipeline-aware.** A grep/rg in a non-first pipe segment is a filter, not a search - excluded from `nav_consume.kind = 'search'`. First-segment and standalone search commands keep current behavior.

**Consumers:** `/navigator stats` adds guard-fire counts and the availability split. `scripts/export-cases.ts` and the usefulness-judge skill export the new fields; old exports remain readable. Pre-v3 rows are not corrected; analysis treats them as lower-confidence.

### M4 — Shared repo identity

`resolveRepo()` (`src/worktree.ts`): `repoName` derives from the **main worktree** - resolve `git rev-parse --git-common-dir`, take its parent directory's basename. Main checkout: result unchanged. Linked worktrees and `.worktrees/<branch>` checkouts: resolve to the main checkout's name. `repoId` (root-commit sha) is already shared, so both `<name>_<id>.db` and `<name>_<id>.telemetry.db` collapse to one file pair per repo.

- **Lock model unchanged but now meaningful across worktrees.** Writer-lock election already arbitrates concurrent sessions on one DB file; previously each worktree had its own file so cross-worktree contention never occurred. Now it does, by design. Non-holders stay read-only.
- **Accepted trade-off:** index content reflects the lock-holder's worktree. A session on a divergent branch gets ranking from a slightly different tree. Safe because slices always read live bytes from the active worktree (invariant), and the M1 `indexedHead != HEAD` caveat tells the model ranking may lag. Clients on a non-canonical branch must not infer file contents from locate results; they MUST read live bytes via `navigator_slice` or direct read before editing. Per-worktree index forks are explicitly rejected - that is the duplication being removed.
- **Edge cases:** bare main repo - detect via `git rev-parse --is-bare-repository`; on `true`, fall back to `basename(git rev-parse --git-dir)` (the bare repo directory name) rather than the common-dir parent. On any parse error, fall back to the existing `basename(root)` behavior. Non-git cwd - dormant, unchanged.
- **Migration:** none in code. Old per-worktree DB files become inert; deleted manually post-release. NAVIGATOR.md documents the naming rule; the AGENTS.md invariant "all worktrees share one index" becomes true.

### M5 — Docs and environment prerequisite

- NAVIGATOR.md: naming rule (M4), guidance model (M1), guard posture (M2).
- README: environment prerequisite - user-global agent-instruction files must not hardcode search-tool preferences (e.g. "prefer rg/fd"); navigator guidance owns search-tool routing where it is installed. Plus an optional per-repo AGENTS.md snippet for repos that want a native navigator line:

  > Repo orientation: prefer `navigator_locate` for finding where code or docs live before broad rg/find/read; use rg/fd for regex or content scans, and as fallback when navigator is unavailable.

## 4. Edge Cases

- **Worker booting on first prompt.** Persona + weak directive + booting caveat fire. Tools return the existing terminal "booting" message if called too early; the caveat pre-arms a single retry.
- **Dirty repo / HEAD drift.** Strong directive still fires when coverage/crawl threshold is met; lag caveat appended. Never suppression.
- **Coverage below 0.9 or crawl incomplete.** Weak directive with live coverage percentage.
- **`navigator_locate` not in `selectedTools`.** No injection (correct - the tool is absent). Session recorded with `tools_selected = 0`.
- **Exact path in prompt.** Directive suppressed, persona retained.
- **`grep -n pat file` inside `$(...)`.** Allowed (the observed false positive).
- **`grep -r pat src/`.** Still blocked with redirect message (no regression).
- **Multiple worktrees concurrently active.** One lock holder writes; others read-only against the same DB. Lock self-heal behavior per `2026-06-03-writer-lock-self-heal.md` is unchanged.
- **Worktree on a branch whose files diverge from the indexed tree.** Locate may rank against the holder's tree; slice reads the active worktree's live bytes; caveat informs the model.
- **Telemetry DB shared across worktrees.** Sessions from all checkouts land in one telemetry DB - intended; per-session rows already carry session identity.

## 5. Testing Approach

Unit tests (`node --test`, colocated `*.test.ts`):

- `prompt-guidance.test.ts`: injection present for every index state (booting / partial / dirty / HEAD-drift) when the tool is selected; absent when not selected; strong/weak tier boundary at `coverage >= 0.9 && fullCrawlDone`; each caveat line keyed to its fact; exact-path suppression retained; `persona` / `promptNudge` opt-outs.
- `grep-guard.test.ts`: the observed single-file false positive (file arg, command substitution); directory-arg scans still blocked; `-r <file>` allowed; multi-statement and substitution contexts; stat-failure falls through to allow; no regressions on existing block matrix.
- telemetry tests: v2 -> v3 migration idempotency; `nav_guard` rows written on block/warn; `tools_selected` set from both branches; `detectSearch` pipe-segment matrix (`ps aux | grep x` excluded, `grep -r x .` and `rg x` counted).
- `worktree.test.ts`: main checkout, linked worktree, and `.worktrees/` checkout resolve identical `dbPath`; bare-repo and non-git fallbacks.

Integration (manual, post-merge): load the extension in a linked worktree of a multi-worktree repo; `/navigator status` shows the shared DB; second session in another worktree reads while the first holds the lock.

CI unchanged: `npm run typecheck` + `node --test`.

## 6. Success Measurement

Re-pull telemetry after 2-3 days of real sessions post-release (the v3 fields make this trustworthy):

- Availability split visible: `tools_selected` separates unavailable from bypassed sessions.
- Among **available** sessions, locate adoption materially above the ~3% baseline; target >30% of orientation-bearing sessions issue at least one locate.
- Guard fire counts nonzero; zero false-positive reports.
- Exactly one index DB per `repoId` in the cache dir for repos worked via worktrees.
- Search totals no longer inflated by pipe filters; search:slice ratio becomes a meaningful trend line.

Targets, not gates. If available-session adoption stays low after this spec plus the companion subagent spec, the next investigation is prompt salience (placement/ordering), not gating.

## 7. Open Questions

None blocking. The 0.9 coverage threshold for the strong tier is a tunable constant; the spec fixes the mechanism, not the exact value.

## 8. Residual Risks

- **Environment instruction conflict (out of navigator's control).** User-global or project `AGENTS.md` files that hardcode "prefer rg/fd" without a navigator mention will suppress adoption regardless of guidance injection; navigator cannot detect or override these. The known instance was removed at source during brainstorming (M5), but the class recurs whenever a new environment file is added. If the post-release adoption target is missed, re-audit environment-level instruction files before tuning the mechanism.
