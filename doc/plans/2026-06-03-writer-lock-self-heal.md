# Self-Healing Writer-Lock Election — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans (or subagent-driven-development) skill to implement this plan task-by-task.

**Goal:** Make navigator writer-lock election self-healing within a running session — read-only sessions promote when the lock frees, live writers never lose the lock to the idle-steal window, dead holders are reclaimed immediately, and a crashed writer respawns itself.

**Architecture:** Two file-disjoint changes. (A) `src/store/lock.ts` gains a same-host pid-liveness check in `acquire()` plus a `host` field on the lockfile. (B) `src/indexer/rolling.ts` gains one `.unref()`'d 20s heartbeat timer that refreshes the lock when writer and retries `acquire()`/promotes when not, plus a crash handler that drops `_isWriter`/nulls `_worker` so the next tick respawns. (C) `index.ts` wires an `onPromote` status flip and drops the now-redundant `turn_end` refresh.

**Tech Stack:** TypeScript, Node 24 native type-stripping (relative imports MUST use `.ts`), `node:worker_threads`, `node:test` + `node:assert/strict`.

**Spec:** `doc/specs/2026-06-03-writer-lock-self-heal.md`

---

## Files

**Modify:**
- `src/store/lock.ts` (add `host` field, `isProcessAlive`, `readLockData`, `deps` param on `acquire`)
- `src/store/lock.test.ts` (liveness + host + backward-compat cases)
- `src/indexer/rolling.ts` (heartbeat timer, `_spawnWorker`, promotion, crash recovery, `onPromote`, `RollingDeps`)
- `src/indexer/rolling.test.ts` (promotion, refresh-via-heartbeat, crash-respawn, concurrent-promotion)
- `index.ts` (`onPromote` wiring; remove redundant `turn_end` `refreshLock()` call)

**Create / Delete:** none.

---

## Wave 1 — Lock liveness + indexer heartbeat (parallel-safe)

Parallel-safe: Task 1 owns `src/store/lock.ts` + `src/store/lock.test.ts`; Task 2 owns `src/indexer/rolling.ts` + `src/indexer/rolling.test.ts`. Disjoint file sets. Task 2's `start()` calls `acquire(lockPath, ttl)` with the existing 2-arg shape (the new 3rd `deps` arg is optional), and Task 2's tests inject their own `acquire` stub — so Task 2 does **not** depend on Task 1.

### Task 1: pid-liveness + `host` field in `acquire()`

**TDD scenario:** Modifying tested code — `src/store/lock.test.ts` already exists; run it first (green baseline), then add new failing tests, then implement.

**Files:**
- Modify: `src/store/lock.ts`
- Test: `src/store/lock.test.ts`

- [ ] **Step 1: Confirm existing lock tests pass (baseline)**

  Run: `node --test src/store/lock.test.ts`
  Expected: PASS (existing cases green before any change).

- [ ] **Step 2: Write failing tests for liveness + host + backward-compat**

  Append to `src/store/lock.test.ts`:

  ```ts
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

  test("isProcessAlive: true for current pid, false for unallocated pid", () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(999999), false);
  });
  ```

  Update the imports at the top of the test file:
  - add `readFileSync` to the `node:fs` import,
  - change `import { acquire } from "./lock.ts";` to `import { acquire, isProcessAlive } from "./lock.ts";`.

- [ ] **Step 3: Run new tests, confirm failure**

  Run: `node --test src/store/lock.test.ts`
  Expected: FAIL — `isProcessAlive` is not exported; `acquire` ignores the 3rd arg; host not stamped.

