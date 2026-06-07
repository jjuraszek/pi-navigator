# Navigator Prompt Guidance

## Context

Navigator is intended to reduce the cost of repository orientation: before an agent fans out into `rg`, `find`, and broad `read` calls, it can call `navigator_locate` once to get ranked entry points, co-change neighbours, and referrers. GridStrong telemetry shows this is not happening often enough. In the sampled telemetry, only a small fraction of sessions used `navigator_locate`, while many sessions used filesystem search or direct reads.

The raw bypass rate overstates the problem because many prompts legitimately start elsewhere: skill workflows may require `phase_tracker`, exact-path prompts should use `read`, GitHub/Linear-only prompts may start with external fetches, and regex scans are still better served by `rg`. The remaining issue is initial repo-orientation prompts that do not literally say “where is X?” Examples include “review this ticket”, “investigate why”, “what needs changing”, or “fix support for X”. Those requests often imply code/document discovery, but the current prompt guidance is too phrase-triggered and passive to reliably cause a first `navigator_locate` call.

This spec changes navigator guidance from optional, user-configured persona injection into built-in extension behavior. If navigator is enabled, fully indexed, current for the repo, and the working tree has no unindexed changes, the extension adds a small system-prompt cue that tells the model when to use `navigator_locate`. For broad prompts, it adds one stronger request-specific nudge. The behavior remains soft: no tool interception, no blocking, and no attempt to replace `rg` for regex/full-content scans.

## Goals

- Increase `navigator_locate` usage for broad repo-investigation prompts.
- Keep guidance low-intrusion: a short system-prompt cue, not a tool policy.
- Only guide the model toward navigator when the index is proven complete, current, and clean relative to the active worktree.
- Prefer recall over strict precision for broad repo-orientation prompts.
- Remove prompt-guidance configuration burden. Including/enabling the package brings the behavior.
- Preserve legitimate direct `read`, `rg`, Git/GitHub/Linear, and skill-workflow starts.
- Make the readiness and classifier rules testable without booting a live Pi session.

## Non-goals

- Blocking, rewriting, or warning on tool calls.
- Forcing `navigator_locate` as the first tool in every session.
- Replacing `rg` for exact regex, symbol-name, or full-content scans.
- Adding a new user-facing config matrix for prompt guidance.
- Keeping backward compatibility for `navigator.injectPersona`.
- Building a machine-learning classifier for prompt intent.
- Treating the index as source-of-truth file contents. `navigator_slice` still reads live worktree bytes.

## Design

Navigator prompt guidance will be generated inside the existing `before_agent_start` integration path. The hook runs for each submitted prompt, so the classifier is evaluated per prompt rather than only once per process or session. The extension appends guidance only after it proves navigator is ready for the current repo and `navigator_locate` is available in the selected tool set.

There are two layers of guidance:

1. **Baseline persona text** from `prompts/navigator-persona.md`.
   - This is one short sentence.
   - It says that when a task requires finding code or docs and no exact path is already known, the model should call `navigator_locate` once before broad `rg`/`find`/`read` exploration.
   - It explicitly preserves `rg` for regex and full-content scans.

2. **Conditional prompt nudge** generated for broad repo-orientation prompts.
   - Example text: `This request likely needs repo orientation. If no exact path is already known, call navigator_locate once before rg/find/read.`
   - The nudge is additive. The persona describes the general behavior; the nudge tells the model that the current prompt appears to be such a case.
   - The nudge is non-authoritarian. It does not say “must” or imply that later `rg` use is wrong.

The old `navigator.injectPersona` switch will be removed from active behavior. Stale `navigator.injectPersona` settings in user config are ignored once this design lands, and docs should stop presenting persona injection as optional. This project currently has one primary user, and enabling navigator means accepting navigator’s prompt guidance. If a future need for an escape hatch appears, it can be designed from observed failures rather than carried forward preemptively.

## Readiness gate

Prompt guidance must only appear when navigator is actually ready. The extension fails quiet when readiness cannot be proven.

The readiness predicate is true only when all of the following are true:

- The current cwd resolves to a git repository.
- The navigator DB for that repo opens successfully.
- `navigator_locate` is present in `event.systemPromptOptions?.selectedTools`.
- `coverage.total > 0`.
- `coverage.indexed === coverage.total`.
- `full_crawl_done === "1"` in DB metadata.
- `head_sha_at_index === headSha(root)`.
- The active worktree is clean according to a non-interactive git status check.
- The main process has no known worker failure state such as `rolling.workerFailed`.

If any condition fails, neither the persona nor the conditional nudge is appended. The user-facing explanation belongs in `/navigator status`, not in the prompt. The tool can still be registered; if a model calls it manually while the index is incomplete or stale, the existing tool response explains the condition.

