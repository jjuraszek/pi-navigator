import type { Coverage } from "./types.ts";
import type { StatsSummary } from "./telemetry/types.ts";

export interface NavigatorState {
  active: boolean;
  coverage: Coverage | null;
  isWriter: boolean;
  dbPath: string;
  reindex(path?: string): void;
  telemetryStats: (() => { session: StatsSummary; lifetime: StatsSummary } | null) | null;
}

export interface PiLike {
  registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: any) => Promise<void> }): void;
}

export function parseSub(args: string): { sub: "status" | "reindex" | "stats"; path?: string } {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  const sub = tokens[0] ?? "";
  if (sub === "reindex") {
    const path = tokens.slice(1).join(" ") || undefined;
    return path !== undefined ? { sub: "reindex", path } : { sub: "reindex" };
  }
  if (sub === "stats") return { sub: "stats" };
  return { sub: "status" };
}

// Curated subset of StatsSummary for in-session glance; the full field set is
// emitted by the offline judge export (scripts/export-cases.ts).
export function formatStats(label: string, s: StatsSummary): string {
  const pct = (r: number) => `${(r * 100).toFixed(0)}%`;
  const reasons = Object.keys(s.unavailableByReason).length === 0
    ? "none"
    : Object.entries(s.unavailableByReason).map(([k, v]) => `${k}=${v}`).join(" ");
  const lines = [
    `navigator stats [${label}]`,
    `  locate_total              ${s.locateTotal}`,
    `  hit_rate                  ${pct(s.hitRate)}`,
    `  assist_rate               ${pct(s.assistRate)}`,
    `  mrr                       ${s.mrr.toFixed(3)}`,
    `  hit@1                     ${pct(s.hitAt1)}`,
    `  hit@3                     ${pct(s.hitAt3)}`,
    `  hit@5                     ${pct(s.hitAt5)}`,
    `  miss_fallback             ${s.missFallback}`,
    `  miss_fallback_unjustified ${s.missFallbackUnjustified}`,
    `  abandoned                 ${s.abandoned}`,
    `  zero_result_locates       ${s.zeroResultLocates}`,
    `  low_conf_precision        ${pct(s.lowConfPrecision)}`,
    `  bypass_session_rate       ${pct(s.bypassSessionRate)}`,
    `  stale_slice_rate          ${pct(s.staleSliceRate)}`,
    `  unavailable_by_reason     ${reasons}`,
  ];
  return lines.join("\n");
}

export function registerNavigatorCommand(pi: PiLike, getState: () => NavigatorState): void {
  pi.registerCommand("navigator", {
    description: "Repository navigator: status / reindex [path] / stats",
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

      if (parsed.sub === "stats") {
        if (!state.telemetryStats) {
          ctx.ui.notify("navigator telemetry is off (set navigator.telemetry: true to record)", "info");
          return;
        }
        const stats = state.telemetryStats();
        if (!stats) {
          ctx.ui.notify("navigator: telemetry on, no data recorded yet", "info");
          return;
        }
        ctx.ui.notify(formatStats("session", stats.session) + "\n\n" + formatStats("lifetime", stats.lifetime), "info");
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
      if (state.dbPath) msg += `\n  db: ${state.dbPath}`;
      ctx.ui.notify(msg, "info");
    },
  });
}
