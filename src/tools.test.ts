import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { registerTools, renderLocateText, type NavigatorCtx } from "./tools.ts";
import { STRONG_HIT_DIRECTIVE } from "./navigator/strong-hit.ts";
import type { LocateResponse } from "./types.ts";
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

function makeLocateResponse(overrides: Partial<LocateResponse> = {}): LocateResponse {
  return {
    results: [{
      path: "src/foo.ts", lang: "ts", score: 0.9,
      signals: { fts: 0.5, path: 0.2, symbol: 0.2, recency: 0 },
      symbols: [{ name: "Foo", kind: "class", lines: [1, 10] }],
    }],
    cluster: null,
    index: { fresh: true, head_behind: 0, coverage: 1, dirty: false },
    confidence: "high",
    has_exact_def: true,
    used_or_fallback: false,
    top_has_anchor: true,
    ...overrides,
  };
}

test("renderLocateText: strong hit includes STRONG_HIT_DIRECTIVE", () => {
  const res = makeLocateResponse();
  const text = renderLocateText(res, "Foo", true);
  assert.ok(text.includes(STRONG_HIT_DIRECTIVE), `expected directive in: ${text}`);
});

test("renderLocateText: strong hit with strongHitDirective=false suppresses directive", () => {
  const res = makeLocateResponse();
  const text = renderLocateText(res, "Foo", false);
  assert.ok(!text.includes(STRONG_HIT_DIRECTIVE), `expected no directive in: ${text}`);
});

test("renderLocateText: low-confidence result has low-confidence line, not strong-hit directive", () => {
  const res = makeLocateResponse({
    confidence: "low",
    has_exact_def: false,
    top_has_anchor: false,
  });
  const text = renderLocateText(res, "Foo", true);
  assert.ok(text.includes("low-confidence"), `expected low-confidence in: ${text}`);
  assert.ok(!text.includes(STRONG_HIT_DIRECTIVE), `strong-hit directive must not appear: ${text}`);
});

test("navigator_locate guidelines contain strong-hit/slice reinforcement", () => {
  const pi = fakePi();
  registerTools(pi, () => null, () => "non_git");
  const locateTool = pi.tools.find((t: any) => t.name === "navigator_locate");
  const guidelines = (locateTool.promptGuidelines as string[]).join(" ");
  assert.ok(
    guidelines.includes("has_exact_def") && guidelines.includes("top_has_anchor"),
    "must mention strong-hit signals in guidelines",
  );
  assert.ok(
    guidelines.includes("navigator_slice") && guidelines.includes("redundant"),
    "must mention slice-direct + redundant re-search",
  );
});

test("navigator_locate guidelines contain navigator-first lead and rg boundary clause", () => {
  const pi = fakePi();
  registerTools(pi, () => null, () => "non_git");
  const locateTool = pi.tools.find((t: any) => t.name === "navigator_locate");
  const text = (locateTool.promptGuidelines as string[]).join(" ").toLowerCase();
  assert.ok(text.includes("before"), "must assert navigator before other tools");
  assert.ok(
    text.includes("rg") || text.includes("ripgrep"),
    "must name rg or ripgrep in boundary clause",
  );
  assert.ok(
    text.includes("regex") || text.includes("full-content") || text.includes("scan"),
    "must state when rg is appropriate",
  );
  assert.ok(
    text.includes("doc") || text.includes("docs") || text.includes("code"),
    "must mention coverage (code or docs)",
  );
});

test("registers navigator_locate and navigator_slice with tool-named guidelines", () => {
  const pi = fakePi();
  registerTools(pi, () => null, () => "non_git");
  const names = pi.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["navigator_locate", "navigator_slice"]);
  for (const t of pi.tools) {
    assert.ok(Array.isArray(t.promptGuidelines) && t.promptGuidelines.length > 0);
    // guideline must name its own tool (no ambiguous "this tool")
    assert.ok(t.promptGuidelines.some((g: string) => g.includes(t.name)));
    assert.ok(t.parameters); // typebox schema present
  }
});

test("locate tool returns a terminal non-git message (no retry, points at rg/fd)", async () => {
  const pi = fakePi();
  registerTools(pi, () => null, () => "non_git");
  const locateTool = pi.tools.find((t: any) => t.name === "navigator_locate");
  const res = await locateTool.execute("id", { query: "Grid" }, undefined, undefined, { cwd: "/x" });
  const text = res.content.map((c: any) => c.text).join("").toLowerCase();
  assert.match(text, /not inside a git repository/);
  assert.match(text, /rg|fd/);
  assert.doesNotMatch(text, /try again/);
});

test("locate tool returns a retryable booting message with fallback hint", async () => {
  const pi = fakePi();
  registerTools(pi, () => null, () => "booting");
  const locateTool = pi.tools.find((t: any) => t.name === "navigator_locate");
  const res = await locateTool.execute("id", { query: "Grid" }, undefined, undefined, { cwd: "/x" });
  const text = res.content.map((c: any) => c.text).join("").toLowerCase();
  assert.match(text, /try again/);
  assert.match(text, /rg|fd/);
});

test("slice tool returns a non-git message when ctx not ready", async () => {
  const pi = fakePi();
  registerTools(pi, () => null, () => "non_git");
  const sliceTool = pi.tools.find((t: any) => t.name === "navigator_slice");
  const res = await sliceTool.execute("id", { path: "app.rb" }, undefined, undefined, {
    cwd: "/x",
  });
  const text = res.content.map((c: any) => c.text).join("").toLowerCase();
  assert.match(text, /not inside a git repository/);
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
  registerTools(pi, () => ctx, () => "ready");
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

test("locate tool nudges toward rg/fd when zero results", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "nav-tools-zero-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repoDir, "grid.rb"), "class Grid\n  def sync; end\nend\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);

  await initParsers(["ruby"]);
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nav-tools-zero-db-")), "i.db"));
  migrate(db);
  runIndexPass(db, repoDir, DEFAULT_CONFIG, { batchSize: 50, priority: [] });

  const cache = new VerifiedCache();
  const ctx: NavigatorCtx = { db, root: repoDir, cache, config: DEFAULT_CONFIG };

  const pi = fakePi();
  registerTools(pi, () => ctx, () => "ready");
  const locateTool = pi.tools.find((t: any) => t.name === "navigator_locate");
  const res = await locateTool.execute(
    "id",
    { query: "zzqwxnonexistenttoken" },
    undefined,
    undefined,
    { cwd: repoDir },
  );
  const text = res.content.map((c: any) => c.text).join("").toLowerCase();
  assert.match(text, /no results/);
  assert.match(text, /rg|fd/);
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
  registerTools(pi, () => ctx, () => "ready");
  const sliceTool = pi.tools.find((t: any) => t.name === "navigator_slice");

  // Pass path with @ prefix — tool must strip it
  const res = await sliceTool.execute("id", { path: "@app.rb" }, undefined, undefined, {
    cwd: repoDir,
  });
  // Should succeed and return content (the file contents)
  const text = res.content.map((c: any) => c.text).join("");
  assert.ok(text.includes("class App"), `expected file content, got: ${text}`);
});
