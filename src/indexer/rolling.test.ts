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
