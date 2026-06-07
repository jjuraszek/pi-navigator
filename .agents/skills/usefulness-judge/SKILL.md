---
name: usefulness-judge
description: Offline, dev-only analysis of pi-navigator usefulness telemetry. Use after telemetry has accumulated to explain navigation gaps (recall vs ranking vs justified fallback), calibrate the confidence flag, and recommend rank.ts weight changes — grounded in the telemetry DB joined with the live index.
---

### When to use

Offline, dev-only, after `navigator.telemetry` has been enabled for a session or more and data has accumulated. Never invoke this in a normal user session.

This skill is **read-only analysis** — it never reads source file contents, only paths, scores, and signals from the telemetry DB and the index DB.

### First-iteration scope

#### Answers (grounded)

| Question | Source fields | Method |
|---|---|---|
| **Ranking-position quality** | `resultsMetadata[].{path,score,signals:{fts,path,symbol,recency}}` + `consumptions[].locateRank` | Identify which signal dominated each result (largest component in `signals`). Aggregate per-signal rank lift. Feed into `rank.ts` weight input. |
| **Confidence-flag calibration** | Aggregate `outcome` by `confidence` → low_conf_precision / high_conf_precision. Raw inputs: `confidenceInputs.{hasExactDef, usedOrFallback, topHasAnchor}` | Compare precision at low vs high confidence; find which raw input(s) best predict a useful outcome. |
| **Recall gap vs ranking gap** | `fallbackVerdicts[].{path, indexed}` verdict + `outcome` | `not_indexed` → recall gap (file not in index). `indexed_not_returned` → retrieval gap (indexed but not in this locate's results or cluster). `indexed` → ranking gap (target was surfaced in the locate's co-change/referrer **cluster** but not in the ranked results — also the verdict emitted for every `cluster-assist` outcome). All verdicts are **proven** from the index join, not inferred. |
| **Bypass rate** | `bypass_session_rate` (from `/navigator stats`) | Fraction of sessions that never called `navigator_locate` at all. A high rate means the agent is not reaching for the tool — an adoption signal, not a ranking failure. |

#### Defers (named, not dropped)

- **Non-identifier queries** (`queryType: keyword` or `open-ended`): exported for inspection but excluded from precision/recall claims until a labelled set exists. No vocabulary-match baseline yet.
- **'Agent ignored a correct result' vs genuine ranking failure**: cannot distinguish intent from consumption data alone. Flag these as low-confidence cases; do not penalize rank.ts.
- **Counterfactual re-rank recommendation**: requires eval/ replay harness (future work). Recommend weight directions only, not exact values.

### How to run

1. Confirm telemetry has data:

   ```
   /navigator stats
   ```

   Output should show nonzero `locate_total`. If zero, run more sessions with `navigator.telemetry: true` in settings first.

2. Export identifier cases (the `--index-db` join is what makes recall verdicts possible):

   ```bash
   node scripts/export-cases.ts \
     --index-db ~/.pi/pi-navigator-cache/<repo>_<id>.db \
     --query-type identifier \
     --limit 50 \
     > /tmp/cases.json
   ```

   `--repo` defaults to cwd. `--index-db` defaults to the repo's own index DB; override when analyzing a secondary worktree.

3. For each case in `/tmp/cases.json`, classify the gap:

   | Gap class | Condition |
   |---|---|
   | **recall** | `fallbackVerdicts` contains the consumed path with `indexed: "not_indexed"` |
   | **retrieval** | `fallbackVerdicts` contains the consumed path with `indexed: "indexed_not_returned"` |
   | **ranking** | `fallbackVerdicts` entry has `indexed: "indexed"` (target surfaced in the locate's co-change/referrer cluster but not ranked), or the `outcome` is `cluster-assist` |
   | **justified-fallback** | `justifiedFallback: true` — agent correctly bypassed locate |
   | **low-confidence** | Ambiguous consumption (multiple consumed paths, mixed signals) — flag, do not classify |

### What to emit

Write a report to `build/eval/reports/<YYYY-MM-DD>-usefulness.md` containing:

1. **Per-case grade table** — one row per identifier case: case id, gap class, dominant signal (from `resultsMetadata[0].signals`, highest value wins), `fallbackVerdicts[0].indexed` verdict, outcome.

2. **Aggregate ranking-position table** — mean consumed rank per dominant signal; signal frequency distribution across all returned results.

3. **Confidence-flag calibration table** — rows: `{confidence: low, precision: X%, n: N}` and `{confidence: high, precision: X%, n: N}`. Annotate which `confidenceInputs` field correlates most strongly with precision.

4. **Evidence-backed recommendations** against:
   - `src/navigator/rank.ts` weight constants (`DEFAULT_WEIGHTS.fts`, `DEFAULT_WEIGHTS.path`, `DEFAULT_WEIGHTS.symbol`, `DEFAULT_WEIGHTS.recency`) — each recommendation must cite ≥2 motivating cases with their signal breakdowns.
   - Confidence threshold — cite low_conf_precision / high_conf_precision delta and the raw input that best explains it.

5. **Insufficient-evidence list** — gaps that could not be classified (low-confidence cases, deferred query types). Feed into the next iteration spec.

### Privacy

- Paths only — never file contents.
- Secret paths (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`) are dropped by `scripts/export-cases.ts` via `isSecret` from `src/indexer/walk.ts` — secret-bearing results, consumptions, and verdicts are omitted entirely from the export, not replaced with a placeholder.
- The telemetry DB is local-only (`~/.pi/pi-navigator-cache/`); never commit or upload it.
