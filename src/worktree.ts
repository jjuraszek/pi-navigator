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
    const common = isGit ? git(cwd, ["rev-parse", "--git-common-dir"]) : root;
    repoId = createHash("sha256").update(common).digest("hex").slice(0, 12);
  }
  const repoName = basename(root);
  return { root, repoName, repoId, dbPath: join(config.indexDir, `${repoName}_${repoId}.db`), isGit };
}

export function headSha(cwd: string): string | null {
  try { return git(cwd, ["rev-parse", "HEAD"]); } catch { return null; }
}
