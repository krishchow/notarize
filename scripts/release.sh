#!/usr/bin/env bash
# Release locally from the pending changesets (no CI minutes needed): version, build, check, commit, tag.
# Alternative to the GitHub "Release" workflow (.github/workflows/release.yml). Publishing stays a
# manual step here because it needs your npm login / 2FA code.
# Usage: bash scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or stash first." >&2
  exit 1
fi
if ! ls .changeset/*.md 2>/dev/null | grep -qv README.md; then
  echo "No changesets to release. Add one with: pnpm changeset" >&2
  exit 1
fi

pnpm run version-packages   # consume .changeset/*.md → package.json, CHANGELOG.md (commits: config has "commit": true)
VERSION="$(node -p 'require("./package.json").version')"
# The plugin pin can move in the same commit here, because main is pushed only after `pnpm publish`.
# Prereleases leave the plugin on the latest stable version, as in the GitHub workflow.
if [[ "$VERSION" != *-* ]]; then node scripts/bump-version.mjs "$VERSION"; fi

pnpm run check   # lint, typecheck, build, test
echo
echo "Package contents:"
npm pack --dry-run --ignore-scripts 2>&1 | grep -E "notarize-mcp@|package size|unpacked size|total files"

git add -A .changeset CHANGELOG.md package.json .claude-plugin/plugin.json
git diff --cached --quiet || git commit -m "Release v$VERSION"
git tag "v$VERSION"

cat <<MSG

Release v$VERSION is committed and tagged locally. Publish npm first, then push main
(the Claude Code plugin on main pins notarize-mcp@$VERSION, which must exist on npm):
  pnpm login                     # once per machine
  pnpm publish                   # enter your 2FA code when asked
  git push --follow-tags origin HEAD:main
Then:  MCP server  →  npx -y notarize-mcp
       Plugin      →  /plugin marketplace add krishchow/notarize ; /plugin install notarize@notarize
MSG
