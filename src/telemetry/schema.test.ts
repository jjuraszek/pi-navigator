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

test("needsRebuild returns correct results", () => {
  assert.equal(needsRebuild(0, 1), false, "version 0 (fresh) should not trigger rebuild");
  assert.equal(needsRebuild(1, 2), true, "stored < current should trigger rebuild");
  assert.equal(needsRebuild(2, 2), false, "stored == current should not trigger rebuild");
  assert.equal(needsRebuild(1, 3), true, "stored far behind current should trigger rebuild");
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
