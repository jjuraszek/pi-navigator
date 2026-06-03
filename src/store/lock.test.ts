import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, isProcessAlive } from "./lock.ts";

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

test("dead same-host pid is reclaimed even when mtime is fresh", () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 999999, mtime: Date.now(), host: "H" }));
  const h = acquire(p, 60_000, { isAlive: () => false, hostname: () => "H" });
  assert.ok(h, "dead same-host holder should be reclaimed");
  h!.release();
});

test("alive same-host pid with fresh mtime is NOT reclaimed", () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 4242, mtime: Date.now(), host: "H" }));
  const h = acquire(p, 60_000, { isAlive: () => true, hostname: () => "H" });
  assert.equal(h, null, "alive fresh holder must be respected");
});

test("alive same-host pid with stale mtime is reclaimed via TTL", () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 4242, mtime: Date.now() - 10 * 60_000, host: "H" }));
  const h = acquire(p, 60_000, { isAlive: () => true, hostname: () => "H" });
  assert.ok(h, "stale mtime should reclaim regardless of liveness");
  h!.release();
});

test("cross-host dead pid with fresh mtime is NOT reclaimed (liveness skipped)", () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 999999, mtime: Date.now(), host: "OTHER" }));
  const h = acquire(p, 60_000, { isAlive: () => false, hostname: () => "H" });
  assert.equal(h, null, "cross-host liveness must be skipped → TTL-only");
});

test("host-absent lockfile (old version) is treated cross-host → TTL-only", () => {
  const p = lockPath();
  writeFileSync(p, JSON.stringify({ pid: 999999, mtime: Date.now() })); // no host
  const h = acquire(p, 60_000, { isAlive: () => false, hostname: () => "H" });
  assert.equal(h, null, "missing host must not trigger liveness reclaim");
});

test("acquire stamps host and pid into the lockfile", () => {
  const p = lockPath();
  const h = acquire(p, 60_000, { hostname: () => "H" })!;
  const data = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(data.host, "H");
  assert.equal(data.pid, process.pid);
  h.release();
});

test("corrupt-JSON lockfile is treated as null (stale) and is reclaimed", () => {
  const p = lockPath();
  writeFileSync(p, "{not json");
  const h = acquire(p, 60_000);
  assert.ok(h, "corrupt lockfile should be reclaimed");
  h!.release();
});

test("isProcessAlive: true for current pid, false for unallocated pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(99_999_999), false);
});
