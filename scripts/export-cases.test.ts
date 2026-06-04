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
  upsertFile(indexDb, {
    path: "src/cluster_file.ts",
    lang: "ts",
    size: 150,
    content_hash: "ccc",
    mtime: NOW,
    last_commit_at: null,
    commits_30d: 0,
    commits_90d: 0,
    indexed_at: NOW,
    symbols_done: 1,
  });
  // src/missing.ts is NOT inserted → not_indexed verdict
  indexDb.close();

  // Telemetry DB
  const telDb = openDb(telPath);
  migrateTelemetry(telDb);

  // s1: identifier miss-fallback — search then read src/missing.ts → not_indexed verdict
  ensureSession(telDb, {
    sessionId: "s1",
    startedAt: NOW,
    repoRoot: "/repo",
    headSha: null,
    isWriter: false,
  });

  insertLocate(telDb, {
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

  // search consume → triggers miss-fallback outcome
  insertConsume(telDb, {
    sessionId: "s1",
    seq: 2,
    turn: 1,
    ts: NOW,
    kind: "search",
    path: null,
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: "rg",
    searchPattern: "missing",
    latencyMs: null,
    isError: false,
    clusterKind: null,
  });

  // First read after search → target for fallback verdict
  insertConsume(telDb, {
    sessionId: "s1",
    seq: 3,
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
    clusterKind: null,
  });

  // secret consume — must be omitted regardless of position
  insertConsume(telDb, {
    sessionId: "s1",
    seq: 4,
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
    clusterKind: null,
  });

  // s2: keyword query, miss-fallback with NO following read
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

  // search with no following read → null target → { path: null, indexed: 'not_indexed' }
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
    clusterKind: null,
  });

  // s3: miss-fallback, search → read indexed path NOT in cluster
  // Path was returned in results_metadata; under old logic this produced 'indexed';
  // under new logic (clusterPaths-based) it must produce 'indexed_not_returned'.
  ensureSession(telDb, {
    sessionId: "s3",
    startedAt: NOW,
    repoRoot: "/repo",
    headSha: null,
    isWriter: false,
  });

  insertLocate(telDb, {
    sessionId: "s3",
    seq: 1,
    turn: 1,
    ts: NOW,
    headSha: null,
    query: "find bar",
    queryTokenCount: 2,
    queryType: "identifier",
    limitN: 10,
    resultCount: 1,
    confidence: "high",
    hasExactDef: false,
    usedOrFallback: false,
    topHasAnchor: false,
    coverage: 0.8,
    dirty: false,
    headBehind: 0,
    fresh: true,
    latencyMs: 40,
    // indexed_not_returned.ts IS in results, but user fell back to search;
    // new logic: indexed_not_returned (not in clusterPaths)
    resultsMetadata: [
      { path: "src/indexed_not_returned.ts", score: 0.6, signals: { fts: 0.3, path: 0.1, symbol: 0.1, recency: 0.1 } },
    ],
    cochange: [],
    referrers: [],
  });

  insertConsume(telDb, {
    sessionId: "s3",
    seq: 2,
    turn: 1,
    ts: NOW,
    kind: "search",
    path: null,
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: "rg",
    searchPattern: "bar",
    latencyMs: null,
    isError: false,
    clusterKind: null,
  });

  insertConsume(telDb, {
    sessionId: "s3",
    seq: 3,
    turn: 1,
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
    clusterKind: null,
  });

  // s4: miss-fallback, post-search read of a CLUSTER path (ranking gap)
  ensureSession(telDb, {
    sessionId: "s4",
    startedAt: NOW,
    repoRoot: "/repo",
    headSha: null,
    isWriter: false,
  });

  insertLocate(telDb, {
    sessionId: "s4",
    seq: 1,
    turn: 1,
    ts: NOW,
    headSha: null,
    query: "find cluster",
    queryTokenCount: 2,
    queryType: "identifier",
    limitN: 10,
    resultCount: 0,
    confidence: "high",
    hasExactDef: false,
    usedOrFallback: false,
    topHasAnchor: false,
    coverage: 0.8,
    dirty: false,
    headBehind: 0,
    fresh: true,
    latencyMs: 40,
    resultsMetadata: [],
    cochange: ["src/cluster_file.ts"],
    referrers: [],
  });

  insertConsume(telDb, {
    sessionId: "s4",
    seq: 2,
    turn: 1,
    ts: NOW,
    kind: "search",
    path: null,
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: "rg",
    searchPattern: "cluster",
    latencyMs: null,
    isError: false,
    clusterKind: null,
  });

  insertConsume(telDb, {
    sessionId: "s4",
    seq: 3,
    turn: 1,
    ts: NOW,
    kind: "slice",
    path: "src/cluster_file.ts",
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: null,
    searchPattern: null,
    latencyMs: null,
    isError: false,
    clusterKind: null,
  });

  // s5: cluster-assist → read cluster path → 'indexed' verdict
  ensureSession(telDb, {
    sessionId: "s5",
    startedAt: NOW,
    repoRoot: "/repo",
    headSha: null,
    isWriter: false,
  });

  insertLocate(telDb, {
    sessionId: "s5",
    seq: 1,
    turn: 1,
    ts: NOW,
    headSha: null,
    query: "find assist",
    queryTokenCount: 2,
    queryType: "identifier",
    limitN: 10,
    resultCount: 2,
    confidence: "high",
    hasExactDef: false,
    usedOrFallback: false,
    topHasAnchor: true,
    coverage: 0.9,
    dirty: false,
    headBehind: 0,
    fresh: true,
    latencyMs: 45,
    resultsMetadata: [
      { path: "src/foo.ts", score: 0.8, signals: { fts: 0.4, path: 0.2, symbol: 0.1, recency: 0.1 } },
    ],
    cochange: ["src/cluster_file.ts"],
    referrers: [],
  });

  // slice with cluster_kind="cochange" → outcome becomes cluster-assist
  insertConsume(telDb, {
    sessionId: "s5",
    seq: 2,
    turn: 1,
    ts: NOW,
    kind: "slice",
    path: "src/cluster_file.ts",
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: null,
    searchPattern: null,
    latencyMs: null,
    isError: false,
    clusterKind: "cochange",
  });

  // s6: miss-fallback, only read after search is a secret path — must be masked to { path: null, indexed: 'not_indexed' }
  ensureSession(telDb, {
    sessionId: "s6",
    startedAt: NOW,
    repoRoot: "/repo",
    headSha: null,
    isWriter: false,
  });

  insertLocate(telDb, {
    sessionId: "s6",
    seq: 1,
    turn: 1,
    ts: NOW,
    headSha: null,
    query: "find secret thing",
    queryTokenCount: 3,
    queryType: "keyword",
    limitN: 10,
    resultCount: 0,
    confidence: "low",
    hasExactDef: false,
    usedOrFallback: false,
    topHasAnchor: false,
    coverage: 0.7,
    dirty: false,
    headBehind: 0,
    fresh: true,
    latencyMs: 20,
    resultsMetadata: [],
    cochange: [],
    referrers: [],
  });

  insertConsume(telDb, {
    sessionId: "s6",
    seq: 2,
    turn: 1,
    ts: NOW,
    kind: "search",
    path: null,
    locateRank: null,
    staleIndex: null,
    unchanged: null,
    searchTool: "rg",
    searchPattern: "secret",
    latencyMs: null,
    isError: false,
    clusterKind: null,
  });

  // The ONLY read/slice after the search is a secret path — must be masked.
  insertConsume(telDb, {
    sessionId: "s6",
    seq: 3,
    turn: 1,
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
    clusterKind: null,
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

test("fallback verdict: indexed_not_returned when path in index but not in clusterPaths (test c)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s3 = cases.find((c) => c.sessionId === "s3");
      assert.ok(s3, "session s3 case should be present");
      assert.equal(s3!.fallbackVerdicts.length, 1, "should have exactly one fallback verdict");
      const verdict = s3!.fallbackVerdicts[0];
      assert.equal(verdict.path, "src/indexed_not_returned.ts");
      assert.equal(verdict.indexed, "indexed_not_returned");
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

test("post-search-read: fallbackVerdict indexed='indexed' via cluster membership (ranking gap)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s4 = cases.find((c) => c.sessionId === "s4");
      assert.ok(s4, "session s4 case should be present");
      assert.equal(s4!.fallbackVerdicts.length, 1, "should have exactly one fallback verdict");
      const verdict = s4!.fallbackVerdicts[0];
      assert.equal(verdict.path, "src/cluster_file.ts");
      assert.equal(verdict.indexed, "indexed");
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

test("fallback verdict: null path and not_indexed when no read follows the search (test b)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s2 = cases.find((c) => c.sessionId === "s2");
      assert.ok(s2, "session s2 case should be present");
      assert.equal(s2!.outcome, "miss-fallback");
      assert.equal(s2!.fallbackVerdicts.length, 1, "should have exactly one fallback verdict");
      const verdict = s2!.fallbackVerdicts[0];
      assert.equal(verdict.path, null, "path must be null when no read follows search");
      assert.equal(verdict.indexed, "not_indexed");
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

test("fallback verdict: cluster-assist exports indexed verdict for cluster path (test d)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s5 = cases.find((c) => c.sessionId === "s5");
      assert.ok(s5, "session s5 case should be present");
      assert.equal(s5!.outcome, "cluster-assist");
      assert.equal(s5!.fallbackVerdicts.length, 1, "should have exactly one fallback verdict");
      const verdict = s5!.fallbackVerdicts[0];
      assert.equal(verdict.path, "src/cluster_file.ts");
      assert.equal(verdict.indexed, "indexed");
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

test("miss-fallback: only secret read after search → fallbackVerdicts { path: null, indexed: 'not_indexed' }", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-export-test-"));
  try {
    const { indexPath, telPath } = seedDbs(dir);
    const idxDb = openDb(indexPath);
    const telDb = openDb(telPath);
    try {
      const cases = exportCases(telDb, idxDb, {});
      const s6 = cases.find((c) => c.sessionId === "s6");
      assert.ok(s6, "session s6 case should be present");
      assert.equal(s6!.outcome, "miss-fallback");
      assert.equal(s6!.fallbackVerdicts.length, 1, "should have exactly one fallback verdict");
      const verdict = s6!.fallbackVerdicts[0];
      assert.equal(verdict.path, null, "secret path must be masked to null");
      assert.equal(verdict.indexed, "not_indexed");
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
