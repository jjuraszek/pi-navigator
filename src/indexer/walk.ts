import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
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
// Lowercased once so matching is case-insensitive on all filesystems.
// Exported so src/navigator/slice.ts can enforce the same guard at read time.
export function isSecret(file: string): boolean {
  const b = basename(file).toLowerCase();
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
    case ".md":
    case ".markdown":
    case ".txt":
    case ".rst":
    case ".adoc":
      return "prose";
    default:
      return null;
  }
}

function isGitRepo(root: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "pipe" });
  return r.status === 0;
}

// Git tree modes we never index: symlinks (120000) and gitlinks/submodules
// (160000). Symlinks are skipped because following them either re-enqueues a
// directory forever (readFileSync → EISDIR) or indexes the link target's
// content as a duplicate (FTS pollution). The mode comes free in --stage output,
// so tracked files cost no extra syscall.
const SKIP_GIT_MODES = new Set(["120000", "160000"]);

function gitFiles(root: string): string[] {
  // Tracked files via --stage so we can read each entry's mode and drop
  // symlinks/gitlinks. -z is NUL-delimited; within a record the format is
  // "<mode> <object> <stage>\t<path>" (the tab survives -z).
  const trackedRaw = execFileSync(
    "git",
    ["ls-files", "-z", "--stage"],
    { cwd: root, stdio: ["ignore", "pipe", "ignore"] }
  )
    .toString()
    .split("\0")
    .filter(Boolean);

  const tracked: string[] = [];
  for (const rec of trackedRaw) {
    const tab = rec.indexOf("\t");
    if (tab === -1) continue;
    const mode = rec.slice(0, rec.indexOf(" "));
    if (SKIP_GIT_MODES.has(mode)) continue;
    tracked.push(rec.slice(tab + 1));
  }

  // Untracked files carry no git mode; lstat each to drop symlinks.
  const untrackedRaw = execFileSync(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { cwd: root, stdio: ["ignore", "pipe", "ignore"] }
  )
    .toString()
    .split("\0")
    .filter(Boolean);

  const untracked: string[] = [];
  for (const p of untrackedRaw) {
    try {
      if (lstatSync(join(root, p)).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    untracked.push(p);
  }

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
    const child = join(abs, name);
    let st;
    try {
      st = lstatSync(child);
    } catch {
      continue;
    }
    // Skip symlinks: following them risks cycles, re-indexing the same content,
    // or recursing out of the repo. Matches the git-mode filter above.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      // Denylist applies to directories only; a regular file named "dist" is fine.
      if (ALWAYS_IGNORE_DIRS.has(name)) continue;
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
