#!/usr/bin/env node
// Set the release version in package.json and the Claude Code plugin manifest together,
// including the plugin's `npx -y notarize-mcp@<version>` server pin, so the plugin's skill and
// the npm server it launches always match.
// Used by scripts/release.sh (local) and .github/workflows/release.yml (GitHub).
// Usage: node scripts/bump-version.mjs 0.2.1 [repo-root]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, root = process.cwd()] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error(`Invalid version "${version ?? ""}": expected semver like 0.2.1 or 0.3.0-beta.1`);
  process.exit(2);
}
for (const f of ["package.json", ".claude-plugin/plugin.json"]) {
  const path = join(root, f);
  // Edit in place (no JSON round-trip) so the files' formatting (and biome) stay happy.
  const text = readFileSync(path, "utf8");
  const next = text
    .replace(/^(\s{2}"version":\s*")[^"]*(")/m, `$1${version}$2`)
    .replace(/("notarize-mcp@)[^"]*(")/g, `$1${version}$2`);
  if (JSON.parse(next).version !== version) throw new Error(`${f}: no top-level "version" field`);
  writeFileSync(path, next);
  console.log(`${f}: ${version}`);
}
