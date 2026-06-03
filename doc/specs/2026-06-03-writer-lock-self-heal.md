# Spec: Self-Healing Writer-Lock Election

**Date:** 2026-06-03
**Status:** Draft (awaiting review)
**Worktree/branch:** `.worktrees/lock-promotion-self-heal` / `lock-promotion-self-heal`

## Problem

The navigator writer lock is acquired exactly once, in `RollingIndexer.start()`. There is no retry, promotion, or liveness check. This produces three sticky failure modes:

1. **Read-only is permanent for a session's lifetime.** A session that loses the lock at boot stays `(read-only)` forever. When the writer leaves, the freed lock sits unclaimed until a *brand-new* session starts. A long-lived read-only session rides an arbitrarily stale index.
2. **Idle-holder steal window.** The lock is refreshed only on `turn_end` (TTL = 60s). A live-but-quiet writer's `mtime` goes stale at 60s; a newly booted session reclaims it → two concurrent writers, redundant CPU, no detection by the original holder.
3. **Crashed writer becomes a stuck session.** On worker `error`/`exit≠0`, the lockfile is released immediately, but `_isWriter` stays `true` with `_worker = null`. The session never indexes again and never self-recovers; in a lone session this is terminal until restart.

None of these corrupt data — SQLite (WAL + `busy_timeout`) guards that. These are availability/freshness defects.

## Goal

Make writer election self-healing within a running session:
- A read-only session **promotes** to writer when the lock frees.
- A live writer **never loses** its lock to the idle-steal window.
- A **confirmed-dead** holder is reclaimed immediately (not after the full 60s TTL).
- A **crashed** writer self-recovers (re-acquire + respawn) within one heartbeat.

**Non-goals:** parallel writers (deliberately out of scope — indexing is CPU-bound on parse/hash/git-log, not write-bound; SQLite serialization buys nothing here). No change to slice/locate semantics. No user-facing config surface.

## Invariants preserved

- **Exactly one writer.** Promotion happens only by winning the lock through the existing atomic `acquire()` (O_EXCL + unlink-retry). pid-liveness only *widens* staleness for confirmed-dead same-host holders; it never narrows it.
- **One index = one git repo identity.** Unchanged.
- **DB stores no secret/gitignored content.** Untouched.
- **Slices read live worktree bytes.** Untouched.

## Architecture

Two independent changes sharing one goal:

- **Change A — pid-liveness in `acquire()`** (`src/store/lock.ts`): same-host liveness probe so a dead holder is reclaimed immediately.
- **Change B — heartbeat timer in `RollingIndexer`** (`src/indexer/rolling.ts`): one `.unref()`'d 20s interval, running for every session, that refreshes (writer) or retries acquire/promotes (non-writer), and underpins crash recovery.

The timer is the single mechanism delivering promotion *and* timer-based refresh (the steal-window fix).

## Components & responsibilities

### `src/store/lock.ts`

- `LockData` gains `host: string`. `writeLock()` stamps the hostname alongside `pid` and `mtime`, using the **same hostname function** the staleness check reads with (`deps.hostname ?? os.hostname`) so write and read always agree.
- **Hostname comparison is exact-string, no normalization** (no case-folding, no FQDN-vs-short reconciliation). The only contract is that write and read use the identical function; a mismatch degrades safely to cross-host (liveness skipped, TTL-only), never to a false reclaim.
- Replace `readLockMtime()` with `readLockData(): LockData | null` (returns full record; `null` on missing/corrupt).
- **Backward compatibility — lockfiles missing `host`:** a record parsed from an older writer that lacks `host` is treated as **cross-host** (liveness skipped → mtime/TTL-only). `readLockData` returns the record with `host` absent/`undefined`; the staleness rule's `data.host === hostname()` is then false, so the conservative TTL path applies. No migration, no reclaim regression — at worst an old stale lock waits out the 60s TTL exactly as today.
- New `isProcessAlive(pid: number): boolean` — `process.kill(pid, 0)` → `true`; on error, `ESRCH` → `false` (no such process); **any other error → `true`** (treat as alive). This covers `EPERM` (exists, other user) and platform-specific codes such as Windows' `ERR_UNKNOWN_SIGNAL` — never reclaim on an ambiguous probe.
- `acquire(lockPath, ttlMs, deps?)` where `deps = { isAlive?: (pid: number) => boolean, hostname?: () => string }`, defaulting to `isProcessAlive` and `os.hostname`. New staleness rule:

  ```
  isStale = data === null
         || Date.now() - data.mtime > ttlMs
         || (data.host === hostname() && !isAlive(data.pid))
  ```

  Strictly widens staleness for confirmed-dead same-host holders. Cross-host, host-absent, or alive → unchanged TTL behavior.

