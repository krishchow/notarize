# Releasing

Releases are cut **locally** (GitHub Actions is manual-only) and published to npm as [`notarize-mcp`](https://www.npmjs.com/package/notarize-mcp).

## One-time setup
1. An npm account with 2FA enabled: <https://www.npmjs.com/signup>.
2. `npm login` on the machine you release from.
3. If the name `notarize-mcp` were ever taken, switch to a scoped name such as `@krishchow/notarize-mcp`. To do that:
   - change `name` in `package.json`;
   - change `PACKAGE_NAME` in `src/cli/install.ts`;
   - change the `selfCommand()` fallback in `src/core/monitor.ts`.

## Each release
```bash
bash scripts/release.sh 0.2.1   # bump package.json + plugin.json, build, check, commit, tag
npm publish                     # prepublishOnly re-runs check + build; enter your 2FA code
git push && git push --tags
```

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
