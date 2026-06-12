import type { GrepPatternKind } from "../grep-guard.ts";

export type GuardAction = "block" | "warn" | "allow_fallback";
export interface GuardRowInput {
  sessionId: string;
  ts: number;
  action: GuardAction;
  patternKind: GrepPatternKind | null;
  reason: string | null;
}

export type Outcome = "hit" | "miss-fallback" | "abandoned" | "cluster-assist";
export type ConsumeKind = "slice" | "read" | "search";
export type UnavailableReason = "non_git" | "disabled" | "booting";
export type QueryType = "identifier" | "keyword" | "open-ended";
export type SearchTool = "rg" | "grep" | "find" | "fd" | "ag" | "ack" | "git-grep" | "ls";

export interface ResultMeta {
  path: string;
  score: number;
  signals: { fts: number; path: number; symbol: number; recency: number };
}
export interface LocateRowInput {
  sessionId: string; seq: number; turn: number; ts: number; headSha: string | null;
  query: string | null; queryTokenCount: number; queryType: QueryType;
  limitN: number; resultCount: number; confidence: "high" | "low";
  hasExactDef: boolean; usedOrFallback: boolean; topHasAnchor: boolean;
  coverage: number; dirty: boolean; headBehind: number; fresh: boolean;
  latencyMs: number; resultsMetadata: ResultMeta[]; cochange: string[]; referrers: string[];
}
export interface ConsumeRowInput {
  sessionId: string; seq: number; turn: number; ts: number; kind: ConsumeKind;
  path: string | null; locateRank: number | null; staleIndex: boolean | null;
  unchanged: boolean | null; searchTool: SearchTool | null; searchPattern: string | null;
  latencyMs: number | null; isError: boolean;
  clusterKind: "cochange" | "referrer" | null;
}
export interface UnavailableRowInput {
  sessionId: string; seq: number; turn: number; ts: number;
  tool: "navigator_locate" | "navigator_slice"; reason: UnavailableReason;
}
export interface LocateOutcome {
  locateId: number; sessionId: string; confidence: "high" | "low"; resultCount: number;
  outcome: Outcome; justifiedFallback: boolean; consumedRank: number | null; turnsToConsume: number | null;
}
export interface StatsSummary {
  scope: string; locateTotal: number; hitRate: number; assistRate: number; missFallback: number;
  missFallbackUnjustified: number; abandoned: number; zeroResultLocates: number;
  fallbackSearches: number; unavailableByReason: Record<string, number>;
  sessionsTotal: number; sessionsWithLocate: number; bypassSessionRate: number;
  mrr: number; hitAt1: number; hitAt3: number; hitAt5: number;
  lowConfPrecision: number; highConfPrecision: number; medianTurnsToUseful: number;
  staleSliceRate: number; unchangedReadsAvoided: number;
  guardBlocks: number; guardWarns: number; guardAllowFallback: number;
  sessionsToolAvailable: number; sessionsToolUnavailable: number;
}
