// Integration exercised via index.ts under `pi -e` (Task 5.7).
// node --test cannot easily host a worker_thread with async WASM init,
// so correctness is covered by worker-core.test.ts.

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { WorkerInbound, WorkerOutbound } from "../types.ts";

if (!isMainThread) {
  runWorker().catch((err: unknown) => {
    console.error("[pi-navigator worker] fatal:", err);
    process.exit(1);
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorker(): Promise<void> {
  // Dynamic imports keep the worker self-contained without circular-import issues.
  const { openDb } = await import("../store/db.ts");
  const { migrate } = await import("../store/schema.ts");
  const { initParsers } = await import("./symbols.ts");
  const { deriveBacklog, runIndexPass } = await import("./worker-core.ts");

  const { dbPath, root, config } = workerData as {
    dbPath: string;
    root: string;
    config: import("../types.ts").NavigatorConfig;
  };

  const db = openDb(dbPath);
  migrate(db);
  await initParsers(config.languages);

  // Priority buffer: paths posted by the main thread for urgent re-index
  let priorityBuffer: string[] = [];

  // Handle inbound messages from the main thread
  parentPort!.on("message", (msg: WorkerInbound) => {
    if (msg.type === "priority") {
      priorityBuffer.push(...msg.paths);
    } else if (msg.type === "reindex") {
      if (msg.path) {
        // Re-index a single path — push to priority so it's done next tick.
        // The file's mtime/hash change will be detected by deriveBacklog;
        // forcing it via priority ensures immediate processing.
        priorityBuffer.push(msg.path);
      } else {
        // Full reindex: reset resume cursors so deriveBacklog re-derives everything.
        db.prepare("DELETE FROM meta WHERE key IN ('head_sha_at_index','cochange_scanned_through','full_crawl_done')").run();
        db.prepare("UPDATE files SET symbols_done = 0").run();
      }
    } else if (msg.type === "stop") {
      db.close();
      process.exit(0);
    }
  });

  // Main loop: run index passes until the backlog is empty, then idle-poll.
  for (;;) {
    const priority = priorityBuffer.splice(0);
    const coverage = runIndexPass(db, root, config, {
      batchSize: config.indexBatchSize,
      priority,
    });

    const out: WorkerOutbound = { type: "coverage", coverage };
    parentPort!.postMessage(out);

    const { files: remaining } = deriveBacklog(db, root, config);
    if (remaining.length === 0 && priorityBuffer.length === 0) {
      // Nothing left to do; sleep longer to avoid busy-spinning.
      await sleep(config.indexIdleMs * 20);
    } else {
      await sleep(config.indexIdleMs);
    }
  }
}
