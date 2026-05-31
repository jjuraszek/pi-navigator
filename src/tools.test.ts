import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { registerTools, type NavigatorCtx } from "./tools.ts";
import { openDb } from "./store/db.ts";
import { migrate } from "./store/schema.ts";
import { initParsers } from "./indexer/symbols.ts";
import { runIndexPass } from "./indexer/worker-core.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { VerifiedCache } from "./navigator/verified-cache.ts";

function fakePi() {
  const tools: any[] = [];
  return { tools, registerTool: (d: any) => tools.push(d) };
}

test("registers navigator_locate and navigator_slice with tool-named guidelines", () => {
  const pi = fakePi();
  registerTools(pi, () => null);
  const names = pi.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["navigator_locate", "navigator_slice"]);
  for (const t of pi.tools) {
    assert.ok(Array.isArray(t.promptGuidelines) && t.promptGuidelines.length > 0);
    // guideline must name its own tool (no ambiguous "this tool")
    assert.ok(t.promptGuidelines.some((g: string) => g.includes(t.name)));
    assert.ok(t.parameters); // typebox schema present
  }
});

test("locate tool returns a friendly message when ctx not ready", async () => {
  const pi = fakePi();
  registerTools(pi, () => null);
  const locateTool = pi.tools.find((t: any) => t.name === "navigator_locate");
  const res = await locateTool.execute("id", { query: "Grid" }, undefined, undefined, {
    cwd: "/x",
  });
  const text = res.content.map((c: any) => c.text).join("");
  assert.match(text, /index|indexing|not a git/i);
});

test("slice tool returns a friendly message when ctx not ready", async () => {
  const pi = fakePi();
  registerTools(pi, () => null);
  const sliceTool = pi.tools.find((t: any) => t.name === "navigator_slice");
  const res = await sliceTool.execute("id", { path: "app.rb" }, undefined, undefined, {
    cwd: "/x",
  });
  const text = res.content.map((c: any) => c.text).join("");
  assert.match(text, /index|indexing|not a git/i);
});

test("locate tool calls locate() with real indexed db and returns results in details", async () => {
  // Build a tiny fixture repo
  const repoDir = mkdtempSync(join(tmpdir(), "nav-tools-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repoDir, "grid.rb"), "class Grid\n  def sync; end\nend\n");
  writeFileSync(join(repoDir, "grid_sync.rb"), "require_relative 'grid'\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);

  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-tools-db-")), "i.db"));
  migrate(db);
  runIndexPass(db, repoDir, DEFAULT_CONFIG, { batchSize: 50, priority: [] });

  const cache = new VerifiedCache();
  const ctx: NavigatorCtx = { db, root: repoDir, cache, config: DEFAULT_CONFIG };

  const pi = fakePi();
  registerTools(pi, () => ctx);
  const locateTool = pi.tools.find((t: any) => t.name === "navigator_locate");
  const res = await locateTool.execute("id", { query: "Grid" }, undefined, undefined, {
    cwd: repoDir,
  });

  // details should be a LocateResponse with at least one result
  assert.ok(res.details, "details must be present");
  assert.ok(Array.isArray(res.details.results), "details.results must be an array");
  assert.ok(res.details.results.length > 0, "should find at least one result for 'Grid'");
  assert.equal(res.details.results[0].path, "grid.rb");

  // content should be non-empty text
  const text = res.content.map((c: any) => c.text).join("");
  assert.ok(text.length > 0);
});

test("slice tool strips leading @ from path", async () => {
  // Build a tiny fixture repo
  const repoDir = mkdtempSync(join(tmpdir(), "nav-tools-slice-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repoDir, "app.rb"), "class App\n  def run; end\nend\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);

  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-tools-slice-db-")), "i.db"));
  migrate(db);
  runIndexPass(db, repoDir, DEFAULT_CONFIG, { batchSize: 50, priority: [] });

  const cache = new VerifiedCache();
  const ctx: NavigatorCtx = { db, root: repoDir, cache, config: DEFAULT_CONFIG };

  const pi = fakePi();
  registerTools(pi, () => ctx);
  const sliceTool = pi.tools.find((t: any) => t.name === "navigator_slice");

  // Pass path with @ prefix — tool must strip it
  const res = await sliceTool.execute("id", { path: "@app.rb" }, undefined, undefined, {
    cwd: repoDir,
  });
  // Should succeed and return content (the file contents)
  const text = res.content.map((c: any) => c.text).join("");
  assert.ok(text.includes("class App"), `expected file content, got: ${text}`);
});
