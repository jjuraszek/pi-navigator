export type Lang = "ruby" | "python" | "ts" | "js" | "prose";

export interface NavigatorConfig {
  enabled: boolean;
  indexDir: string;            // default ~/.pi/pi-navigator-cache
  languages: Lang[];
  maxLocateResults: number;
  indexBatchSize: number;
  indexIdleMs: number;
  cochangeWindowDays: number;
  cochangeMaxCommits: number;
  cochangeMaxFilesPerCommit: number;
  maxFileBytes: number;
  keywordStoplist: string[];    // extra stoplist terms appended to defaults; default []
  keywordMinLength: number;     // drop keyword tokens shorter than this; default 3
  telemetry: boolean;              // master switch; default false
  telemetryStoreQueries: boolean;  // store raw query text; default true
  telemetryTurnCap: number;        // attribution window cap in assistant turns; default 10
  telemetryRetentionDays: number;  // prune rows older than this on DB open; default 30
  persona: boolean;             // M1 always-on persona tier; default true
  promptNudge: boolean;         // M1 freshness-gated nudge tier; default true
  strongHitDirective: boolean;  // M2 locate strong-hit directive; default true
  grepBlock: boolean;           // M3 shell-grep block (bash only); default true
}

export interface FileRecord {
  id: number;
  path: string;                // repo-relative, POSIX
  lang: Lang | null;
  size: number;
  content_hash: string;
  mtime: number;
  last_commit_at: number | null;
  commits_30d: number;
  commits_90d: number;
  indexed_at: number;
  symbols_done: 0 | 1;
}

export interface SymbolRecord {
  name: string;
  kind: "class" | "module" | "method" | "function" | "const";
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
}

export interface ImportEdge { fromPath: string; toPathHint: string; kind: "import" | "require" | "require_relative" | "ruby_const"; }

export interface LocateSignals { fts: number; path: number; symbol: number; recency: number; }
export interface LocateResult {
  path: string; lang: Lang | null; score: number;
  signals: LocateSignals; symbols: { name: string; kind: string; lines: [number, number] }[];
}
export interface LocateCluster { anchor: string; cochange: string[]; referrers: string[]; }
export interface LocateResponse {
  results: LocateResult[]; cluster: LocateCluster | null;
  index: { fresh: boolean; head_behind: number; coverage: number; dirty: boolean };
  // "low" signals weak recall: query terms don't co-occur in any one file, or the
  // top hit has no structural (symbol/path) anchor. Callers should fall back to
  // rg/find/read rather than trust the ranking.
  confidence: "high" | "low";
  // raw inputs to the confidence verdict, surfaced for telemetry/judge calibration
  has_exact_def: boolean;
  used_or_fallback: boolean;
  top_has_anchor: boolean;
}

/**
 * Tool-facing repo gating state.
 * - "booting": git repo, index not yet ready (retryable — try again shortly).
 * - "non_git": cwd is not inside a git work tree (terminal — navigator dormant, use rg/fd).
 * - "disabled": navigator turned off via config (terminal — use rg/fd).
 * - "ready": serving.
 */
export type RepoStatus = "booting" | "non_git" | "disabled" | "ready";

export interface SliceResult {
  path: string; range: [number, number]; content: string;
  content_hash: string; stale_index: boolean; unchanged_since_last_read: boolean;
}

export interface Coverage { total: number; indexed: number; fullCrawlDone: boolean; headBehind: number; }

// worker <-> main messages
export type WorkerInbound =
  | { type: "priority"; paths: string[] }
  | { type: "reindex"; path?: string }
  | { type: "stop" };
export type WorkerOutbound =
  | { type: "coverage"; coverage: Coverage }
  | { type: "log"; level: "info" | "warn"; msg: string };
