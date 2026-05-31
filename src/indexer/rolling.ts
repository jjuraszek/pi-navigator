import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Coverage, WorkerInbound, NavigatorConfig } from "../types.ts";
import type { RepoInfo } from "../worktree.ts";
import { acquire } from "../store/lock.ts";
import type { LockHandle } from "../store/lock.ts";

const LOCK_TTL_MS = 60_000;

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

  private _isWriter = false;
  private _lock: LockHandle | null = null;
  private _worker: WorkerLike | null = null;
  private _coverage: Coverage | null = null;
  private _stopped = false;
  private _workerError: string | null = null;

  constructor(config: NavigatorConfig, spawn?: SpawnFn) {
    this._config = config;
    this._spawn = spawn ?? defaultSpawn;
  }

  get isWriter(): boolean {
    return this._isWriter;
  }

  get coverage(): Coverage | null {
    return this._coverage;
  }

  get workerFailed(): boolean {
    return this._workerError !== null;
  }

  start(repo: RepoInfo): void {
    const lockPath = repo.dbPath + ".lock";
    const handle = acquire(lockPath, LOCK_TTL_MS);

    if (handle !== null) {
      this._isWriter = true;
      this._lock = handle;
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
        }
      });
      worker.on("error", (err: Error) => {
        this._workerError = err?.message ?? String(err);
        this._releaseLock();
      });
      worker.on("exit", (code: number) => {
        // code 0 = clean stop; non-zero = unexpected crash
        if (code !== 0) {
          this._workerError = `worker exited with code ${code}`;
          this._releaseLock();
        }
      });
    } else {
      this._isWriter = false;
    }
  }

  postPriority(paths: string[]): void {
    if (!this._isWriter || this._worker === null || paths.length === 0) return;
    this._worker.postMessage({ type: "priority", paths });
  }

  reindex(path?: string): void {
    if (!this._isWriter || this._worker === null) return;
    this._worker.postMessage({ type: "reindex", path });
  }

  refreshLock(): void {
    this._lock?.refresh();
  }

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
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
