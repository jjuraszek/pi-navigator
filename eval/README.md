# pi-navigator eval harness

`cases.jsonl` contains 8 representative queries targeting this repo (pi-navigator) by default. Each line is `{ "query": string, "expect": string[] }` where `expect` lists repo-relative path substrings that a correct `navigator_locate` answer should surface in its top results.

Run against this repo: `node eval/run.ts --repo /path/to/pi-navigator`

Run against another repo: `node eval/run.ts --repo /path/to/repo` — update `cases.jsonl` with cases meaningful for that repo first.

Optional: `--k <n>` sets the hit@k window (default 5).

Write ad-hoc eval analysis reports under `build/eval/reports/`; `build/` is gitignored.