The clean-worktree requirement closes the gap where `head_sha_at_index` matches `HEAD` but local edits or untracked eligible files are not reflected in the DB. It is intentionally strict because this feature is only guidance. Suppressing guidance in dirty worktrees is better than teaching the model to rely on an index that may not include the file state it is about to inspect.

This strict gate preserves trust. A partial, stale, or dirty index is worse than no nudge because it teaches the model to rely on incomplete orientation.

## Hook integration

`index.ts` remains the integration boundary because it already owns extension lifecycle state, repo resolution, DB setup, worker coordination, and `before_agent_start` registration.

The hook should use the live Pi extension event shape:

- Read the submitted prompt from `event.prompt`.
- Read selected tools from `event.systemPromptOptions?.selectedTools`.
- Append text to the chained system prompt through the same mechanism currently used for persona injection.

The hook flow is:

1. Receive `before_agent_start`.
2. Check whether `navigator_locate` is selected.
3. Resolve current repo state and open/read DB facts.
4. Evaluate the strict readiness predicate.
5. If readiness is false, return without prompt changes.
6. Append baseline persona text.
7. Evaluate the prompt classifier against `event.prompt`.
8. Append the conditional nudge when the classifier returns `likely_orientation`.

All readiness exceptions are caught and treated as `not_ready`. No warning or diagnostic text is injected into the prompt.

## Prompt classifier

The conditional nudge uses a simple, permissive decision tree. The aim is higher recall, not perfect classification.

Decision order:

1. Normalize the prompt to lowercase text while preserving path punctuation for path detection.
2. If the prompt is external-only, return `skip_nudge`.
3. If the prompt contains an exact local path target, return `skip_nudge`.
4. If the prompt contains broad repo-orientation language, return `likely_orientation`.
5. If the prompt mentions an issue/ticket/PR and asks for implementation, review, fix, or actionable code changes, return `likely_orientation`.
6. Otherwise return `skip_nudge`.

### Exact local path detection

Treat these as exact local path targets:

- Slash paths: `src/foo.ts`, `doc/specs/x.md`, `app/models/user.rb`.
- Relative paths: `./src/foo.ts`, `../gridstrong/app/foo.rb`.
- Path plus line/column suffixes: `src/foo.ts:42`, `app/foo.rb:10:2`.
- Known source/doc filenames when used as file targets: `foo.ts`, `foo.test.ts`, `README.md`, `AGENTS.md`, `package.json`.
- Quoted or backticked variants of the above.

Exact-path detection suppresses only the conditional nudge. In a ready repo, the baseline persona still appears.

Do not treat vague symbols, class names, feature names, domain terms, ticket IDs, or PR numbers as exact paths.

### External-only detection

Treat prompts as external-only only when they ask for work that does not imply repo inspection:

- Summarize or fetch a URL.
- Check GitHub PR comments without asking for code impact.
- Report git branch/status/log information only.
- Send or inspect Slack messages.
- Query an external service without tying the result to implementation.

Mentions of Linear, GitHub, or PRs do not automatically suppress the nudge. Prompts such as “review Linear E-1935 and identify implementation changes” or “look at this PR and see what code needs to change” are repo-orientation prompts.

### Broad trigger language

Treat prompts as likely repo orientation when they include broad investigation or change language without an exact local path:

- “investigate why navigator is rarely used in gridstrong”
- “review Linear E-1935”
- “what needs changing to support X?”
- “where is fleet readiness implemented?”
- “fix the heatmap behavior”
- “add support for X”
- “look into this behavior”
- “is this actionable?”
- “explain how X works”
- “find where X is handled”

Skill-heavy sessions may receive the nudge even though the first required tool is something else. That is acceptable because the nudge is soft and can influence the next repo-orientation step after the skill-mandated action completes.

## Components

### `prompts/navigator-persona.md`

Rewrite the prompt to be a compact repo-orientation rule rather than a phrase-specific reminder. It should be short enough to be cheap in every ready repo session.

Proposed content:

```md
Repo orientation rule: when a task requires finding code/docs and no exact path is already known, call `navigator_locate` once before broad `rg`/`find`/`read`; use `rg` for regex or full-content scans.
```

### `index.ts`

Responsibilities:

- Determine whether `navigator_locate` is available in `event.systemPromptOptions?.selectedTools`.
- Run the strict readiness gate.
- Append the baseline persona when ready.
- Classify `event.prompt`.
- Append the conditional nudge when ready and likely orientation.
- Fail quiet on readiness errors.

### Prompt-guidance helper

Add a small helper module or local helper functions to keep regex/classification/readiness logic testable and out of the hook body.

Suggested functions:

