---
name: navigator
description: Use when orienting in a large or unfamiliar repository — finding where something lives (code OR docs), what files change together, or who references a file — before falling back to ripgrep/read.
---

## When to use

- First-contact orientation in a large or unfamiliar codebase — code **or** docs (don't start with `rg`).
- Cross-subproject locate in a monorepo — "which service owns this concept?"
- Relationship discovery: what files change together with a given file (co-change neighbors), and what files import/require it (referrers).
- Reading an exact symbol body instead of fetching a whole file.

**Boundary:** prefer `navigator_locate` to locate code or docs (where is X / where to start / what's related); use `rg` for regex or full-content scans across many files.

## Tools

### `navigator_locate(query)`

Returns ranked files matching the query, fused from full-text search, path/symbol matching, and recency. The top result is expanded into a **cluster**: co-change neighbors (files that historically change together) and referrers (files that import the anchor). One call replaces several rounds of `rg`/`ls`/`read`.

**Use BEFORE ripgrep or read** to orient. The response includes `index.fresh`, `index.coverage`, and `index.head_behind` so you know how current the index is.

### `navigator_slice(path, symbol? | startLine?, endLine?)`

Returns the exact current working-tree bytes for a symbol or line range, plus a `content_hash`. The hash matches what `edit`/`write` expect. A result flagged `unchanged_since_last_read: true` was already read this session with no intervening change — skip re-reading it.

## Examples

```
# Where is the Grid model and what references it?
navigator_locate("Grid")
→ results[0].path = "dashboard/app/models/grid.rb"
  cluster.referrers = ["dashboard/app/controllers/grids_controller.rb", ...]
  cluster.cochange  = ["dashboard/app/services/grid_sync.rb"]

# Find a doc file covering queue contracts
navigator_locate("queue contracts")
→ results[0].path = "doc/QUEUE_CONTRACTS.md"

# Read only the `sync` method of grid.rb
navigator_slice("dashboard/app/models/grid.rb", symbol: "sync")
→ content = "  def sync\n    ...\n  end", content_hash = "abc123..."

# Read lines 10–30 of a Python file (startLine/endLine are 1-based, inclusive)
navigator_slice("excavation/grid_loader.py", startLine: 10, endLine: 30)
```

## Honest boundary

The navigator speeds **finding** and **reading spans**. It does **not** replace reading ground-truth bytes before an edit.

- `navigator_slice` always reads live worktree bytes — use its `content_hash` to anchor the `edit` call's `oldText` lookup, not a cached index value.
- The index may lag the working tree slightly (rolling background worker). `locate` reports `index.fresh` and `index.coverage`; treat results as orientation signals, not authoritative facts for a mutation.
- When `index.fresh` is false or `index.coverage` is low, fall back to `rg`/`read` for confirmation before editing.
