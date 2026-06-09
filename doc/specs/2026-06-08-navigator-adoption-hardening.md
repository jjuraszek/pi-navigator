# Navigator Adoption Hardening

Status: Draft (awaiting review)
Supersedes the readiness model in `doc/specs/2026-06-07-navigator-prompt-guidance.md` (extends, does not replace, that spec's classifier).

## 1. Problem & Evidence

Telemetry across `~/.pi/pi-navigator-cache/*.telemetry.db` shows ranking/recall are fine but **invocation is near-zero outside the author's own repo**.

gridstrong (175 sessions, Jun 4–8, navigator pinned at v0.7.0 with prompt guidance):

| metric | value |
|---|---|
| sessions | 175 |
| `navigator_locate` calls | 7 (in 6 sessions) → **96.6% session bypass** |
| native searches | 1265 (grep 594 > rg 490 > find 103 > fd 38 > ls 38) |
| native reads | 413 |
| `navigator_slice` | 4 |

Cross-repo: locates/slices are only meaningful in `pi-navigator` (own repo: 11 locates, 47 slices vs 40 reads). Every other repo, including worktrees where this guidance was being *built*, shows 0 organic locates.

When locate **is** invoked it works: 5 of 7 led to a consumed ranked result; 4 were high-confidence rank-1/2 direct hits with useful co-change clusters. **Recall is not the bottleneck; reaching the tool is.**

Two root causes:

1. **Guidance self-suppresses exactly where it's needed.** `buildNavigatorPromptGuidance` returns `[]` whenever `isNavigatorPromptGuidanceReady` is false, and that gate fails on any dirty tree or any HEAD lag. Busy repos (gridstrong) are almost always dirty → the persona *and* the nudge never fire. Only the static tool description survives, which is why v0.7.0 showed no adoption lift.
2. **Locate-then-flail and native-first search habit.** Even after a rank-1 hit, sessions fire 20–30 greps. `grep` (594) outranks `rg` (490) — grep is slow and not gitignore-aware.

## 2. Goals / Non-Goals

**Goals**

- Raise organic `navigator_locate` invocation in real (dirty, evolving) working repos.
- Suppress the redundant rg/fd/read re-search loop *after a high-confidence hit*, without removing the fallback path.
- Eliminate slow repo-scanning `grep`, redirecting to `rg` / `navigator_locate`.
- Keep all new pressure honest: never push locate-first harder than the index's actual trustworthiness.

**Non-Goals**

- No `rank.ts` weight changes. n=7 invocations is far too small to justify ranking tuning.
- No removal of the rg/fd/read fallback loop. Fallback stays fully legal.
- No new persona persistence/state machine; no stateful "next command" enforcement.
- No change to walk/index/secret invariants.

## 3. Design

Four independent mechanisms. Each is on by default with a `navigator.*` opt-out.

### M1 — Two-tier prompt guidance (decouple persona from nudge)

Today one readiness gate governs both lines. Split into two tiers in `src/prompt-guidance.ts`:

- **Persona tier (usable-index gate).** Fire the persona whenever the index is *usable*:
  `repoResolved && selectedTools.includes("navigator_locate") && coverage.indexed > 0 && !workerFailed`.
  **Not** gated on `dirty`, `indexedHead === currentHead`, **or `fullCrawlDone`**. Requiring `fullCrawlDone` would silence the persona in a partially-indexed *active* repo — the exact dirty/evolving case the spec targets — so the gate keys on "at least one file indexed" (`coverage.indexed > 0`), not crawl completion. The persona is a non-asserting orientation rule (see wording below); it stays true even when the index lags, so silence is the worst outcome and is removed.
- **Nudge tier (fresh-index gate).** Keep the existing strict `isNavigatorPromptGuidanceReady` (coverage complete, head matches, not dirty, worker healthy) for the per-prompt `NAVIGATOR_PROMPT_NUDGE`, which is freshness-asserting ("call locate first"). The existing `classifyNavigatorPrompt` orientation classifier continues to gate *which* prompts get the nudge.

Persona wording is rewritten to be non-asserting (orientation, not a freshness claim). Target ~25 words, e.g.:

> A repository index (`navigator_locate` / `navigator_slice`) is available. Prefer it for first orientation — finding where code or docs live, co-change, and referrers. Slices read live working-tree bytes; the ranking index may lag recent edits, so verify with rg/fd/read when a result looks stale.

The "may lag … verify" clause is what makes always-on safe: it is the persona-tier caveat, replacing the all-or-nothing silence.

`buildNavigatorPromptGuidance` becomes (config opt-outs threaded explicitly):

```
guidance = []
if config.persona and personaUsable(readiness):      # coverage.indexed > 0 && !workerFailed && tool selected
    guidance.push(persona)
if config.promptNudge and isNavigatorPromptGuidanceReady(readiness) \
        and classify(prompt)=="likely_orientation":
    guidance.push(NAVIGATOR_PROMPT_NUDGE)
return guidance
```

### M2 — Adaptive strong-hit directive in locate results (+ system-prompt reinforcement)

A result-text advisory alone is a weak signal — telemetry shows agents read the existing low-confidence line and still fire 20–30 greps after a rank-1 hit. M2 therefore acts on **two surfaces**:

**(a) Locate result directive.** In `src/tools.ts` locate renderer (gated on `config.strongHitDirective`), add a directive line scaled to the signals locate already computes:

- **Strong hit** — `has_exact_def && top_has_anchor`:
  append `"  [high-confidence exact match — slice rank 1 directly; re-running rg/grep/read to re-find this is redundant]"`.
- **Low hit** — existing `confidence === "low"` line is unchanged (already advises fallback).
- **Neutral** — no directive.

The condition is `has_exact_def && top_has_anchor` (not a three-way conjunction): `has_exact_def ⇒ confidence === "high"` by current derivation, so the `confidence` check is redundant and `top_has_anchor` is the non-redundant discriminator. A code comment records this implication so the test isn't read as relying on coincidence. Strong-hit and low lines stay mutually exclusive; the test asserts this on the two-condition predicate rather than the implication.

**(b) `promptGuidelines` reinforcement.** Augment `navigator_locate`'s `promptGuidelines` (system-prompt surface) with: *"When navigator_locate returns a high-confidence exact match (has_exact_def + top_has_anchor), use navigator_slice on the rank-1 result directly — re-running rg/grep/read to re-find the same symbol is redundant."* This puts the directive in the system prompt, not only the per-call result, which is where the flail habit must be overridden.

Both are advisory; neither blocks.

### M3 — shell-grep block via `tool_call` hook

**Scope: bash shell `grep` only.** Ground-truth correction (writing-plans phase): pi's **built-in `grep` tool is already ripgrep-backed** (`dist/core/tools/grep.d.ts`: "Default: local filesystem plus ripgrep"), so it is not slow and is **not** blocked. The "grep is slow" rationale applies solely to shell GNU/BSD `grep` invoked through bash. Adoption pressure toward `navigator_locate` is M1/M2's job, not a reason to block a fast first-class tool. The telemetry breakdown that suggested two sources mixes `correlator.ts` `case "grep"` (built-in tool) with `detect.ts`'s bash-command regex (shell grep); only the latter is the slow target.

Register a `pi.on("tool_call")` handler in `index.ts` (gated on `config.grepBlock`), `isToolCallEventType("bash", event)`. Classify `event.input.command`. Block (return `{ block: true, reason }`) **only** the repo-scanning shell-grep form:
- a `grep` invocation **not** downstream of a pipe (not `… | grep`) and **not** reading from stdin, AND
- has a **recursive flag** (`-r`/`-R`/`--recursive`) **OR** a path argument that resolves to a **directory** (e.g. `src/`, `.`).

**Single explicit file arguments are always allowed** (`grep foo src/file.ts`, `grep foo package.json`) — a targeted single-file read is a legitimate fallback shape, not the slow repo scan we forbid. Leave untouched: `… | grep`, stdin grep, `git grep` (already fast/tracked-aware), `grep --help`/version, and grep inside a subshell feeding a pipe. When uncertain, **allow** — false negatives (a slow grep slips through) are cheaper than false positives (breaking a legit command).

**Activation guard.** The block must never push locate-first harder than the index's trustworthiness (§2). Skip blocking entirely — allow the command — when `config.enabled` is false, `config.grepBlock` is false, the repo is non-git, navigator state is not ready/booting, or `navigator_locate` is not in the selected tool set. When navigator is unavailable, the reject path is disabled; we never tell the model to use a tool it doesn't have.

**Intent-aware reject message** (only emitted when navigator is active and a block is decided):
- pattern looks like a symbol/identifier (single token, word-chars, no regex metachars) → point at `navigator_locate`.
- otherwise → point at `rg` with the equivalent invocation shape.

When navigator is inactive (per the activation guard) the block is skipped entirely — the command is allowed, never redirected. We do not block on slowness alone in a repo where we can't offer the index as the alternative; this keeps the mechanism strictly an adoption lever, never a bare restriction.

**rg-presence guard.** Declare module-scope `let rgAvailable: boolean | undefined` and `let rgWarnedOnce = false` in `index.ts`. On first relevant `tool_call`, resolve `rgAvailable` via `command -v rg`. If `rg` is absent: never hard-block; emit exactly one `ctx.ui.notify("rg not found — navigator grep block degraded to warn-only; install ripgrep", "warn")` (guarded by `rgWarnedOnce`), and allow the command. `before_agent_start` guidance cannot be used here because `tool_call` fires after it. README lists `rg` as a prerequisite (M4).

### M4 — Defaults, config, README

`NavigatorConfig` in `src/types.ts` gains **four new optional boolean fields**; `mergeConfig` in `src/config.ts` adds a validation/coerce branch for each (default `true`, same pattern as existing booleans). All default `true`:

| key | default | controls |
|---|---|---|
| `persona` | `true` | M1 persona tier (always-on orientation line) |
| `promptNudge` | `true` | M1 nudge tier (fresh-gated per-prompt nudge) |
| `strongHitDirective` | `true` | M2 locate result directive |
| `grepBlock` | `true` | M3 shell-grep block (bash only; degrades to warn-only when rg absent) |

**`injectPersona` is already filtered out as a stale/unknown key** by the existing `mergeConfig` (config tests assert unknown keys are dropped) — there is no live `injectPersona` to migrate. `persona`/`promptNudge` are net-new knobs, not renames; no deprecation-mapping shim is needed. The CHANGELOG notes the new keys. Unknown-key filtering behavior is unchanged and a config test continues to assert it.

Each opt-out is honored at its mechanism's read site (threaded through the §3 pseudocode): `config.persona`/`config.promptNudge` in `buildNavigatorPromptGuidance`, `config.strongHitDirective` in the locate renderer, `config.grepBlock` in the `tool_call` handler.

README gains a **Prerequisites** section: `rg` (ripgrep) required on PATH; navigator uses it as the sanctioned search tool and the grep block redirects to it.

## 4. Edge Cases

- **rg missing.** M3 degrades to warn-once (`ctx.ui.notify`), never blocks; M1/M2 unaffected. README prereq documents it.
- **Navigator inactive (non-git / disabled / booting / tool unselected).** Grep block is skipped entirely; commands pass through unmodified. Persona/nudge already require `navigator_locate` selected.
- **Partially-indexed active repo (`fullCrawlDone === false`, `coverage.indexed > 0`).** Persona fires (this is the case the blocker fix unlocks); nudge stays silent until the fresh gate passes.
- **Dirty repo.** Persona fires (with lag caveat); nudge stays silent. Slices still read live bytes (invariant unchanged).
- **Built-in `grep` tool (rg-backed).** Never blocked — it is not slow; only shell grep through bash is in scope.
- **grep on a single explicit file.** Always allowed.
- **grep in a pipe / git grep / stdin grep.** Always allowed.
- **grep with exotic flags rg lacks.** Allowed if it doesn't match the repo-scan signature; if it does and the user truly needs grep, the `navigator.grepBlock=false` opt-out exists.
- **Non-orientation prompt while index is fresh.** Persona fires; nudge suppressed by `classifyNavigatorPrompt` (unchanged).
- **Tool not selected.** Both tiers already require `selectedTools.includes("navigator_locate")`.

## 5. Testing Approach

- `src/prompt-guidance.test.ts` — new cases: persona fires when dirty/behind but `coverage.indexed > 0`; persona fires when `fullCrawlDone === false` as long as `coverage.indexed > 0`; persona suppressed when `coverage.indexed === 0` / worker failed / tool unselected / `config.persona === false`; nudge still requires the full fresh gate and `config.promptNudge`. Add `personaUsable` unit coverage.
- `src/tools.test.ts` (locate render) — strong-hit directive present iff `high && has_exact_def && top_has_anchor`; mutually exclusive with low-confidence line; neutral emits neither.
- New `src/grep-guard.test.ts` (pure `decideGrepAction` extracted from the hook) — block matrix over bash command strings: `grep -r x src/` and `grep x .` (directory) → block; `grep x src/file.ts` (single file), `ps|grep`, `grep x` (stdin), `git grep x`, `cat f|grep x`, `grep --help` → allow; symbol-pattern → locate message, regex-pattern → rg message. Navigator-inactive (`navigatorActive=false`) → allow regardless of command shape. rg-absent (`rgAvailable=false`) on a repo-scan → `{ action: "allow", warn: true }` (caller emits warn once). (No built-in `grep` tool branch — out of scope.)
- `src/config.test.ts` — new keys default true, validate/coerce, opt-out respected, unknown keys still filtered.
- Manual: load via `pi -e`, `/navigator status`, confirm persona appears in a dirty repo and a repo-scan grep is rejected.

## 6. Success Measurement (telemetry)

Re-pull the same telemetry after rollout in an active repo. Targets, not gates:

- Session bypass rate (sessions with consumes but no locate) drops materially from 96.6%.
- `navigator_slice` / native `read` ratio rises off the floor.
- Native `grep` repo-scans → ~0 (blocked); rg becomes the dominant native search.
- locates/day rises with dirty-repo sessions now receiving persona guidance.

n stays too small for `rank.ts` changes; this spec is strictly about adoption and search-habit redirection.

## 7. Open Questions

None blocking. Wording of the persona line is final-pass-tunable but does not change the design.
