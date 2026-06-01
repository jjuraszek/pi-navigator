/**
 * pi-navigator eval harness
 * Measures hit@1 / hit@k for navigator_locate against a ripgrep baseline.
 *
 * Usage:
 *   node eval/run.ts [--repo <absolute-path>] [--k <n>]
 *
 * Defaults: --repo <pi-navigator root>, --k 5
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb } from "../src/store/db.ts";
import { migrate } from "../src/store/schema.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { initParsers } from "../src/indexer/symbols.ts";
import { runIndexPass } from "../src/indexer/worker-core.ts";
import { locate } from "../src/navigator/locate.ts";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const navRoot = resolve(__dirname, "..");

function parseArgs(): { repo: string; k: number } {
  const args = process.argv.slice(2);
  let repo = navRoot;
  let k = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && args[i + 1]) { repo = resolve(args[i + 1]); i++; }
    else if (args[i] === "--k" && args[i + 1]) { k = parseInt(args[i + 1], 10) || 5; i++; }
  }
  return { repo, k };
}

// ---------------------------------------------------------------------------
// Case loading
// ---------------------------------------------------------------------------

interface EvalCase {
  query: string;
  expect?: string[];
  expect_prefix?: string;
  expect_contains?: string;
  expect_not_suffix?: string;
}

function loadCases(): EvalCase[] {
  const casesPath = join(__dirname, "cases.jsonl");
  return readFileSync(casesPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EvalCase)
    .filter((c) => c.expect || c.expect_prefix || c.expect_contains || c.expect_not_suffix !== undefined);
}

// ---------------------------------------------------------------------------
// ripgrep baseline
// ---------------------------------------------------------------------------

interface RgResult {
  present: boolean;   // any expect path appeared in rg output
  candidateCount: number;
  available: boolean; // false if rg not installed / errored
}

function rgBaseline(query: string, repo: string, expect: string[] | undefined): RgResult {
  try {
    // Use the first 1-2 non-trivial tokens (skip stopwords, short words)
    const tokens = query.split(/\s+/).filter((t) => t.length > 3);
    const searchTerm = tokens[0] ?? query.split(/\s+/)[0] ?? query;

    const raw = execFileSync(
      "rg",
      ["--files-with-matches", "--max-count=1", searchTerm],
      { cwd: repo, stdio: ["ignore", "pipe", "ignore"], timeout: 10000 },
    )
      .toString()
      .trim();

    const files = raw.length === 0 ? [] : raw.split("\n").map((f) => f.trim());
    const candidateCount = files.length;

    // Normalise rg output to repo-relative POSIX paths
    const present = (expect ?? []).some((exp) =>
      files.some((f) => {
        const rel = relative(repo, resolve(repo, f)).split("\\").join("/");
        return rel.includes(exp) || exp.includes(rel);
      }),
    );

    return { present, candidateCount, available: true };
  } catch {
    return { present: false, candidateCount: 0, available: false };
  }
}

// ---------------------------------------------------------------------------
// Hit check
// ---------------------------------------------------------------------------

function pathMatchesExpect(path: string, expect: string[]): boolean {
  return expect.some((exp) => path.includes(exp) || exp.includes(path));
}

function evalHits(
  results: Array<{ path: string }>,
  c: EvalCase,
  k: number,
): { hit1: boolean; hitK: boolean } {
  if (results.length === 0) return { hit1: false, hitK: false };

  const top1 = results[0].path;
  const topK = results.slice(0, k).map((r) => r.path);

  // expect_not_suffix: #1 result must NOT end with suffix
  if (c.expect_not_suffix !== undefined) {
    const ok = !top1.endsWith(c.expect_not_suffix);
    return { hit1: ok, hitK: ok };
  }

  // expect_prefix: some top-k result starts with prefix
  if (c.expect_prefix !== undefined) {
    const hitK = topK.some((p) => p.startsWith(c.expect_prefix!));
    const hit1 = top1.startsWith(c.expect_prefix!);
    return { hit1, hitK };
  }

  // expect_contains: some top-k result includes substring
  if (c.expect_contains !== undefined) {
    const hitK = topK.some((p) => p.includes(c.expect_contains!));
    const hit1 = top1.includes(c.expect_contains!);
    return { hit1, hitK };
  }

  // expect: existing exact-match logic
  if (c.expect) {
    const hit1 = pathMatchesExpect(top1, c.expect);
    const hitK = topK.some((p) => pathMatchesExpect(p, c.expect!));
    return { hit1, hitK };
  }

  return { hit1: false, hitK: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { repo, k } = parseArgs();
  const cases = loadCases();

  console.log(`\npi-navigator eval harness`);
  console.log(`  repo : ${repo}`);
  console.log(`  k    : ${k}`);
  console.log(`  cases: ${cases.length}\n`);

  // Build a fresh index in a temp directory
  const tmpDir = mkdtempSync(join(tmpdir(), "nav-eval-"));
  const dbPath = join(tmpDir, "eval.db");

  try {
    console.log("Building index…");
    const db = openDb(dbPath);
    migrate(db);
    await initParsers(DEFAULT_CONFIG.languages);
    const coverage = runIndexPass(db, repo, DEFAULT_CONFIG, { batchSize: 100, priority: [] });
    console.log(`Index built: ${coverage.indexed}/${coverage.total} files, fullCrawlDone=${coverage.fullCrawlDone}\n`);

    // ---------------------------------------------------------------------------
    // Run eval cases
    // ---------------------------------------------------------------------------

    let hit1 = 0;
    let hitK = 0;
    let rgPresent = 0;
    let rgCandidateTotal = 0;
    let rgAvailableCases = 0;

    console.log(
      "Query".padEnd(35) +
      "hit@1".padEnd(7) +
      `hit@${k}`.padEnd(7) +
      "rg present".padEnd(12) +
      "rg candidates",
    );
    console.log("─".repeat(75));

    for (const c of cases) {
      let caseHit1 = false;
      let caseHitK = false;
      let rgResult: RgResult = { present: false, candidateCount: 0, available: false };

      try {
        const res = locate(db, repo, c.query, DEFAULT_CONFIG);

        const hits = evalHits(res.results, c, k);
        caseHit1 = hits.hit1;
        caseHitK = hits.hitK;

        rgResult = rgBaseline(c.query, repo, c.expect);
      } catch (err) {
        console.error(`  ERROR on case "${c.query}":`, (err as Error).message);
      }

      if (caseHit1) hit1++;
      if (caseHitK) hitK++;

      if (rgResult.available) {
        rgAvailableCases++;
        if (rgResult.present) rgPresent++;
        rgCandidateTotal += rgResult.candidateCount;
      }

      const rgCol = rgResult.available
        ? `${rgResult.present ? "✓" : "✗"} ${rgResult.candidateCount} files`
        : "n/a";

      console.log(
        c.query.slice(0, 34).padEnd(35) +
        (caseHit1 ? "✓" : "✗").padEnd(7) +
        (caseHitK ? "✓" : "✗").padEnd(7) +
        rgCol,
      );
    }

    const n = cases.length;
    const avgCandidates =
      rgAvailableCases > 0 ? (rgCandidateTotal / rgAvailableCases).toFixed(1) : "n/a";

    console.log("─".repeat(75));
    console.log(`\nResults (${n} cases):`);
    console.log(`  navigator hit@1  : ${hit1}/${n}`);
    console.log(`  navigator hit@${k}  : ${hitK}/${n}`);
    if (rgAvailableCases > 0) {
      console.log(`  rg expected file : ${rgPresent}/${rgAvailableCases}`);
      console.log(`  rg avg candidates: ${avgCandidates} files`);
    } else {
      console.log(`  rg baseline      : n/a (rg not available)`);
    }
    console.log();

    db.close();
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
