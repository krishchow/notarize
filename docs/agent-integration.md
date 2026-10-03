# Agent integration guide

How to drive the `notarize` MCP server from an agent (Claude Code or any MCP client), interactively or unattended.

## Installing

| Mode | How | Notes |
|---|---|---|
| Claude Code plugin (recommended) | `/plugin marketplace add krishchow/notarize` → `/plugin install notarize@notarize` | Installs the skill and the MCP server (defined in `.claude-plugin/plugin.json` with `${CLAUDE_PLUGIN_ROOT}`). |
| Developing this repo | `claude --plugin-dir .`, or `claude mcp add notarize -- node "$PWD/dist/notarize-mcp.js"` | The repo deliberately has **no root `.mcp.json`**. A project-scoped file can't resolve `${CLAUDE_PLUGIN_ROOT}`, so the server would fail to start. |
| Other MCP clients | `{"command": "node", "args": ["/abs/path/dist/notarize-mcp.js"]}` | Skill content is also available as `notarize://guides/*` resources and four MCP prompts. |

Run the server **on the Mac that has the signing identities**. On Linux and cloud agents only App Store Connect and file-inspection tools work. For signing there, generate a CI workflow with `ci_config` and run it on a macOS runner.

## The confirm contract

Every tool that changes something — files, keychain, Apple account, uploads — works in two calls:

1. Call it normally. The result is a **preview**:
   ```json
   { "status": "preview", "title": "...", "destructive": false,
     "steps": [{ "description": "...", "command": "codesign --force ..." }],
     "warnings": [], "confirm_token": "lq3k…", "confirm_token_expires_in_seconds": 600 }
   ```
   Nothing has changed yet.
2. After the user approves, repeat the call with **identical arguments** plus `confirm_token`.
   - Any changed argument, another tool, or an expired token gives a new preview with `isError: true` and the reason.
   - `destructive: true` marks irreversible or account-affecting actions:
     - revoke, delete, expire;
     - uploads, review submissions, releases;
     - raw `asc_api` writes;
     - device registration (it uses a yearly slot);
     - profile regeneration;
     - resetting TCC permissions for all apps.

   Always get explicit approval for these.

Tokens are HMACs held in the server process's memory, so they die when the server restarts.

## Unattended runs: `NOTARIZE_MCP_AUTO_CONFIRM`

| Value | Behaviour |
|---|---|
| unset / `0` / `false` | Always preview (default, interactive) |
| `1` / `true` / `safe` | Auto-run **non-destructive** actions: signing, packaging, notarization submit/staple, keychain imports, writing generated files. Destructive actions still return a preview. |
| `sign,package,notary:submit,staple` | Auto-run only the listed tools or `tool:action` pairs. Listing an action is an explicit opt-in, so it runs even if destructive (e.g. `upload_build`). |
| `all` | Auto-run everything. Only for throwaway accounts or test fixtures. |

Auto-confirmed results include `data.auto_confirmed: true` and a summary prefix.

Before `0.2`, `1` meant "everything". It now means `safe`.

## Long-running work: jobs and the Monitor

Several operations take minutes to hours: notarization, `xcodebuild` archive/export, uploads, App Store Connect build processing, and signing very large bundles. These tools wait for a while in the foreground (90s for notarization and build processing, `max_wait_seconds` to override), then return:

```json
{ "status": "running", "job_id": "job_1a2b3c4d", "submission_id": "…",
  "monitor": { "tool": "Monitor", "command": "node …/notarize-mcp.js watch-job job_1a2b3c4d --state-dir …",
               "description": "Notarize + staple Example.app", "timeout_ms": 1800000,
               "fallback_command": "node …/notarize-mcp.js watch-notarization <submission-id>" } }
```

**Claude Code:**
1. Start `Monitor({command, description, timeout_ms: 1800000})` and keep working. Each line it emits is one notification.
2. When it exits, call `jobs action=status job_id=…` for the full result.
3. Monitors expire after 30 minutes. If one expires without a final line, start it again; that is not a failure.

