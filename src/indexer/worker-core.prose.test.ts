import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../store/db.ts";
import { migrate } from "../store/schema.ts";
import { runIndexPass } from "./worker-core.ts";
import { locate } from "../navigator/locate.ts";
import { DEFAULT_CONFIG } from "../config.ts";

async function proseRepo() {
  const d = mkdtempSync(join(tmpdir(), "nav-prose-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]);
  git(["config", "user.email", "a@b.c"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(d, "doc"), { recursive: true });
  // Body contains both a phrase ("queue contracts") and a body-only term
  // ("idempotency") that appears in no path or symbol name.
  writeFileSync(
    join(d, "doc", "QUEUE_CONTRACTS.md"),
    "# Queue Contracts\n\nThe worker guarantees idempotency for each job.\n",
  );
  // Body is pure stopwords — only the path matters.
  writeFileSync(
    join(d, "doc", "ONBOARDING.md"),
    "the and of to is it for on with as at by be\n",
  );
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return d;
}

test("prose file is indexed and locatable by filename and by body term", async () => {
  const d = await proseRepo();
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-prose-db-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });

  // Locatable by filename stem (path tokens)
  const byName = locate(db, d, "QUEUE_CONTRACTS", DEFAULT_CONFIG);
  assert.ok(
    byName.results.slice(0, 5).some((r) => r.path.endsWith("QUEUE_CONTRACTS.md")),
    "expected QUEUE_CONTRACTS.md in top-5 for filename query",
  );

  // Locatable by exact phrase (body tokens — AND-first query)
  const byPhrase = locate(db, d, "queue contracts", DEFAULT_CONFIG);
  assert.ok(
    byPhrase.results.slice(0, 5).some((r) => r.path.endsWith("QUEUE_CONTRACTS.md")),
    "expected QUEUE_CONTRACTS.md in top-5 for 'queue contracts'",
  );

  // Body-only term: "idempotency" appears in no path or symbol — proves body indexing.
  const byBody = locate(db, d, "idempotency", DEFAULT_CONFIG);
  assert.ok(
    byBody.results.some((r) => r.path.endsWith("QUEUE_CONTRACTS.md")),
    "expected QUEUE_CONTRACTS.md to be findable by body-only term 'idempotency'",
  );
});

test("prose file matching only via path tokens ranks normally (empty keywords/content)", async () => {
  const d = await proseRepo();
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-prose-db2-")), "i.db"));
  migrate(db);
  runIndexPass(db, d, DEFAULT_CONFIG, { batchSize: 50, priority: [] });

  // ONBOARDING.md has only stopword body — path tokens should still resolve it.
  const res = locate(db, d, "ONBOARDING", DEFAULT_CONFIG);
  assert.ok(
    res.results.some((r) => r.path.endsWith("ONBOARDING.md")),
    "expected ONBOARDING.md to be findable by filename even with stopword-only body",
  );
});

test("extractSymbols is never called for prose even if prose is in config.languages", async () => {
  const d = await proseRepo();
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-prose-db3-")), "i.db"));
  migrate(db);
  // Force prose into config.languages (misconfiguration scenario)
  const badConfig = { ...DEFAULT_CONFIG, languages: [...DEFAULT_CONFIG.languages, "prose" as any] };
  runIndexPass(db, d, badConfig, { batchSize: 50, priority: [] });

  // No symbols rows should exist for the prose file (symbol_names stays empty in FTS row)
  const symRows = db
    .prepare("SELECT symbol_names FROM search_index WHERE path LIKE '%.md'")
    .all() as { symbol_names: string }[];
  for (const row of symRows) {
    assert.equal(
      row.symbol_names,
      "",
      "prose files must have empty symbol_names regardless of config.languages",
    );
  }
});
