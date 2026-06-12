import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { openDb } from "../store/db.ts";
import { migrate } from "./schema.ts";
import { TelemetryCorrelator } from "./correlator.ts";
import type { CorrelatorOpts } from "./correlator.ts";
import { insertGuard, markToolsSelected, ensureSession } from "./queries.ts";

function makeTmpPath(): string {
  return join(tmpdir(), `correlator-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = path + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

const ROOT = "/tmp/testrepo";

function makeOpts(dbPath: string, overrides: Partial<CorrelatorOpts> = {}): CorrelatorOpts & { dbPath: string } {
  const db = openDb(dbPath);
  migrate(db);
  return {
    db,
    sessionId: `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    root: ROOT,
    sessionCwd: ROOT,
    headSha: "abc123",
    isWriter: false,
    storeQueries: true,
    dbPath,
    ...overrides,
  };
}

const startEv = (id: string, toolName: string, args: any) => ({ toolCallId: id, toolName, args });
const endEv = (id: string, toolName: string, details: any, isError = false) => ({
  toolCallId: id,
  toolName,
  result: details !== undefined ? { details } : { content: "unavailable" },
  isError,
});

function makeLocateDetails(results: any[], extra: any = {}) {
  return {
    results,
    cluster: null,
    index: { coverage: 1, dirty: false, head_behind: 0, fresh: true },
    confidence: "high" as const,
    has_exact_def: true,
    used_or_fallback: false,
    top_has_anchor: true,
    ...extra,
  };
}

test("locate→slice hit: nav_locate row + nav_consume slice at rank 2 + used_locate=1", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    const locateResults = [
      { path: "a.ts", score: 9, signals: { fts: 1, path: 0, symbol: 2, recency: 0 } },
      { path: "b.ts", score: 5, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
    ];
    const locateDetails = makeLocateDetails(locateResults);

    c.onToolStart(startEv("l1", "navigator_locate", { query: "findMe" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: locateDetails }, isError: false });

    c.onToolStart(startEv("s1", "navigator_slice", { path: ROOT + "/b.ts" }));
    c.onToolEnd({ toolCallId: "s1", toolName: "navigator_slice", result: {
      details: { path: ROOT + "/b.ts", range: [1, 10], content: "x", content_hash: "h", stale_index: false, unchanged_since_last_read: false },
    }, isError: false });

    const locRow = db.prepare("SELECT * FROM nav_locate WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(locRow, "nav_locate row should exist");
    assert.equal(locRow.result_count, 2);
    assert.equal(locRow.confidence, "high");

    const consumeRow = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(consumeRow, "nav_consume row should exist");
    assert.equal(consumeRow.kind, "slice");
    assert.equal(consumeRow.path, "b.ts");
    assert.equal(consumeRow.locate_rank, 2);

    const sessRow = db.prepare("SELECT * FROM nav_session WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.equal(sessRow.used_locate, 1);
  } finally {
    cleanup(dbPath);
  }
});

test("locate→rg miss: nav_consume search row", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    c.onToolStart(startEv("l1", "navigator_locate", { query: "foo" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: makeLocateDetails([
      { path: "a.ts", score: 5, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
    ]) }, isError: false });

    c.onToolStart(startEv("b1", "bash", { command: "rg foo" }));
    c.onToolEnd({ toolCallId: "b1", toolName: "bash", result: { details: null, content: "..." }, isError: false });

    const rows = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").all(corrOpts.sessionId) as any[];
    assert.equal(rows.length, 1, "should have one nav_consume row");
    assert.equal(rows[0].kind, "search");
    assert.equal(rows[0].search_tool, "rg");
    assert.equal(rows[0].search_pattern, "foo");
  } finally {
    cleanup(dbPath);
  }
});

test("read of returned path: nav_consume read at rank 1", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    c.onToolStart(startEv("l1", "navigator_locate", { query: "x" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: makeLocateDetails([
      { path: "x.ts", score: 8, signals: { fts: 1, path: 1, symbol: 1, recency: 0 } },
    ]) }, isError: false });

    c.onToolStart(startEv("r1", "read", { path: ROOT + "/x.ts" }));
    c.onToolEnd({ toolCallId: "r1", toolName: "read", result: { content: "file content" }, isError: false });

    const row = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(row, "nav_consume row should exist");
    assert.equal(row.kind, "read");
    assert.equal(row.path, "x.ts");
    assert.equal(row.locate_rank, 1);
  } finally {
    cleanup(dbPath);
  }
});

