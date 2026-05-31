import { Type } from "typebox";
import { locate } from "./navigator/locate.ts";
import { slice } from "./navigator/slice.ts";
import { VerifiedCache } from "./navigator/verified-cache.ts";
import type { Db } from "./store/db.ts";
import type { NavigatorConfig } from "./types.ts";

export interface NavigatorCtx {
  db: Db;
  root: string;
  cache: VerifiedCache;
  config: NavigatorConfig;
}

export interface PiLike {
  registerTool(def: any): void;
}

const NOT_READY_RESULT = {
  content: [
    {
      type: "text" as const,
      text: "navigator is still indexing or not a git repo — try again in a moment, or run /navigator status",
    },
  ],
};

export function registerTools(pi: PiLike, getCtx: () => NavigatorCtx | null): void {
  // --- navigator_locate ---
  pi.registerTool({
    name: "navigator_locate",
    label: "Navigator Locate",
    description:
      "Search the repository index for files and symbols by name or description. Returns ranked results with co-change neighbours and referrers so you can understand the cluster in one call.",
    promptSnippet: "Find entry points, related files, and who references them",
    promptGuidelines: [
      "Use navigator_locate BEFORE ripgrep or read to orient in this repository: it returns ranked files, what changes with them (co-change), and who imports/requires them (referrers) in a single call.",
      "navigator_locate is the fastest way to answer 'where does X live' or 'what is related to Y' — prefer it over repeated grep/find calls.",
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
      if (!navCtx) return NOT_READY_RESULT;

      const config = {
        ...navCtx.config,
        maxLocateResults: params.limit ?? navCtx.config.maxLocateResults,
      };
      const res = locate(navCtx.db, navCtx.root, params.query, config);

      // Produce a concise text summary
      const lines: string[] = [];
      if (res.results.length === 0) {
        lines.push("No results found.");
      } else {
        lines.push(`Found ${res.results.length} result(s) for "${params.query}":`);
        for (const r of res.results) {
          lines.push(`  ${r.path} (score: ${r.score.toFixed(2)}, lang: ${r.lang ?? "?"}`);
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
      if (!res.index.fresh) {
        lines.push(
          `  [index coverage: ${Math.round(res.index.coverage * 100)}% — still building]`,
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
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
      startLine: Type.Optional(Type.Number({ description: "Start line (0-based, inclusive)" })),
      endLine: Type.Optional(Type.Number({ description: "End line (0-based, inclusive)" })),
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; symbol?: string; startLine?: number; endLine?: number },
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const navCtx = getCtx();
      if (!navCtx) return NOT_READY_RESULT;

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
