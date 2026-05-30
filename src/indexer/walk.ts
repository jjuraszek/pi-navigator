import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import type { Lang } from "../types.ts";

// Directories unconditionally excluded regardless of .gitignore status.
// Needed because `git ls-files --others` can list untracked dirs like
// node_modules if they are not explicitly gitignored.
const ALWAYS_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  "coverage",
]);

// Secret basenames that must never be enumerated.
function isSecret(file: string): boolean {
  const b = basename(file);
  if (b.startsWith(".env")) return true; // .env, .env.local, .env.production …
  if (b.endsWith(".pem")) return true;
  if (b.endsWith(".key")) return true;
  if (b.startsWith("id_")) return true; // id_rsa, id_ed25519 …
  if (b.endsWith(".p12")) return true;
  if (b.endsWith(".pfx")) return true;
  return false;
}

// Returns true if any POSIX path segment is in the always-ignore set.
function hasIgnoredSegment(posixPath: string): boolean {
  for (const seg of posixPath.split("/")) {
    if (ALWAYS_IGNORE_DIRS.has(seg)) return true;
  }
  return false;
}

export function langOf(path: string): Lang | null {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".rb":
      return "ruby";
    case ".py":
      return "python";
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "ts";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "js";
    default:
      return null;
  }
}

function isGitRepo(root: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "pipe" });
  return r.status === 0;
}

function gitFiles(root: string): string[] {
  // Use -z (NUL-delimited) to handle filenames with spaces or special chars
  // without needing to deal with git's core.quotePath escaping.
  const run = (extra: string[]) =>
    execFileSync(
      "git",
      ["ls-files", "-z", ...extra],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .split("\0")
      .filter(Boolean);

  const tracked = run([]);
  const untracked = run(["--others", "--exclude-standard"]);

  // Dedup via Set (a path should not appear in both, but be safe).
  const seen = new Set<string>();
  for (const p of tracked) seen.add(p);
  for (const p of untracked) seen.add(p);
  return Array.from(seen);
}

function walkDir(root: string, rel: string, out: string[]): void {
  const abs = rel ? join(root, rel) : root;
  for (const name of readdirSync(abs)) {
    const relChild = rel ? `${rel}/${name}` : name;
    if (ALWAYS_IGNORE_DIRS.has(name)) continue;
    const child = join(abs, name);
    let st;
    try {
      st = statSync(child);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(root, relChild, out);
    } else if (st.isFile()) {
      // Normalize separators for non-POSIX systems
      out.push(relChild.split(sep).join("/"));
    }
  }
}

export function enumerateFiles(root: string): { path: string; lang: Lang | null }[] {
  let rawPaths: string[];

  if (isGitRepo(root)) {
    rawPaths = gitFiles(root);
  } else {
    const list: string[] = [];
    walkDir(root, "", list);
    rawPaths = list;
  }

  const results: { path: string; lang: Lang | null }[] = [];
  for (const p of rawPaths) {
    if (!p) continue;
    // POSIX path separators expected from git; normalize just in case.
    const posix = p.split(sep).join("/");
    if (hasIgnoredSegment(posix)) continue;
    if (isSecret(posix)) continue;
    results.push({ path: posix, lang: langOf(posix) });
  }
  return results;
}
