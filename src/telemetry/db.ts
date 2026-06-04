import { openDb, type Db } from "../store/db.ts";
import { migrate, pruneOld } from "./schema.ts";

export function telemetryPathFor(indexDbPath: string): string {
  return indexDbPath.replace(/\.db$/, ".telemetry.db");
}

export function openTelemetryDb(indexDbPath: string, retentionDays: number): Db | null {
  try {
    const db = openDb(telemetryPathFor(indexDbPath));
    migrate(db);
    pruneOld(db, retentionDays);
    return db;
  } catch {
    return null;
  }
}
