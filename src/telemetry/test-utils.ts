import { openDb } from "../store/db.ts";
import { migrate as migrateIndex } from "../store/schema.ts";
import { upsertFile } from "../store/queries.ts";
import { migrate as migrateTelemetry } from "./schema.ts";
import { TelemetryCorrelator } from "./correlator.ts";
import type { Db } from "../store/db.ts";

export interface TraceEvent {
  turn: number;
  toolName: string;
  args?: any;
  result?: any;
  isError?: boolean;
}

export interface ReplayOpts {
  root?: string;
  sessionId?: string;
}

export interface ReplayResult {
  telemetryDb: Db;
  sessionId: string;
}

/**
 * Drive a real TelemetryCorrelator from an ordered event trace without ever
 * inserting nav_consume rows directly. Exercises detect.ts + classifyConsume.
 */
export function replayTrace(events: TraceEvent[], opts?: ReplayOpts): ReplayResult {
  const root = opts?.root ?? "/tmp/testrepo";
  const sessionId =
    opts?.sessionId ??
    `sess-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const db = openDb(":memory:");
  migrateTelemetry(db);

  const corr = new TelemetryCorrelator({
    db,
    sessionId,
    root,
    sessionCwd: root,
    headSha: null,
    isWriter: true,
    storeQueries: true,
  });

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const toolCallId = `call-${i}`;
    corr.bumpTurn(ev.turn);
    corr.onToolStart({ toolCallId, toolName: ev.toolName, args: ev.args ?? {} });
    corr.onToolEnd({
      toolCallId,
      toolName: ev.toolName,
      result: ev.result ?? {},
      isError: ev.isError ?? false,
    });
  }

  return { telemetryDb: db, sessionId };
}

/**
 * Open an in-memory index DB with a minimal file row per path so that
 * scripts/export-cases.ts's path lookup (getFileByPath) can resolve them.
 */
export function indexDbWith(paths: string[]): Db {
  const db = openDb(":memory:");
  migrateIndex(db);
  const now = Date.now();
  for (const p of paths) {
    upsertFile(db, {
      path: p,
      lang: "ts",
      size: 100,
      content_hash: "dummy",
      mtime: now,
      last_commit_at: null,
      commits_30d: 0,
      commits_90d: 0,
      indexed_at: now,
      symbols_done: 0,
    });
  }
  return db;
}

