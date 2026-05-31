import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { Db } from "../store/db.ts";
import { getFileByPath } from "../store/queries.ts";
import { hashBuffer } from "../indexer/hash.ts";
import { extractSymbols } from "../indexer/symbols.ts";
import { langOf, isSecret } from "../indexer/walk.ts";
import type { SliceResult, Lang } from "../types.ts";
import type { VerifiedCache } from "./verified-cache.ts";

export interface SliceArgs {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

export function slice(
  db: Db,
  root: string,
  cache: VerifiedCache,
  args: SliceArgs,
): SliceResult {
  // 1. Resolve + guard against path traversal
  const resolvedRoot = resolve(root);
  const abs = resolve(root, args.path);

  // relPath in POSIX form (repo-relative)
  const relPath = relative(resolvedRoot, abs).split(sep).join("/");

  // Reject if abs escapes the root
  if (relPath.startsWith("..")) {
    throw new Error(`path escapes worktree: ${args.path}`);
  }

  // Reject secret files — spec invariant: slices honor the same ignore list as the walk.
  if (isSecret(relPath)) {
    throw new Error(`slice refused: secret file: ${relPath}`);
  }

  if (!existsSync(abs)) {
    throw new Error(`file not found: ${args.path}`);
  }

  // 2. Read live bytes (always from active worktree)
  const buf = readFileSync(abs);
  const content_hash = hashBuffer(buf);
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const lastLineIndex = lines.length - 1;

  // 3. Determine [start, end] range (0-based, inclusive)
  let start: number;
  let end: number;

  if (args.symbol !== undefined) {
    // Try DB first (only if index is fresh for this file)
    const row = getFileByPath(db, relPath);
    let foundStart: number | undefined;
    let foundEnd: number | undefined;

    if (row && row.content_hash === content_hash) {
      // Index is fresh — query symbols table
      const symRow = db
        .prepare(
          `SELECT start_line, end_line FROM symbols WHERE file_id = ? AND name = ? LIMIT 1`,
        )
        .get(row.id, args.symbol) as { start_line: number; end_line: number } | undefined;
      if (symRow) {
        foundStart = symRow.start_line;
        foundEnd = symRow.end_line;
      }
    }

    if (foundStart === undefined) {
      // Stale index or no row — re-extract live via tree-sitter
      const lang = langOf(relPath) as Lang | null;
      if (lang !== null) {
        const syms = extractSymbols(lang, text);
        const match = syms.find((s) => s.name === args.symbol);
        if (match) {
          foundStart = match.start_line;
          foundEnd = match.end_line;
        }
      }
    }

    if (foundStart === undefined || foundEnd === undefined) {
      throw new Error(`symbol not found: ${args.symbol}`);
    }

    start = foundStart;
    end = foundEnd;
  } else if (args.startLine !== undefined) {
    // 1-based from caller → 0-based internal
    start = Math.max(0, args.startLine - 1);
    end = Math.min(lastLineIndex, (args.endLine ?? args.startLine) - 1);
  } else {
    start = 0;
    end = lastLineIndex;
  }

  // 4. Extract content
  const content = lines.slice(start, end + 1).join("\n");

  // 5. stale_index
  const row = getFileByPath(db, relPath);
  const stale_index = row === undefined ? true : row.content_hash !== content_hash;

  // 6. unchanged_since_last_read (check BEFORE updating cache)
  const unchanged_since_last_read = cache.has(abs, content_hash);
  cache.set(abs, content_hash);

  // 7. Return
  return {
    path: relPath,
    range: [start, end],
    content,
    content_hash,
    stale_index,
    unchanged_since_last_read,
  };
}
