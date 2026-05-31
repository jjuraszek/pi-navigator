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

/**
 * Derive which files still need indexing from durable DB state.
 * Pass `enumerated` from a prior `enumerateFiles(root)` call to avoid a
 * second filesystem traversal; when omitted the function enumerates itself.
 */
export function deriveBacklog(
  db: Db,
  root: string,
  config: NavigatorConfig,
  enumerated?: { path: string; lang: Lang | null }[],
): Backlog {
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

  const filesToCheck = enumerated ?? enumerateFiles(root);

  const needsWork: string[] = [];
  for (const { path } of filesToCheck) {
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
// Two-phase processing: phase A shells + phase B extract
// ---------------------------------------------------------------------------

/**
 * Result of Phase A for a single file.
 * null means the file was binary/oversized (already fully stored, skip Phase B).
 */
interface PhaseAResult {
  fileId: number;
  text: string;
  lang: Lang | null;
}

/**
 * Phase A: read bytes, stat, hash; upsert the file row; populate pathToId/pathIndex.
 * Returns null for binary/oversized files (they are fully processed here).
 * Returns a PhaseAResult for text files so Phase B can finish them without re-reading.
 *
 * NOTE: must be called INSIDE an open transaction.
 */
function upsertFileShell(
  db: Db,
  root: string,
  relPath: string,
  config: NavigatorConfig,
  pathIndex: Set<string>,
  pathToId: Map<string, number>,
  now: number,
): PhaseAResult | null {
  const absPath = join(root, relPath);
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return null; // file disappeared
  }

  const st = statSync(absPath);
  const mtime = Math.floor(st.mtimeMs);
  const size = st.size;

  // Binary or oversized: fully store with symbols_done=1 so we never retry.
  if (buf.length > config.maxFileBytes || isBinary(buf)) {
    const fileId = upsertFile(db, {
      path: relPath,
      lang: null,
      size,
      content_hash: hashBuffer(buf.slice(0, 4096)),
      mtime,
      last_commit_at: null,
      commits_30d: 0,
      commits_90d: 0,
      indexed_at: now,
      symbols_done: 1,
    });
    pathToId.set(relPath, fileId);
    pathIndex.add(relPath);
    return null;
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

  // Cache the text so Phase B avoids a second read.
  return { fileId, text, lang };
}

/**
 * Phase B: extract symbols + imports, resolve refs, store everything.
 * Requires pathToId to already contain ALL files being processed this pass
 * (populated by Phase A), so refs resolve regardless of declaration order.
 *
 * NOTE: must be called INSIDE an open transaction.
 *
 * Residual caveat (acceptable, test-only): if `maxFiles` truncated the work
 * list, a ref whose target falls outside the truncation won't resolve this
 * pass — it will be picked up in the next pass once the target is indexed.
 * `maxFiles` is only used in tests; the real worker never sets it.
 */
function extractAndStore(
  db: Db,
  relPath: string,
  fileId: number,
  text: string,
  lang: Lang | null,
  config: NavigatorConfig,
  pathIndex: Set<string>,
  pathToId: Map<string, number>,
): void {
  const isSupported = lang !== null && (config.languages as string[]).includes(lang);
  let symbolNames = "";
  let kindTags = "";

  if (isSupported && lang !== null) {
    const syms = extractSymbols(lang as Lang, text);
    replaceSymbols(db, fileId, syms);
    symbolNames = syms.map((s) => s.name).join(" ");
    const kindSet = new Set(syms.map((s) => s.kind));
    kindTags = Array.from(kindSet).join(" ");

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

  // Only source files (lang !== null) enter the FTS index.  Generated
  // artefacts like package-lock.json have no symbols and their path tokens
  // would pollute BM25 scores for source-navigation queries.
  if (lang !== null) {
    ftsUpsert(db, fileId, relPath, symbolNames, kindTags);
  }
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

  // Enumerate once; reuse the result in deriveBacklog (Fix 3: single traverse).
  const enumerated = enumerateFiles(root);

  // Build path index and id map from what's already in the DB (for ref resolution).
  const allIndexed = getAllFiles(db);
  const pathIndex = new Set<string>(allIndexed.map((r) => r.path));
  const pathToId = new Map<string, number>(allIndexed.map((r) => [r.path, r.id]));

  // Seed pathIndex with all on-disk paths so relative imports can always be
  // resolved by path even before a target file's row exists in the DB.
  for (const { path } of enumerated) {
    pathIndex.add(path);
  }

  // Derive backlog using the already-enumerated list (no second traversal).
  const { files: backlogFiles, needsCochange } = deriveBacklog(db, root, config, enumerated);

  // Build work list: priority first (deduped), then backlog remainder.
  const prioritySet = new Set(priority);
  const workList: string[] = [];
  for (const p of priority) {
    if (pathIndex.has(p)) workList.push(p);
  }
  for (const p of backlogFiles) {
    if (!prioritySet.has(p)) workList.push(p);
  }

  const toProcess = maxFiles !== undefined ? workList.slice(0, maxFiles) : workList;

  // ---- Phase A: upsert all file shells so pathToId is complete ----
  // After this loop, pathToId contains every previously-indexed file PLUS
  // every file being processed this pass, so Phase B ref resolution never
  // misses a target due to processing order.
  //
  // phaseACache maps relPath → PhaseAResult for text files that need Phase B.
  const phaseACache = new Map<string, PhaseAResult>();

  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const relPath of batch) {
        const result = upsertFileShell(db, root, relPath, config, pathIndex, pathToId, now);
        if (result !== null) {
          phaseACache.set(relPath, result);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
  }

  // ---- Phase B: extract symbols + imports + refs for all text files ----
  // pathToId is now fully populated, so ref resolution works regardless of
  // the order files were processed in Phase A.
  const phaseAKeys = Array.from(phaseACache.keys());
  for (let i = 0; i < phaseAKeys.length; i += batchSize) {
    const batch = phaseAKeys.slice(i, i + batchSize);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const relPath of batch) {
        const cached = phaseACache.get(relPath)!;
        extractAndStore(
          db,
          relPath,
          cached.fileId,
          cached.text,
          cached.lang,
          config,
          pathIndex,
          pathToId,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
  }

  // Co-change + recency (when needed).
  if (needsCochange) {
    buildCochange(db, root, config);
  }

  // Mark full crawl done if backlog is empty after this pass.
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

  // cochange_scanned_through marks the full-scan as done (not an incremental
  // resume cursor — the full co-change graph is rebuilt whenever head changes).
  const oldest = commits.at(-1);
  setMeta(db, "cochange_scanned_through", oldest?.sha ?? "done");
  setMeta(db, "head_sha_at_index", headSha(root) ?? "");
}