test("read escaping root: no nav_consume row", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    c.onToolStart(startEv("r1", "read", { path: "../outside" }));
    c.onToolEnd({ toolCallId: "r1", toolName: "read", result: { content: "data" }, isError: false });

    const row = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.equal(row, undefined, "no nav_consume row should be inserted for escaping path");
  } finally {
    cleanup(dbPath);
  }
});

test("unavailable locate: nav_unavailable inserted, no nav_locate", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    c.onToolStart(startEv("l1", "navigator_locate", { query: "anything" }));
    c.onToolEnd({
      toolCallId: "l1",
      toolName: "navigator_locate",
      result: { content: "navigator is unavailable here: not inside a git work tree. Use rg/fd/read to search." },
      isError: false,
    });

    const unavRow = db.prepare("SELECT * FROM nav_unavailable WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(unavRow, "nav_unavailable row should exist");
    assert.equal(unavRow.tool, "navigator_locate");
    assert.equal(unavRow.reason, "non_git");

    const locRow = db.prepare("SELECT * FROM nav_locate WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.equal(locRow, undefined, "no nav_locate row should be inserted");
  } finally {
    cleanup(dbPath);
  }
});

test("slice error: nav_consume with is_error=1", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    c.onToolStart(startEv("s1", "navigator_slice", { path: ROOT + "/err.ts" }));
    c.onToolEnd({
      toolCallId: "s1",
      toolName: "navigator_slice",
      result: { details: { path: ROOT + "/err.ts", range: [1, 5], content: "", content_hash: "h", stale_index: false, unchanged_since_last_read: false } },
      isError: true,
    });

    const row = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(row, "nav_consume row should exist");
    assert.equal(row.kind, "slice");
    assert.equal(row.is_error, 1);
  } finally {
    cleanup(dbPath);
  }
});

test("non-search bash: no nav_consume row", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    c.onToolStart(startEv("b1", "bash", { command: "npm test" }));
    c.onToolEnd({ toolCallId: "b1", toolName: "bash", result: { content: "..." }, isError: false });

    const row = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.equal(row, undefined, "no nav_consume row for non-search bash");
  } finally {
    cleanup(dbPath);
  }
});

test("seq strictly increases and bumpTurn sets turn", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    // First locate at turn 1 (default)
    c.onToolStart(startEv("l1", "navigator_locate", { query: "alpha" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: makeLocateDetails([
      { path: "a.ts", score: 5, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
    ]) }, isError: false });

    // Bump turn to 3
    c.bumpTurn(3);

    // Second locate at turn 3
    c.onToolStart(startEv("l2", "navigator_locate", { query: "beta" }));
    c.onToolEnd({ toolCallId: "l2", toolName: "navigator_locate", result: { details: makeLocateDetails([
      { path: "b.ts", score: 3, signals: { fts: 0, path: 1, symbol: 0, recency: 0 } },
    ]) }, isError: false });

    const rows = db.prepare("SELECT seq, turn FROM nav_locate WHERE session_id = ? ORDER BY seq").all(corrOpts.sessionId) as any[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].turn, 0); // initial turn
    assert.equal(rows[1].turn, 3); // after bumpTurn(3)
    assert.ok(rows[1].seq > rows[0].seq, "seq must strictly increase");
  } finally {
    cleanup(dbPath);
  }
});

test("storeQueries=false: query is null, query_token_count populated", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath, { storeQueries: false });
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    c.onToolStart(startEv("l1", "navigator_locate", { query: "findSomething" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: makeLocateDetails([
      { path: "z.ts", score: 4, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
    ]) }, isError: false });

    const row = db.prepare("SELECT * FROM nav_locate WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(row, "nav_locate row should exist");
    assert.equal(row.query, null, "query should be null when storeQueries=false");
    assert.ok(row.query_token_count > 0, "query_token_count should be populated");
  } finally {
    cleanup(dbPath);
  }
});

test("locate→read of cochange cluster path: cluster_kind='cochange', locate_rank=null", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    // Locate returns a.ts + b.ts as ranked results; rolling.ts is only in the cochange cluster
    const locateDetails = makeLocateDetails(
      [
        { path: "a.ts", score: 9, signals: { fts: 1, path: 0, symbol: 2, recency: 0 } },
        { path: "b.ts", score: 5, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
      ],
      { cluster: { cochange: ["src/rolling.ts"], referrers: [] } },
    );

    c.onToolStart(startEv("l1", "navigator_locate", { query: "rolling" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: locateDetails }, isError: false });

    // Agent reads the cluster path
    c.onToolStart(startEv("r1", "read", { path: ROOT + "/src/rolling.ts" }));
    c.onToolEnd({ toolCallId: "r1", toolName: "read", result: { content: "file content" }, isError: false });

    const row = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(row, "nav_consume row should exist");
    assert.equal(row.kind, "read");
    assert.equal(row.path, "src/rolling.ts");
    assert.equal(row.locate_rank, null, "cluster path must not have a locate_rank");
    assert.equal(row.cluster_kind, "cochange", "cluster path must have cluster_kind=cochange");
  } finally {
    cleanup(dbPath);
  }
});

