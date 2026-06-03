import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import { loadConfig } from "./src/config.ts";
import { resolveRepo, headSha } from "./src/worktree.ts";
import { openDb } from "./src/store/db.ts";
import { migrate } from "./src/store/schema.ts";
import { getMeta, getCoverage } from "./src/store/queries.ts";
import type { RepoStatus, Coverage } from "./src/types.ts";
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
/** Footer label for the current indexing coverage. */
function statusLabel(cov: Coverage): string {
  const pct = cov.total === 0 ? 0 : Math.round((cov.indexed / cov.total) * 100);
  return cov.fullCrawlDone
    ? `navigator: ${pct}% indexed`
    : `navigator: indexing ${pct}%…`;
}

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
  let repoStatus: RepoStatus = "booting";
  let dbPathForStatus = "";
  let config = loadConfig(); // outer config so before_agent_start can read it
  let sessionCwd = process.cwd(); // updated in session_start
  // Captured in session_start so background coverage updates can refresh the
  // footer between turns (the worker finishes indexing while the user is idle).
  let ui: { setStatus(key: string, text: string | undefined): void } | null = null;

  // Map toolCallId → path for in-flight edit/write calls
  const pendingArgs = new Map<string, string>();

  // Register tools and command at load-time with late-bound state getters.
  registerTools(pi, () => state, () => repoStatus);
  registerNavigatorCommand(pi, () => ({
    active: rolling !== null,
    coverage: rolling?.coverage ?? null,
    isWriter: rolling?.isWriter ?? false,
    dbPath: dbPathForStatus,
    reindex: (p?: string) => rolling?.reindex(p),
  }));

  // -------------------------------------------------------------------------
  // session_start — open DB, boot the rolling indexer
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    if (!config.enabled) {
      repoStatus = "disabled";
      return;
    }

    sessionCwd = ctx.cwd;
    const repo = resolveRepo(ctx.cwd, config);

    // Git-gating: navigator only activates inside a git repository. Outside one,
    // every signal it relies on (repo identity, co-change, recency) is undefined,
    // and walking an arbitrary cwd would index files with no .gitignore
    // protection. Stay fully dormant: no DB, no worker, tools report inactive.
    if (!repo.isGit) {
      repoStatus = "non_git";
      ctx.ui.setStatus("navigator", "navigator: inactive (not a git repo)");
      return;
    }

    // Open a read/write DB handle on the main thread.
    // Bootstrap exception: migrate is idempotent + WAL-serialised; safe for non-writers
    // to ensure schema exists before the lock election and worker spawn.
    const db = openDb(repo.dbPath);
    try {
      migrate(db);
      // Parsers are needed on the main thread for slice re-extraction (live symbol lookup).
      await initParsers(config.languages);
    } catch {
      // Init failed: don't leak the DB handle, and leave status retryable.
      try {
        db.close();
      } catch {
        // ignore
      }
      ctx.ui.setStatus("navigator", "navigator: failed to initialise");
      return;
    }

    const cache = new VerifiedCache();
    state = { db, root: repo.root, cache, config };
    dbPathForStatus = repo.dbPath;
    repoStatus = "ready";

    // Footnote only after the index is actually ready — never announce "loaded" on a failed init.
    const cov0 = getCoverage(db);
    ctx.ui.notify(`navigator loaded — ${repo.dbPath} (${cov0.indexed}/${cov0.total} indexed)`, "info");

    // Boot the rolling indexer — acquires writer lock, spawns the worker if elected.
    rolling = new RollingIndexer(config);
    // Push status reactively whenever the worker reports coverage, so the footer
    // leaves "indexing…" as soon as the crawl finishes — not at the next turn_end.
    ui = ctx.ui;
    rolling.onCoverage((cov) => {
      if (rolling?.isWriter) ui?.setStatus("navigator", statusLabel(cov));
    });
    rolling.onPromote(() => {
      ui?.setStatus("navigator", "navigator: indexing…");
    });
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
  // turn_end — update the navigator status widget with the latest coverage
  // -------------------------------------------------------------------------
  pi.on("turn_end", async (_event, ctx) => {
    // Update the status widget with latest coverage if available.
    const cov = rolling?.coverage;
    if (cov && rolling?.isWriter && ctx?.ui) {
      ctx.ui.setStatus("navigator", statusLabel(cov));
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
    repoStatus = "booting";
    dbPathForStatus = "";
    ui = null;
    pendingArgs.clear();
  });
}
