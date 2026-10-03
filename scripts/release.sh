#!/usr/bin/env bash
# Prepare a release locally (no CI minutes needed): bump versions, check, build, commit, tag.
# Publishing stays a manual step because it needs your npm login / 2FA code.
# Usage: bash scripts/release.sh 0.2.1
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?usage: scripts/release.sh <version>}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or stash first." >&2
  exit 1
fi

# Bump package.json and the Claude Code plugin manifest together.
node -e '
const fs = require("fs");
for (const f of ["package.json", ".claude-plugin/plugin.json"]) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = process.argv[1];
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}' "$VERSION"
npm install --package-lock-only --silent

npm run build
npm run check
echo
echo "Package contents:"
npm pack --dry-run --ignore-scripts 2>&1 | grep -E "notarize-mcp@|package size|unpacked size|total files"

git add package.json package-lock.json .claude-plugin/plugin.json dist
git commit -m "Release v$VERSION"
git tag "v$VERSION"

cat <<MSG

Release v$VERSION is committed and tagged locally. To publish:
  npm whoami || npm login        # once per machine
  npm publish                    # enter your 2FA code when asked
  git push && git push --tags
Then anyone can install with:  npx -y notarize-mcp install
MSG