test("locate→read of referrer cluster path: cluster_kind='referrer', locate_rank=null", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    const locateDetails = makeLocateDetails(
      [{ path: "a.ts", score: 9, signals: { fts: 1, path: 0, symbol: 2, recency: 0 } }],
      { cluster: { cochange: [], referrers: ["src/referrer.ts"] } },
    );

    c.onToolStart(startEv("l1", "navigator_locate", { query: "ref" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: locateDetails }, isError: false });

    c.onToolStart(startEv("r1", "read", { path: ROOT + "/src/referrer.ts" }));
    c.onToolEnd({ toolCallId: "r1", toolName: "read", result: { content: "file content" }, isError: false });

    const row = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(row, "nav_consume row should exist");
    assert.equal(row.locate_rank, null);
    assert.equal(row.cluster_kind, "referrer");
  } finally {
    cleanup(dbPath);
  }
});

test("ranked path wins over cluster: locate_rank set, cluster_kind null", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    // same path in ranked AND cochange — ranked wins
    const locateDetails = makeLocateDetails(
      [{ path: "a.ts", score: 9, signals: { fts: 1, path: 0, symbol: 2, recency: 0 } }],
      { cluster: { cochange: ["a.ts"], referrers: [] } },
    );

    c.onToolStart(startEv("l1", "navigator_locate", { query: "a" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: locateDetails }, isError: false });

    c.onToolStart(startEv("r1", "read", { path: ROOT + "/a.ts" }));
    c.onToolEnd({ toolCallId: "r1", toolName: "read", result: { content: "file content" }, isError: false });

    const row = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(row);
    assert.equal(row.locate_rank, 1, "ranked path must have locate_rank");
    assert.equal(row.cluster_kind, null, "ranked path must not have cluster_kind");
  } finally {
    cleanup(dbPath);
  }
});

test("two locates before any read: earlier locate's ranked/cluster files still attribute", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    // Locate #1 (database query): ranked conn.ts + a cochange cluster file.
    c.onToolStart(startEv("l1", "navigator_locate", { query: "db connection pooling" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: makeLocateDetails(
      [{ path: "db/conn.ts", score: 9, signals: { fts: 1, path: 0, symbol: 2, recency: 0 } }],
      { cluster: { cochange: ["db/model.ts"], referrers: [] } },
    ) }, isError: false });

    // Locate #2 (auth query) fires before any read — this used to clobber locate #1.
    c.onToolStart(startEv("l2", "navigator_locate", { query: "auth middleware" }));
    c.onToolEnd({ toolCallId: "l2", toolName: "navigator_locate", result: { details: makeLocateDetails(
      [{ path: "auth/mw.ts", score: 7, signals: { fts: 1, path: 1, symbol: 0, recency: 0 } }],
    ) }, isError: false });

    // Now the agent reads files from BOTH locates.
    c.onToolStart(startEv("r1", "read", { path: ROOT + "/db/conn.ts" }));
    c.onToolEnd({ toolCallId: "r1", toolName: "read", result: { content: "x" }, isError: false });
    c.onToolStart(startEv("r2", "read", { path: ROOT + "/db/model.ts" }));
    c.onToolEnd({ toolCallId: "r2", toolName: "read", result: { content: "x" }, isError: false });
    c.onToolStart(startEv("r3", "read", { path: ROOT + "/auth/mw.ts" }));
    c.onToolEnd({ toolCallId: "r3", toolName: "read", result: { content: "x" }, isError: false });

    const rows = db.prepare("SELECT path, locate_rank, cluster_kind FROM nav_consume WHERE session_id = ? ORDER BY seq").all(corrOpts.sessionId) as any[];
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));

    assert.equal(byPath["db/conn.ts"].locate_rank, 1, "ranked file from earlier locate keeps its rank");
    assert.equal(byPath["db/conn.ts"].cluster_kind, null);
    assert.equal(byPath["db/model.ts"].cluster_kind, "cochange", "cluster file from earlier locate keeps cluster_kind");
    assert.equal(byPath["db/model.ts"].locate_rank, null);
    assert.equal(byPath["auth/mw.ts"].locate_rank, 1, "most-recent locate still attributes");
  } finally {
    cleanup(dbPath);
  }
});

