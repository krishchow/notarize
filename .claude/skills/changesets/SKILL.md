---
name: changesets
description: Versioning and releases for this repo (notarize-mcp + the Claude Code plugin) via Changesets. Use when a change affects what users get and needs a changeset, when asked to bump/set a version, cut or prepare a release, write release notes or CHANGELOG entries, do a prerelease, or when touching package.json "version", .claude-plugin/plugin.json, .changeset/, CHANGELOG.md, scripts/bump-version.mjs, scripts/release.sh or .github/workflows/release.yml. Keywords: changeset, version bump, semver, release, publish, CHANGELOG, Version Packages PR, plugin pin, prerelease.
---

# Changesets in notarize

## Three version numbers, one source of truth
| Where | What it is | Who changes it |
|---|---|---|
| `.changeset/*.md` | Pending release intent: bump level + changelog line | You, in the PR that makes the change |
| `package.json` `version` | The **MCP server** version, the one published to npm as `notarize-mcp` | `changeset version` only (Version Packages PR, or `scripts/release.sh`) |
| `.claude-plugin/plugin.json` `version` + `npx -y notarize-mcp@X` pin | The **plugin** version; it equals the server version it launches | `scripts/bump-version.mjs` only, run by the release workflow's `sync-plugin` job **after** npm has X |

There is only one package: the plugin has no version of its own. It trails `package.json` briefly after each release, and never leads it (`test/package.test.ts` enforces this). Never hand-edit any of these versions, and never put `bump-version` in the version step.

## When a PR needs a changeset
Add one when the change reaches users through npm or the plugin:
- `src/**`: tools, parsers, server behaviour, CLI.
- `skills/**`: guidance agents read. Both the npm package and the plugin ship it.
- Runtime behaviour of `.claude-plugin/` (not its version).

Don't add one for tests, docs-only changes, CI or release tooling, or refactors with no behaviour change. If someone asks, an empty changeset (`pnpm changeset --empty`) records that "no release" is intentional.

**Bump level** (we're on 0.x, but treat it as semver):
- `patch`: bug fixes, better error messages, catalog or knowledge updates, skill wording.
- `minor`: a new tool, action, argument, skill or resource, or new behaviour.
- `major`: a breaking tool contract (renamed or removed tools, actions or args, changed result shape), or a raised Node minimum.

## Writing one
`pnpm changeset` is interactive, and it auto-commits because `.changeset/config.json` has `"commit": true`. As an agent, write the file directly instead and commit it together with the change:

Name it `.changeset/<short-kebab-name>.md`. The frontmatter must be the first line:
```md
---
"notarize-mcp": minor
---

Add `foo_bar` tool to list App Store Connect widgets.
```

- Use one changeset per logical change. Several can sit in one PR.
- The summary becomes the CHANGELOG line. `@changesets/changelog-github` adds the PR link and author, so write it for users: say what changed and why it matters, in one sentence, in the imperative.
- Check what's pending with `pnpm changeset status`.

## What happens after merge (no action needed)
1. The push to `main` triggers `.github/workflows/release.yml`. It opens or updates the **Version Packages** PR, which consumes the changesets, bumps `package.json` and writes `CHANGELOG.md`.
2. Merging that PR runs `changeset publish`. That calls `pnpm publish`, whose `prepublishOnly` runs `pnpm run check`, then it tags `vX` and creates the GitHub Release.
3. `sync-plugin` pins `plugin.json` to `notarize-mcp@X` and pushes to `main`. It skips prereleases. Re-running the workflow retries it.

Local alternative: `bash scripts/release.sh`, then `pnpm publish`, then `git push --follow-tags origin HEAD:main`. Always publish to npm first, then push main.

## Prereleases
`pnpm changeset pre enter next` (commit `.changeset/pre.json`), then add changesets as usual; versions become `X.Y.Z-next.N` on npm tag `next`. `pnpm changeset pre exit` to return. The plugin stays on the latest stable version.

## Don'ts
- Don't edit `version` in `package.json` or `plugin.json`, and don't run `bump-version.mjs` by hand on a branch.
- Don't edit `CHANGELOG.md` by hand for upcoming changes. Add a changeset instead.
- Don't delete other people's pending changesets. `changeset version` consumes them.
- Don't add `[skip ci]` to commit messages or PR titles. It would stop the release workflow from running.

Full details are in `docs/releasing.md`.
