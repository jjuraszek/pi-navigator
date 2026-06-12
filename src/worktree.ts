import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { NavigatorConfig } from "./types.ts";

export interface RepoInfo { root: string; repoName: string; repoId: string; dbPath: string; isGit: boolean; }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

// Returns the canonical repo name from the main worktree so linked worktrees
// resolve to the same DB. git-common-dir points to the shared .git dir;
// its parent dir is the main worktree's root.
function canonicalRepoName(cwd: string, root: string): string {
  try {
    if (git(cwd, ["rev-parse", "--is-bare-repository"]) === "true") {
      return basename(git(cwd, ["rev-parse", "--git-dir"]));
    }
    const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
    const abs = isAbsolute(commonDir) ? commonDir : join(root, commonDir);
    return basename(dirname(abs));
  } catch {
    return basename(root);
  }
}

export function resolveRepo(cwd: string, config: NavigatorConfig): RepoInfo {
  let root: string, isGit = true, repoId: string;
  try {
    root = git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    root = cwd;
    isGit = false;
  }
  try {
    const rootCommit = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]).split("\n").pop()!.trim();
    repoId = rootCommit.slice(0, 12);
  } catch {
    let basis: string;
    try {
      basis = isGit ? git(cwd, ["rev-parse", "--git-common-dir"]) : root;
    } catch {
      basis = root;
    }
    repoId = createHash("sha256").update(basis).digest("hex").slice(0, 12);
  }
  // Use the main worktree's basename so all linked worktrees share one DB.
  const repoName = isGit ? canonicalRepoName(cwd, root) : basename(root);
  const dbPath = isGit ? join(config.indexDir, `${repoName}_${repoId}.db`) : "";
  return { root, repoName, repoId, dbPath, isGit };
}

/**
 * True when the working tree has uncommitted changes (tracked edits OR
 * untracked files — a new untracked source file is genuinely uncovered by an
 * index keyed on committed state). Never throws: a non-git or failed call is
 * treated conservatively as dirty so readiness gates do not trust unknown state.
 */
export function workingTreeDirty(root: string): boolean {
  try {
    return git(root, ["status", "--porcelain=v1"]).length > 0;
  } catch {
    return true;
  }
}

export function headSha(cwd: string): string | null {
  try {
    return git(cwd, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}
