import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { enumerateFiles, langOf } from "./walk.ts";

test("langOf maps known extensions", () => {
  assert.equal(langOf("a/b.rb"), "ruby");
  assert.equal(langOf("a/b.py"), "python");
  assert.equal(langOf("a/b.tsx"), "ts");
  assert.equal(langOf("a/b.unknown"), null);
});

test("enumerateFiles skips secrets and respects gitignore", () => {
  const d = mkdtempSync(join(tmpdir(), "nav-walk-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]);
  writeFileSync(join(d, ".gitignore"), "ignored.rb\n");
  writeFileSync(join(d, "app.rb"), "class A; end");
  writeFileSync(join(d, "ignored.rb"), "x");
  writeFileSync(join(d, ".env"), "SECRET=1");
  mkdirSync(join(d, "node_modules")); writeFileSync(join(d, "node_modules/x.js"), "1");
  const paths = enumerateFiles(d).map((f) => f.path).sort();
  assert.ok(paths.includes("app.rb"));
  assert.ok(!paths.includes("ignored.rb"));
  assert.ok(!paths.includes(".env"));
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")));
});

test("enumerateFiles non-git fallback returns files", () => {
  const d = mkdtempSync(join(tmpdir(), "nav-walk-nongit-"));
  writeFileSync(join(d, "model.rb"), "class M; end");
  writeFileSync(join(d, "script.py"), "pass");
  const results = enumerateFiles(d);
  const paths = results.map((f) => f.path);
  assert.ok(paths.includes("model.rb"), "should find model.rb");
  assert.ok(paths.includes("script.py"), "should find script.py");
  const rb = results.find((f) => f.path === "model.rb");
  assert.equal(rb?.lang, "ruby");
});
