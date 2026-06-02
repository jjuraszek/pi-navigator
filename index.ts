import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import { loadConfig } from "./src/config.ts";
import { resolveRepo, headSha } from "./src/worktree.ts";
import { openDb } from "./src/store/db.ts";
import { migrate } from "./src/store/schema.ts";
import { getMeta } from "./src/store/queries.ts";
import { initParsers } from "./src/indexer/symbols.ts";
import { RollingIndexer } from "./src/indexer/rolling.ts";
import { VerifiedCache } from "./src/navigator/verified-cache.ts";
import { registerTools } from "./src/tools.ts";
import type { NavigatorCtx } from "./src/tools.ts";
import { registerNavigatorCommand } from "./src/commands.ts";

/**
 * Converts an absolute or cwd-relative path to a repo-relative POSIX path.
 * Returns undefined if the resolved path escapes the repo root.
 */
function toRepoRel(root: string, p: string, cwd: string): string | undefined {
  const abs = resolve(cwd, p);
  const rel = relative(root, abs);
  // Escaped if it starts with ".." (POSIX join) or on Windows with sep
  const posixRel = rel.split(sep).join(posix.sep);
  if (posixRel.startsWith("..")) return undefined;
  return posixRel;
}

export default function (pi: ExtensionAPI): void {
  // Per-session state; initialised in session_start, torn down in session_shutdown.
  let state: NavigatorCtx | null = null;
  let rolling: RollingIndexer | null = null;
  let config = loadConfig(); // outer config so before_agent_start can read it
  let sessionCwd = process.cwd(); // updated in session_start

  // Map toolCallId → path for in-flight edit/write calls
  const pendingArgs = new Map<string, string>();

  // Register tools and command at load-time with late-bound state getters.
  registerTools(pi, () => state);
  registerNavigatorCommand(pi, () => ({
    active: rolling !== null,
    coverage: rolling?.coverage ?? null,
    isWriter: rolling?.isWriter ?? false,
    reindex: (p?: string) => rolling?.reindex(p),
  }));

  // -------------------------------------------------------------------------
  // session_start — open DB, boot the rolling indexer
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    if (!config.enabled) return;

    sessionCwd = ctx.cwd;
    const repo = resolveRepo(ctx.cwd, config);

    // Git-gating: navigator only activates inside a git repository. Outside one,
    // every signal it relies on (repo identity, co-change, recency) is undefined,
    // and walking an arbitrary cwd would index files with no .gitignore
    // protection. Stay fully dormant: no DB, no worker, tools report inactive.
    if (!repo.isGit) {
      ctx.ui.setStatus("navigator", "navigator: inactive (not a git repo)");
      return;
    }

    // Open a read/write DB handle on the main thread.
    // Bootstrap exception: migrate is idempotent + WAL-serialised; safe for non-writers
    // to ensure schema exists before the lock election and worker spawn.
    const db = openDb(repo.dbPath);
    migrate(db);

    // Parsers are needed on the main thread for slice re-extraction (live symbol lookup).
    await initParsers(config.languages);

    const cache = new VerifiedCache();
    state = { db, root: repo.root, cache, config };

    // Boot the rolling indexer — acquires writer lock, spawns the worker if elected.
    rolling = new RollingIndexer(config);
    rolling.start(repo);

    ctx.ui.setStatus(
      "navigator",
      rolling.isWriter ? "navigator: indexing…" : "navigator: (read-only)",
    );

    // Warn if the index is behind HEAD.
    const currentHead = headSha(repo.root);
    const indexedHead = getMeta(db, "head_sha_at_index");
    if (indexedHead && currentHead && indexedHead !== currentHead) {
      ctx.ui.notify(
        "navigator: index is behind HEAD — refreshing in background",
        "info",
      );
    }
  });

  // -------------------------------------------------------------------------
  // tool_execution_start — capture path args for edit/write tools
  // -------------------------------------------------------------------------
  pi.on("tool_execution_start", async (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const args = event.args as Record<string, unknown> | undefined;
    if (!args) return;
    // Built-in edit uses `path`; write uses `file_path` or `path`.
    const p =
      (typeof args["path"] === "string" ? args["path"] : undefined) ??
      (typeof args["file_path"] === "string" ? args["file_path"] : undefined);
    if (p) pendingArgs.set(event.toolCallId, p);
  });

  // -------------------------------------------------------------------------
  // tool_execution_end — post re-index priority for successfully edited files
  // -------------------------------------------------------------------------
  pi.on("tool_execution_end", async (event) => {
    const p = pendingArgs.get(event.toolCallId);
    pendingArgs.delete(event.toolCallId);
    if (!p || event.isError || !rolling || !state) return;

    const rel = toRepoRel(state.root, p, sessionCwd);
    if (rel) rolling.postPriority([rel]);
  });

  // -------------------------------------------------------------------------
  // turn_end — refresh the advisory lock so we keep writer status alive
  // -------------------------------------------------------------------------
  pi.on("turn_end", async (_event, ctx) => {
    rolling?.refreshLock();
    // Update the status widget with latest coverage if available.
    const cov = rolling?.coverage;
    if (cov && ctx?.ui) {
      const pct = cov.total === 0 ? 0 : Math.round((cov.indexed / cov.total) * 100);
      const label = cov.fullCrawlDone
        ? `navigator: ${pct}% indexed`
        : `navigator: indexing ${pct}%…`;
      ctx.ui.setStatus("navigator", label);
    }
  });

  // -------------------------------------------------------------------------
  // before_agent_start — optionally inject the persona line
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    if (!config.injectPersona) return;
    const active: string[] = event.systemPromptOptions?.selectedTools ?? [];
    if (!active.includes("navigator_locate")) return;
    try {
      const personaPath = fileURLToPath(
        new URL("./prompts/navigator-persona.md", import.meta.url),
      );
      const persona = readFileSync(personaPath, "utf8").trim();
      return { systemPrompt: event.systemPrompt + "\n\n" + persona };
    } catch {
      // If the file is missing, silently skip persona injection.
    }
  });

  // -------------------------------------------------------------------------
  // session_shutdown — tear down worker, release lock, close DB
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    rolling?.stop();
    rolling = null;
    try {
      state?.db.close();
    } catch {
      // Ignore errors closing the DB on shutdown.
    }
    state = null;
    pendingArgs.clear();
  });
}
