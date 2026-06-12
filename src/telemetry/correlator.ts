import type { Db } from "../store/db.ts";
import type { ResultMeta, SearchTool, UnavailableReason, GuardAction } from "./types.ts";
import type { GrepPatternKind } from "../grep-guard.ts";
import {
  ensureSession,
  markWriter as dbMarkWriter,
  markUsedLocate,
  insertLocate,
  insertConsume,
  insertUnavailable,
  insertGuard,
  markToolsSelected,
} from "./queries.ts";
import { classifyQuery, detectSearch } from "./detect.ts";
import { toRepoRel } from "../paths.ts";

interface LocateState {
  ranked: string[];
  cluster: Array<{ path: string; kind: "cochange" | "referrer" }>;
}

export interface CorrelatorOpts {
  db: Db;
  sessionId: string;
  root: string;
  sessionCwd: string;
  headSha: string | null;
  isWriter: boolean;
  storeQueries: boolean;
}

export class TelemetryCorrelator {
  /** Cap on retained locate result sets for consume attribution; bounds memory and stale matches. */
  private static readonly MAX_RECENT_LOCATES = 8;

  private readonly db: Db;
  private readonly sessionId: string;
  private readonly root: string;
  private readonly sessionCwd: string;
  private readonly headSha: string | null;
  private readonly storeQueries: boolean;

  private seq = 0;
  private turn = 0;
  private readonly pendingStart = new Map<string, number>();
  private readonly pendingArgs = new Map<string, any>();
  // A consume is attributed to whichever recent locate's ranked/cluster set contains its
  // path. A single slot mis-attributes when several locates fire before their follow-up
  // reads (parallel/batched tool calls): the last locate clobbers earlier result sets, so
  // ranked/cluster files from earlier locates get no rank/cluster_kind. Keep a bounded ring
  // and scan newest-first so the most-recent containing locate wins.
  private readonly recentLocates: LocateState[] = [];
  private warned = false;

  constructor(o: CorrelatorOpts) {
    this.db = o.db;
    this.sessionId = o.sessionId;
    this.root = o.root;
    this.sessionCwd = o.sessionCwd;
    this.headSha = o.headSha;
    this.storeQueries = o.storeQueries;

    this.guard(() => {
      ensureSession(this.db, {
        sessionId: o.sessionId,
        startedAt: Date.now(),
        repoRoot: o.root,
        headSha: o.headSha,
        isWriter: o.isWriter,
      });
    });
  }

  bumpTurn(turnIndex: number): void {
    this.turn = turnIndex;
  }

  markWriter(): void {
    this.guard(() => dbMarkWriter(this.db, this.sessionId));
  }

  recordGuard(action: GuardAction, patternKind: GrepPatternKind | null, reason: string | null): void {
    this.guard(() => insertGuard(this.db, { sessionId: this.sessionId, ts: Date.now(), action, patternKind, reason }));
  }

  recordToolsSelected(selected: boolean): void {
    this.guard(() => markToolsSelected(this.db, this.sessionId, selected));
  }

  onToolStart(ev: { toolCallId: string; toolName: string; args: any }): void {
    this.pendingStart.set(ev.toolCallId, Date.now());
    this.pendingArgs.set(ev.toolCallId, ev.args);
  }

  onToolEnd(ev: { toolCallId: string; toolName: string; result: any; isError: boolean }): void {
    const latencyMs = this.takeLatency(ev.toolCallId);
    const args = this.pendingArgs.get(ev.toolCallId);
    this.pendingArgs.delete(ev.toolCallId);
    this.guard(() => this.dispatch({ ...ev, args: args ?? {} }, latencyMs));
  }

