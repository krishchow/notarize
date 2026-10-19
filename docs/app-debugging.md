# Target-aware app debugging

Use the apple-distribution entrypoint or the `debug-app` MCP prompt. Runtime failures route to the app-debugging skill, also available at `notarize://guides/app-debugging`. Local collection and imports require no Apple account.

`app_debugging` exposes `setup`, `probe`, `start`, `status`, `mark`, `cancel`, `resume`, `import`, and `relaunch`. Setup needs no target; capture requires an explicit target:

```json
{"platform":"macos","bundle_id":"com.example.app","process":"Example","runtime":"native"}
{"platform":"ios","device_id":"<CoreDevice UUID>","bundle_id":"com.example.app","process":"Example"}
{"platform":"ios-simulator","simulator_id":"<simulator UUID>","bundle_id":"com.example.app","process":"Example"}
```

For an iOS app running on Mac, use `platform=macos` and `runtime=ios-on-mac`. Process filters are useful because bundle IDs are only a hint about unified-log subsystem names. Widgets/extensions can need a separate process-scoped capture. The legacy `system_logs` and `crash_reports` tools collect host-Mac evidence only.

## Collection and confirmation

Probe first. `start` previews the target, commands, destination, bounds, capability gaps and retention. Confirm with identical arguments and the preview token. No auto-confirm setting is changed. `collection=logs|reports|both` defaults to both; unavailable components are disclosed in the preview.

The result carries a session ID, job ID and Monitor command. Use `status` for readiness; request reproduction only after a live segment reports `ready`. Record the event with `mark` and an optional ISO timestamp. For physical-device logs, `log_mode=snapshot` means reproduce first and then call `start collection=logs lookback_seconds=120` to collect recent stored logs. This is not a live stream and does not report `ready`. `lookback_seconds` ranges from 1 to 3600, while `seconds` separately bounds execution. A report snapshot does not wait for reproduction. With `collection=both`, reports are snapshotted first and live logs use the remaining time/byte budget. For crashes after a live capture, start or resume with `collection=reports` to collect a fresh report snapshot.

Captures stop at 120 seconds, 10 MiB, or 20,000 log lines by default. Explicit maxima are 600 seconds, 50 MiB and 100,000 log lines. Imported UTF-8 `.txt`, `.log`, `.ips`, and `.crash` files are limited to 50 MiB. Archives must be exported as text first. A bound reached during collection is recorded; cancellation retains partial evidence. A duration limit bounds collection, with process termination allowed up to five additional seconds for cleanup.

Every persistent write, cancellation and relaunch uses preview/confirm. `status` and `probe` do not persist session evidence. Probe commands may use private ephemeral JSON files for Apple's supported machine-readable output and remove them afterward.

`resume` rechecks capabilities and starts a separately confirmed segment with the session's target and bounds. It does not reconnect a dead process or fill a missing interval. Active segments become interrupted after server loss. App launch/relaunch is separately confirmed; physical-device/simulator relaunch terminates the running app, while Mac launch activates an existing instance. Launch-console attachment is disabled because terminating that command can forward signals to the app.

### Physical-device backend selection

Physical devices default to `backend=auto`: use a supported installed libimobiledevice live backend, otherwise Apple snapshots. `backend=apple` explicitly selects snapshots; `backend=libimobiledevice` requires the live backend and never silently falls back.

### Optional live device logging setup

`app_debugging action=setup` checks for idevicesyslog 1.4 or newer with the required device selector, filters and disconnect handling. `install=true` previews installation of the fixed `libimobiledevice` package through existing Homebrew, then runs a bounded job and verifies the executable. Nothing installs during inspection or preview. No Apple credentials or root MCP are required; Homebrew itself is not bootstrapped. Missing tooling or installation failures leave Apple snapshots and manual import available.

