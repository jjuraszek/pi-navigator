import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { migrate, SCHEMA_VERSION } from "./schema.ts";

test("migrate creates all tables and is idempotent", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-sch-")), "t.db"));
  migrate(db);
  migrate(db); // idempotent
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r: any) => r.name);
  for (const t of ["meta", "files", "symbols", "cochange", "refs", "search_index"]) assert.ok(tables.includes(t), `missing ${t}`);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
});
