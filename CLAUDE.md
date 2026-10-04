# notarize — working on this repo

A stdio MCP server (TypeScript) plus a Claude Code skill for Apple code signing, notarization, provisioning and App Store Connect. Users run it **on a Mac**; development and unit tests run anywhere (macOS commands are faked).

## Commands
```bash
pnpm run check                 # biome lint + tsc + build + vitest — must pass before committing
pnpm run build                 # tsup → dist/notarize-mcp.js (build output; gitignored, published to npm)
UPDATE_DOCS=1 pnpm exec vitest run test/docs.test.ts   # regenerate docs/tools.md, docs/claude-settings.example.json, error-catalog.md
pnpm run test:recorded         # parsers vs real macOS output in test/fixtures/recorded (skips missing files)
pnpm run test:live             # real Apple account, opt-in — see docs/testing.md
bash scripts/smoke-macos.sh   # real end-to-end on a Mac (no Apple credentials)
pnpm changeset                # add a changeset (patch/minor/major + summary) to any PR that changes what users get
bash scripts/release.sh       # local release from pending changesets: version, check, commit + tag; then `pnpm publish`
# GitHub: Release workflow (changesets/action) opens a "Version Packages" PR; merging it publishes (docs/releasing.md)
```
GitHub Actions are **manual only** (`workflow_dispatch`) — the account has no spare minutes — with one exception: `release.yml` also runs on pushes to `main` that touch `.changeset/` or `package.json`. Run the checks locally. `ci.yml` = optional macOS/live verification; `release.yml` = Changesets version PR + publish to npm. Never edit `version` by hand: add a changeset and let `changeset version` bump `package.json`; the plugin pin follows via `scripts/bump-version.mjs` after publishing.

## Layout
| Path | What |
|---|---|
| `src/index.ts` | CLI entry: MCP over stdio, `watch-job`, `watch-notarization`, `--list-tools` |
| `src/server.ts` | registers tools / resources / prompts; converts `ToolOutput` → MCP result |
| `src/core/` | `exec.ts` (CommandRunner), `confirm.ts` (tokens + auto-confirm policy), `jobs.ts` (background jobs + state files), `monitor.ts`, `config.ts` (credentials), `redact.ts`, `plist.ts`, `result.ts`, `fake-runner.ts` |
| `src/knowledge/` | data: targets, certificate types, entitlements, privacy keys, error catalog, SDK minimums |
| `src/parsers/` | pure parsers for codesign/security/spctl/notarytool/xcodebuild/otool/logs/crash reports, Mach-O discovery, project detection |
| `src/asc/` | App Store Connect JWT auth + JSON:API client |
| `src/tools/` | one module per tool group; `index.ts` is the registry; `types.ts` has `defineTool` + `withConfirmation` |
| `src/cli/watch.ts` | Monitor-friendly watchers |
| `src/docs/tool-docs.ts` | generators for docs/tools.md and the settings example |
| `skills/setup/` | `/notarize:setup` skill; `scripts/setup.mjs` is a zero-dep Node script (JSON out) that checks/installs ASC credentials. Its resolution must match `ConfigStore.resolveAsc` (parity test in `test/setup-script.test.ts`) |
| `skills/apple-distribution/` | the skill (SKILL.md + references/) — also served as `notarize://guides/*` |
| `test/` | vitest; `helpers.ts` has `makeCtx`, `connect`, `call`, `callConfirmed`, `fakeAsc`, `ascEnv` |

## Invariants (don't break these)
1. **Never use a shell.** All commands go through `CommandRunner.run(cmd, argv[])` (`src/core/exec.ts`). Paths are user input.
2. **Every state change goes through `withConfirmation`** (`src/tools/types.ts`). This covers files, keychain, Apple account and uploads. Set `mutating: true` on the tool, and set `destructive: true` on the plan for anything irreversible or account-affecting. Destructive plans are never auto-confirmed under the `safe` policy.
3. **Secrets never travel through tool arguments, results or logs.**
   - Take `password_env` (the name of an env var), not passwords.
   - Pass `secrets: [...]` to `runner.run` so transcripts redact them.
   - Persist only the path of a `.p8`, never its contents.
4. **New failure strings get an `ERROR_CATALOG` entry** (`src/knowledge/error-catalog.ts`). Add a matching real-world message to `test/knowledge.test.ts`, then regenerate docs.
5. **Long operations go through `ctx.jobs.runWithDeadline`.** When they detach, return `detachedOutput()` (`src/tools/detached.ts`), which carries the Monitor command. Record durable identifiers with `job.setMeta(...)`, e.g. `submissionId`.
6. **Results are `ToolOutput`**: a short `summary` first, structured `data`, and `next_steps` naming exact tool calls.
7. **Commit generated docs, not the bundle.** After changing tools or the catalog, run `UPDATE_DOCS=1 …` and commit the docs. `dist/` is build output; it is gitignored and only published to npm.
8. **Keep the knowledge base dated.** When Apple changes requirements, update `src/knowledge/*`, including `SDK_REQUIREMENTS_LAST_REVIEWED`.
9. **Two artifacts, one version.** The npm package is the server. The plugin (`.claude-plugin/plugin.json` + `skills/`) runs `npx -y notarize-mcp@<version>`. Versions come from changesets (`pnpm changeset`); never hand-edit them. Never let the plugin on `main` pin a version that isn't on npm yet: the Version Packages PR bumps only `package.json`, and `release.yml`'s sync-plugin job runs `scripts/bump-version.mjs` after the publish.

## Adding a tool
1. In `src/tools/<group>.ts`: `export const fooTool = defineTool({ name, title, description, input: { action: z.enum([...]), ... }, mutating?, handler })`.
2. Descriptions say what every action does. Arguments get `.describe()` text, because agents read these.
3. Mutating actions: `return withConfirmation(ctx, extra, args, () => plan, () => execute())`.
4. Register it in `src/tools/index.ts`.
5. Test it with `makeCtx({ runner })` + `connect(ctx)` + `call` / `callConfirmed`. Script the commands with `FakeRunner.on(cmd, argvPrefix, response)`, and fake the App Store Connect API with `fakeAsc({ "GET /v1/x": {...} })`.
6. Mention it in SKILL.md if agents should know when to use it. `test/docs.test.ts` checks that every tool SKILL.md mentions exists.
7. Regenerate the docs and rebuild `dist/`.
8. Add a changeset (`pnpm changeset`, usually `minor` for a new tool).

## Docs
- `README.md`: users.
- `docs/agent-integration.md`: confirm and auto-confirm contract, jobs/Monitor, permissions, network.
- `docs/tools.md` (generated).
- `docs/testing.md`.
