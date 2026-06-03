import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RollingIndexer, type WorkerLike } from "./rolling.ts";
import { acquire } from "../store/lock.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { RepoInfo } from "../worktree.ts";

function fakeRepo(): RepoInfo {
  const dir = mkdtempSync(join(tmpdir(), "nav-roll-"));
  return { root: dir, repoName: "x", repoId: "abc123abc123", dbPath: join(dir, "x_abc.db"), isGit: true };
}
function fakeSpawn() {
  const sent: unknown[] = [];
  const worker: WorkerLike = {
    postMessage: (m) => { sent.push(m); },
    terminate: () => {},
    on: () => {},
  };
  return { worker, sent, fn: () => worker };
}

test("first indexer is writer + spawns worker; second is read-only", () => {
  const repo = fakeRepo();
  const s1 = fakeSpawn();
  let spawned = 0;
  const a = new RollingIndexer(DEFAULT_CONFIG, (wd) => { spawned++; return s1.fn(); });
  a.start(repo);
  assert.equal(a.isWriter, true);
  assert.equal(spawned, 1);

  const b = new RollingIndexer(DEFAULT_CONFIG, () => { throw new Error("read-only must not spawn"); });
  b.start(repo);
  assert.equal(b.isWriter, false);

  a.postPriority(["app/x.rb"]);
  assert.deepEqual(s1.sent.at(-1), { type: "priority", paths: ["app/x.rb"] });

  b.postPriority(["y.rb"]); // no-op, no throw
  a.stop();
  b.stop();
});

test("coverage message from worker is captured", () => {
  const repo = fakeRepo();
  let messageCb: ((msg: unknown) => void) | undefined;
  const sent: unknown[] = [];
  const worker: WorkerLike = {
    postMessage: (m) => { sent.push(m); },
    terminate: () => {},
    // Capture only the "message" callback; ignore "error" and "exit" for this test.
    on: (event, cb) => { if (event === "message") messageCb = cb as (msg: unknown) => void; },
  };
  const a = new RollingIndexer(DEFAULT_CONFIG, () => worker);
  a.start(repo);
  assert.equal(a.isWriter, true);

  // Simulate the worker emitting a coverage message
  assert.ok(messageCb !== undefined, "on('message') must have been called");
  messageCb({ type: "coverage", coverage: { total: 2, indexed: 1, fullCrawlDone: false, headBehind: 0 } });

  assert.equal(a.coverage?.indexed, 1);
  assert.equal(a.coverage?.total, 2);
  a.stop();
});

test("onCoverage callback fires on every worker coverage message", () => {
  const repo = fakeRepo();
  let messageCb: ((msg: unknown) => void) | undefined;
  const worker: WorkerLike = {
    postMessage: () => {},
    terminate: () => {},
    on: (event, cb) => { if (event === "message") messageCb = cb as (msg: unknown) => void; },
  };
  const a = new RollingIndexer(DEFAULT_CONFIG, () => worker);
  const seen: Array<{ indexed: number; fullCrawlDone: boolean }> = [];
  a.onCoverage((cov) => { seen.push({ indexed: cov.indexed, fullCrawlDone: cov.fullCrawlDone }); });
  a.start(repo);

  assert.ok(messageCb !== undefined);
  messageCb({ type: "coverage", coverage: { total: 2, indexed: 1, fullCrawlDone: false, headBehind: 0 } });
  messageCb({ type: "coverage", coverage: { total: 2, indexed: 2, fullCrawlDone: true, headBehind: 0 } });

  assert.deepEqual(seen, [
    { indexed: 1, fullCrawlDone: false },
    { indexed: 2, fullCrawlDone: true },
  ]);
  a.stop();
});

test("worker crash: workerFailed=true and lock released for next acquirer", () => {
  const repo = fakeRepo();
  // Capture the "exit" callback so we can fire it manually
  const callbacks = new Map<string, (arg: any) => void>();
  const crashWorker: WorkerLike = {
    postMessage: () => {},
    terminate: () => {},
    on: (event, cb) => { callbacks.set(event, cb); },
  };

  const a = new RollingIndexer(DEFAULT_CONFIG, () => crashWorker);
  a.start(repo);
  assert.equal(a.isWriter, true);
  assert.equal(a.workerFailed, false);

  // Simulate an unexpected exit (non-zero code)
  const exitCb = callbacks.get("exit");
  assert.ok(exitCb !== undefined, "exit callback must be registered");
  exitCb(1);

  assert.equal(a.workerFailed, true);

  // Lock must have been released — a second indexer can now acquire it
  const b = new RollingIndexer(DEFAULT_CONFIG, () => crashWorker);
  b.start(repo);
  assert.equal(b.isWriter, true, "second indexer must acquire lock after crash");
  b.stop();
});

// Helper: invoke the private heartbeat deterministically.
function tick(idx: RollingIndexer): void {
  (idx as unknown as { _heartbeat(): void })._heartbeat();
}
const SLOW = { heartbeatMs: 3_600_000 };