### `src/indexer/rolling.ts`

- New state: `_repo: RepoInfo | null`, `_lockPath: string`, `_timer`, `_onPromote`.
- Constructor gains optional 3rd arg `deps?: { acquire?: typeof acquire, heartbeatMs?: number }`. `spawn` stays the 2nd positional arg (existing tests unaffected). `deps.heartbeatMs` is test-only; production uses the constant.
- New constant `LOCK_HEARTBEAT_MS = 20_000` (3× margin under the 60s TTL; internal, not user-configurable, guaranteeing `heartbeat < TTL`).
- Extract `_spawnWorker(): void` — reads `_repo`/`_lockPath` from instance state (no args), constructs the `Worker`, and attaches the `message`/`error`/`exit` wiring. Shared by `start()` and promotion (removes duplication). Synchronous; **throws** if `new Worker(...)` fails, so callers can treat a spawn failure like a crash.
- `start(repo)`:
  1. Early-return if `repo.dbPath === ""` (dormant / non-git) — no lockPath, no timer.
  2. Store `_repo`, derive `_lockPath = repo.dbPath + ".lock"`.
  3. `acquire()` → win: `_isWriter = true`, `_spawnWorker()`; lose: `_isWriter = false`.
  4. **Always** `_timer = setInterval(() => this._heartbeat(), heartbeatMs); _timer.unref()`.
- `_heartbeat()`:
  - `_stopped` → return.
  - `_isWriter && _lock` → `_lock.refresh()` (wall-clock refresh; keeps lock alive while idle).
  - `!_isWriter` → `acquire()`. Win → `_isWriter = true`; try `_spawnWorker()` (on throw: release lock, `_isWriter = false`, return); `_onPromote?.()`. Lose → stay read-only, retry next tick.
- **Crash handler change:** on worker `error`/`exit≠0`, record `_workerError`, release lock (existing), **plus** set `_isWriter = false` and `_worker = null`. `_coverage` is **left intact** as last-known-good (not reset); a respawned worker overwrites it on its first pass, so the footer/`/navigator status` keeps showing the last real percentage rather than blanking. Next heartbeat re-acquires + respawns. A persistent crash loops at 20s cadence; observability is the existing `_workerError` field surfaced via the `workerFailed`/status path (no new signal added). Backoff is out of scope (YAGNI).
- `onPromote(cb)` registration. `stop()` clears the interval (`clearInterval`), sets `_stopped`, terminates worker, releases lock — idempotent.

### `index.ts`

- After `rolling.onCoverage(...)`, wire `rolling.onPromote(() => ui?.setStatus("navigator", "navigator: indexing…"))`. Subsequent `coverage` messages flow through the existing `onCoverage` path (gated on `isWriter`, now true) and update the percentage live.
- Remove the now-redundant `rolling?.refreshLock()` call in the `turn_end` handler (the timer owns refresh). Keep the status update.

## Control flow

**Boot:** `start(repo)` → acquire → spawn if won → always start unref'd 20s heartbeat.

**Heartbeat tick:** stopped→return; writer→`_lock.refresh()`; non-writer→`acquire()`, on win promote (writer + spawn + `onPromote`).

