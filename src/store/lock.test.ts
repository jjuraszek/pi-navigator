import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire } from "./lock.ts";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "nav-lock-")), "index.db.lock");

test("first acquire succeeds, second returns null while held", () => {
  const p = lockPath();
  const h1 = acquire(p, 60_000);
  assert.ok(h1, "first acquire should succeed");
  const h2 = acquire(p, 60_000);
  assert.equal(h2, null, "second acquire should fail while fresh");
  h1!.release();
  const h3 = acquire(p, 60_000);
  assert.ok(h3, "acquire should succeed after release");
  h3!.release();
});

test("stale lock (old mtime) is reclaimable", () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 999999, mtime: Date.now() - 10 * 60_000 }));
  // also backdate the file's own mtime in case the impl uses statSync mtime
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(p, old, old);
  const h = acquire(p, 60_000); // ttl 60s, lock is 10min old → reclaim
  assert.ok(h, "stale lock should be reclaimed");
  h!.release();
});

test("refresh keeps the lock owned", () => {
  const p = lockPath();
  const h = acquire(p, 60_000)!;
  h.refresh();
  assert.equal(acquire(p, 60_000), null, "still held after refresh");
  h.release();
});
