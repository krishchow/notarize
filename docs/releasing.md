# Releasing

Each release ships two artifacts with the same version:
1. **The npm package [`notarize-mcp`](https://www.npmjs.com/package/notarize-mcp).** It is the MCP server, and users run it with `npx -y notarize-mcp`.
2. **The Claude Code plugin.** The marketplace is this repo's `main` branch. The plugin holds the skill plus `.claude-plugin/plugin.json`, which starts the server with `npx -y notarize-mcp@<version>`.

Versions are managed with [Changesets](https://github.com/changesets/changesets) and [changesets/action](https://github.com/changesets/action). Each PR describes its own release impact in a changeset. `package.json` holds the real version, and no one edits it by hand.

`scripts/bump-version.mjs` sets the version in `package.json`, in `plugin.json`, and in the plugin's `notarize-mcp@<version>` pin. Because of the pin, **`main` must only pin a version npm already has**. The flow below keeps that order: the plugin pin moves in its own commit, after the publish.

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

   It does **not** touch the plugin. Review the PR, and keep merging feature PRs; the bot updates it with each new changeset.
3. **Merge the Version Packages PR** to release. Then **publish** runs `changeset publish`, which:
   - runs `pnpm publish`, whose `prepublishOnly` runs `pnpm run check` first (lint, typecheck, build, tests);
   - pushes the `vX` tag;
   - creates the GitHub Release with the changelog entry.
4. **sync-plugin** checks that npm now has `notarize-mcp@X`, then runs `scripts/bump-version.mjs X` and pushes `Pin the Claude Code plugin to notarize-mcp@X` to `main`. Plugin users get the new version from that commit.

Between steps 3 and 4, `main` briefly has `package.json` at X and the plugin still at X−1. That is expected, and safe for plugin users. `test/package.test.ts` allows the plugin to lag, but never to lead.

**If a run fails partway,** fix the cause and start **Actions → Release → Run workflow** on `main`.
- If npm doesn't have the version yet, the run publishes it.
- If npm has it but the plugin isn't pinned, sync-plugin pins it on every run.

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
2. Run `npm login` on the machine you release from.

### Each release
```bash
bash scripts/release.sh                   # consume changesets, bump versions + plugin pin, check, commit, tag
pnpm publish                              # prepublishOnly re-runs the checks; enter your 2FA code
git push --follow-tags origin HEAD:main   # only after npm has the version
```
The local path moves the plugin pin in the release commit itself, because `main` is pushed only after `pnpm publish`.

### Using a scoped package name
If the name `notarize-mcp` were ever taken, switch to a scoped name such as `@krishchow/notarize-mcp`. Change it in these places:
- `name` in `package.json`;
- the `notarize-mcp@` pin in `.claude-plugin/plugin.json` and the regex in `scripts/bump-version.mjs`;
- the `selfCommand()` fallback in `src/core/monitor.ts`;
- `PACKAGE` in `.github/workflows/release.yml`;
- a `.changeset/*.md` file's frontmatter, if any are pending.

## What gets published
- **npm:** `dist/notarize-mcp.js` (one self-contained bundle with every runtime library inside, so the package has **no dependencies** and `npx` starts fast), `skills/apple-distribution/` (served as `notarize://guides/*` resources), `README.md` and `LICENSE`. `dist/` is built at publish time and isn't in git.
- **Plugin:** whatever is on `main`, which is `.claude-plugin/` and `skills/`. It contains no server code. The server comes from npm.

`test/package.test.ts` covers these checks:
- the tarball contents, via `npm pack --dry-run`;
- the plugin's npx pin matches `plugin.json`, and the plugin is never ahead of `package.json`;
- `bump-version`;
- the release order: the Version Packages PR never moves the plugin pin, and sync-plugin pins it only after npm has the version.
