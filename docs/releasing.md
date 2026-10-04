# Releasing

Each release ships two artifacts with the same version:
1. **The npm package [`notarize-mcp`](https://www.npmjs.com/package/notarize-mcp).** It is the MCP server, and users run it with `npx -y notarize-mcp`.
2. **The Claude Code plugin.** The marketplace is this repo's `main` branch. The plugin holds the skill plus `.claude-plugin/plugin.json`, which starts the server with `npx -y notarize-mcp@<version>`.

`scripts/bump-version.mjs` sets the version in `package.json`, in `plugin.json`, and in the plugin's `notarize-mcp@<version>` pin. Because of the pin, **`main` must only reach a new version after npm has it**. Both release paths below follow that order.

There are two ways to release:
- the manual **Release** GitHub workflow (recommended);
- the local script.

## Release from GitHub (recommended)
`.github/workflows/release.yml` only runs when you start it. It is one Linux job of about 2–3 minutes. Nothing runs on push or PR.

### One-time setup
1. **Create an npm token.** On npmjs.com, go to your avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**.
   - Permissions: Packages and scopes → **Read and write**, **All packages**. The package doesn't exist until the first publish, so you can't select it yet.
   - Tick **Bypass two-factor authentication**. CI can't type an OTP.
   - Choose an expiry; 90 days is the maximum.
2. **Store it in GitHub.** Go to the repo → **Settings → Secrets and variables → Actions → New repository secret `NPM_TOKEN`**.
   - Optional approval gate: create an environment (for example `npm`) with yourself under **Required reviewers**, move the secret into it, and add `environment: npm` to the `release` job. Every run then waits for your click before it can touch npm.
3. **If `main` is branch-protected,** let `github-actions[bot]` bypass it. The workflow pushes the `Release vX` commit to `main`.

The workflow appears under the **Actions** tab once `release.yml` is on `main`, the default branch.

### Each release
- **From the web:** Actions → **Release** → **Run workflow** (branch `main`).
  - `version`: for example `0.2.1`. Use the current `package.json` version, such as `0.2.0` for the very first publish, to publish without a bump.
  - `npm_tag`: `latest`, or `next` for a pre-release.
  - `dry_run`: builds, checks and runs `npm publish --dry-run`, and pushes nothing. This works from any branch.
- **From a terminal:** `gh workflow run release.yml -f version=0.2.1`, optionally with `-f dry_run=true`.

What it does, in order:
1. **Guards.** It checks that the version is semver and that the run is on `main` (unless `dry_run`). It refuses a version that is already released.
2. **Install.** `pnpm install --frozen-lockfile`.
3. **Bump and check.** If the version changed, it bumps it, then runs `pnpm run check` (lint, typecheck, build, tests).
4. **Commit and tag.** It commits `Release vX` (the version files only; `dist/` isn't committed) and tags `vX`. It pushes **only the tag**. Plugin users follow `main`, so a tag alone changes nothing for them.
5. **Publish.** `npm publish --access public --provenance`. Provenance applies only when the repo is public.
6. **Push `main`.** It fast-forwards `main` to the release commit. The plugin now pins `notarize-mcp@X`, which npm already has.
7. **GitHub Release.** It creates one with generated notes.

**If a run fails partway** (for example, the token was wrong, or `main` moved), fix the cause and run it again with the **same** version. The run resumes from the pushed tag: it publishes if npm doesn't have the version yet, then pushes `main`.

### Optional: drop the token (trusted publishing)
After the first publish, on npmjs.com go to package **notarize-mcp → Settings → Trusted Publisher → GitHub Actions** and enter:
- owner `krishchow`;
- repository `notarize`;
- workflow `release.yml`;
- environment: leave empty, unless you added one to the job.

Then delete the `NPM_TOKEN` secret. When the secret is empty, the workflow authenticates with GitHub's OIDC token instead.

## Release locally (alternative)
### One-time setup
1. You need an npm account with 2FA enabled: <https://www.npmjs.com/signup>.
2. Run `npm login` on the machine you release from.

### Each release
```bash
bash scripts/release.sh 0.2.1             # bump versions + plugin pin, check, commit, tag
npm publish                               # prepublishOnly re-runs the checks; enter your 2FA code
git push --follow-tags origin HEAD:main   # only after npm has the version
```

### Using a scoped package name
If the name `notarize-mcp` were ever taken, switch to a scoped name such as `@krishchow/notarize-mcp`. Change it in these places:
- `name` in `package.json`;
- the `notarize-mcp@` pin in `.claude-plugin/plugin.json` and the regex in `scripts/bump-version.mjs`;
- the `selfCommand()` fallback in `src/core/monitor.ts`;
- `PACKAGE` in `.github/workflows/release.yml`.

## What gets published
- **npm:** `dist/notarize-mcp.js` (one self-contained bundle with every runtime library inside, so the package has **no dependencies** and `npx` starts fast), `skills/apple-distribution/` (served as `notarize://guides/*` resources), `README.md` and `LICENSE`. `dist/` is built at publish time and isn't in git.
- **Plugin:** whatever is on `main`, which is `.claude-plugin/` and `skills/`. It contains no server code. The server comes from npm.

`test/package.test.ts` covers four checks:
- the tarball contents, via `npm pack --dry-run`;
- version sync between `package.json`, `plugin.json` and the plugin's npx pin;
- `bump-version`;
- the release order (checks → tag → publish → `main`).
