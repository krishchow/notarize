# Notarization and stapling

Notarization = Apple's automated malware/signature scan of Developer ID software. Gatekeeper on macOS 10.15+ requires it for smooth first launch of downloaded apps. It is **not** App Review.

## Requirements Apple checks
- Every Mach-O signed with **Developer ID Application** (not Apple Development/Distribution, not ad-hoc)
- **Hardened runtime** (`--options runtime`) on executables
- **Secure timestamp** (`--timestamp`)
- No `com.apple.security.get-task-allow` (Debug builds)
- Linked against macOS SDK ≥ 10.9
- Installer packages signed with **Developer ID Installer**
- Nested code (frameworks, helpers, plug-ins, `.node`, `.so`, binaries inside zips/jars) signed too

`inspect_code_signature target=mac-developer-id` checks all of this locally before you upload; `notarize_and_staple` refuses to submit if the preflight finds errors (override with `force=true`).

## Flow
1. `notary action=store_credentials` once (stores the API key in the keychain as a notarytool profile; optional — the tools can use the API key directly).
2. `notarize_and_staple path=App.app` (or `.dmg` / `.pkg`): zip with ditto → `notarytool submit` → poll → on **Accepted** staple + validate + Gatekeeper assess; on **Invalid** fetch the developer log and explain each issue.
3. `gatekeeper action=simulate_download path=App.dmg` to test as a user.

### What to notarize / staple
| You ship | Notarize | Staple |
|---|---|---|
| `.dmg` containing the app | the signed .dmg (app inside signed too) | the .dmg |
| `.zip` of the app | the zip | the **.app**, then re-zip (zips can't be stapled) |
| `.pkg` | the signed .pkg | the .pkg |
| bare CLI binary | inside a .zip or .pkg | cannot staple a bare binary (online check) — prefer a .pkg |

## Timing — use a Monitor, don't block
- Typical: 2–15 minutes. First submissions for a new team, very large uploads, or Apple incidents: up to hours. Check https://developer.apple.com/system-status/ if everything is slow.
- Tools wait ~90 s in the foreground, then return `job_id`, `submission_id`, and `monitor.command`.
- In Claude Code: `Monitor({command: monitor.command, description: monitor.description, timeout_ms: 1800000})`. The watcher prints one line per status change and exits on SUCCEEDED / FAILED / LOST. If the monitor times out (30 min cap) without a final line, start it again.
- Then `jobs action=status job_id=…` for the full result.
- Job lost (server restarted)? Apple still has the submission: `notarize-mcp watch-notarization <submission-id>` or `notary action=status|wait submission_id=…`, then `staple`.
- Never re-submit while a submission is "In Progress" (`notary action=history` lists them).
- CI: `xcrun notarytool submit … --wait --timeout 90m` is fine.

## Reading a rejection (`notary action=log`)
The developer log lists issues per file/architecture. Most common:
| Message | Fix |
|---|---|
| The binary is not signed with a valid Developer ID certificate | Sign everything with Developer ID Application |
| The signature does not include a secure timestamp | `--timestamp` |
| The executable does not have the hardened runtime enabled | `--options runtime` / `ENABLE_HARDENED_RUNTIME=YES` |
| The executable requests the com.apple.security.get-task-allow entitlement | Release build; remove the entitlement |
| The binary uses an SDK older than the 10.9 SDK | Rebuild/remove that binary |
| The signature of the binary is invalid | Something changed after signing; re-sign last |
| The binary is not signed (path inside a zip/jar) | Sign nested binaries before archiving them |

## Stapling errors
- `Error 65` / `Record not found` → not notarized yet, notarized a different build (cdhash changed after submission), or ticket still propagating (retry after a minute — `notarize_and_staple` retries automatically).
- `Error 73` / unsupported file type → staple the .app/.dmg/.pkg, not a zip or bare binary.
