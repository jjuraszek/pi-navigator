import type { Coverage } from "./types.ts";

export interface NavigatorState {
  active: boolean;
  coverage: Coverage | null;
  isWriter: boolean;
  reindex(path?: string): void;
}

export interface PiLike {
  registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: any) => Promise<void> }): void;
}

export function parseSub(args: string): { sub: "status" | "reindex"; path?: string } {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  const sub = tokens[0] ?? "";
  if (sub === "reindex") {
    const path = tokens.slice(1).join(" ") || undefined;
    return path !== undefined ? { sub: "reindex", path } : { sub: "reindex" };
  }
  return { sub: "status" };
}

export function registerNavigatorCommand(pi: PiLike, getState: () => NavigatorState): void {
  pi.registerCommand("navigator", {
    description: "Repository navigator: status / reindex [path]",
    handler: async (args: string, ctx: any) => {
      const parsed = parseSub(args);
      const state = getState();

      if (!state.active) {
        ctx.ui.notify("navigator: inactive (not a git repository)", "info");
        return;
      }

      if (parsed.sub === "reindex") {
        if (!state.isWriter) {
          ctx.ui.notify("navigator: this session is read-only — reindex is a no-op", "info");
          return;
        }
        state.reindex(parsed.path);
        const msg = parsed.path
          ? `navigator: reindex queued for ${parsed.path}`
          : "navigator: reindex queued";
        ctx.ui.notify(msg, "info");
        return;
      }

      // status
      const cov = state.coverage;
      let msg: string;
      if (cov === null) {
        msg = `navigator: starting up, writer=${state.isWriter ? "yes" : "no"}`;
      } else {
        const pct = cov.total === 0 ? 0 : Math.round((cov.indexed / cov.total) * 100);
        const crawl = cov.fullCrawlDone ? "done" : "building";
        msg = `navigator: ${cov.indexed}/${cov.total} indexed (${pct}%), full crawl ${crawl}, writer=${state.isWriter ? "yes" : "no"}`;
      }
      ctx.ui.notify(msg, "info");
    },
  });
}