**Other clients:** call `jobs action=status job_id=… wait_seconds=600` repeatedly, or run the watcher in a background shell.

### Watcher CLI
| Command | Output | Exit codes |
|---|---|---|
| `notarize-mcp watch-job <id> [--state-dir DIR] [--interval S] [--max-minutes N]` | One line per status/progress change, then a final `SUCCEEDED` / `FAILED` / `LOST` line | 0 succeeded · 1 failed (incl. notarization Invalid) · 2 not found / usage · 3 lost (server stopped) · 4 max time reached |
| `notarize-mcp watch-notarization <submission-id> [--keychain-profile P] [--profile P]` | Polls Apple every 30s | 0 Accepted · 1 Invalid/Rejected (prints top issues) · 2 error · 4 max time |

### State files
Each job is mirrored to `<state dir>/<job_id>.json`. The state dir is `NOTARIZE_MCP_STATE_DIR`, default `~/Library/Logs/notarize-mcp/jobs`. The file is written atomically, mode 0600, with a heartbeat every 30s.

```ts
{ id, name, description, status: "running"|"succeeded"|"failed"|"cancelled",
  resultIsError?: boolean,   // finished but failed (e.g. notarization Invalid)
  startedAt, endedAt?, updatedAt, pid, progress?, error?, summary?,
  meta: { submissionId?, path?, buildId?, … } }
```

### After a server restart
- `jobs action=list` shows jobs from previous sessions. A job that was still running when its server died, or whose heartbeat is older than 2 minutes, is reported as **LOST**.
- `jobs action=status job_id=…` on a lost notarization gives the recovery steps. Apple keeps processing the submission, so use `notary action=status submission_id=…` or the `watch-notarization` Monitor, then `staple`.
- `notary submit` and `notarize_and_staple` refuse to re-submit an artifact that a live job is already notarizing. The refusal returns that job's Monitor command; pass `force=true` only if the artifact really changed.
- State files older than 30 days are pruned.

## Things that block unattended runs (and how the server handles them)
| Problem | Handling |
|---|---|
| Keychain "codesign wants to use the key" dialog | `sign`/`resign` give the first `codesign` 45s (`NOTARIZE_MCP_CODESIGN_PROMPT_TIMEOUT` seconds), then abort with the fix: Always Allow, `security unlock-keychain`, or `security set-key-partition-list -S apple-tool:,apple:,codesign: …` |
| Locked login keychain / SSH session | `doctor` reports it |
| Xcode license not accepted / first-launch components missing | `doctor` reports `sudo xcodebuild -license accept` / `sudo xcodebuild -runFirstLaunch` |
| Human-only steps (enrolment, agreements, API key, app record, Developer ID certificate) | `distribution_checklist` lists them as `manual` items with click paths; re-run it after the human is done |

## Claude Code permissions
Allow the read-only tools so only real changes prompt. [`claude-settings.example.json`](claude-settings.example.json) is generated from the tool list. Merge it into `.claude/settings.json`.

Tools such as `entitlements`, `gatekeeper` or `jobs` are marked mutating because one of their actions can change things. Their read actions still run without a token; leave them prompting, or allow them if the preview step is enough for you.

## Network access
Sandboxed or proxied environments must allow:

| Host | Used by |
|---|---|
| `api.appstoreconnect.apple.com` | App Store Connect API (all `asc_*`, `testflight`, `app_store`) |
| `appstoreconnect.apple.com` | notarytool (notary service) |
| `timestamp.apple.com` | `codesign --timestamp` |
| `ocsp.apple.com`, `crl.apple.com` | certificate revocation checks |
| `api.apple-cloudkit.com` | stapler / Gatekeeper ticket lookup |
| `contentdelivery.itunes.apple.com` | altool uploads |
| `www.apple.com/certificateauthority` | `keychain install_intermediates` |

## Context budget
The 35 tool definitions are about 17–18k tokens. Prefer clients that defer tool schemas (Claude Code tool search). Results are sent as a short summary plus structured JSON; the summary always comes first.