- [ ] **Step 4: Implement liveness + host in `src/store/lock.ts`**

  Replace the file's top imports, `LockData`, `writeLock`, `readLockMtime`, `tryCreate`, `acquire`, and `makeHandle` with:

  ```ts
  import { openSync, writeFileSync, readFileSync, unlinkSync, closeSync } from "node:fs";
  import { hostname as osHostname } from "node:os";

  export interface LockHandle {
    readonly path: string;
    refresh(): void;
    release(): void;
  }

  export interface AcquireDeps {
    isAlive?: (pid: number) => boolean;
    hostname?: () => string;
  }

  interface LockData {
    pid: number;
    mtime: number;
    host?: string;
  }

  /**
   * Liveness probe via signal 0. ESRCH = no such process (dead). Any other
   * error (EPERM = exists under another user; ERR_UNKNOWN_SIGNAL on Windows)
   * is treated as alive — never reclaim on an ambiguous probe.
   */
  export function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
      return true;
    }
  }

  function writeLock(lockPath: string, mtime: number, host: string): void {
    const data: LockData = { pid: process.pid, mtime, host };
    writeFileSync(lockPath, JSON.stringify(data), "utf8");
  }

  function readLockData(lockPath: string): LockData | null {
    try {
      const raw = readFileSync(lockPath, "utf8");
      const data = JSON.parse(raw) as LockData;
      if (typeof data.mtime === "number") return data;
      return null;
    } catch {
      return null;
    }
  }

  function tryCreate(lockPath: string, host: string): boolean {
    try {
      const fd = openSync(lockPath, "wx");
      writeLock(lockPath, Date.now(), host);
      closeSync(fd);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  /**
   * Attempt to acquire an advisory writer lock at `lockPath`.
   *
   * Staleness widens beyond the TTL only for a confirmed-dead, *same-host*
   * holder (pid-liveness via signal 0). Cross-host or host-absent lockfiles
   * fall back to mtime/TTL-only, since pids are meaningless across machines.
   *
   * `deps` injects `isAlive`/`hostname` for deterministic tests.
   */
  export function acquire(
    lockPath: string,
    ttlMs: number,
    deps?: AcquireDeps,
  ): LockHandle | null {
    const hostname = deps?.hostname ?? osHostname;
    const isAlive = deps?.isAlive ?? isProcessAlive;
    const host = hostname();

    if (tryCreate(lockPath, host)) return makeHandle(lockPath, host);

    const data = readLockData(lockPath);
    const isStale =
      data === null ||
      Date.now() - data.mtime > ttlMs ||
      (data.host === host && !isAlive(data.pid));

    if (!isStale) return null;

    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have already claimed it; fall through to tryCreate.
    }

    if (tryCreate(lockPath, host)) return makeHandle(lockPath, host);
    return null;
  }

  function makeHandle(lockPath: string, host: string): LockHandle {
    let released = false;

    return {
      path: lockPath,

      refresh(): void {
        if (released) return;
        writeLock(lockPath, Date.now(), host);
      },

      release(): void {
        if (released) return;
        released = true;
        try {
          unlinkSync(lockPath);
        } catch {
          // Best-effort: ignore ENOENT or races.
        }
      },
    };
  }
  ```

- [ ] **Step 5: Run lock tests, confirm green**

  Run: `node --test src/store/lock.test.ts`
  Expected: PASS (existing + 7 new cases).

- [ ] **Step 6: Typecheck**

  Run: `npm run typecheck`
  Expected: no errors. (`rolling.ts` still calls `acquire(lockPath, LOCK_TTL_MS)` — valid, `deps` is optional.)

- [ ] **Step 7: Commit**

  ```bash
  git add src/store/lock.ts src/store/lock.test.ts
  git commit -m "lock: reclaim confirmed-dead same-host holders via pid-liveness"
  ```

### Task 2: heartbeat timer, promotion, crash recovery in `RollingIndexer`

**TDD scenario:** Modifying tested code — `src/indexer/rolling.test.ts` exists; run it first, then add failing tests, then implement.

**Files:**
- Modify: `src/indexer/rolling.ts`
- Test: `src/indexer/rolling.test.ts`

- [ ] **Step 1: Confirm existing rolling tests pass (baseline)**

  Run: `node --test src/indexer/rolling.test.ts`
  Expected: PASS.

- [ ] **Step 2: Write failing tests for promotion, heartbeat-refresh, crash-respawn, concurrent promotion**

  Append to `src/indexer/rolling.test.ts`. These drive the private `_heartbeat()` directly (no real timer) and pass a long `heartbeatMs` so the unref'd interval never fires during the test:

  ```ts
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
    function crashableSpawn(): WorkerLike {
      return {
        postMessage: () => {},
        terminate: () => {},
        on: (event, cb) => { if (event === "error") errorCb = cb as (e: Error) => void; },
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

    assert.ok(errorCb, "error handler wired");
    errorCb!(new Error("boom"));
    assert.equal(idx.isWriter, false, "crash drops writer");
    assert.equal(idx.workerFailed, true);

    tick(idx); // lock still acquirable → respawn
    assert.equal(idx.isWriter, true, "heartbeat re-acquires after crash");
    assert.equal(spawned, 2, "worker respawned");
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
  ```

  Confirm the test file imports `acquire` (it already does: `import { acquire } from "../store/lock.ts";`).

