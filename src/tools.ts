import { Type } from "typebox";
import { locate } from "./navigator/locate.ts";
import { slice } from "./navigator/slice.ts";
import { isStrongHit, STRONG_HIT_DIRECTIVE } from "./navigator/strong-hit.ts";
import { VerifiedCache } from "./navigator/verified-cache.ts";
import type { Db } from "./store/db.ts";
import type { LocateResponse, NavigatorConfig, RepoStatus } from "./types.ts";

export interface NavigatorCtx {
  db: Db;
  root: string;
  cache: VerifiedCache;
  config: NavigatorConfig;
}

export function renderLocateText(res: LocateResponse, query: string, strongHitDirectiveEnabled: boolean): string {
  const lines: string[] = [];
  if (res.results.length === 0) {
    lines.push("No results found — navigator may not cover this query. Fall back to rg/fd/read before concluding it doesn't exist.");
  } else {
    lines.push(`Found ${res.results.length} result(s) for "${query}":`);
    for (const r of res.results) {
      lines.push(`  ${r.path} (score: ${r.score.toFixed(2)}, lang: ${r.lang ?? "?"})`);
      if (r.symbols.length > 0) {
        lines.push(`    symbols: ${r.symbols.map((s) => s.name).join(", ")}`);
      }
    }
    if (res.cluster) {
      if (res.cluster.cochange.length > 0) {
        lines.push(`  co-changes: ${res.cluster.cochange.join(", ")}`);
      }
      if (res.cluster.referrers.length > 0) {
        lines.push(`  referrers: ${res.cluster.referrers.join(", ")}`);
      }
    }
  }
  if (res.index.dirty) {
    lines.push("  [working tree has uncommitted edits — slices read live bytes, but locate ranking may lag; the writer refreshes in the background]");
  }
  if (res.index.coverage < 1) {
    lines.push(`  [index coverage: ${Math.round(res.index.coverage * 100)}% — still building; some files may be missing]`);
  }
  if (res.index.head_behind > 0) {
    lines.push(`  [index is ${res.index.head_behind} commit(s) behind HEAD — may miss very recent changes; refreshing in background]`);
  }
  if (res.results.length > 0 && res.confidence === "low") {
    lines.push(
      "  [low-confidence: query terms don't co-occur in one file, or the top hit has no symbol/path anchor — verify the top candidate by reading it, or fall back to rg/find/read]",
    );
  }
  if (strongHitDirectiveEnabled && isStrongHit(res)) {
    lines.push(STRONG_HIT_DIRECTIVE);
  }
  return lines.join("\n");
}

export interface PiLike {
  registerTool(def: any): void;
}

function unavailable(status: RepoStatus) {
  let text: string;
  switch (status) {
    case "non_git":
      text = "navigator is unavailable here: not inside a git repository. Use rg/fd/read to search.";
      break;
    case "disabled":
      text = "navigator is disabled in this project's config. Use rg/fd/read to search.";
      break;
    default:
      text = "navigator is still indexing — try again shortly, or use rg/fd/read meanwhile.";
  }
  return { content: [{ type: "text" as const, text }] };
}

export function registerTools(pi: PiLike, getCtx: () => NavigatorCtx | null, getStatus: () => RepoStatus): void {
  // --- navigator_locate ---
  pi.registerTool({
    name: "navigator_locate",
    label: "Navigator Locate",
    description:
      "First step for locating anything in this repo — code OR docs. Returns ranked entry points with co-change neighbours and referrers in one call. Call before rg/find/read for 'where is X', 'where do I start', 'what's related to Y'.",
    promptSnippet: "Find entry points, related files, and who references them",
    promptGuidelines: [
      "Call navigator_locate BEFORE rg/find/read to locate code OR docs: it returns ranked files, co-change, and referrers in a single call.",
      "Use rg only for regex matching or scanning full file contents across many files; use navigator_locate to find where something lives or what relates to it.",
      "Results are ranked candidates, not verified answers. Before asserting a file is THE place for a 'where is X / where do I start' query, open the top candidate (read or navigator_slice) to confirm — ranking is by signals, not by reading the code.",
      "If the result is flagged low-confidence (terms don't co-occur, or no symbol/path anchor matched), do NOT trust the top hit blindly: fall back to rg/find/read or refine the query.",
      "When navigator_locate returns a high-confidence exact match (has_exact_def + top_has_anchor), use navigator_slice on the rank-1 result directly — re-running rg/grep/read to re-find the same symbol is redundant.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Name, symbol, or description to search for" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results to return (default: config value)" }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { query: string; limit?: number },
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const navCtx = getCtx();
      if (!navCtx) return unavailable(getStatus());

      const config = {
        ...navCtx.config,
        maxLocateResults: params.limit ?? navCtx.config.maxLocateResults,
      };
      const res = locate(navCtx.db, navCtx.root, params.query, config);

      return {
        content: [{ type: "text" as const, text: renderLocateText(res, params.query, config.strongHitDirective !== false) }],
        details: res,
      };
    },
  });

  // --- navigator_slice ---
  pi.registerTool({
    name: "navigator_slice",
    label: "Navigator Slice",
    description:
      "Read the exact bytes for a symbol or line range from the current working-tree file. Returns content, a content hash, and a staleness flag. Never reads outside the worktree.",
    promptSnippet: "Read a symbol or line range from a file (hash-verified, worktree-aware)",
    promptGuidelines: [
      "Use navigator_slice to read the exact symbol or line range instead of reading the whole file — it is smaller and hash-verified.",
      "navigator_slice returns unchanged_since_last_read: true when the file has not changed since the last slice; if so, re-reading is unnecessary.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative or absolute path (leading @ is stripped)" }),
      symbol: Type.Optional(Type.String({ description: "Symbol name to slice (class/method/fn)" })),
      startLine: Type.Optional(Type.Number({ description: "Start line (1-based, inclusive)" })),
      endLine: Type.Optional(Type.Number({ description: "End line (1-based, inclusive)" })),
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; symbol?: string; startLine?: number; endLine?: number },
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const navCtx = getCtx();
      if (!navCtx) return unavailable(getStatus());

      // Some models prefix @ to path arguments — strip it.
      const cleanPath = params.path.startsWith("@") ? params.path.slice(1) : params.path;

      try {
        const r = slice(navCtx.db, navCtx.root, navCtx.cache, {
          path: cleanPath,
          symbol: params.symbol,
          startLine: params.startLine,
          endLine: params.endLine,
        });

        const flags: string[] = [];
        if (r.stale_index) flags.push("stale_index");
        if (r.unchanged_since_last_read) flags.push("unchanged_since_last_read");

        return {
          content: [{ type: "text" as const, text: r.content }],
          details: r,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `navigator_slice error: ${msg}` }],
        };
      }
    },
  });
}
