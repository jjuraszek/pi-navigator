import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

let warningSuppressed = false;

function suppressSqliteWarning(): void {
  if (warningSuppressed) return;
  warningSuppressed = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    if (text.includes("SQLite is an experimental feature")) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

export type Db = DatabaseSyncType;

let _DatabaseSync: typeof DatabaseSyncType | undefined;

// Lazy-load node:sqlite so we can install the suppressor first.
// createRequire gives us synchronous CJS-style require from ESM context.
function getDatabaseSync(): typeof DatabaseSyncType {
  if (_DatabaseSync) return _DatabaseSync;
  suppressSqliteWarning();
  const _require = createRequire(import.meta.url);
  const mod = _require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
  _DatabaseSync = mod.DatabaseSync;
  return _DatabaseSync;
}

export function openDb(path: string): Db {
  const DS = getDatabaseSync();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DS(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
