import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, existsSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openDb } from "../src/store/db.ts";
import { migrate as migrateIndex } from "../src/store/schema.ts";
import { migrate as migrateTelemetry } from "../src/telemetry/schema.ts";
import { upsertFile } from "../src/store/queries.ts";
import { ensureSession, insertLocate, insertConsume } from "../src/telemetry/queries.ts";
import { exportCases } from "./export-cases.ts";

const NOW = Date.now();

function seedDbs(dir: string): { indexPath: string; telPath: string } {
  const indexPath = join(dir, "index.db");
  const telPath = join(dir, "index.telemetry.db");

  // Index DB: seed known paths
  const indexDb = openDb(indexPath);
  migrateIndex(indexDb);
  upsertFile(indexDb, {
    path: "src/foo.ts",
    lang: "ts",
    size: 100,
    content_hash: "aaa",
    mtime: NOW,
    last_commit_at: null,
    commits_30d: 0,
    commits_90d: 0,
    indexed_at: NOW,
    symbols_done: 1,
  });
  upsertFile(indexDb, {
    path: "src/indexed_not_returned.ts",
    lang: "ts",
    size: 200,
    content_hash: "bbb",
    mtime: NOW,
    last_commit_at: null,
    commits_30d: 0,
    commits_90d: 0,
    indexed_at: NOW,
    symbols_done: 1,
  });
  // src/missing.ts is NOT inserted → not_indexed verdict
  indexDb.close();

  // Telemetry DB: session 1 (identifier, miss-fallback unjustified)
  const telDb = openDb(telPath);
  migrateTelemetry(telDb);

  ensureSession(telDb, {
    sessionId: "s1",
    startedAt: NOW,
    repoRoot: "/repo",
    headSha: null,
    isWriter: false,
  });

  const locateId1 = insertLocate(telDb, {
    sessionId: "s1",
    seq: 1,
    turn: 1,
    ts: NOW,
    headSha: null,
    query: "find foo",
    queryTokenCount: 2,
    queryType: "identifier",
    limitN: 10,
    resultCount: 3,
    confidence: "high",
    hasExactDef: false,
    usedOrFallback: false,
    topHasAnchor: true,
    coverage: 0.9,
    dirty: false,
    headBehind: 0,
    fresh: true,
    latencyMs: 50,
    resultsMetadata: [
      { path: "src/foo.ts", score: 0.9, signals: { fts: 0.5, path: 0.2, symbol: 0.1, recency: 0.1 } },
    ],
    cochange: [],
    referrers: [],
  });

  // Consume: missing.ts (not in index) → not_indexed
  insertConsume(telDb, {
    sessionId: "s1",
    seq: 2,
    turn: 1,
    ts: NOW,
    kind: "slice",
    path: "src/missing.ts",
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: null,
    searchPattern: null,
    latencyMs: null,
    isError: false,
  });

  // Consume: indexed_not_returned.ts (in index, not in results_metadata) → indexed_not_returned
  insertConsume(telDb, {
    sessionId: "s1",
    seq: 3,
    turn: 2,
    ts: NOW,
    kind: "slice",
    path: "src/indexed_not_returned.ts",
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: null,
    searchPattern: null,
    latencyMs: null,
    isError: false,
  });

  // Consume: foo.ts (in index AND in results_metadata) → indexed
  insertConsume(telDb, {
    sessionId: "s1",
    seq: 4,
    turn: 2,
    ts: NOW,
    kind: "slice",
    path: "src/foo.ts",
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: null,
    searchPattern: null,
    latencyMs: null,
    isError: false,
  });

  // Consume: .env.local (secret) → must be omitted
  insertConsume(telDb, {
    sessionId: "s1",
    seq: 5,
    turn: 2,
    ts: NOW,
    kind: "slice",
    path: ".env.local",
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: null,
    searchPattern: null,
    latencyMs: null,
    isError: false,
  });

  // Session 2: keyword query (for query-type filter test)
  ensureSession(telDb, {
    sessionId: "s2",
    startedAt: NOW,
    repoRoot: "/repo",
    headSha: null,
    isWriter: false,
  });

  insertLocate(telDb, {
    sessionId: "s2",
    seq: 1,
    turn: 1,
    ts: NOW,
    headSha: null,
    query: "authentication",
    queryTokenCount: 1,
    queryType: "keyword",
    limitN: 10,
    resultCount: 0,
    confidence: "low",
    hasExactDef: false,
    usedOrFallback: false,
    topHasAnchor: false,
    coverage: 0.5,
    dirty: false,
    headBehind: 0,
    fresh: true,
    latencyMs: 30,
    resultsMetadata: [],
    cochange: [],
    referrers: [],
  });

  insertConsume(telDb, {
    sessionId: "s2",
    seq: 2,
    turn: 1,
    ts: NOW,
    kind: "search",
    path: null,
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: "rg",
    searchPattern: "authentication",
    latencyMs: null,
    isError: false,
  });

  telDb.close();

  return { indexPath, telPath };
}

