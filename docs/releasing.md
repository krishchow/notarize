# Releasing

Releases are published to npm as [`notarize-mcp`](https://www.npmjs.com/package/notarize-mcp). There are two ways to do it:
- the manual **Release** GitHub workflow (recommended);
- the local script.

Both bump `package.json` and `.claude-plugin/plugin.json` together using `scripts/bump-version.mjs`.

## Release from GitHub (recommended)
`.github/workflows/release.yml` only runs when you start it. It is one Linux job of about 2–3 minutes. Nothing runs on push or PR.

### One-time setup
1. **Create an npm token.** On npmjs.com, go to your avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**.
   - Permissions: Packages and scopes → **Read and write**, **All packages**. The package doesn't exist until the first publish, so you can't select it yet.
   - Tick **Bypass two-factor authentication**. CI can't type an OTP.
   - Choose an expiry; 90 days is the maximum.
2. **Store it in GitHub.** Go to the repo → **Settings → Environments → New environment `npm`** → **Add environment secret `NPM_TOKEN`**.
   - A repository secret with the same name also works.
   - Optional: add yourself under **Required reviewers**, so every run waits for your click before it can touch npm.
3. **If `main` is branch-protected,** let `github-actions[bot]` bypass it. The workflow pushes the `Release vX` commit and tag to `main`.

The workflow appears under the **Actions** tab once `release.yml` is on `main`, the default branch.

### Each release
- **From the web:** Actions → **Release** → **Run workflow** (branch `main`).
  - `version`: for example `0.2.1`. Use the current `package.json` version, such as `0.2.0` for the very first publish, to publish without a bump.
  - `npm_tag`: `latest`, or `next` for a pre-release.
  - `dry_run`: builds, checks and runs `npm publish --dry-run`, and pushes nothing. This works from any branch.
- **From a terminal:** `gh workflow run release.yml -f version=0.2.1`, optionally with `-f dry_run=true`.

What it does, in order:
1. **Guards.** It checks that the version is semver and that the run is on `main` (unless `dry_run`). It checks that the version isn't already on npm. It checks that tag `vX` doesn't point at another commit.
2. **Install.** `npm ci`.
3. **Bump.** If the version changed, it bumps it and runs `npm run build` + `npm run check`.
4. **Commit and tag.** It commits `Release vX` (versions + `dist/`) and tags `vX`. It pushes both atomically to `main`.
5. **Publish.** `npm publish --access public --provenance`. Provenance applies only when the repo is public.
6. **GitHub Release.** It creates one with generated notes.

**If a run fails after the push** (for example, the token was wrong), fix the cause and run it again with the **same** version. The commit and tag already exist, so it goes straight to publishing.

### Optional: drop the token (trusted publishing)
After the first publish, on npmjs.com go to package **notarize-mcp → Settings → Trusted Publisher → GitHub Actions** and enter:
- owner `krishchow`;
- repository `notarize`;
- workflow `release.yml`;
- environment `npm`.

Then delete the `NPM_TOKEN` secret. When the secret is empty, the workflow authenticates with GitHub's OIDC token instead.

## Release locally (alternative)
### One-time setup
1. You need an npm account with 2FA enabled: <https://www.npmjs.com/signup>.
2. Run `npm login` on the machine you release from.

### Each release
```bash
bash scripts/release.sh 0.2.1   # bump package.json + plugin.json, build, check, commit, tag
npm publish                     # prepublishOnly re-runs check + build; enter your 2FA code
git push && git push --tags
```

### Using a scoped package name
If the name `notarize-mcp` were ever taken, switch to a scoped name such as `@krishchow/notarize-mcp`. Change it in these places:
- `name` in `package.json`;
- `PACKAGE_NAME` in `src/cli/install.ts`;
- the `selfCommand()` fallback in `src/core/monitor.ts`;
- `PACKAGE` in `.github/workflows/release.yml`.

## What gets published
- `dist/notarize-mcp.js`: a single self-contained bundle. All runtime libraries are bundled, so the package has **no dependencies** and `npx` starts fast.
- `skills/apple-distribution/`: the skill.
- `README.md` and `LICENSE`.

`test/install.test.ts` checks the tarball contents with `npm pack --dry-run` and checks that the plugin and package versions match.

## How users install
- **`npx -y notarize-mcp install`** does three things:
  - registers the server with Claude Code (`claude mcp add --scope user notarize -- npx -y notarize-mcp@latest`), Claude Desktop and/or Cursor, whichever are detected;
  - installs the skill into `~/.claude/skills/apple-distribution`;
  - prints the next steps.
- **Options:**
  - `--client claude-code|claude-desktop|cursor|all`
  - `--scope project` (writes into the current repo)
  - `--pin` (pins this version instead of `@latest`)
  - `--no-skill`, `--force`, `--dry-run`
  - `uninstall` reverses everything.
- **Claude Code plugin** (alternative): `/plugin marketplace add krishchow/notarize` then `/plugin install notarize@notarize`. This uses the committed `dist/`, not npm.
