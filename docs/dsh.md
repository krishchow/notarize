# DeepSeek Harness (DSH)

`notarize-mcp` is also a [DeepSeek Harness](https://deepseek.com/harness) **bundle**: installing
the npm package into a DSH profile gives that profile the MCP server *and* both skills, in one
step. This page explains what the bundle adds, how it finds its own files, and the one way DSH
differs from Claude Code.

## Install

Choose whichever surface fits; all three do the same thing (install the package, then select it as
a bundle):

- **Web sidebar → Plugins**, then install `notarize-mcp`.
- **Ask the agent** to call `plugin_manager` with `action: install_bundle` and `target: notarize-mcp`.
- **From a checkout**, the same tool with `target` set to this repository's absolute path — that is
  the workflow for testing a local change, because a path install links the working tree rather
  than downloading from npm.

> `dsh plugin --profile <name> add notarize-mcp` is **not** an equivalent: `dsh plugin` only owns
> the `allow-version`, `revoke-version` and `version-exemptions` subcommands and passes everything
> else to `pnpm`. That installs the package as a plain dependency without selecting it as a bundle,
> so `cordis.patch.yml` never runs and no tools or skills appear. The same applies to a bare
> `pnpm add notarize-mcp` in the profile directory.

Installing changes the profile, so it affects every session in it and survives restarts. Remove it
with `plugin_manager` `action: remove_bundle`.

## What the bundle composes

[`cordis.patch.yml`](../cordis.patch.yml) at the package root is the bundle's patch layer. It adds
two rows after every shipped bundle layer:

| Row id | Plugin | Effect |
|---|---|---|
| `notarize-mcp` | `@deepseek-ai/dsh-mcp-client` | Starts the server over stdio, so its tools reach the agent as `mcp__notarize__<tool>` — for example `mcp__notarize__doctor`, `mcp__notarize__distribution_checklist`, `mcp__notarize__notarize_and_staple`. |
| `notarize-skills` | `@deepseek-ai/dsh-skill-filesystem` | Adds a skill root scoped to this package's `skills/` directory, so `apple-distribution` and `setup` join the session catalog. |

### Why the rows are added, not overridden

`@deepseek-ai/dsh-web-app` disables the base host `skill-filesystem` row, because agent presets own
local skill discovery in that deployment. Re-enabling it would also re-scan the project and user
skill roots that the preset rows already cover. So this bundle inserts its **own** secondary
provider instead, with a non-default `providerName` and `includeDefaultRoots: false`, which
contributes exactly these two skills and nothing else.

### Why `bundledSkillDir`, not `customSkillDirs`

Both make a directory visible to the skill registry, but they read it differently:

- `customSkillDirs` roots are read through the fs service, which is sandboxed to the session
  workspace. This package is installed in the profile — outside that workspace.
- `bundledSkillDir` roots are read host-side (source `bundled`, rank 600), which works regardless.

Rank 600 is the lowest priority, so a project or user skill of the same name still wins.

### How the patch finds the package

A patch's `config` values stay literal — relative paths are only anchored for inserted plugin
*names*, not for config. So the skills root is resolved at activation by a Loader `!!js` expression:

```yaml
bundledSkillDir: !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(new URL('resolve.mjs', baseUrl)).resolve('notarize-mcp/package.json')), 'skills')
```

`baseUrl` is the profile directory, where the package is installed, so the lookup succeeds for a
registry install and a local-path install alike. `new URL('resolve.mjs', baseUrl)` turns a
directory URL into a file URL so `createRequire` treats the directory itself as the resolution
root, instead of its parent.

## The one caveat: ambient credentials are scrubbed

Before DSH starts a stdio MCP server it removes ambient variables whose *names* match
`/KEY|PASSWORD|SECRET|TOKEN/i` (and every `DSH_*`). That deliberately catches several of this
server's credentials:

| Variable | Scrubbed | Why it matters |
|---|---|---|
| `ASC_KEY_ID` | yes | Falls back to the saved profile, so this is usually harmless. |
| `ASC_PRIVATE_KEY_PATH`, `ASC_PRIVATE_KEY` | yes | Same. |
| `NOTARY_KEYCHAIN_PROFILE` | yes | Falls back to the saved profile field of the same name. |
| `ASC_ISSUER_ID`, `ASC_PROFILE` | no | Reach the server normally. |
| `NOTARIZE_MCP_*` (`CONFIG_DIR`, `LOG_DIR`, `STATE_DIR`, `AUTO_CONFIRM`) | no | Reach the server normally. |
| any user-chosen `password_env` name containing KEY/PASSWORD/SECRET/TOKEN | yes | The server is told to read a variable the child never received. |

**Fix:** let credentials live in the saved profile instead of the environment. That is what
`/notarize:setup` and `asc_auth action=configure` already write, at
`~/.config/notarize-mcp/config.json` (0600), and `HOME` is not scrubbed — so the server finds it
with no configuration at all. `asc_auth action=status` reports which source won.

If you must pass environment variables through, override the row in the profile's
`cordis.patch.yml`. A patch replaces an entry's **whole** `config`, so restate every field you
keep:

```yaml
- id: notarize-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: notarize
    transport: stdio
    command: npx
    # Copy these four values from the bundle's own cordis.patch.yml, so the pin
    # keeps matching the release rather than a version written down here.
    args: ['-y', 'notarize-mcp@<version>']
    failOnStartupError: true
    env:
      ASC_KEY_ID: !!js process.env.ASC_KEY_ID
      ASC_ISSUER_ID: !!js process.env.ASC_ISSUER_ID
      ASC_PRIVATE_KEY_PATH: !!js process.env.ASC_PRIVATE_KEY_PATH
      NOTARY_KEYCHAIN_PROFILE: !!js process.env.NOTARY_KEYCHAIN_PROFILE
```

An `!!js` expression is stored as an expression, not as its value, so the secret is not written to
disk. Explicit `env` entries merge *over* the scrubbed environment, which is why they survive.

## Verifying an install

- The tools are registered as `mcp__notarize__doctor` and friends; `cordis_inspect_query` with the
  `Tool` provider lists what the agent can currently call, without needing approval.
- `cordis_inspect_query` with `Config.listConfigs` (filter by `name`) shows the mounted rows and
  their resolved config, including whether the skills root resolved.
- A skill that DSH rejects is dropped silently — DSH writes a warning to its log and the catalog
  simply omits it. `test/package.test.ts` guards the frontmatter rules (kebab-case `name` matching
  the directory, non-empty `description`) so this cannot regress unnoticed.

## Long operations

The server's background jobs and `watch-job` / `watch-notarization` commands work the same under
DSH; see [agent-integration.md](agent-integration.md) for the confirm-token contract and the
Monitor workflow.