- [ ] **Step 3: Run new tests, confirm failure**

  Run: `node --test src/indexer/rolling.test.ts`
  Expected: FAIL — constructor ignores 3rd `deps` arg; no `onPromote`; no `_heartbeat`; crash does not flip `isWriter`.

- [ ] **Step 4: Implement heartbeat + promotion + crash recovery in `src/indexer/rolling.ts`**

  Add the constant and `RollingDeps` after the existing `LOCK_TTL_MS`:

  ```ts
  const LOCK_TTL_MS = 60_000;
  const LOCK_HEARTBEAT_MS = 20_000;

  export interface RollingDeps {
    acquire?: typeof acquire;
    heartbeatMs?: number;
  }
  ```

  Replace the field block + constructor with (adds `_acquire`, `_heartbeatMs`, `_repo`, `_lockPath`, `_timer`, `_onPromote`):

  ```ts
    private readonly _config: NavigatorConfig;
    private readonly _spawn: SpawnFn;
    private readonly _acquire: typeof acquire;
    private readonly _heartbeatMs: number;

    private _isWriter = false;
    private _lock: LockHandle | null = null;
    private _worker: WorkerLike | null = null;
    private _coverage: Coverage | null = null;
    private _stopped = false;
    private _workerError: string | null = null;
    private _onCoverage: ((cov: Coverage) => void) | null = null;
    private _onPromote: (() => void) | null = null;
    private _repo: RepoInfo | null = null;
    private _lockPath = "";
    private _timer: ReturnType<typeof setInterval> | null = null;

    constructor(config: NavigatorConfig, spawn?: SpawnFn, deps?: RollingDeps) {
      this._config = config;
      this._spawn = spawn ?? defaultSpawn;
      this._acquire = deps?.acquire ?? acquire;
      this._heartbeatMs = deps?.heartbeatMs ?? LOCK_HEARTBEAT_MS;
    }
  ```

  Replace the whole `start(repo)` method with the version that delegates spawning to `_spawnWorker` and always starts the heartbeat:

  ```ts
    start(repo: RepoInfo): void {
      if (repo.dbPath === "") return; // dormant / non-git → no lock, no timer
      this._repo = repo;
      this._lockPath = repo.dbPath + ".lock";

      const handle = this._acquire(this._lockPath, LOCK_TTL_MS);
      if (handle !== null) {
        this._isWriter = true;
        this._lock = handle;
        this._spawnWorker();
      } else {
        this._isWriter = false;
      }

      this._timer = setInterval(() => this._heartbeat(), this._heartbeatMs);
      this._timer.unref();
    }

    /** Subscribe to writer promotion (read-only → writer). Fires once per promotion. */
    onPromote(cb: () => void): void {
      this._onPromote = cb;
    }

    private _heartbeat(): void {
      if (this._stopped) return;
      if (this._isWriter) {
        this.refreshLock();
        return;
      }
      const handle = this._acquire(this._lockPath, LOCK_TTL_MS);
      if (handle === null) return;
      this._isWriter = true;
      this._lock = handle;
      try {
        this._spawnWorker();
      } catch (err: unknown) {
        this._workerError = err instanceof Error ? err.message : String(err);
        this._releaseLock();
        this._isWriter = false;
        this._worker = null;
        return;
      }
      this._onPromote?.();
    }

    /** Construct + wire the worker from current repo state. Throws if spawn fails. */
    private _spawnWorker(): void {
      const repo = this._repo;
      if (repo === null) return;
      const worker = this._spawn({
        dbPath: repo.dbPath,
        root: repo.root,
        config: this._config,
      });
      this._worker = worker;
      worker.on("message", (msg: unknown) => {
        if (
          msg !== null &&
          typeof msg === "object" &&
          (msg as Record<string, unknown>)["type"] === "coverage"
        ) {
          this._coverage = (msg as Record<string, unknown>)["coverage"] as Coverage;
          this._onCoverage?.(this._coverage);
        }
      });
      worker.on("error", (err: Error) => {
        this._workerError = err?.message ?? String(err);
        this._handleWorkerExit();
      });
      worker.on("exit", (code: number) => {
        if (code !== 0) {
          this._workerError = `worker exited with code ${code}`;
          this._handleWorkerExit();
        }
      });
    }

    /**
     * Crash recovery: release the lock and drop writer role so the next
     * heartbeat re-acquires + respawns. `_coverage` is retained as
     * last-known-good (not reset) so the footer doesn't blank.
     */
    private _handleWorkerExit(): void {
      if (this._stopped) return;
      this._releaseLock();
      this._isWriter = false;
      this._worker = null;
    }
  ```

  Delete the now-duplicated inline worker-wiring that remains in the old `start()` body (the `worker.on("message"|"error"|"exit", …)` block and its surrounding `if (handle !== null) { … } else { … }`), since `_spawnWorker` + the new `start()` replace it. Leave `postPriority`, `reindex`, `refreshLock`, `stop`, and `_releaseLock` intact, except update `stop()` to clear the timer:

  ```ts
    stop(): void {
      if (this._stopped) return;
      this._stopped = true;
      if (this._timer !== null) {
        clearInterval(this._timer);
        this._timer = null;
      }
      if (this._worker !== null) {
        this._worker.postMessage({ type: "stop" });
        void this._worker.terminate();
        this._worker = null;
      }
      this._releaseLock();
    }
  ```

  Note: `refreshLock()` stays — the heartbeat's writer branch calls it, so it is **not** dead code.

