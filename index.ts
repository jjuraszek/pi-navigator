import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { classifyGrepCommand, decideGrepAction } from "./src/grep-guard.ts";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { toRepoRel } from "./src/paths.ts";
import { loadConfig } from "./src/config.ts";
import { resolveRepo, headSha, workingTreeDirty } from "./src/worktree.ts";
import { buildNavigatorPromptGuidance } from "./src/prompt-guidance.ts";
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
import { openTelemetryDb } from "./src/telemetry/db.ts";
import { TelemetryCorrelator } from "./src/telemetry/correlator.ts";
import { aggregate } from "./src/telemetry/stats.ts";
import type { Db } from "./src/store/db.ts";

/**
 * Resolve whether a path argument names a directory. Falls back to a syntactic
 * guess when the path can't be stat'd (e.g. relative to a cwd we don't probe).
 */
function grepProbeDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return p === "." || p === ".." || p.endsWith("/");
  }
}

/** Footer label for the current indexing coverage. */
function statusLabel(cov: Coverage): string {
  const pct = cov.total === 0 ? 0 : Math.round((cov.indexed / cov.total) * 100);
  return cov.fullCrawlDone
    ? `navigator: ${pct}% indexed`
    : `navigator: indexing ${pct}%…`;
}

export default function (pi: ExtensionAPI): void {
  // Per-session state; initialised in session_start, torn down in session_shutdown.
  let state: NavigatorCtx | null = null;
  let rolling: RollingIndexer | null = null;
  let repoStatus: RepoStatus = "booting";
  let dbPathForStatus = "";
  let config = loadConfig();
  let sessionCwd = process.cwd(); // updated in session_start
  // Captured in session_start so background coverage updates can refresh the
  // footer between turns (the worker finishes indexing while the user is idle).
  let ui: { setStatus(key: string, text: string | undefined): void } | null = null;

  // Map toolCallId → path for in-flight edit/write calls
  const pendingArgs = new Map<string, string>();

  let correlator: TelemetryCorrelator | null = null;
  let telemetryDb: Db | null = null;
  let currentSessionId: string | null = null;
  let rgAvailable: boolean | undefined;
  let rgWarnedOnce = false;

  // Register tools and command at load-time with late-bound state getters.
  registerTools(pi, () => state, () => repoStatus);
  pi.on("tool_call", async (event, ctx) => {
    if (!config.grepBlock) return;
    if (!isToolCallEventType("bash", event)) return;

    // Classify first: non-grep commands (cd, npm, …) and non-repo-scan greps
    // return immediately, so the rg probe and block logic never run for them.
    const classification = classifyGrepCommand(event.input.command, grepProbeDir);
    if (!classification.isRepoScan) return;

    const navigatorActive = repoStatus === "ready" && state !== null;

    if (rgAvailable === undefined) {
      try {
        execFileSync("rg", ["--version"], { stdio: "ignore" });
        rgAvailable = true;
      } catch {
        rgAvailable = false;
      }
    }

    const decision = decideGrepAction({
      command: event.input.command,
      probeDir: grepProbeDir,
      rgAvailable,
      navigatorActive,
      classification,
    });

    if (decision.warn && !rgWarnedOnce) {
      rgWarnedOnce = true;
      ctx?.ui?.notify(
        "rg not found \u2014 navigator grep block degraded to warn-only; install ripgrep for faster search",
        "warning",
      );
    }
    if (decision.action === "block") {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });

  registerNavigatorCommand(pi, () => ({
    active: rolling !== null,
    coverage: rolling?.coverage ?? null,
    isWriter: rolling?.isWriter ?? false,
    dbPath: dbPathForStatus,
    reindex: (p?: string) => rolling?.reindex(p),
    telemetryStats: config.telemetry ? () => {
      if (!telemetryDb || !currentSessionId) return null;
      // Aggregation reads SQLite directly; guard so a DB error in /navigator stats
      // can never reject into the command handler (telemetry must never break the session).
      try {
        return {
          session: aggregate(telemetryDb, { turnCap: config.telemetryTurnCap, scope: currentSessionId }),
          lifetime: aggregate(telemetryDb, { turnCap: config.telemetryTurnCap, scope: "lifetime" }),
        };
      } catch {
        return null;
      }
    } : null,
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
      correlator?.markWriter();
    });
    rolling.start(repo);

    if (config.telemetry) {
      telemetryDb = openTelemetryDb(repo.dbPath, config.telemetryRetentionDays);
      if (telemetryDb) {
        try { currentSessionId = ctx.sessionManager.getSessionId(); }
        catch { currentSessionId = randomUUID(); }
        correlator = new TelemetryCorrelator({
          db: telemetryDb, sessionId: currentSessionId, root: repo.root,
          sessionCwd: ctx.cwd, headSha: headSha(repo.root),
          isWriter: rolling.isWriter, storeQueries: config.telemetryStoreQueries,
        });
      }
    }

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
    correlator?.onToolStart(event);
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
    correlator?.onToolEnd(event);
    const p = pendingArgs.get(event.toolCallId);
    pendingArgs.delete(event.toolCallId);
    if (!p || event.isError || !rolling || !state) return;

    const rel = toRepoRel(state.root, p, sessionCwd);
    if (rel) rolling.postPriority([rel]);
  });

  pi.on("turn_start", async (event) => { correlator?.bumpTurn(event.turnIndex); });

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
  // before_agent_start — append readiness-gated navigator guidance
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    if (!state || repoStatus !== "ready") return;
    try {
      const personaPath = fileURLToPath(
        new URL("./prompts/navigator-persona.md", import.meta.url),
      );
      const persona = readFileSync(personaPath, "utf8").trim();
      const coverage = getCoverage(state.db);
      const guidance = buildNavigatorPromptGuidance({
        prompt: event.prompt ?? "",
        persona,
        enablePersona: config.persona,
        enableNudge: config.promptNudge,
        readiness: {
          repoResolved: true,
          selectedTools: event.systemPromptOptions?.selectedTools,
          coverage,
          fullCrawlDone: getMeta(state.db, "full_crawl_done") === "1",
          indexedHead: getMeta(state.db, "head_sha_at_index"),
          currentHead: headSha(state.root),
          dirty: workingTreeDirty(state.root),
          workerFailed: rolling?.workerFailed ?? false,
        },
      });
      if (guidance.length === 0) return;
      return { systemPrompt: [event.systemPrompt, ...guidance].join("\n\n") };
    } catch {
      return undefined;
    }
  });

  // -------------------------------------------------------------------------
  // session_shutdown — tear down worker, release lock, close DB
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    try { telemetryDb?.close(); } catch {}
    telemetryDb = null;
    correlator = null;
    currentSessionId = null;
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
    // Re-probe rg next session: it may be installed/removed between sessions,
    // and the degraded-mode warning should be eligible to fire once again.
    rgAvailable = undefined;
    rgWarnedOnce = false;
    pendingArgs.clear();
  });
}
