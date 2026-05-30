import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { enumerateFiles, langOf } from "./walk.ts";

test("langOf maps known extensions", () => {
  // Ruby / Python
  assert.equal(langOf("a/b.rb"), "ruby");
  assert.equal(langOf("a/b.py"), "python");
  // TypeScript family
  assert.equal(langOf("a/b.ts"), "ts");
  assert.equal(langOf("a/b.tsx"), "ts");
  assert.equal(langOf("a/b.mts"), "ts");
  assert.equal(langOf("a/b.cts"), "ts");
  // JavaScript family
  assert.equal(langOf("a/b.js"), "js");
  assert.equal(langOf("a/b.jsx"), "js");
  assert.equal(langOf("a/b.mjs"), "js");
  assert.equal(langOf("a/b.cjs"), "js");
  // Unknown
  assert.equal(langOf("a/b.unknown"), null);
  assert.equal(langOf("a/b.yaml"), null);
});

test("enumerateFiles skips secrets and respects gitignore", () => {
  const d = mkdtempSync(join(tmpdir(), "nav-walk-"));
  const git = (a: string[]) => execFileSync("git", a, { cwd: d });
  git(["init", "-q"]);
  writeFileSync(join(d, ".gitignore"), "ignored.rb\n");
  writeFileSync(join(d, "app.rb"), "class A; end");
  writeFileSync(join(d, "ignored.rb"), "x");
  writeFileSync(join(d, ".env"), "SECRET=1");
  // Nested secrets — must be excluded at any depth
  mkdirSync(join(d, "config"), { recursive: true });
  writeFileSync(join(d, "config/.env"), "NESTED=1");
  mkdirSync(join(d, "secrets"), { recursive: true });
  writeFileSync(join(d, "secrets/id_rsa"), "k");
  writeFileSync(join(d, "cert.pem"), "k");
  mkdirSync(join(d, "node_modules")); writeFileSync(join(d, "node_modules/x.js"), "1");
  const paths = enumerateFiles(d).map((f) => f.path).sort();
  assert.ok(paths.includes("app.rb"), "app.rb should be found");
  assert.ok(!paths.includes("ignored.rb"), "gitignored file must not appear");
  assert.ok(!paths.includes(".env"), "root .env must not appear");
  assert.ok(!paths.includes("config/.env"), "nested .env must not appear");
  assert.ok(!paths.includes("secrets/id_rsa"), "id_rsa must not appear");
  assert.ok(!paths.includes("cert.pem"), "cert.pem must not appear");
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "node_modules must be excluded");
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

test("non-git fallback applies secret + denylist filters", () => {
  const d = mkdtempSync(join(tmpdir(), "nav-walk-nogit2-"));
  writeFileSync(join(d, "model.rb"), "class M; end");
  writeFileSync(join(d, ".env"), "S=1");
  writeFileSync(join(d, "id_rsa"), "k");
  // Uppercase extension — locks in case-insensitive matching (Fix 1).
  writeFileSync(join(d, "secret.PEM"), "k");
  mkdirSync(join(d, "node_modules")); writeFileSync(join(d, "node_modules/x.js"), "1");
  const paths = enumerateFiles(d).map((f) => f.path);
  assert.ok(paths.includes("model.rb"), "model.rb should be found");
  for (const bad of [".env", "id_rsa", "secret.PEM"]) {
    assert.ok(!paths.includes(bad), `leaked: ${bad}`);
  }
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "node_modules must be excluded");
});
