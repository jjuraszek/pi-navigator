import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Coverage, WorkerInbound, NavigatorConfig } from "../types.ts";
import type { RepoInfo } from "../worktree.ts";
import { acquire } from "../store/lock.ts";
import type { LockHandle } from "../store/lock.ts";

const LOCK_TTL_MS = 60_000;
const LOCK_HEARTBEAT_MS = 20_000;

export interface RollingDeps {
  acquire?: typeof acquire;
  heartbeatMs?: number;
}

export interface WorkerLike {
  postMessage(msg: WorkerInbound): void;
  terminate(): void | Promise<number>;
  // event param is `any` so a single signature covers "message" (Coverage),
  // "error" (Error), and "exit" (number) without a union overload chain.
  on(event: "message" | "error" | "exit", cb: (arg: any) => void): void;
}

export type SpawnFn = (workerData: {
  dbPath: string;
  root: string;
  config: NavigatorConfig;
}) => WorkerLike;

function defaultSpawn(workerData: {
  dbPath: string;
  root: string;
  config: NavigatorConfig;
}): WorkerLike {
  const workerUrl = fileURLToPath(new URL("./worker.ts", import.meta.url));
  return new Worker(workerUrl, { workerData }) as WorkerLike;
}

export class RollingIndexer {
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

  get isWriter(): boolean {
    return this._isWriter;
  }

  get coverage(): Coverage | null {
    return this._coverage;
  }

  /**
   * Subscribe to coverage updates pushed by the worker. Fires on every reported
   * coverage message, so the UI can switch out of "indexing…" the moment the
   * background crawl finishes — without waiting for the next turn_end.
   */
  onCoverage(cb: (cov: Coverage) => void): void {
    this._onCoverage = cb;
  }

  /** Subscribe to writer promotion (read-only → writer). Fires once per promotion. */
  onPromote(cb: () => void): void {
    this._onPromote = cb;
  }

  get workerFailed(): boolean {
    return this._workerError !== null;
  }

  start(repo: RepoInfo): void {
    if (repo.dbPath === "") return;
    if (this._timer !== null) return; // idempotency: prevent double-start
    this._repo = repo;
    this._lockPath = repo.dbPath + ".lock";

    const handle = this._acquire(this._lockPath, LOCK_TTL_MS);
    if (handle !== null) {
      this._isWriter = true;
      this._lock = handle;
      try {
        this._spawnWorker();
      } catch (err: unknown) {
        this._workerError = err instanceof Error ? err.message : String(err);
        this._releaseLock();
        this._isWriter = false;
        this._worker = null;
      }
    } else {
      this._isWriter = false;
    }

    // Always arm the heartbeat so a failed initial spawn gets retried.
    this._timer = setInterval(() => this._heartbeat(), this._heartbeatMs);
    this._timer.unref();
  }

  private _heartbeat(): void {
    if (this._stopped) return;
    if (this._isWriter) {
      this._refreshLock();
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
    this._workerError = null; // clear stale failure signal on successful respawn
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

  postPriority(paths: string[]): void {
    if (!this._isWriter || this._worker === null || paths.length === 0) return;
    this._worker.postMessage({ type: "priority", paths });
  }

  reindex(path?: string): void {
    if (!this._isWriter || this._worker === null) return;
    this._worker.postMessage({ type: "reindex", path });
  }

  private _refreshLock(): void {
    this._lock?.refresh();
  }

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

  /** Release the lock without terminating the worker (used on crash). */
  private _releaseLock(): void {
    if (this._lock !== null) {
      this._lock.release();
      this._lock = null;
    }
  }
}
