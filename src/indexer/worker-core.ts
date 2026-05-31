import { readFileSync, statSync } from "node:fs";
import { dirname, join, basename, extname, posix } from "node:path";
import type { Db } from "../store/db.ts";
import type { NavigatorConfig, Coverage, Lang } from "../types.ts";
import {
  upsertFile,
  getAllFiles,
  setSymbolsDone,
  replaceSymbols,
  replaceRefs,
  upsertCochange,
  ftsUpsert,
  setMeta,
  getMeta,
  getCoverage,
} from "../store/queries.ts";
import { hashBuffer, isBinary } from "./hash.ts";
import { enumerateFiles, langOf } from "./walk.ts";
import { readLog, foldSignals } from "./git.ts";
import { extractSymbols, extractImports } from "./symbols.ts";
import { headSha } from "../worktree.ts";

// ---------------------------------------------------------------------------
// Backlog derivation (resumable: derived from DB state, not in-memory queue)
// ---------------------------------------------------------------------------

export interface Backlog {
  files: string[];
  needsCochange: boolean;
}

export function deriveBacklog(db: Db, root: string, config: NavigatorConfig): Backlog {
  // Build a map of what's already indexed
  const indexed = new Map<
    string,
    { mtime: number; size: number; symbols_done: 0 | 1 }
  >();
  for (const row of getAllFiles(db)) {
    indexed.set(row.path, {
      mtime: row.mtime,
      size: row.size,
      symbols_done: row.symbols_done,
    });
  }

  const needsWork: string[] = [];
  for (const { path } of enumerateFiles(root)) {
    const absPath = join(root, path);
    let st;
    try {
      st = statSync(absPath);
    } catch {
      continue; // file disappeared between enumeration and stat
    }
    const mtime = Math.floor(st.mtimeMs);
    const size = st.size;
    const stored = indexed.get(path);
    if (!stored || stored.mtime !== mtime || stored.size !== size || stored.symbols_done === 0) {
      needsWork.push(path);
    }
  }

  const storedHead = getMeta(db, "head_sha_at_index");
  const currentHead = headSha(root);
  const fullCrawlDone = getMeta(db, "full_crawl_done") === "1";
  const cochangeCursor = getMeta(db, "cochange_scanned_through");
  const needsCochange = storedHead !== currentHead || !fullCrawlDone || !cochangeCursor;

  return { files: needsWork, needsCochange };
}

// ---------------------------------------------------------------------------
// Import hint resolution
// ---------------------------------------------------------------------------

// Known source extensions to try when resolving a hint
const SOURCE_EXTS = [".rb", ".py", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];

/**
 * Try to resolve an import hint to a repo-relative POSIX path.
 * Returns the matching path string or undefined.
 *
 * Strategy (PoC):
 * 1. require_relative / relative hints (starts with "." or kind==="require_relative"):
 *    resolve relative to fromDir, then try adding known extensions.
 * 2. Absolute/bare hints: match by basename stem against all indexed paths.
 */
