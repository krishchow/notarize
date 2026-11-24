# The installer

`npx notarize-mcp install` puts the skills and the MCP server registration into an AI coding
harness directly, for harnesses with no plugin marketplace or when you want the files in a
repository. It is the agentpkg engine reading this
package's [`agentpkg.json`](../agentpkg.json); nothing about any harness lives in this repository.

```bash
npx notarize-mcp install                 # asks which harnesses, and where
npx notarize-mcp install --harness claude,codex --user
npx notarize-mcp install --all --local --dry-run
npx notarize-mcp status
npx notarize-mcp uninstall [--user | --local] [--harness ids]
npx notarize-mcp harnesses               # what it supports, and which it found on this machine
```

## Scope

| | `--user` | `--local` |
|---|---|---|
| Applies to | every project you open | this repository only |
| Skills go in | the harness's directory under your home, e.g. `~/.claude/skills` | the repository, e.g. `.claude/skills` |
| Server is registered in | the harness's user config, e.g. `~/.claude.json` | the repository's config, e.g. `.mcp.json` |
| Record of what was written | `~/.agentpkg/notarize.json` | `.agentpkg/notarize.json` (commit it with the files) |

`--local` uses the nearest directory above the current one that contains `.git`; pass
`--project-root <dir>` to choose another. Some harnesses have no repository-level MCP config (Cline,
Goose, Zed): a local install tells you so and installs the skills only.

## What is written

Five skills, as `notarize-setup`, `notarize-apple-distribution`, `notarize-app-debugging`,
`notarize-testflight-feedback` and `notarize-apple-platform-context`, and one MCP server entry
named `notarize` that runs `npx -y notarize-mcp@<the version you ran>`.

| Harness | Skills | Server entry |
|---|---|---|
| Claude Code | `.claude/skills` | `~/.claude.json` or `.mcp.json` → `mcpServers` |
| Codex | `.agents/skills` | `.codex/config.toml` → `[mcp_servers.notarize]` |
| Cursor | `.agents/skills` | `.cursor/mcp.json` → `mcpServers` |
| GitHub Copilot | `~/.copilot/skills` or `.github/skills` | `~/.copilot/mcp-config.json` or `.github/mcp.json` |
| Gemini CLI | `.agents/skills` | `.gemini/settings.json` → `mcpServers` |
| OpenCode | `.agents/skills` | `opencode.json` → `mcp.servers` |
| Factory Droid, Devin, Kilo Code, Qwen Code, Amp, pi | `.agents/skills` | each harness's own config file |
| Cline | `~/.cline/skills` or `.agents/skills` | `~/.cline/data/settings/cline_mcp_settings.json` (user only) |
| Goose, Zed | `.agents/skills` | user config only |

Paths are shown for a repository; a user install uses the same names under your home directory.
Harnesses that read the shared `.agents/skills` directory get one copy between them. A harness that
also reads Claude Code's directory, such as Cursor, uses that copy when Claude Code is installed
too, so no skill is listed twice.

The server reads its credentials from a saved profile or from `ASC_*` environment variables (see
the README). Most harnesses start the server with your environment. Codex forwards only variables
it is told about, and Gemini CLI and Copilot strip most of them, so for those the entry names the
`ASC_*` and `NOTARIZE_MCP_*` variables explicitly.

## What it will not do

- **Delete or overwrite what it did not write.** Everything it writes is recorded with a hash. An
  existing file or server entry that is not in that record stops the install before anything
  changes; `--force` replaces it after copying it to `.agentpkg/backup/`.
- **Rewrite your config files.** One entry is added or removed. Comments, key order and formatting
  elsewhere in the file are untouched, and a file that does not parse is left alone.
- **Lose your edits.** A skill file you changed is backed up before an update replaces it. A server
  entry you changed is left in place when you uninstall.
- **Update itself.** Run `npx notarize-mcp@latest install` again to move to a new version; it
  updates every harness the package is already installed for at that scope.

## Installer or plugin

For Claude Code and Codex the plugin is still the simplest route, because the harness keeps it up
to date. Use the installer for the other harnesses, or when you want the skills checked into a
repository. Do not use both for the same harness: each registers a server named `notarize`.
