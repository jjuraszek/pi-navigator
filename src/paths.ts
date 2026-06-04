import { relative, resolve, sep, posix } from "node:path";

/**
 * Converts an absolute or cwd-relative path to a repo-relative POSIX path.
 * Returns undefined if the resolved path escapes the repo root.
 */
export function toRepoRel(root: string, p: string, cwd: string): string | undefined {
  const abs = resolve(cwd, p);
  const rel = relative(root, abs);
  const posixRel = rel.split(sep).join(posix.sep);
  if (posixRel.startsWith("..")) return undefined;
  return posixRel;
}