Live capture requires the selected phone to appear in the backend's USB device list; Apple's wireless discovery alone is insufficient. It passes the resolved hardware UDID explicitly and waits for that exact device's connection banner before reporting ready. The default `log_scope=app-related` captures messages mentioning the bundle ID, including system lifecycle records. `log_scope=process` captures the known process instead. These scopes have different coverage; neither promises JavaScript console output. Segments record scope, transport connection, and record counts separately from total output lines. A connection banner is not a log record. Premature exit or disconnect fails the segment and retains partial evidence; cancellation and duration/output bounds stop the child normally.

In a normal-user CLI feasibility test on 2026-10-18, idevicesyslog 1.4.0 captured 75 bundle-matching lines for Meitian Hanzi, including launch/lifecycle records. Process-only and legacy-relay tests connected but produced no app-owned messages. This establishes useful system evidence, not full visibility into a release app's own console. The MCP integration is verified separately below.

The first real stdio MCP live test verified dependency detection, preview/confirm, bounded execution and persisted failure evidence. By then the USB device was no longer visible, although Apple's wireless discovery still worked. The session correctly failed with zero records and no readiness claim. The probe now checks USB visibility separately. Successful nonempty live capture through MCP remains pending reconnection; the earlier nonempty capture was through the CLI spike.

### Apple snapshot implementation

The physical-device backend runs `log collect --device-udid <resolved UDID> --start <time> --size <bound> --predicate <app filter>` through CommandRunner. It never selects the first available device. It exports filtered text with `log show`, redacts before persistence, and removes the raw archive from private temporary storage. Oversized archives, permission failures and missing tooling are errors; they are not successful empty captures. Stored logs can omit debug/JavaScript messages, so a successful collection is not proof of complete runtime visibility.

On this Mac, the real collector required administrator authorization. The normal-user MCP supports optional `use_sudo=true`, explicitly bound into its confirmation plan, for noninteractive authorization already available to that process. It never accepts a password or changes sudo policy. Cached authorization can be terminal-specific. Privileged export and cleanup use the same opt-in. No root MCP or privileged helper has been installed. Console/import remains a manual fallback.

The capability probe returns the installed app identity/version/build when accessible and can resolve a running main process from its app-bundle path. Each snapshot segment records that observation, its backend, capture mode, and evidence start time.

### Developer Mode assistance

When Apple's attempted report/app inspection operation reports Developer Mode disabled, `probe` returns `developer_mode=disabled` and a deduplicated `manual_actions` entry. It names the blocked operations, provides on-device steps, links Apple's guide, explains a missing switch, and supplies the exact probe retry. The same instructions appear in `next_steps` for clients that display text results.

