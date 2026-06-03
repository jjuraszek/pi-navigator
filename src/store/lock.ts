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
    // If the dead holder's PID was already recycled, isAlive() returns true and we fall back to the
    // 60s TTL — no double-write risk, just slower reclaim in that rare case. Deliberately conservative.
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

    // Unconditional write; no ownership re-check. Only safe while the holder is alive within its TTL.
    // The 20s heartbeat against the 60s TTL (3× budget) ensures a live writer stays current.
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