test("most-recent locate wins on tie: same path ranked in both locates", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    // shared.ts is rank 2 in locate #1, rank 1 in locate #2 → newest wins → rank 1
    c.onToolStart(startEv("l1", "navigator_locate", { query: "first" }));
    c.onToolEnd({ toolCallId: "l1", toolName: "navigator_locate", result: { details: makeLocateDetails([
      { path: "x.ts", score: 9, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
      { path: "shared.ts", score: 5, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
    ]) }, isError: false });
    c.onToolStart(startEv("l2", "navigator_locate", { query: "second" }));
    c.onToolEnd({ toolCallId: "l2", toolName: "navigator_locate", result: { details: makeLocateDetails([
      { path: "shared.ts", score: 8, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
    ]) }, isError: false });

    c.onToolStart(startEv("r1", "read", { path: ROOT + "/shared.ts" }));
    c.onToolEnd({ toolCallId: "r1", toolName: "read", result: { content: "x" }, isError: false });

    const row = db.prepare("SELECT * FROM nav_consume WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.equal(row.locate_rank, 1, "most-recent locate's rank wins");
  } finally {
    cleanup(dbPath);
  }
});

test("telemetry never throws after DB is closed: guard() swallows DB errors", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    // Construct BEFORE closing so the session row is written successfully.
    const c = new TelemetryCorrelator({ ...corrOpts, db });

    // Close the underlying DB — subsequent writes will throw internally.
    db.close();

    let threw = false;
    try {
      c.onToolStart(startEv("l1", "navigator_locate", { query: "anything" }));
      c.onToolEnd({
        toolCallId: "l1",
        toolName: "navigator_locate",
        result: { details: makeLocateDetails([
          { path: "a.ts", score: 5, signals: { fts: 1, path: 0, symbol: 0, recency: 0 } },
        ]) },
        isError: false,
      });
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "TelemetryCorrelator must never propagate DB errors to the caller");
  } finally {
    cleanup(dbPath);
  }
});

test("recordGuard inserts a nav_guard row with mapped action", () => {
  const p = makeTmpPath();
  try {
    const db = openDb(p);
    migrate(db);
    db.prepare("INSERT INTO nav_session (session_id, started_at) VALUES ('s1', 1)").run();
    insertGuard(db, { sessionId: "s1", ts: 10, action: "block", patternKind: "symbol", reason: "scan blocked" });
    insertGuard(db, { sessionId: "s1", ts: 11, action: "warn", patternKind: null, reason: "rg missing" });
    const rows = db.prepare("SELECT action, pattern_kind, reason FROM nav_guard WHERE session_id='s1' ORDER BY ts").all() as any[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, "block");
    assert.equal(rows[0].pattern_kind, "symbol");
    assert.equal(rows[0].reason, "scan blocked");
    assert.equal(rows[1].action, "warn");
    assert.equal(rows[1].pattern_kind, null);
    assert.equal(rows[1].reason, "rg missing");
  } finally {
    cleanup(p);
  }
});

test("correlator.recordGuard writes a nav_guard row for the session", () => {
  const dbPath = makeTmpPath();
  try {
    const opts = makeOpts(dbPath);
    const { db, dbPath: _p, ...corrOpts } = opts;
    const c = new TelemetryCorrelator({ ...corrOpts, db });
    c.recordGuard("block", "symbol", "some reason");
    const row = db.prepare("SELECT action, pattern_kind, reason FROM nav_guard WHERE session_id = ?").get(corrOpts.sessionId) as any;
    assert.ok(row, "nav_guard row should exist");
    assert.equal(row.action, "block");
    assert.equal(row.pattern_kind, "symbol");
    assert.equal(row.reason, "some reason");
  } finally {
    cleanup(dbPath);
  }
});

test("markToolsSelected updates nav_session.tools_selected", () => {
  const p = makeTmpPath();
  try {
    const db = openDb(p);
    migrate(db);
    ensureSession(db, { sessionId: "s2", startedAt: 1, repoRoot: "/r", headSha: null, isWriter: false });
    markToolsSelected(db, "s2", true);
    assert.equal((db.prepare("SELECT tools_selected FROM nav_session WHERE session_id='s2'").get() as any).tools_selected, 1);
    markToolsSelected(db, "s2", false);
    assert.equal((db.prepare("SELECT tools_selected FROM nav_session WHERE session_id='s2'").get() as any).tools_selected, 0);
  } finally {
    cleanup(p);
  }
});