On iPhone/iPad: Settings → Privacy & Security → Developer Mode → enable → Restart. After restart, unlock, confirm Turn On, and enter the passcode on the device if asked. If the switch is absent, connect/unlock/Trust the phone, select it in Xcode → Window → Devices and Simulators, then recheck Settings. Managed restrictions require the device administrator. [Apple's instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device) describe this flow.

The skill guides the user and retries the MCP probe after restart. This feature does not toggle the setting or reboot the phone, and never asks for its passcode. TestFlight installation does not require Developer Mode; the prompt is specific to an operation that Apple blocked. Enabling the mode does not guarantee access to a TestFlight app's debugger, container, or JS logs. Console/import remains an explicit alternative.

## Evidence and privacy

Sessions live under `<jobs state directory>/debugging/debug_<id>/`. The manifest is schema 1, with explicit target, backend/tool versions, installation channel, reported build identity, segments, reproduction markers, artifact references, excerpts, imports, and limitations. Directories are private (0700), files are 0600, and manifest updates are atomic. Inactive sessions older than 30 days are pruned when an approved session creation runs.

Logs are buffered within the approved bounds, with stdout and stderr reassembled separately, then redacted before evidence/excerpts are persisted. Known key/token/password patterns are masked, including secrets split across output chunks. Device report transfers use private temporary scratch space, then validate identity and redact retained artifacts. These masks cannot guarantee removal of arbitrary personal information; keep collection app-scoped. Captures do not enable private logging or collect whole-device sysdiagnoses.

Crash-report app identity must match the selected app. Imported device provenance is user-reported unless matching simulator metadata establishes it. Report version/build is evidence about that report; it does not establish that the same build is currently installed. The supplied version/build fields are explicitly user-reported. Findings and verification remain the agent's responsibility: an empty capture or source-level reproduction does not prove the distributed app is fixed.

## Backend status and feasibility findings

Sanitized failure evidence is recorded in `test/fixtures/recorded/app-debugging/coredevice-mode-disabled.json`. Local inspection on 2026-10-18 used Xcode 26.6 (17F113), devicectl 518.33, and an iPhone 14 Pro on iOS 26.6. The phone was paired and reachable over the local network. Discovery initially showed it unavailable, then available; `tunnelState=disconnected` in discovery alone did not mean a subsequent operation could not establish a tunnel.

| Backend | Implemented behavior | Verification limits |
|---|---|---|
| macOS unified logs | App-scoped `log stream`, bounded job capture | The live test checks readiness and duration termination; a real launch/permission failure still needs an acceptance demonstration. |
| Mac crash reports | Filename-narrowed host report snapshots, parsed app identity | Missing directories differ from permission failures; matching report content is required. |
| Physical iPhone/iPad logs | Optional libimobiledevice live stream with setup, exact device selection and distinct bundle/process scopes; Apple snapshot and Console import fallback | Normal-user CLI captured real bundle-related launch/lifecycle records. Process-only output was empty. Apple snapshot reached the collector but required administrator authorization. See validation below for MCP results. |
| Physical crash reports | Probe `systemCrashLogs`; copy individual matching reports only when listing schema and sizes permit bounded transfer | Initially blocked by Developer Mode (CoreDeviceError 10005). After the user enabled it, a real MCP report session completed with zero matching reports; installed Meitian Hanzi 1.0.0/build 2 and app/widget processes were observed. Transfer of a nonempty report remains unverified. Unknown listing/size schemas return a limitation. |
| Simulator unified logs | Explicit `simctl spawn <UUID> log stream` | Installed iOS 26.5 simulators were shut down. Target isolation and lifecycle are fixture-tested; live simulator capture remains pending. |
| Simulator reports | Explicit imports with app/provenance checks | Automatic discovery from shared host directories is disabled. |

`devicectl device process launch --console` documents launch-time standard streams and signal forwarding. It is not a general-purpose passive unified-log stream. No debugger was attached and no app was reinstalled or reset. The user manually enabled Developer Mode after receiving guidance; the MCP did not change that setting. An attempted Console UI capture did not produce an exported evidence file and is not counted as successful log collection.

When automation cannot capture, select the phone in Console, begin app/process-filtered streaming, reproduce, export the relevant interval to UTF-8 text, and use `app_debugging action=import target=… path=/absolute/file.txt origin="Console, phone identity, app filter, interval"`. An app-specific crash report can also be exported from Xcode or shared from the phone's Analytics Data screen. Do not request Developer Mode merely to use this fallback.

## Validation

Unit coverage includes selectors, phone isolation, missing tools, locks/trust, Developer Mode, multiple simulators, confirmation binding, limits, redaction, imports, report provenance, cancellation and restart/resume. The runner has real-process tests for a child ignoring SIGTERM and split UTF-8 output.

Opt-in local backend checks require macOS and no Apple credentials:

```bash
NOTARIZE_DEBUG_LIVE=1 pnpm exec vitest run --config vitest.live.config.ts test/live/app-debugging.live.test.ts
# Optionally add NOTARIZE_DEBUG_DEVICE_ID=<CoreDevice UUID> for a read-only phone probe.
```

Pending acceptance demonstrations: successful authorized Apple snapshot extraction; a real Mac launch/permission failure; original Meitian Hanzi TestFlight spinner evidence; an accessible physical-device crash report; and a live simulator failure. The `rad_strokes` message in automated fixtures tests evidence handling and is not a captured phone log. App-source/data repairs belong to the app workspace and require its own verification against the actual shipped artifact/build.
