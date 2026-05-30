---
name: release
description: Tag-pin release for pi-navigator (private repo, no npm publish)
---

# Release Skill

pi-navigator is a **private repo** installed via git-tag-pin — not published to npm. Consumers install with:

```bash
pi install git:github.com/jjuraszek/pi-navigator@vX.Y.Z
```

This requires ssh access to `github.com/jjuraszek/pi-navigator`.

## Usage

Preview (dry-run — prints the version bump, makes no changes):

```bash
DRY_RUN=1 bash .agents/skills/release/scripts/release.sh minor
```

Release:

```bash
bash .agents/skills/release/scripts/release.sh minor
```

## Bump argument

| Arg | Effect |
|---|---|
| `patch` (default) | `0.1.0` → `0.1.1` |
| `minor` | `0.1.0` → `0.2.0` |
| `major` | `0.1.0` → `1.0.0` |
| `X.Y.Z` or `vX.Y.Z` | Explicit version |

## What it does

1. Requires a **clean working tree** on `main`.
2. Bumps `version` in `package.json`.
3. Inserts a dated `## [vX.Y.Z]` section in `CHANGELOG.md` below `## [Unreleased]`.
4. Commits with message `release: vX.Y.Z`.
5. Tags `vX.Y.Z` and pushes with `--follow-tags`.

## Update install pins after release

If pi settings files pin a previous tag, update them to the new tag:

```bash
grep -r 'pi-navigator@' ~/.pi/agent*/settings.json
# edit each occurrence to the new tag
```