test("read-only session promotes on the next heartbeat once the lock frees", () => {
  const repo = fakeRepo();
  let lockFree = false;
  const stubAcquire = ((p: string, ttl: number) =>
    lockFree ? ({ path: p, refresh() {}, release() { lockFree = false; } }) : null) as typeof acquire;
  let spawned = 0;
  let promoted = 0;
  const idx = new RollingIndexer(DEFAULT_CONFIG, () => { spawned++; return fakeSpawn().fn(); }, {
    acquire: stubAcquire,
    ...SLOW,
  });
  idx.onPromote(() => { promoted++; });
  idx.start(repo);
  assert.equal(idx.isWriter, false, "boots read-only while lock held");
  assert.equal(spawned, 0);

  tick(idx); // still held
  assert.equal(idx.isWriter, false);

  lockFree = true;
  tick(idx); // promote
  assert.equal(idx.isWriter, true, "promoted after lock freed");
  assert.equal(spawned, 1, "worker spawned exactly once on promotion");
  assert.equal(promoted, 1, "onPromote fired exactly once");
  idx.stop();
});

test("writer heartbeat refreshes the lock", () => {
  const repo = fakeRepo();
  let refreshed = 0;
  const handle = { path: "x", refresh() { refreshed++; }, release() {} };
  const stubAcquire = (() => handle) as unknown as typeof acquire;
  const idx = new RollingIndexer(DEFAULT_CONFIG, () => fakeSpawn().fn(), { acquire: stubAcquire, ...SLOW });
  idx.start(repo);
  assert.equal(idx.isWriter, true);
  tick(idx);
  tick(idx);
  assert.equal(refreshed, 2, "each writer heartbeat refreshes the held lock");
  idx.stop();
});

test("worker crash drops writer + nulls worker, then heartbeat respawns", () => {
  const repo = fakeRepo();
  let errorCb: ((e: Error) => void) | undefined;
  let messageCb: ((msg: unknown) => void) | undefined;
  function crashableSpawn(): WorkerLike {
    return {
      postMessage: () => {},
      terminate: () => {},
      on: (event, cb) => {
        if (event === "error") errorCb = cb as (e: Error) => void;
        if (event === "message") messageCb = cb as (msg: unknown) => void;
      },
    };
  }
  let lockHandedOut = true;
  const stubAcquire = ((p: string) =>
    lockHandedOut ? ({ path: p, refresh() {}, release() { } }) : null) as typeof acquire;
  let spawned = 0;
  const idx = new RollingIndexer(DEFAULT_CONFIG, () => { spawned++; return crashableSpawn(); }, {
    acquire: stubAcquire,
    ...SLOW,
  });
  idx.start(repo);
  assert.equal(idx.isWriter, true);
  assert.equal(spawned, 1);

  // Deliver a coverage message before the crash so _coverage is populated.
  assert.ok(messageCb, "message handler wired");
  const preCrashCoverage = { total: 10, indexed: 7, fullCrawlDone: false, headBehind: 0 };
  messageCb!({ type: "coverage", coverage: preCrashCoverage });
  assert.deepEqual(idx.coverage, preCrashCoverage, "coverage captured before crash");

  assert.ok(errorCb, "error handler wired");
  errorCb!(new Error("boom"));
  assert.equal(idx.isWriter, false, "crash drops writer");
  assert.equal(idx.workerFailed, true);

  // _coverage must be retained as last-known-good across the crash.
  assert.deepEqual(idx.coverage, preCrashCoverage, "coverage retained as last-known-good after crash");

  tick(idx); // lock still acquirable → respawn
  assert.equal(idx.isWriter, true, "heartbeat re-acquires after crash");
  assert.equal(spawned, 2, "worker respawned");
  assert.equal(idx.workerFailed, false, "workerFailed clears on recovery");
  idx.stop();
});

test("synchronous spawn throw in start() rolls back isWriter and still arms heartbeat", () => {
  const repo = fakeRepo();
  const throwingSpawn = () => { throw new Error("spawn boom"); };
  const idx = new RollingIndexer(DEFAULT_CONFIG, throwingSpawn as any, SLOW);
  idx.start(repo);
  assert.equal(idx.isWriter, false, "spawn throw must roll back isWriter");
  assert.equal(idx.workerFailed, true, "workerFailed set after synchronous throw");
  // Heartbeat timer must be armed: tick() must not throw even though spawn always fails.
  assert.doesNotThrow(() => tick(idx));
  idx.stop();
});

test("concurrent promotion: only one of two read-only sessions wins", () => {
  const repo = fakeRepo();
  let granted = false;
  const stubAcquire = ((p: string) => {
    if (granted) return null;
    granted = true;
    return { path: p, refresh() {}, release() {} };
  }) as typeof acquire;
  const mk = () => new RollingIndexer(DEFAULT_CONFIG, () => fakeSpawn().fn(), { acquire: stubAcquire, ...SLOW });
  // Both boot read-only: first start grabs the single grant, so flip order —
  // force both to start while the lock is "held" by pre-granting once.
  granted = true;
  const a = mk(); a.start(repo);
  const b = mk(); b.start(repo);
  assert.equal(a.isWriter, false);
  assert.equal(b.isWriter, false);

  granted = false; // lock frees: exactly one grant available
  let promotedA = 0, promotedB = 0;
  a.onPromote(() => { promotedA++; });
  b.onPromote(() => { promotedB++; });
  tick(a);
  tick(b);
  assert.equal(promotedA + promotedB, 1, "exactly one session promotes");
  assert.equal(a.isWriter !== b.isWriter, true, "single-writer invariant holds");
  a.stop();
  b.stop();
});