**Promotion→UI:** `onPromote` flips footer to `navigator: indexing…`; live percentage resumes via `onCoverage`.

**Crash→recovery:** record error, release lock, `_isWriter=false`, `_worker=null`; next tick re-acquires + respawns.

**Shutdown:** `clearInterval`, post `stop`, terminate, release lock; `_stopped` guards re-entry.

## Edge cases

| Case | Behavior |
|---|---|
| pid reuse, same host | dead pid reused by unrelated proc → `isAlive` true → no liveness reclaim, fall back to 60s TTL. No regression. |
| Cross-host lock (networked cache FS) | `host` mismatch → liveness skipped → mtime-only TTL. Never reclaims a live remote holder early. |
| `EPERM` from `process.kill` | process exists under another user → treat as **alive** (conservative). |
| Two non-writers promote together | atomic `acquire()` → one wins, other gets `null`. Single-writer holds. |
| Timer keeping process alive | `.unref()` → never blocks pi exit; still fires while session alive (idle refresh works). |
| Spawn throws during promotion | release lock + `_isWriter=false` → retry next tick. |
| `heartbeatMs` vs TTL | internal `LOCK_HEARTBEAT_MS=20_000` guarantees `heartbeat < TTL`; `deps.heartbeatMs` test-only. |
| Non-git / dormant repo | `dbPath===""` → `start()` early-returns; no timer. |
| `stop()` vs in-flight tick | tick fully synchronous; `_stopped` guard + `clearInterval` → no post-stop work. |
| Lockfile written by older version (no `host`) | parsed as host-absent → treated cross-host → liveness skipped, TTL-only. Worst case: old stale lock waits the full 60s TTL (= today). No reclaim regression. |
| Windows / non-`ESRCH` kill error | `isProcessAlive` returns `true` for any error other than `ESRCH` → never reclaim on an ambiguous probe. |
| UI lag during crash recovery | footer may show `indexing…` for up to one heartbeat (≤20s) after a crash before the respawned worker reports, or briefly when a crashed writer hasn't yet flipped to read-only. **Accepted tradeoff** — no dedicated `recovering…` status (YAGNI); `_coverage` stays last-known-good so the percentage doesn't blank. |

## Testing

### `src/store/lock.test.ts` (inject `isAlive` + `hostname`)
- dead same-host pid → reclaimed (acquire succeeds).
- alive same-host pid + fresh mtime → not reclaimed (`null`).
- alive same-host pid + stale mtime → reclaimed via TTL path.
- cross-host + dead pid + fresh mtime → **not** reclaimed (liveness skipped).
- corrupt/missing lockfile → acquire succeeds.
- `writeLock` stamps `host` and `pid`.
- `isProcessAlive`: `true` for `process.pid`; `false` for a never-allocated pid.

### `src/indexer/rolling.test.ts` (inject `deps.acquire` + `spawn`; drive `_heartbeat()` directly — no real timer)
- Boot non-writer (acquire→null): `isWriter` false, no worker. Flip acquire→handle, tick → promoted: `isWriter` true, worker spawned, `onPromote` fired once.
- Boot writer: tick calls `_lock.refresh()` (spy).
- Crash (worker emits `error`/`exit≠0`): `isWriter` false, `_worker` null, lock released, `_coverage` retained as last-known-good; next tick re-acquires + respawns.
- **Concurrent promotion:** two non-writer instances each call `_heartbeat()`; stubbed `acquire` hands the lock to exactly one. Asserts exactly one flips to `isWriter`/spawns/fires `onPromote`, the other stays read-only, and neither throws (single-writer invariant under race).
- `stop()` clears interval; post-stop tick is a no-op.

### Verification
`npm run typecheck` && `node --test` — both green; baseline is 108 tests passing.

## Out of scope

- Parallel writers / work partitioning.
- Crash backoff (constant 20s retry is sufficient and visible).
- User-configurable heartbeat or TTL.
- Changes to locate/slice ranking or storage.