- [ ] **Step 5: Run rolling tests, confirm green**

  Run: `node --test src/indexer/rolling.test.ts`
  Expected: PASS (existing + 4 new cases).

- [ ] **Step 6: Typecheck**

  Run: `npm run typecheck`
  Expected: no errors. (`index.ts` still calls `rolling?.refreshLock()` in `turn_end` — valid; Task 3 removes it.)

- [ ] **Step 7: Commit**

  ```bash
  git add src/indexer/rolling.ts src/indexer/rolling.test.ts
  git commit -m "rolling: heartbeat-driven promotion, lock refresh, and crash respawn"
  ```

---

## Wave 2 — index.ts wire-up

Depends on Wave 1: consumes `RollingIndexer.onPromote` introduced by Task 2.

### Task 3: `onPromote` status flip + drop redundant `turn_end` refresh

**TDD scenario:** Trivial wiring change in `index.ts` (extension entry; not unit-tested in isolation). Verification is typecheck + full suite, not a new unit test.

**Files:**
- Modify: `index.ts` (around lines 121–124 and 165–174)

- [ ] **Step 1: Wire `onPromote` next to the existing `onCoverage` registration**

  In the block that currently reads:

  ```ts
    rolling.onCoverage((cov) => {
      if (rolling?.isWriter) ui?.setStatus("navigator", statusLabel(cov));
    });
    rolling.start(repo);
  ```

  insert an `onPromote` registration before `rolling.start(repo);`:

  ```ts
    rolling.onCoverage((cov) => {
      if (rolling?.isWriter) ui?.setStatus("navigator", statusLabel(cov));
    });
    rolling.onPromote(() => {
      ui?.setStatus("navigator", "navigator: indexing…");
    });
    rolling.start(repo);
  ```

- [ ] **Step 2: Remove the redundant `refreshLock()` call in `turn_end`**

  The heartbeat timer now owns lock refresh. In the `turn_end` handler, delete the `rolling?.refreshLock();` line, keeping the coverage status update:

  ```ts
    pi.on("turn_end", async (_event, ctx) => {
      // Update the status widget with latest coverage if available.
      const cov = rolling?.coverage;
      if (cov && rolling?.isWriter && ctx?.ui) {
        ctx.ui.setStatus("navigator", statusLabel(cov));
      }
    });
  ```

- [ ] **Step 3: Typecheck**

  Run: `npm run typecheck`
  Expected: no errors.

- [ ] **Step 4: Run the full suite**

  Run: `node --test`
  Expected: PASS — baseline 108 + new lock/rolling cases, 0 failures.

- [ ] **Step 5: Commit**

  ```bash
  git add index.ts
  git commit -m "index: flip status on promotion; drop turn-gated lock refresh"
  ```

---

## Verification (whole plan)

```bash
npm run typecheck   # no errors
node --test         # all green (≥108 + new cases)
```

## Notes for the executor

- **`.ts` extensions are mandatory** on every relative import (Node 24 strip-types). Don't drop them.
- The heartbeat tests drive `_heartbeat()` directly via an `as unknown as { _heartbeat(): void }` cast and pass `heartbeatMs: 3_600_000` so the real `.unref()`'d interval never fires mid-test; every test calls `stop()` to clear it.
- Do **not** widen scope to backoff, configurable TTL/heartbeat, or parallel writers — all explicitly out of scope in the spec.