function resolveImport(
  hint: string,
  kind: string,
  fromPath: string,   // repo-relative
  pathIndex: Set<string>,
): string | undefined {
  const fromDir = dirname(fromPath);

  const isRelative = kind === "require_relative" || hint.startsWith(".");
  if (isRelative) {
    // Candidate without extension change
    const base = posix.normalize(posix.join(fromDir === "." ? "" : fromDir, hint));
    // Try exact first (already has extension)
    if (pathIndex.has(base)) return base;
    // Try appending known extensions
    for (const ext of SOURCE_EXTS) {
      const candidate = base + ext;
      if (pathIndex.has(candidate)) return candidate;
    }
    // Try as directory index
    for (const ext of SOURCE_EXTS) {
      const candidate = posix.join(base, `index${ext}`);
      if (pathIndex.has(candidate)) return candidate;
    }
    return undefined;
  }

  // Bare/absolute module name: match by stem of the last segment
  const stem = basename(hint, extname(hint)) || hint;
  for (const p of pathIndex) {
    const pStem = basename(p, extname(p));
    if (pStem === stem) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-file processing helper
// ---------------------------------------------------------------------------

function processFile(
  db: Db,
  root: string,
  relPath: string,
  config: NavigatorConfig,
  pathIndex: Set<string>,
  pathToId: Map<string, number>,
  now: number,
): void {
  const absPath = join(root, relPath);
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return; // file disappeared
  }

  const st = statSync(absPath);
  const mtime = Math.floor(st.mtimeMs);
  const size = st.size;

  // Skip oversized or binary files — upsert with symbols_done=1 so they
  // are not retried on every pass.
  if (buf.length > config.maxFileBytes || isBinary(buf)) {
    const fileId = upsertFile(db, {
      path: relPath,
      lang: null,
      size,
      content_hash: hashBuffer(buf.slice(0, 4096)), // cheap hash of first chunk
      mtime,
      last_commit_at: null,
      commits_30d: 0,
      commits_90d: 0,
      indexed_at: now,
      symbols_done: 1, // mark done to avoid infinite retry
    });
    pathToId.set(relPath, fileId);
    pathIndex.add(relPath);
    return;
  }

  const text = buf.toString("utf8");
  const content_hash = hashBuffer(buf);
  const lang = langOf(relPath);

  const fileId = upsertFile(db, {
    path: relPath,
    lang,
    size,
    content_hash,
    mtime,
    last_commit_at: null,
    commits_30d: 0,
    commits_90d: 0,
    indexed_at: now,
    symbols_done: 0,
  });
  pathToId.set(relPath, fileId);
  pathIndex.add(relPath);

  // Symbol + import extraction (only for supported languages)
  const isSupported = lang !== null && (config.languages as string[]).includes(lang);
  let symbolNames = "";
  let kindTags = "";

  if (isSupported && lang !== null) {
    const syms = extractSymbols(lang as Lang, text);
    replaceSymbols(db, fileId, syms);
    symbolNames = syms.map((s) => s.name).join(" ");
    const kindSet = new Set(syms.map((s) => s.kind));
    kindTags = Array.from(kindSet).join(" ");

    // Resolve import edges
    const rawImports = extractImports(lang as Lang, text);
    const edges: { dstFileId: number; kind: string }[] = [];
    for (const { toPathHint, kind } of rawImports) {
      const resolved = resolveImport(toPathHint, kind, relPath, pathIndex);
      if (!resolved || resolved === relPath) continue;
      const dstId = pathToId.get(resolved);
      if (dstId === undefined) continue;
      edges.push({ dstFileId: dstId, kind });
    }
    replaceRefs(db, fileId, edges);
  }

  ftsUpsert(db, fileId, relPath, symbolNames, kindTags);
  setSymbolsDone(db, fileId, 1);
}

// ---------------------------------------------------------------------------
// Main index pass (sync)
// ---------------------------------------------------------------------------

export interface RunOpts {
  batchSize: number;
  priority: string[];
  maxFiles?: number;
}

export function runIndexPass(
  db: Db,
  root: string,
  config: NavigatorConfig,
  opts: RunOpts,
): Coverage {
  const now = Date.now();
  const { batchSize, priority, maxFiles } = opts;

  // Build path index and id map from what's already in the DB (for ref resolution)
  const allIndexed = getAllFiles(db);
  const pathIndex = new Set<string>(allIndexed.map((r) => r.path));
  const pathToId = new Map<string, number>(allIndexed.map((r) => [r.path, r.id]));

  // Also add all enumerated files to pathIndex (for resolving refs to not-yet-indexed files)
  // We need to know candidate paths exist on disk even before indexing them.
  const enumerated = enumerateFiles(root);
  for (const { path } of enumerated) {
    pathIndex.add(path);
  }

  // Derive backlog
  const { files: backlogFiles, needsCochange } = deriveBacklog(db, root, config);

  // Build the work list: priority first (deduped), then backlog remainder
  const prioritySet = new Set(priority);
  const workList: string[] = [];

  for (const p of priority) {
    if (pathIndex.has(p)) workList.push(p);
  }
  for (const p of backlogFiles) {
    if (!prioritySet.has(p)) workList.push(p);
  }

  // Truncate if maxFiles is set
  const toProcess = maxFiles !== undefined ? workList.slice(0, maxFiles) : workList;

  // Process in batches (each batch is one BEGIN IMMEDIATE … COMMIT)
  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const relPath of batch) {
        processFile(db, root, relPath, config, pathIndex, pathToId, now);
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
  }

  // Co-change + recency (when needed and files exist in index)
  if (needsCochange) {
    buildCochange(db, root, config);
  }

  // Mark full crawl done if backlog is empty after this pass
  if (backlogFiles.length === 0 || (maxFiles === undefined && toProcess.length === backlogFiles.length)) {
    setMeta(db, "full_crawl_done", "1");
  }

  const { total, indexed } = getCoverage(db);
  const fullCrawlDone = getMeta(db, "full_crawl_done") === "1";
  return { total, indexed, fullCrawlDone, headBehind: 0 };
}

// ---------------------------------------------------------------------------
// Co-change + recency builder
// ---------------------------------------------------------------------------

function buildCochange(db: Db, root: string, config: NavigatorConfig): void {
  const commits = readLog(root, config.cochangeMaxCommits);
  if (commits.length === 0) return;

  const now = Date.now() / 1000; // seconds — matches git %ct
  const { recency, cochange } = foldSignals(commits, {
    now,
    windowDays: config.cochangeWindowDays,
    maxFilesPerCommit: config.cochangeMaxFilesPerCommit,
  });

  // Build path→id lookup from current DB state
  const allRows = getAllFiles(db);
  const pathToId = new Map<string, number>(allRows.map((r) => [r.path, r.id]));

  // Inline recency update (can't add a new exported query — update inline)
  const updateRecency = db.prepare(
    "UPDATE files SET last_commit_at=?, commits_30d=?, commits_90d=? WHERE path=?",
  );

  try {
    db.exec("BEGIN IMMEDIATE");
    for (const [path, rec] of recency) {
      if (pathToId.has(path)) {
        updateRecency.run(rec.last, rec.c30, rec.c90, path);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }

  // Upsert co-change weights
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const [key, weight] of cochange) {
      const [pathA, pathB] = key.split("\u0000");
      const idA = pathToId.get(pathA);
      const idB = pathToId.get(pathB);
      if (idA !== undefined && idB !== undefined) {
        upsertCochange(db, idA, idB, weight);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }

  // Advance the cursor
  const oldest = commits.at(-1);
  setMeta(db, "cochange_scanned_through", oldest?.sha ?? "done");
  setMeta(db, "head_sha_at_index", headSha(root) ?? "");
}
