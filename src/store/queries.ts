import type { Db } from "./db.ts";
import type { FileRecord, SymbolRecord } from "../types.ts";

// ---------------------------------------------------------------------------
// File upsert / lookup
// ---------------------------------------------------------------------------

/**
 * Insert a file row, or update all mutable columns on path conflict.
 * Returns the canonical id for that path (same value whether insert or update).
 */
export function upsertFile(db: Db, rec: Omit<FileRecord, "id">): number {
  // RETURNING works on node:sqlite; verify at runtime below.
  const row = db
    .prepare(
      `INSERT INTO files
         (path, lang, size, content_hash, mtime, last_commit_at,
          commits_30d, commits_90d, indexed_at, symbols_done)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         lang           = excluded.lang,
         size           = excluded.size,
         content_hash   = excluded.content_hash,
         mtime          = excluded.mtime,
         last_commit_at = excluded.last_commit_at,
         commits_30d    = excluded.commits_30d,
         commits_90d    = excluded.commits_90d,
         indexed_at     = excluded.indexed_at,
         symbols_done   = excluded.symbols_done
       RETURNING id`,
    )
    .get(
      rec.path,
      rec.lang ?? null,
      rec.size,
      rec.content_hash,
      rec.mtime,
      rec.last_commit_at ?? null,
      rec.commits_30d,
      rec.commits_90d,
      rec.indexed_at,
      rec.symbols_done,
    ) as { id: number };
  return row.id;
}

export function getFileByPath(db: Db, path: string): FileRecord | undefined {
  return db
    .prepare("SELECT * FROM files WHERE path = ?")
    .get(path) as FileRecord | undefined;
}

/** Lightweight projection for worker backlog derivation. */
export function getAllFiles(
  db: Db,
): Pick<FileRecord, "id" | "path" | "mtime" | "size" | "content_hash" | "symbols_done">[] {
  return db
    .prepare("SELECT id, path, mtime, size, content_hash, symbols_done FROM files")
    .all() as Pick<
    FileRecord,
    "id" | "path" | "mtime" | "size" | "content_hash" | "symbols_done"
  >[];
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export function setSymbolsDone(db: Db, fileId: number, done: 0 | 1): void {
  db.prepare("UPDATE files SET symbols_done = ? WHERE id = ?").run(done, fileId);
}

/**
 * Replace all symbols for a file atomically: delete existing, insert new batch.
 * The caller is responsible for wrapping in a transaction if batching multiple files.
 */
export function replaceSymbols(db: Db, fileId: number, symbols: SymbolRecord[]): void {
  db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);
  const ins = db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, start_byte, end_byte)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of symbols) {
    ins.run(fileId, s.name, s.kind, s.start_line, s.end_line, s.start_byte, s.end_byte);
  }
}

// ---------------------------------------------------------------------------
// Reference edges
// ---------------------------------------------------------------------------

/**
 * Replace all outgoing refs for srcFileId: delete then insert.
 * INSERT OR IGNORE so duplicate-PK edges are silently skipped.
 */
export function replaceRefs(
  db: Db,
  srcFileId: number,
  edges: { dstFileId: number; kind: string }[],
): void {
  db.prepare("DELETE FROM refs WHERE src_file = ?").run(srcFileId);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO refs (src_file, dst_file, kind) VALUES (?, ?, ?)",
  );
  for (const e of edges) {
    ins.run(srcFileId, e.dstFileId, e.kind);
  }
}

// ---------------------------------------------------------------------------
// Co-change
// ---------------------------------------------------------------------------

/**
 * Upsert a co-change weight, normalising so file_a < file_b.
 * ON CONFLICT replaces the weight (not accumulates — accumulation is the caller's job).
 */
export function upsertCochange(db: Db, aId: number, bId: number, weight: number): void {
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  db
    .prepare(
      `INSERT INTO cochange (file_a, file_b, weight) VALUES (?, ?, ?)
       ON CONFLICT(file_a, file_b) DO UPDATE SET weight = excluded.weight`,
    )
    .run(lo, hi, weight);
}

// ---------------------------------------------------------------------------
// FTS
// ---------------------------------------------------------------------------

/**
 * Upsert a file's FTS tokens.
 * Contentless FTS5 does NOT support plain DELETE; use the special FTS5
 * standard DELETE + INSERT so that FTS5 can maintain its index correctly.
 * The FTS5 table stores content (no content=''), so SELECT returns real values
 * and standard DML works.
 */
export function ftsUpsert(
  db: Db,
  fileId: number,
  path: string,
  symbolNames: string,
  keywords: string,
  content: string,
): void {
  db.prepare("DELETE FROM search_index WHERE rowid = ?").run(fileId);
  db
    .prepare(
      "INSERT INTO search_index (rowid, path, symbol_names, keywords, content) VALUES (?, ?, ?, ?, ?)",
    )
    .run(fileId, path, symbolNames, keywords, content);
}

// ---------------------------------------------------------------------------
// Reference fan-in
// ---------------------------------------------------------------------------

/**
 * Count distinct source files that reference dstFileId via a ruby_const edge.
 * Used for ranking: high fan-in signals a central/widely-used file.
 */
export function refFanIn(db: Db, dstFileId: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT src_file) AS n FROM refs WHERE dst_file = ? AND kind = 'ruby_const'",
    )
    .get(dstFileId) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export function setMeta(db: Db, key: string, value: string): void {
  db
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export function getCoverage(db: Db): { total: number; indexed: number } {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN symbols_done = 1 THEN 1 ELSE 0 END) AS indexed FROM files",
    )
    .get() as { total: number; indexed: number | null };
  return { total: row.total, indexed: row.indexed ?? 0 };
}
