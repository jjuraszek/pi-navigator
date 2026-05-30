import { openSync, writeFileSync, readFileSync, unlinkSync, closeSync } from "node:fs";

export interface LockHandle {
  readonly path: string;
  refresh(): void;
  release(): void;
}

interface LockData {
  pid: number;
  mtime: number;
}

function writeLock(lockPath: string, mtime: number): void {
  const data: LockData = { pid: process.pid, mtime };
  writeFileSync(lockPath, JSON.stringify(data), "utf8");
}

function readLockMtime(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw) as LockData;
    if (typeof data.mtime === "number") return data.mtime;
    return null;
  } catch {
    return null;
  }
}

function tryCreate(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    writeLock(lockPath, Date.now());
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
 * Staleness is determined by the JSON `mtime` field inside the lockfile
 * (survives file copies; falls back to treating corrupt content as stale).
 *
 * Returns a LockHandle on success, or null if a fresh lock is held elsewhere.
 */
export function acquire(lockPath: string, ttlMs: number): LockHandle | null {
  // Fast path: try exclusive create.
  if (tryCreate(lockPath)) return makeHandle(lockPath);

  // File exists — check staleness via stored JSON mtime.
  const storedMtime = readLockMtime(lockPath);
  const isStale = storedMtime === null || Date.now() - storedMtime > ttlMs;

  if (!isStale) return null; // Fresh lock held by someone else.

  // Stale — reclaim: unlink then retry exclusive create once.
  try {
    unlinkSync(lockPath);
  } catch {
    // Another process may have already claimed it; fall through to tryCreate.
  }

  if (tryCreate(lockPath)) return makeHandle(lockPath);

  // Another process won the race after our unlink.
  return null;
}

function makeHandle(lockPath: string): LockHandle {
  let released = false;

  return {
    path: lockPath,

    refresh(): void {
      if (released) return;
      writeLock(lockPath, Date.now());
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
