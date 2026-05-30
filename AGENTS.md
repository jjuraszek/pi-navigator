# pi-navigator — Agent Instructions

## Project Overview

pi-navigator is a pi coding-agent extension. It maintains a worktree-aware, self-updating repository index that speeds the **find → read → update** loop.

**What it provides:**
- `navigator_locate(query)` — ranked entry points (FTS + symbol + path + recency) with a co-change/referrer cluster in one call.
- `navigator_slice(path, symbol|range)` — exact current working-tree bytes + content hash (edit-ready, worktree-aware).
- `/navigator status|reindex` — in-session commands.
- **Rolling background indexing** — a `worker_thread` derives a resumable backlog from DB state and indexes off-thread; no CLI, no manual step.

**The thesis:** the agent loop has two cost phases — *find/orient* (many exploratory `rg`/`read` calls) and *read-to-verify* (opening real bytes before editing). The index collapses phase 1 into one lookup; it makes phase 2 cheaper (smaller slices, hash-verified, non-repeating) but never replaces it.

**Storage:** `node:sqlite` (FTS5, WAL) at `~/.pi/pi-navigator-cache/<repo_name>_<repo_id>.db`. The DB stores no file contents — only paths, symbols, offsets, and hashes.

---

## Communication Style

**Suppress process narration. Never output:**
- Intent classification ("I detect X", "My approach: …")
- Phase/routing announcements before acting
- Tool/subagent preamble ("I'll delegate this…", "Let me start by…")
- Status narration ("I'm working on…", "Now I'll…")
- Preamble pleasantries ("Great question!", "Happy to help")
- Restatement of what was just done — the diff/output speaks for itself

**Output instead:**
- **Outcomes:** what changed, what was found, what the answer is
- **Decisions needing user input:** concerns, ambiguities, options
- **Verification results:** test/build output, diagnostics, errors
- **Blockers:** failures or decisions required to proceed

**Format:**
- Bullets over prose. Short paragraphs.
- No wall-of-text. No educational tone or tutorials unless asked.
- End on the ask, not a summary.

**Human-facing artifacts (PR/issue comments, chat replies):**
- Match the recipient's register. Read the thread first. Casual → casual.
- No scaffolding templates. Skip `**Options**:` / `**Recommendation**:` / "TL;DR:" headers on short comments.
- No headings on short comments. A 3-sentence reply doesn't need `## Section` structure.
- Word budget: under ~100 words unless content genuinely needs more.

**Exception — LLM-readable artifacts stay structured.** The human-facing rules above do NOT apply to:
- `AGENTS.md`, `README.md`, specs, plans, design docs
- API contracts, schema docs, runbooks
- Skill files, agent definitions, prompt libraries
- Code comments where the *why* is non-obvious

For these: tables, headings, code blocks, and explicit field references are features. Optimize for unambiguous retrieval over readability.

**Code comments:**
- No comment that restates the next line.
- No commented-out code — delete it.
- No banner/separator comments.

---

## Shell Behavior

pi runs bash **non-interactively** (`bash -c`). No TTY. Anything that waits for input, opens an editor, or invokes a pager **hangs forever**.

**Banned commands (always hang):**
- Editors: `vim`, `vi`, `nano`, `emacs`, `pico`, `ed`
- Pagers: `less`, `more`, `most`, `pg`, `man`
- Bare REPLs: `python`, `node`, `irb` — use `-c` / `-e` flags
- Interactive shells: `bash -i`, `zsh -i`
- Interactive git: `git commit` without `-m`, `git add -p`, `git rebase -i`

**Always pass non-interactive flags:**

| Action | Use |
|---|---|
| npm install | `npm install --yes` |
| git commit | `git commit -m "msg"` |
| git log / diff | `git --no-pager log -n 20`, `git --no-pager diff` |
| rm / cp / mv | `rm -f`, `cp -f`, `mv -f` (never `-i`) |
| curl | `curl -fsSL url` |
| docker run | drop `-it` |
| python / node | `python -c "…"`, `node -e "…"` |

**Search and file finding:**
- Prefer `rg` (ripgrep) over `grep`.
- Prefer `fd` (or `fdfind`) over `find`.
- `rg -l <pattern>` instead of `grep -rl <pattern>`.

---

## Ground Truth Before Reasoning

**Type imports are runtime-erased.** Node 24 strip-types erases `import type` declarations at runtime. Never infer runtime behavior from type-only imports. Use `import type` for `@earendil-works/*` peer deps — they are typecheck-only; the pi runtime provides the actual modules.

**Target `@earendil-works/*`.** The current scope is `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`. The stale `@mariozechner/*` scope is obsolete.

**Verify the live pi extension API** against the installed version before relying on it. Read `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` to confirm hook names, tool registration signatures, and config loading patterns. API shape may drift between pi releases; always check ground truth.

---

## Project Layout