test("fallback verdict: not_indexed when path absent from index", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s1 = cases.find((c) => c.sessionId === "s1");
      assert.ok(s1, "session s1 case should be present");
      const verdict = s1!.fallbackVerdicts.find((v) => v.path === "src/missing.ts");
      assert.ok(verdict, "missing.ts should have a verdict");
      assert.equal(verdict!.indexed, "not_indexed");
    } finally {
      idxDb.close();
      telDb.close();
    }
  } finally {
    for (const f of ["index.db", "index.db-wal", "index.db-shm", "index.telemetry.db", "index.telemetry.db-wal", "index.telemetry.db-shm"]) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
    try { rmdirSync(dir); } catch {}
  }
});

test("fallback verdict: indexed_not_returned when path in index but not in results_metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s1 = cases.find((c) => c.sessionId === "s1");
      assert.ok(s1, "session s1 case should be present");
      const verdict = s1!.fallbackVerdicts.find((v) => v.path === "src/indexed_not_returned.ts");
      assert.ok(verdict, "indexed_not_returned.ts should have a verdict");
      assert.equal(verdict!.indexed, "indexed_not_returned");
    } finally {
      idxDb.close();
      telDb.close();
    }
  } finally {
    for (const f of ["index.db", "index.db-wal", "index.db-shm", "index.telemetry.db", "index.telemetry.db-wal", "index.telemetry.db-shm"]) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
    try { rmdirSync(dir); } catch {}
  }
});

test("fallback verdict: indexed when path is in index AND in results_metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s1 = cases.find((c) => c.sessionId === "s1");
      assert.ok(s1, "session s1 case should be present");
      const verdict = s1!.fallbackVerdicts.find((v) => v.path === "src/foo.ts");
      assert.ok(verdict, "foo.ts should have a verdict");
      assert.equal(verdict!.indexed, "indexed");
    } finally {
      idxDb.close();
      telDb.close();
    }
  } finally {
    for (const f of ["index.db", "index.db-wal", "index.db-shm", "index.telemetry.db", "index.telemetry.db-wal", "index.telemetry.db-shm"]) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
    try { rmdirSync(dir); } catch {}
  }
});

test("secret masking: .env.local path is omitted from consumptions and fallbackVerdicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s1 = cases.find((c) => c.sessionId === "s1");
      assert.ok(s1, "session s1 case should be present");
      const secretInConsumptions = s1!.consumptions.some((c) => c.path === ".env.local");
      assert.equal(secretInConsumptions, false, ".env.local must not appear in consumptions");
      const secretInVerdicts = s1!.fallbackVerdicts.some((v) => v.path === ".env.local");
      assert.equal(secretInVerdicts, false, ".env.local must not appear in fallbackVerdicts");
    } finally {
      idxDb.close();
      telDb.close();
    }
  } finally {
    for (const f of ["index.db", "index.db-wal", "index.db-shm", "index.telemetry.db", "index.telemetry.db-wal", "index.telemetry.db-shm"]) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
    try { rmdirSync(dir); } catch {}
  }
});

test("CLI rejects a non-numeric --limit with exit code 1", () => {
  const script = fileURLToPath(new URL("./export-cases.ts", import.meta.url));
  const r = spawnSync(process.execPath, [script, "--limit", "abc"], { encoding: "utf8" });
  assert.equal(r.status, 1, "should exit non-zero on bad --limit");
  assert.match(r.stderr, /--limit requires a positive integer/);
});

test("--query-type filter: 'identifier' excludes keyword locate cases", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, { queryType: "identifier" });
      const hasKeyword = cases.some((c) => c.queryType === "keyword");
      assert.equal(hasKeyword, false, "keyword locate should be excluded");
      const hasIdentifier = cases.some((c) => c.queryType === "identifier");
      assert.equal(hasIdentifier, true, "identifier locate should be included");
    } finally {
      idxDb.close();
      telDb.close();
    }
  } finally {
    for (const f of ["index.db", "index.db-wal", "index.db-shm", "index.telemetry.db", "index.telemetry.db-wal", "index.telemetry.db-shm"]) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
    try { rmdirSync(dir); } catch {}
  }
});
