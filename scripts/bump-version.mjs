#!/usr/bin/env node
// Set the release version on every plugin surface together, including the
// `npx -y notarize-mcp@<version>` server pin three of them use, so the skills and the npm server
// they launch always match. The surfaces:
//   package.json                 the npm package and MCP server (the version of record)
//   .claude-plugin/plugin.json   the Claude Code plugin (version + its own mcpServers pin)
//   .codex-plugin/plugin.json    the Codex plugin manifest (version only)
//   codex.mcp.json               the Codex plugin's MCP server config (pin only)
//   cordis.patch.yml             the DeepSeek Harness bundle layer (pin only)
// Used by scripts/release.sh (local) and .github/workflows/release.yml (GitHub).
// Usage: node scripts/bump-version.mjs 0.2.1 [repo-root]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, root = process.cwd()] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error(`Invalid version "${version ?? ""}": expected semver like 0.2.1 or 0.3.0-beta.1`);
  process.exit(2);
}

// Manifests with a top-level "version" field, which may also carry a pin of their own.
for (const f of ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
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

// Files that hold only the server pin, in their own syntax: JSON quotes it, YAML leaves it bare.
// Each pattern captures the whole pin, so the replacement is a plain string with no callback.
for (const [f, pattern, replacement] of [
  ["codex.mcp.json", /"notarize-mcp@[^"]*"/g, `"notarize-mcp@${version}"`],
  ["cordis.patch.yml", /notarize-mcp@[0-9A-Za-z.+-]+/g, `notarize-mcp@${version}`],
]) {
  const path = join(root, f);
  const text = readFileSync(path, "utf8");
  const next = text.replace(pattern, replacement);
  // Idempotent: re-running with the same version leaves the file untouched and is not an error.
  if (next === text && !text.includes(`notarize-mcp@${version}`)) {
    throw new Error(`${f}: no notarize-mcp@<version> pin to update`);
  }
  writeFileSync(path, next);
  console.log(`${f}: notarize-mcp@${version}`);
}
