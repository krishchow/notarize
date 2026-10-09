# Codex

This repository is also a [Codex](https://developers.openai.com/codex) **plugin**: installing it
adds the MCP server *and* both skills to Codex in one step, and marks `setup` as the skill Codex
offers to run right after installing.

## Install

```bash
codex plugin marketplace add krishchow/notarize
codex plugin add notarize@notarize
```

Add `--ref main` to pin a ref, or add a local checkout instead of the GitHub repo while developing:

```bash
codex plugin marketplace add /absolute/path/to/notarize
codex plugin add notarize@notarize
```

Then confirm both halves arrived:

```bash
codex mcp list                 # notarize  npx  -y notarize-mcp@<version>  … enabled
codex mcp get notarize --json  # the resolved stdio transport, env_vars and timeouts
```

Remove it with `codex plugin remove notarize@notarize`, and the marketplace with
`codex plugin marketplace remove notarize`.

## What the plugin declares

| File | What it is |
|---|---|
| [`.codex-plugin/plugin.json`](../.codex-plugin/plugin.json) | The plugin manifest: name, version, both component paths, and the display metadata Codex shows in its plugin directory. |
| [`codex.mcp.json`](../codex.mcp.json) | The server: `npx -y notarize-mcp@<version>` over stdio, plus the environment allowlist and timeouts below. |
| [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json) | The repo marketplace that makes the plugin installable by name. |
| `skills/` | The two skills, discovered as `notarize:apple-distribution` and `notarize:setup`. |

`extensions.com.openai.onboardingSkill` points at `skills/setup/SKILL.md`, so Codex treats setup as
the plugin's onboarding flow rather than just another skill.

### Why one plugin references the repository root

Codex resolves every component path relative to the plugin root and rejects `..` traversal, so
`skills/` has to live *inside* it. This plugin's root is therefore the repository root — the same
layout the Codex docs describe with `"source": "url"` for a plugin that lives at the repo root —
and the marketplace entry points at it with `"path": "./"`. There is one copy of the skills, shared
by Codex, Claude Code, the DeepSeek Harness bundle, and the npm package.

The trade-off is that installing copies the plugin directory. From a git marketplace that is the
repository (~3.6 MB); from a **local checkout that has run `pnpm install`**, the copy also picks up
`node_modules` (hundreds of megabytes), because Codex does not exclude anything. Use a git
marketplace, or a fresh clone with no `node_modules`, if that matters.

## The environment allowlist

Codex builds an MCP server's child environment from an explicit allowlist, so `mcp.json` lists the
names the server reads. Without that list the server starts with no credential configuration at
all:

| Name | Used for |
|---|---|
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY`, `ASC_PRIVATE_KEY_PATH` | The App Store Connect API key |
| `ASC_PROFILE` | Which saved credential profile to use |
| `NOTARY_KEYCHAIN_PROFILE` | A `notarytool store-credentials` profile, for scripts and CI |
| `NOTARIZE_MCP_CONFIG_DIR`, `NOTARIZE_MCP_LOG_DIR`, `NOTARIZE_MCP_STATE_DIR` | Where config, transcripts and job state live |
| `NOTARIZE_MCP_AUTO_CONFIRM` | Unattended runs; see [agent-integration.md](agent-integration.md) |

You do **not** need any of these. `/notarize:setup` (and `asc_auth action=configure`) writes
`~/.config/notarize-mcp/config.json`, and `HOME` always reaches the server, so a saved profile is
found with no environment configuration at all. `asc_auth action=status` reports which source won.

## Timeouts

`startup_timeout_sec: 60` gives the first run room to download the package with `npx`.
`tool_timeout_sec: 300` covers a call that waits in the foreground; the notarization, archive and
upload tools hand off to background jobs well before that and return a Monitor command, so no tool
depends on a long timeout.

## Two deliberate details

- **The MCP config is `codex.mcp.json`, not `.mcp.json`.** Codex would accept either, and its
  documentation points its examples at `.mcp.json` — but Claude Code treats a *project-root*
  `.mcp.json` as project-scoped MCP servers, so that name would give every Claude Code session
  opened in this repository a second `notarize` server alongside the plugin's. Because the manifest
  names the file explicitly, the name is ours to choose, and `test/unattended.test.ts` keeps the
  root `.mcp.json` absent.
- **The npm package includes none of these files.** `files` in `package.json` covers `dist/`,
  `skills/`, `cordis.patch.yml` and `README.md`; the Codex and Claude manifests ship from the git
  repository, which is what both marketplaces read. `test/package.test.ts` asserts they stay out of
  the tarball.
