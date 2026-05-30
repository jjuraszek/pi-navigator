#!/usr/bin/env bash
set -euo pipefail
bump="${1:-patch}"
dry="${DRY_RUN:-0}"
git diff --quiet && git diff --cached --quiet || { echo "working tree dirty"; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "not on main"; exit 1; }
cur=$(node -p "require('./package.json').version")
next=$(node -e '
  const [cur, bump] = process.argv.slice(1);
  if (/^v?\d+\.\d+\.\d+$/.test(bump)) { console.log(bump.replace(/^v/, "")); process.exit(0); }
  const s = cur.split(".").map(Number);
  if (bump === "major") { s[0]++; s[1] = 0; s[2] = 0; }
  else if (bump === "minor") { s[1]++; s[2] = 0; }
  else if (bump === "patch") { s[2]++; }
  else { throw new Error("bad bump: " + bump); }
  console.log(s.join("."));
' "$cur" "$bump")
echo "release $cur → $next"
[ "$dry" = "1" ] && { echo "(dry-run, no changes)"; exit 0; }
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  p.version = process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
' "$next"
date=$(date +%F)
node -e '
  const fs = require("fs");
  const [next, date] = process.argv.slice(1);
  let c = fs.readFileSync("CHANGELOG.md", "utf8");
  c = c.replace("## [Unreleased]", "## [Unreleased]\n\n## [v" + next + "] - " + date);
  fs.writeFileSync("CHANGELOG.md", c);
' "$next" "$date"
git add package.json CHANGELOG.md
git commit -m "release: v$next"
git tag "v$next"
git push --follow-tags
echo "tagged v$next"
