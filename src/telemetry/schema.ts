import type { Db } from "../store/db.ts";

export const TELEMETRY_SCHEMA_VERSION = 3;

export const DDL = `
CREATE TABLE IF NOT EXISTS nav_session (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, repo_root TEXT, head_sha TEXT, is_writer INTEGER DEFAULT 0, used_locate INTEGER DEFAULT 0, tools_selected INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS nav_locate (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER NOT NULL, ts INTEGER NOT NULL, head_sha TEXT, query TEXT, query_token_count INTEGER, query_type TEXT, limit_n INTEGER, result_count INTEGER, confidence TEXT, has_exact_def INTEGER, used_or_fallback INTEGER, top_has_anchor INTEGER, coverage REAL, dirty INTEGER, head_behind INTEGER, fresh INTEGER, latency_ms INTEGER, results_metadata TEXT, cochange TEXT, referrers TEXT);
CREATE INDEX IF NOT EXISTS idx_locate_session_seq ON nav_locate(session_id, seq);
CREATE TABLE IF NOT EXISTS nav_consume (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT, locate_rank INTEGER, stale_index INTEGER, unchanged INTEGER, search_tool TEXT, search_pattern TEXT, latency_ms INTEGER, is_error INTEGER DEFAULT 0, cluster_kind TEXT, CHECK (locate_rank IS NULL OR cluster_kind IS NULL));
CREATE INDEX IF NOT EXISTS idx_consume_session_seq ON nav_consume(session_id, seq);
CREATE TABLE IF NOT EXISTS nav_unavailable (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER NOT NULL, ts INTEGER NOT NULL, tool TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nav_guard (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, action TEXT NOT NULL, pattern_kind TEXT, reason TEXT);
CREATE INDEX IF NOT EXISTS idx_guard_session ON nav_guard(session_id);
`;

// v2+ is additive (ALTER/CREATE-IF-NOT-EXISTS); only pre-v2 data is disposable telemetry worth dropping
export function needsRebuild(storedVersion: number, currentVersion: number): boolean {
  return storedVersion > 0 && storedVersion < 2 && storedVersion < currentVersion;
}

export function migrate(db: Db): void {
  // Ensure tmeta exists first so we can read schema_version
  db.exec("CREATE TABLE IF NOT EXISTS tmeta (key TEXT PRIMARY KEY, value TEXT)");

  const row = db
    .prepare("SELECT value FROM tmeta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  const stored = row ? parseInt(row.value, 10) : 0;

  if (needsRebuild(stored, TELEMETRY_SCHEMA_VERSION)) {
    // Telemetry is disposable — drop all nav_* tables and rebuild empty
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        DROP TABLE IF EXISTS nav_unavailable;
        DROP TABLE IF EXISTS nav_consume;
        DROP TABLE IF EXISTS nav_locate;
        DROP TABLE IF EXISTS nav_session;
      `);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  db.exec(DDL);

  // Idempotent ALTER for v2 DBs that predate tools_selected
  const sessionCols = (db.prepare("PRAGMA table_info(nav_session)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!sessionCols.includes("tools_selected")) {
    db.exec("ALTER TABLE nav_session ADD COLUMN tools_selected INTEGER DEFAULT 0");
  }

  db.prepare(
    "INSERT INTO tmeta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(TELEMETRY_SCHEMA_VERSION));
}

export function pruneOld(db: Db, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  db.prepare("DELETE FROM nav_locate WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM nav_consume WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM nav_unavailable WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM nav_guard WHERE ts < ?").run(cutoff);
  db.prepare("DELETE FROM nav_session WHERE started_at < ?").run(cutoff);
  for (const t of ["nav_locate", "nav_consume", "nav_unavailable", "nav_guard"]) {
    db.exec(`DELETE FROM ${t} WHERE session_id NOT IN (SELECT session_id FROM nav_session)`);
  }
}
