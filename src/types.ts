export type Lang = "ruby" | "python" | "ts" | "js" | "prose";

export interface NavigatorConfig {
  enabled: boolean;
  injectPersona: boolean;
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
  index: { fresh: boolean; head_behind: number; coverage: number };
}

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