  close(): void {
    // db owned by caller
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[pi-navigator telemetry] error:", e);
      }
    }
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  private takeLatency(id: string): number | null {
    const start = this.pendingStart.get(id);
    if (start === undefined) return null;
    this.pendingStart.delete(id);
    return Date.now() - start;
  }

  private classifyConsume(path: string): { rank: number | null; clusterKind: "cochange" | "referrer" | null } {
    for (let i = this.recentLocates.length - 1; i >= 0; i--) {
      const loc = this.recentLocates[i];
      const rankedIdx = loc.ranked.findIndex((p) => p === path);
      if (rankedIdx !== -1) return { rank: rankedIdx + 1, clusterKind: null };
      const clusterEntry = loc.cluster.find((e) => e.path === path);
      if (clusterEntry) return { rank: null, clusterKind: clusterEntry.kind };
    }
    return { rank: null, clusterKind: null };
  }

  private mapReason(text: unknown): UnavailableReason {
    const s = typeof text === "string" ? text : "";
    if (s.includes("not inside a git") || s.includes("not a git")) return "non_git";
    if (s.includes("disabled")) return "disabled";
    return "booting";
  }

  /** Extract the plain-text reason string from result.content (array or string). */
  private reasonText(result: any): string {
    const c = result?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return (c[0] as any)?.text ?? "";
    return "";
  }

  private dispatch(
    ev: { toolCallId: string; toolName: string; result: any; isError: boolean; args: any },
    latencyMs: number | null,
  ): void {
    const ts = Date.now();
    switch (ev.toolName) {
      case "navigator_locate":
        this.onLocate(ev, ts, latencyMs);
        break;
      case "navigator_slice":
        this.onSlice(ev, ts, latencyMs);
        break;
      case "read":
        this.onRead(ev, ts, latencyMs);
        break;
      case "bash":
        this.onBash(ev, ts, latencyMs);
        break;
      case "grep":
      case "find":
      case "ls":
        this.onSearchTool(ev, ts, latencyMs);
        break;
    }
  }

  private onLocate(ev: any, ts: number, latencyMs: number | null): void {
    const details = ev.result?.details;
    if (details === undefined) {
      insertUnavailable(this.db, {
        sessionId: this.sessionId,
        seq: this.nextSeq(),
        turn: this.turn,
        ts,
        tool: "navigator_locate",
        reason: this.mapReason(this.reasonText(ev.result)),
      });
      return;
    }

    markUsedLocate(this.db, this.sessionId);

    const query: string = ev.args?.query ?? "";
    const { type: queryType, tokenCount: queryTokenCount } = classifyQuery(query);

    const resultsMetadata: ResultMeta[] = ((details.results ?? []) as any[]).map((r: any) => ({
      path: r.path,
      score: r.score,
      signals: {
        fts: r.signals?.fts ?? 0,
        path: r.signals?.path ?? 0,
        symbol: r.signals?.symbol ?? 0,
        recency: r.signals?.recency ?? 0,
      },
    }));

    const clusterDetails = details.cluster ?? null;

    insertLocate(this.db, {
      sessionId: this.sessionId,
      seq: this.nextSeq(),
      turn: this.turn,
      ts,
      headSha: this.headSha,
      query: this.storeQueries ? query : null,
      queryTokenCount,
      queryType,
      limitN: (ev.args?.limit as number | undefined) ?? resultsMetadata.length,
      resultCount: resultsMetadata.length,
      confidence: details.confidence ?? "low",
      hasExactDef: details.has_exact_def ?? false,
      usedOrFallback: details.used_or_fallback ?? false,
      topHasAnchor: details.top_has_anchor ?? false,
      coverage: details.index?.coverage ?? 0,
      dirty: details.index?.dirty ?? false,
      headBehind: details.index?.head_behind ?? 0,
      fresh: details.index?.fresh ?? false,
      latencyMs: latencyMs ?? 0,
      resultsMetadata,
      cochange: clusterDetails?.cochange ?? [],
      referrers: clusterDetails?.referrers ?? [],
    });

    const clusterEntries: Array<{ path: string; kind: "cochange" | "referrer" }> = [
      ...((clusterDetails?.cochange ?? []) as string[]).map((p: string) => ({ path: p, kind: "cochange" as const })),
      ...((clusterDetails?.referrers ?? []) as string[]).map((p: string) => ({ path: p, kind: "referrer" as const })),
    ];
    this.recentLocates.push({ ranked: resultsMetadata.map((r) => r.path), cluster: clusterEntries });
    if (this.recentLocates.length > TelemetryCorrelator.MAX_RECENT_LOCATES) this.recentLocates.shift();
  }

  private onSlice(ev: any, ts: number, latencyMs: number | null): void {
    const details = ev.result?.details;
    if (details === undefined) {
      insertUnavailable(this.db, {
        sessionId: this.sessionId,
        seq: this.nextSeq(),
        turn: this.turn,
        ts,
        tool: "navigator_slice",
        reason: this.mapReason(this.reasonText(ev.result)),
      });
      return;
    }

    const rel = toRepoRel(this.root, details.path, this.sessionCwd);
    const sliceClass = rel ? this.classifyConsume(rel) : { rank: null, clusterKind: null };
    insertConsume(this.db, {
      sessionId: this.sessionId,
      seq: this.nextSeq(),
      turn: this.turn,
      ts,
      kind: "slice",
      path: rel ?? null,
      locateRank: sliceClass.rank,
      clusterKind: sliceClass.clusterKind,
      staleIndex: details.stale_index ?? null,
      unchanged: details.unchanged_since_last_read ?? null,
      searchTool: null,
      searchPattern: null,
      latencyMs,
      isError: ev.isError,
    });
  }

  private onRead(ev: any, ts: number, latencyMs: number | null): void {
    const rawPath: string | undefined = ev.args?.path ?? ev.args?.file_path;
    if (!rawPath) return;
    const rel = toRepoRel(this.root, rawPath, this.sessionCwd);
    if (rel === undefined) return;
    const readClass = this.classifyConsume(rel);
    insertConsume(this.db, {
      sessionId: this.sessionId,
      seq: this.nextSeq(),
      turn: this.turn,
      ts,
      kind: "read",
      path: rel,
      locateRank: readClass.rank,
      clusterKind: readClass.clusterKind,
      staleIndex: null,
      unchanged: null,
      searchTool: null,
      searchPattern: null,
      latencyMs,
      isError: ev.isError,
    });
  }

  private onBash(ev: any, ts: number, latencyMs: number | null): void {
    const d = detectSearch(ev.args?.command ?? "");
    if (!d) return;
    insertConsume(this.db, {
      sessionId: this.sessionId,
      seq: this.nextSeq(),
      turn: this.turn,
      ts,
      kind: "search",
      path: null,
      locateRank: null,
      clusterKind: null,
      staleIndex: null,
      unchanged: null,
      searchTool: d.tool,
      searchPattern: d.pattern,
      latencyMs,
      isError: ev.isError,
    });
  }

  private onSearchTool(ev: any, ts: number, latencyMs: number | null): void {
    insertConsume(this.db, {
      sessionId: this.sessionId,
      seq: this.nextSeq(),
      turn: this.turn,
      ts,
      kind: "search",
      path: null,
      locateRank: null,
      clusterKind: null,
      staleIndex: null,
      unchanged: null,
      searchTool: ev.toolName as SearchTool,
      searchPattern: ev.args?.pattern ?? ev.args?.query ?? null,
      latencyMs,
      isError: ev.isError,
    });
  }
}
