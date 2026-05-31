import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RollingIndexer, type WorkerLike } from "./rolling.ts";
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
  let capturedCb: ((msg: unknown) => void) | undefined;
  const sent: unknown[] = [];
  const worker: WorkerLike = {
    postMessage: (m) => { sent.push(m); },
    terminate: () => {},
    on: (_event, cb) => { capturedCb = cb as (msg: unknown) => void; },
  };
  const a = new RollingIndexer(DEFAULT_CONFIG, () => worker);
  a.start(repo);
  assert.equal(a.isWriter, true);

  // Simulate the worker emitting a coverage message
  assert.ok(capturedCb !== undefined, "on('message') must have been called");
  capturedCb({ type: "coverage", coverage: { total: 2, indexed: 1, fullCrawlDone: false, headBehind: 0 } });

  assert.equal(a.coverage?.indexed, 1);
  assert.equal(a.coverage?.total, 2);
  a.stop();
});