```
pi-navigator/
├── index.ts                    # extension entry: register hooks, tools, commands; own DB handle,
│                               #   spawn/own the worker, hold the verified-cache
├── src/
│   ├── types.ts                # shared interfaces: NavigatorConfig, FileRecord, SymbolRecord,
│   │                           #   LocateResult, SliceResult, WorkerInbound/Outbound
│   ├── config.ts               # loadConfig() from settings.json `navigator` namespace; defaults
│   ├── worktree.ts             # resolveRepo(): root, repoName, repoId, dbPath; headSha()
│   ├── indexer/
│   │   ├── rolling.ts          # main-thread coordinator: writer-lock election, priority enqueue,
│   │   │                       #   spawn + own the worker, expose coverage
│   │   ├── worker.ts           # worker_thread sole writer: derive resumable backlog from DB,
│   │   │                       #   index off-thread, commit per batch
│   │   ├── worker-core.ts      # pure indexing logic: deriveBacklog(), runIndexPass() — testable
│   │   │                       #   without spawning a thread
│   │   ├── walk.ts             # gitignore-aware file enumeration; secret-glob filter; langOf()
│   │   ├── git.ts              # parseLog(), foldSignals(): recency + co-change from git log
│   │   ├── hash.ts             # hashBuffer() (sha-256), isBinary()
│   │   └── symbols.ts          # web-tree-sitter: initParsers(), extractSymbols(),
│   │                           #   extractImports() for ruby/python/ts/js
│   ├── store/
│   │   ├── db.ts               # node:sqlite WAL wrapper; suppress ExperimentalWarning once
│   │   ├── schema.ts           # DDL + idempotent migrate(); SCHEMA_VERSION
│   │   ├── queries.ts          # prepared-statement helpers: upsertFile, replaceSymbols,
│   │   │                       #   upsertCochange, ftsUpsert, setMeta/getMeta, coverage()
│   │   └── vectors.ts          # interface-only seam for future embeddings (not built)
│   └── navigator/
│       ├── locate.ts           # locate(): bm25 FTS + signal fusion + co-change/referrer fan-out
│       ├── slice.ts            # slice(): ground-truth live bytes + hash; stale-index re-extract
│       ├── rank.ts             # score() with transparent constants w_fts/path/symbol/recency
│       └── verified-cache.ts   # VerifiedCache: session Map<absPath, hash>; unchanged detection
├── src/tools.ts                # registerTools(): navigator_locate + navigator_slice with
│                               #   promptGuidelines nudge
├── src/commands.ts             # registerNavigatorCommand(): /navigator status|reindex
├── prompts/
│   └── navigator-persona.md    # optional ~25-word system-prompt line; off by default
├── skills/
│   └── navigator/SKILL.md      # when/how the agent should use navigator tools; examples
├── eval/
│   ├── cases.jsonl             # 10–20 "where do I start" queries → expected file paths
│   └── run.ts                  # hit@k vs rg baseline measurement
├── grammars/                   # committed *.wasm tree-sitter grammars (ruby/python/ts/js)
├── .agents/skills/release/
│   ├── SKILL.md                # how to run the release skill
│   └── scripts/release.sh      # tag-pin release: bump version, CHANGELOG, tag, push
├── doc/
│   ├── specs/                  # source-of-truth spec
│   └── plans/                  # implementation plan
├── AGENTS.md                   # this file
├── README.md                   # human-readable install + six core ideas
├── NAVIGATOR.md                # deep doc: schema, ranking, rolling algorithm, lock model
├── CHANGELOG.md                # newest-first, tag-aligned
├── package.json                # pi manifest (pi.extensions, pi.skills, pi.prompts)
├── tsconfig.json
├── scripts/build-grammars.sh   # copy/rebuild *.wasm from node_modules
├── .gitignore
└── .npmignore
```

---

## Verification Commands

```bash
# typecheck (no emit)
npm run typecheck

# run all tests
node --test

# run a specific test file
node --test src/store/db.test.ts

# load the extension locally for a session
pi -e ~/repos/pi-navigator/index.ts

# confirm indexing is running after load
# (inside a pi session with the extension active)
/navigator status

# force a full rebuild
/navigator reindex
```

CI runs `npm run typecheck` then `node --test` on every push (`.github/workflows/ci.yml`).

---

## Code & Doc Discipline

**Comments:**
- No comment that restates the next line of code.
- No commented-out code — delete it.
- No banner/separator comments.
- Do add comments where the *why* is non-obvious (invariant rationale, algorithm note, etc.).

**Invariants — never violate:**

| Invariant | Why |
|---|---|
| **The DB stores no file contents** | Privacy + freshness. Only paths, symbols, byte/line offsets, and hashes are persisted. Slice content is always read live from disk. |
| **Only the lock holder writes the index** | Prevents duplicate indexing across worktrees, subagents, and concurrent sessions. Non-holders run read-only. |
| **Slices always read the active worktree** | Ground-truth correctness. The index is a navigation approximation; it must never be the source of bytes for an edit. |
| **Secret globs are always ignored** | `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12` are excluded from walk and never sliced. |
