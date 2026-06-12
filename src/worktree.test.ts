import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRepo, workingTreeDirty } from "./worktree.ts";
import { DEFAULT_CONFIG } from "./config.ts";

function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "nav-wt-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: d });
  git(["init", "-q"]);
  git(["config", "user.email", "a@b.c"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(d, "f.txt"), "hi");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return d;
}

test("resolveRepo on a non-git directory yields empty dbPath (no phantom index)", () => {
  const d = mkdtempSync(join(tmpdir(), "nav-nogit-"));
  const r = resolveRepo(d, DEFAULT_CONFIG);
  assert.equal(r.isGit, false);
  assert.equal(r.dbPath, "", "non-git resolution must not name a real DB file");
});

test("workingTreeDirty is false on a clean committed tree", () => {
  const d = tmpRepo();
  assert.equal(workingTreeDirty(d), false);
});

test("workingTreeDirty is true with an uncommitted edit, outside git, and on git command errors", () => {
  const d = tmpRepo();
  writeFileSync(join(d, "f.txt"), "changed");
  assert.equal(workingTreeDirty(d), true);

  const nogit = mkdtempSync(join(tmpdir(), "nav-nogit-dirty-"));
  assert.equal(workingTreeDirty(nogit), true, "non-git path must be treated as dirty/not-ready");

  rmSync(d, { recursive: true, force: true });
  assert.equal(workingTreeDirty(d), true, "git command errors must be treated as dirty/not-ready");
});

test("linked worktree resolves to the main worktree's repoName and dbPath", () => {
  const main = tmpRepo();
  const wtParent = mkdtempSync(join(tmpdir(), "nav-wt-linked-"));
  const linked = join(wtParent, "feature");
  execFileSync("git", ["worktree", "add", "-q", linked, "-b", "feature"], { cwd: main });
  const rMain = resolveRepo(main, DEFAULT_CONFIG);
  const rLinked = resolveRepo(linked, DEFAULT_CONFIG);
  assert.equal(rLinked.repoName, rMain.repoName);
  assert.equal(rLinked.repoId, rMain.repoId);
  assert.equal(rLinked.dbPath, rMain.dbPath);
  execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: main });
  rmSync(wtParent, { recursive: true, force: true });
  rmSync(main, { recursive: true, force: true });
});

test("non-git directory still yields empty dbPath (no regression)", () => {
  const d = mkdtempSync(join(tmpdir(), "nav-nogit2-"));
  const r = resolveRepo(d, DEFAULT_CONFIG);
  assert.equal(r.isGit, false);
  assert.equal(r.dbPath, "");
  rmSync(d, { recursive: true, force: true });
});

test("resolveRepo yields root, name, stable id, and cache db path", () => {
  const d = tmpRepo();
  const r = resolveRepo(d, DEFAULT_CONFIG);
  assert.equal(r.root, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: d }).toString().trim());
  assert.equal(r.repoName, r.root.split("/").pop());
  assert.match(r.repoId, /^[0-9a-f]{12}$/);
  assert.equal(r.dbPath, join(DEFAULT_CONFIG.indexDir, `${r.repoName}_${r.repoId}.db`));
  assert.equal(resolveRepo(d, DEFAULT_CONFIG).repoId, r.repoId);
});