- `isNavigatorPromptGuidanceReady(context): boolean`
- `classifyNavigatorPrompt(prompt: string): "likely_orientation" | "skip_nudge"`
- `hasExactLocalPath(prompt: string): boolean`
- `isExternalOnlyPrompt(prompt: string): boolean`
- `buildNavigatorPromptGuidance(prompt: string, persona: string, readiness: Readiness): string[]`

The exact function signatures can be adjusted during implementation, but classifier, readiness, and prompt assembly behavior need direct unit coverage.

### `src/config.ts`

Remove `injectPersona` from `NavigatorConfig`, defaults, and config behavior. If the parser continues to accept unknown config keys, stale `navigator.injectPersona` values can be ignored without throwing. Tests should assert that prompt guidance is no longer gated by `injectPersona`.

### Documentation

Update README/NAVIGATOR documentation where they describe persona injection or optional prompt configuration. The docs should explain:

- Navigator adds a small system-prompt guidance line when the repo index is complete, current, and clean.
- Broad repo-orientation prompts get an additional soft nudge.
- The guidance is soft and does not block tool choices.
- `rg` remains the right tool for exact regex/full-content scans.
- `/navigator status` is the place to inspect readiness.
- `navigator.injectPersona` is no longer a supported behavior switch.

## Error handling and edge cases

Readiness failures do not surface in the system prompt. Prompt guidance is simply absent. This avoids making every session carry operational state and prevents the model from spending turns explaining navigator availability.

If the DB cannot be opened, metadata is missing, coverage values are unknown, the repo is outside git, the selected tool set is unavailable, or the worker has failed, the result is no guidance. If the worker has not yet reported coverage but the DB metadata proves a complete current crawl and the worktree is clean, guidance may be appended. The readiness check should prefer live DB facts over waiting for in-memory worker messages.

A broad prompt with an exact path receives the baseline persona when ready, but not the conditional nudge. This keeps the general behavior available while avoiding a request-specific push away from the known file.

The clean-worktree gate may suppress guidance during active implementation sessions. That is acceptable for the first version because the feature’s purpose is initial orientation, and stale guidance is more harmful than absent guidance. Telemetry can later justify a more precise dirty-file freshness model if needed.

## Testing

Add unit tests for the prompt classifier:

- Broad prompts return `likely_orientation`.
- Exact local-path prompts return `skip_nudge`.
- External-only prompts return `skip_nudge`.
- Linear/GitHub prompts that ask for implementation review return `likely_orientation`.
- PR-comment-only and branch/status-only prompts return `skip_nudge`.

Add unit tests for readiness:

- Complete coverage, `full_crawl_done === "1"`, matching HEAD, clean worktree, selected `navigator_locate`, and no worker failure returns ready.
- Incomplete coverage returns not ready.
- `coverage.total === 0` returns not ready.
- Missing or false `full_crawl_done` returns not ready.
- Stale indexed HEAD returns not ready.
- Dirty worktree returns not ready.
- Missing selected `navigator_locate` returns not ready.
- DB/meta read errors return not ready.
- Worker failure returns not ready.

Add prompt-assembly tests with mocked hook events and mocked readiness facts:

- Ready repo + active `navigator_locate` + broad prompt appends persona and nudge.
- Ready repo + active `navigator_locate` + exact path appends persona only.
- Incomplete coverage appends neither persona nor nudge.
- Stale indexed HEAD appends neither persona nor nudge.
- Missing `navigator_locate` appends neither persona nor nudge.
- Readiness error appends neither persona nor nudge.
- Stale `navigator.injectPersona: false` config does not suppress guidance.

Run existing verification:

```bash
npm run typecheck
node --test
```

A manual check after implementation should start a local Pi session in a fully indexed clean repo and confirm that broad prompts include both prompt cues while exact-path prompts include only the baseline persona.

## Success measurement

Use telemetry to validate the change after it has run in GridStrong-like sessions.

Measure:

- Lift in `navigator_locate` usage for broad repo-orientation prompts.
- First repo-navigation action after broad prompts: `navigator_locate` versus broad `rg`/`find`/`read`.
- False-positive nudges on exact-path, external-only, git/status-only, and PR-comment-only prompts.
- Whether locate calls from nudged prompts produce consumed results or immediate fallback.
- Whether dirty/incomplete readiness suppression explains missed opportunities.

A useful first target is that broad repo-orientation prompts reliably get at least one early `navigator_locate` call when readiness is true, while exact-path and external-only prompts avoid the conditional nudge.

## Success criteria

- Broad repo-orientation prompts get a `navigator_locate` nudge when the index is ready.
- Exact-path and external-only prompts avoid the conditional nudge.
- Prompt guidance is absent when the index is incomplete, stale, dirty, unavailable, or not selected.
- `navigator.injectPersona` no longer gates prompt guidance.
- No new prompt-guidance config is required.
- Existing tests pass, and new tests cover readiness, classifier, and prompt assembly behavior.
