import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { openDb } from "../store/db.ts";
import { migrate, pruneOld, needsRebuild, TELEMETRY_SCHEMA_VERSION } from "./schema.ts";
import { ensureSession, insertLocate } from "./queries.ts";

function makeTmpPath(): string {
  return join(tmpdir(), `nav-telemetry-test-${process.pid}-${Date.now()}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = path + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

test("migrate is idempotent and schema_version is set", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath);
    migrate(db);
    migrate(db); // second call must not throw

    const row = db
      .prepare("SELECT value FROM tmeta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    assert.ok(row, "tmeta schema_version row should exist");
    assert.equal(row!.value, String(TELEMETRY_SCHEMA_VERSION));
  } finally {
    cleanup(dbPath);
  }
});

test("ensureSession inserts and reads back a nav_session row", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath);
    migrate(db);

    ensureSession(db, {
      sessionId: "sess-abc",
      startedAt: 1000000,
      repoRoot: "/tmp/repo",
      headSha: "deadbeef",
      isWriter: false,
    });

    const row = db
      .prepare("SELECT * FROM nav_session WHERE session_id = ?")
      .get("sess-abc") as Record<string, unknown> | undefined;
    assert.ok(row, "session row should exist");
    assert.equal(row!.session_id, "sess-abc");
    assert.equal(row!.started_at, 1000000);
    assert.equal(row!.repo_root, "/tmp/repo");
    assert.equal(row!.head_sha, "deadbeef");
    assert.equal(row!.is_writer, 0);
  } finally {
    cleanup(dbPath);
  }
});

test("pruneOld deletes stale rows and keeps fresh ones", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath);
    migrate(db);

    const now = Date.now();
    const staleTs = now - 31 * 86_400_000;
    const freshTs = now;

    ensureSession(db, {
      sessionId: "sess-prune",
      startedAt: freshTs,
      repoRoot: "/tmp/repo",
      headSha: null,
      isWriter: false,
    });

    const baseLocate = {
      sessionId: "sess-prune",
      seq: 1,
      turn: 1,
      headSha: null,
      query: "test",
      queryTokenCount: 1,
      queryType: "keyword" as const,
      limitN: 10,
      resultCount: 2,
      confidence: "high" as const,
      hasExactDef: false,
      usedOrFallback: true,
      topHasAnchor: false,
      coverage: 0.9,
      dirty: false,
      headBehind: 0,
      fresh: true,
      latencyMs: 5,
      resultsMetadata: [],
      cochange: [],
      referrers: [],
    };

    const staleId = insertLocate(db, { ...baseLocate, ts: staleTs, seq: 1 });
    const freshId = insertLocate(db, { ...baseLocate, ts: freshTs, seq: 2 });

    pruneOld(db, 30);

    const staleRow = db
      .prepare("SELECT id FROM nav_locate WHERE id = ?")
      .get(staleId) as { id: number } | undefined;
    assert.equal(staleRow, undefined, "stale row should have been pruned");

    const freshRow = db
      .prepare("SELECT id FROM nav_locate WHERE id = ?")
      .get(freshId) as { id: number } | undefined;
    assert.ok(freshRow, "fresh row should remain after pruning");
  } finally {
    cleanup(dbPath);
  }
});

test("needsRebuild only rebuilds for pre-v2 stored versions", () => {
  assert.equal(needsRebuild(0, 3), false);
  assert.equal(needsRebuild(1, 3), true);
  assert.equal(needsRebuild(2, 3), false);
  assert.equal(needsRebuild(3, 3), false);
});

test("nav_consume has a cluster_kind column after migrate", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath);
    migrate(db);

    const cols = db
      .prepare("PRAGMA table_info(nav_consume)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes("cluster_kind"), `cluster_kind column missing; got: ${names.join(", ")}`);
  } finally {
    cleanup(dbPath);
  }
});

test("nav_consume CHECK rejects row with both locate_rank and cluster_kind set", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath);
    migrate(db);

    // Insert a session first so FK/NOT NULL is satisfied
    db.prepare(
      "INSERT INTO nav_session (session_id, started_at) VALUES (?, ?)"
    ).run("sess-check", Date.now());

    assert.throws(
      () => {
        db.prepare(
          `INSERT INTO nav_consume (session_id, seq, turn, ts, kind, locate_rank, cluster_kind)
           VALUES ('sess-check', 1, 1, ${Date.now()}, 'slice', 1, 'cochange')`
        ).run();
      },
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected an Error");
        assert.match(err.message, /CHECK constraint failed/i);
        return true;
      },
    );
  } finally {
    cleanup(dbPath);
  }
});

test("v2->v3 migration preserves nav_session rows (ALTER, not drop)", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS tmeta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS nav_session (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, repo_root TEXT, head_sha TEXT, is_writer INTEGER DEFAULT 0, used_locate INTEGER DEFAULT 0)");
    db.prepare("INSERT INTO nav_session (session_id, started_at) VALUES ('keep-me', 123)").run();
    db.prepare("INSERT INTO tmeta (key, value) VALUES ('schema_version', '2')").run();
    migrate(db);
    const row = db.prepare("SELECT session_id, tools_selected FROM nav_session WHERE session_id = 'keep-me'").get() as Record<string, unknown> | undefined;
    assert.ok(row, "v2 row must survive the v2->v3 migration");
    assert.equal(row!.tools_selected, 0);
    const ver = db.prepare("SELECT value FROM tmeta WHERE key='schema_version'").get() as { value: string } | undefined;
    assert.equal(ver!.value, "3");
  } finally { cleanup(dbPath); }
});

test("migrate creates nav_guard with the expected columns", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath); migrate(db);
    const cols = (db.prepare("PRAGMA table_info(nav_guard)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["session_id", "ts", "action", "pattern_kind", "reason"]) assert.ok(cols.includes(c), `nav_guard missing ${c}`);
  } finally { cleanup(dbPath); }
});

test("nav_session has tools_selected after a fresh migrate", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath); migrate(db);
    const cols = (db.prepare("PRAGMA table_info(nav_session)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes("tools_selected"));
  } finally { cleanup(dbPath); }
});

test("pruneOld removes orphaned nav_locate rows with no matching session", () => {
  const dbPath = makeTmpPath();
  try {
    const db = openDb(dbPath);
    migrate(db);

    // Insert a locate row with a session_id that has no nav_session row
    db.exec(`INSERT INTO nav_locate (session_id, seq, turn, ts, query, query_token_count, query_type, limit_n, result_count, confidence, has_exact_def, used_or_fallback, top_has_anchor, coverage, dirty, head_behind, fresh, latency_ms)
      VALUES ('orphan-session', 1, 1, ${Date.now()}, 'test', 1, 'keyword', 10, 0, 'low', 0, 0, 0, 0.0, 0, 0, 0, 1)`);

    const before = db
      .prepare("SELECT id FROM nav_locate WHERE session_id = 'orphan-session'")
      .get() as { id: number } | undefined;
    assert.ok(before, "orphan locate row should exist before pruneOld");

    pruneOld(db, 30);

    const after = db
      .prepare("SELECT id FROM nav_locate WHERE session_id = 'orphan-session'")
      .get() as { id: number } | undefined;
    assert.equal(after, undefined, "orphan locate row should be removed by pruneOld");
  } finally {
    cleanup(dbPath);
  }
});
