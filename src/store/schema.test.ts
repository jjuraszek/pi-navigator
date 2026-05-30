import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { migrate, SCHEMA_VERSION } from "./schema.ts";

test("deleting a file cascades to cochange", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-cc-")), "t.db"));
  migrate(db);
  db.exec("INSERT INTO files(id,path,content_hash,indexed_at) VALUES (1,'a.rb','h1',1),(2,'b.rb','h2',1)");
  db.exec("INSERT INTO cochange(file_a,file_b,weight) VALUES (1,2,3.0)");
  db.exec("DELETE FROM files WHERE id=1");
  const n = (db.prepare("SELECT COUNT(*) AS c FROM cochange").get() as { c: number }).c;
  assert.equal(n, 0);
});

test("migrate creates all tables and is idempotent", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-sch-")), "t.db"));
  migrate(db);
  migrate(db); // idempotent
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r: any) => r.name);
  for (const t of ["meta", "files", "symbols", "cochange", "refs", "search_index"]) assert.ok(tables.includes(t), `missing ${t}`);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
});
