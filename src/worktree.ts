import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { NavigatorConfig } from "./types.ts";

export interface RepoInfo { root: string; repoName: string; repoId: string; dbPath: string; isGit: boolean; }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

export function resolveRepo(cwd: string, config: NavigatorConfig): RepoInfo {
  let root: string, isGit = true, repoId: string;
  try {
    root = git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch { root = cwd; isGit = false; }
  try {
    const rootCommit = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]).split("\n").pop()!.trim();
    repoId = rootCommit.slice(0, 12);
  } catch {
    let basis: string;
    try { basis = isGit ? git(cwd, ["rev-parse", "--git-common-dir"]) : root; }
    catch { basis = root; }
    repoId = createHash("sha256").update(basis).digest("hex").slice(0, 12);
  }
  const repoName = basename(root);
  const dbPath = isGit ? join(config.indexDir, `${repoName}_${repoId}.db`) : "";
  return { root, repoName, repoId, dbPath, isGit };
}

/**
 * True when the working tree has uncommitted changes (tracked edits OR
 * untracked files — a new untracked source file is genuinely uncovered by an
 * index keyed on committed state). Never throws: a non-git or failed call
 * resolves to "not dirty" so it can be used unconditionally inside locate().
 */
export function workingTreeDirty(root: string): boolean {
  try {
    return git(root, ["status", "--porcelain"]).length > 0;
  } catch {
    return false;
  }
}

export function headSha(cwd: string): string | null {
  try { return git(cwd, ["rev-parse", "HEAD"]); } catch { return null; }
}
