import { execFileSync } from "node:child_process";

export interface Commit {
  sha: string;
  ts: number;
  files: string[];
}

export interface RecencyEntry {
  last: number;
  c30: number;
  c90: number;
}

export interface FoldOptions {
  now: number;
  windowDays: number;
  maxFilesPerCommit: number;
}

/**
 * Parse `git log --pretty=format:__C__ %H %ct --name-only` output into
 * structured Commit objects. Robust to leading/trailing blank lines and
 * commits with zero files.
 */
export function parseLog(raw: string): Commit[] {
  const commits: Commit[] = [];
  let current: Commit | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("__C__ ")) {
      // Flush previous commit (even if it has no files — safe)
      if (current !== null) commits.push(current);
      const parts = trimmed.split(" ");
      // parts: ["__C__", sha, ts]
      current = { sha: parts[1], ts: Number(parts[2]), files: [] };
    } else if (current !== null && trimmed.length > 0) {
      current.files.push(trimmed);
    }
    // blank lines between commits are intentionally ignored
  }
  if (current !== null) commits.push(current);

  return commits;
}

/**
 * Fold a list of commits into:
 * - `recency`: per-file last-seen ts, 30d commit count, 90d commit count.
 *   Every commit is counted for recency, including mega-commits.
 * - `cochange`: recency-decayed co-occurrence weight for pairs of files that
 *   appeared together in the same commit.  Mega-commits (files.length >
 *   maxFilesPerCommit) are skipped for co-change only.
 */
export function foldSignals(
  commits: Commit[],
  opts: FoldOptions,
): { recency: Map<string, RecencyEntry>; cochange: Map<string, number> } {
  const recency = new Map<string, RecencyEntry>();
  const cochange = new Map<string, number>();

  for (const commit of commits) {
    const ageDays = (opts.now - commit.ts) / 86400;
    const inWindow30 = ageDays <= 30;
    const inWindow90 = ageDays <= 90;

    // --- Recency (every commit, including mega-commits) ---
    for (const file of commit.files) {
      const entry = recency.get(file) ?? { last: 0, c30: 0, c90: 0 };
      if (commit.ts > entry.last) entry.last = commit.ts;
      if (inWindow30) entry.c30 += 1;
      if (inWindow90) entry.c90 += 1;
      recency.set(file, entry);
    }

    // --- Co-change (skip mega-commits) ---
    if (commit.files.length > opts.maxFilesPerCommit) continue;

    const weight = Math.exp(-ageDays / opts.windowDays);
    const files = commit.files;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        // Normalise pair so file_a < file_b (lexicographic)
        const [a, b] = files[i] < files[j] ? [files[i], files[j]] : [files[j], files[i]];
        const key = `${a}\u0000${b}`;
        cochange.set(key, (cochange.get(key) ?? 0) + weight);
      }
    }
  }

  return { recency, cochange };
}

/**
 * Run `git log` and return parsed commits.  Returns [] for non-git dirs or
 * repos with no commits.
 */
export function readLog(
  root: string,
  maxCommits: number,
  sinceSha?: string,
): Commit[] {
  try {
    const args = [
      "log",
      "--no-merges",
      `--pretty=format:__C__ %H %ct`,
      "--name-only",
      `-n${maxCommits}`,
    ];
    if (sinceSha) args.push(`${sinceSha}..HEAD`);

    const raw = execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    }).toString();

    return parseLog(raw);
  } catch {
    return [];
  }
}
