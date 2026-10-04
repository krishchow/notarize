#!/usr/bin/env bash
# Prepare a release locally (no CI minutes needed): bump versions, build, check, commit, tag.
# Alternative to the GitHub "Release" workflow (.github/workflows/release.yml); here publishing
# stays a manual step because it needs your npm login / 2FA code.
# Usage: bash scripts/release.sh 0.2.1
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?usage: scripts/release.sh <version>}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or stash first." >&2
  exit 1
fi

node scripts/bump-version.mjs "$VERSION"
npm install --package-lock-only --silent

npm run check   # lint, typecheck, build, test
echo
echo "Package contents:"
npm pack --dry-run --ignore-scripts 2>&1 | grep -E "notarize-mcp@|package size|unpacked size|total files"

git add package.json package-lock.json .claude-plugin/plugin.json
git commit -m "Release v$VERSION"
git tag "v$VERSION"

cat <<MSG

Release v$VERSION is committed and tagged locally. Publish npm first, then push main
(the Claude Code plugin on main pins notarize-mcp@$VERSION, which must exist on npm):
  npm whoami || npm login        # once per machine
  npm publish                    # enter your 2FA code when asked
  git push --follow-tags origin HEAD:main
Then:  MCP server  →  npx -y notarize-mcp
       Plugin      →  /plugin marketplace add krishchow/notarize ; /plugin install notarize@notarize
MSG
