# Releasing

Each release ships one npm package with the same version, consumed four ways:
1. **The npm package [`notarize-mcp`](https://www.npmjs.com/package/notarize-mcp) as the MCP server.** Users run it with `npx -y notarize-mcp`.
2. **The same package as a DeepSeek Harness bundle.** `package.json` declares `dsh.bundle.patch`, so the published `cordis.patch.yml` mounts the server and both skills into a DSH profile. It starts the server with `npx -y notarize-mcp@<version>`.
3. **This repository as a Codex plugin.** `.codex-plugin/plugin.json` plus `codex.mcp.json` give Codex the same server and skills; the repo marketplace at `.agents/plugins/marketplace.json` makes it installable by name. It starts the server with `npx -y notarize-mcp@<version>`.
4. **The Claude Code plugin.** The marketplace is this repo's `main` branch. The plugin holds the skills plus `.claude-plugin/plugin.json`, which starts the server with `npx -y notarize-mcp@<version>`.

Versions are managed with [Changesets](https://github.com/changesets/changesets) and [changesets/action](https://github.com/changesets/action). Each PR describes its own release impact in a changeset. `package.json` holds the real version, and no one edits it by hand.

`scripts/bump-version.mjs` is the only way a version or pin moves. It rewrites all five files that carry one:

| File | Version field | Server pin |
|---|---|---|
| `package.json` | yes — the version of record | — |
| `.claude-plugin/plugin.json` | yes | yes |
| `.codex-plugin/plugin.json` | yes | — |
| `codex.mcp.json` | — | yes |
| `cordis.patch.yml` | — | yes |

Because of the pins, **`main` must only pin a version npm already has**. The flow below keeps that order: every plugin surface moves in its own commit, after the publish.

## Day to day: add a changeset
Add a changeset to every PR that changes what users get (server, tools, skills, plugin):
```bash
pnpm changeset               # choose patch / minor / major, write a one-line summary; it commits the file
```
- Pick the bump by semver: `patch` for fixes, `minor` for new tools, actions or skills, `major` for breaking tool contracts.
- Several changesets can pile up on `main`. They are all released together, at the highest bump level among them.
- PRs that release nothing (tests, docs, CI) need no changeset. You can add an empty one with `pnpm changeset --empty` to make that explicit.
- Optional: install the [Changesets bot](https://github.com/apps/changeset-bot) to comment on PRs that have no changeset. It is a GitHub App, so it uses no Actions minutes.

`@changesets/cli` is a devDependency and needs Node 22.11+ or 24. The changelog uses `@changesets/changelog-github`, which links each entry to its PR and author; `changeset version` needs a `GITHUB_TOKEN` for that (the workflow provides one).

## Release from GitHub (recommended)
`.github/workflows/release.yml` runs on pushes to `main` that touch `.changeset/` or `package.json`, and on demand (**Actions → Release → Run workflow**). It never runs on PRs. Each run is a few short Linux jobs.

1. **select-mode** decides what to do.
   - `version` when there are changesets.
   - `publish` when `package.json` holds a version that npm doesn't have.
   - `none` otherwise.
2. **version** opens or updates the **Version Packages** PR. That PR runs `pnpm run version-packages` (`changeset version`), which:
   - consumes `.changeset/*.md`;
   - bumps `package.json`;
   - writes `CHANGELOG.md`.

   It does **not** touch any plugin surface. Review the PR, and keep merging feature PRs; the bot updates it with each new changeset.
3. **Merge the Version Packages PR** to release. Then **publish** runs `changeset publish`, which:
   - runs `pnpm publish`, whose `prepublishOnly` runs `pnpm run check` first (lint, typecheck, build, tests);
   - pushes the `vX` tag;
   - creates the GitHub Release with the changelog entry.
4. **sync-plugin** waits for npm to list `notarize-mcp@X` (up to 5 minutes; it fails the run if npm never does), then runs `scripts/bump-version.mjs X` and pushes `Pin the plugin surfaces to notarize-mcp@X` to `main`. Users of all three plugin surfaces get the new version from that commit.

Between steps 3 and 4, `main` briefly has `package.json` at X while the plugin surfaces still pin X−1. That is expected, and safe for plugin users. `test/package.test.ts` allows the Claude Code plugin to lag, but never to lead; the Codex and DSH surfaces are checked for exact equality, because they carry the version or pin without the same lag allowance.

**If a run fails partway,** fix the cause and start **Actions → Release → Run workflow** on `main`.
- If npm doesn't have the version yet, the run publishes it.
- If npm has it but any surface is behind, sync-plugin fixes them on every run.

### One-time setup
1. **Let Actions open PRs.** Go to repo **Settings → Actions → General → Workflow permissions** and tick **Allow GitHub Actions to create and approve pull requests**.
2. **npm auth.** Choose one.
   - **Trusted publishing (recommended).** On npmjs.com go to package **notarize-mcp → Settings → Trusted Publisher → GitHub Actions** and enter:
     - owner `krishchow`;
     - repository `notarize`;
     - workflow `release.yml`;
     - environment: leave empty.

     No secret is needed.
   - **Token.** Create a granular access token with publish rights and **Bypass two-factor authentication**, then store it as the repository secret `NPM_TOKEN`. When the secret is set, the workflow uses it. npm is phasing out 2FA-bypass tokens, so prefer trusted publishing.
3. **If `main` is branch-protected,** let `github-actions[bot]` bypass it. sync-plugin pushes the pin commit straight to `main`.

PRs opened by the workflow's `GITHUB_TOKEN` don't trigger other workflows. That is fine here, since CI is manual-only; run `pnpm run check` locally on the Version Packages branch if you want.

### Prereleases
```bash
pnpm changeset pre enter next          # commit .changeset/pre.json; versions become X.Y.Z-next.N, npm tag `next`
pnpm changeset pre exit                # back to normal releases
```
Prereleases are published to npm under the `next` tag. sync-plugin leaves the plugin on the latest stable version.

## Release locally (alternative)
### One-time setup
1. You need an npm account with 2FA enabled: <https://www.npmjs.com/signup>.
2. Run `pnpm login` on the machine you release from.

### Each release
```bash
bash scripts/release.sh                   # consume changesets, bump versions + every pin, check, commit, tag
pnpm publish                              # prepublishOnly re-runs the checks; enter your 2FA code
git push --follow-tags origin HEAD:main   # only after npm has the version
```
The local path moves every version and pin in the release commit itself, because `main` is pushed only after `pnpm publish`.

### Using a scoped package name
If the name `notarize-mcp` were ever taken, switch to a scoped name such as `@krishchow/notarize-mcp`. Change it in these places:
- `name` in `package.json`;
- the `notarize-mcp@` pins in `.claude-plugin/plugin.json`, `codex.mcp.json` and `cordis.patch.yml`, and the regexes in `scripts/bump-version.mjs`;
- the `selfCommand()` fallback in `src/core/monitor.ts`;
- `PACKAGE` in `.github/workflows/release.yml`;
- a `.changeset/*.md` file's frontmatter, if any are pending.

## What gets published
- **npm:** `dist/notarize-mcp.js` (one self-contained bundle with every runtime library inside, so the package has **no dependencies** and `npx` starts fast), `skills/apple-distribution/` (served as `notarize://guides/*` resources), `skills/setup/`, `cordis.patch.yml` (the DSH bundle layer), `README.md` and `LICENSE`. `dist/` is built at publish time and isn't in git. The plugin manifests (`.claude-plugin/`, `.codex-plugin/`, `.agents/`, `codex.mcp.json`) are deliberately **not** in the tarball: the marketplaces read the git repository.
- **Claude Code plugin:** whatever is on `main`, which is `.claude-plugin/` and `skills/`. It contains no server code. The server comes from npm.
- **Codex plugin:** also whatever is on `main` — `.codex-plugin/plugin.json`, `codex.mcp.json`, `.agents/plugins/marketplace.json` and `skills/`. See [codex.md](codex.md).
- **DeepSeek Harness bundle:** the published npm package itself — `dsh.bundle.patch` in its `package.json` points at the `cordis.patch.yml` above, so installing the package as a profile bundle composes the server row and the skills row. See [dsh.md](dsh.md).

`test/package.test.ts` covers these checks:
- the tarball contents, via `npm pack --dry-run`, including that no plugin manifest is published;
- the Claude Code plugin's npx pin matches `plugin.json`, and the plugin is never ahead of `package.json`;
- the DSH manifest, its `insert` rows and its pin, which must equal `package.json` exactly;
- that both shipped skills pass DeepSeek Harness frontmatter discovery;
- the Codex manifest, its `./`-relative component paths, the onboarding skill, the server row's `env_vars` and timeouts, and that the marketplace entry agrees with the manifest name;
- that the release guard's own pin-reading expressions resolve to the version in `package.json`;
- `bump-version`;
- the release order: the Version Packages PR never moves a pin, and sync-plugin moves them only after npm has the version.
