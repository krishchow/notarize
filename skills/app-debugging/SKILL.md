---
name: app-debugging
description: Debug installed macOS, iPhone/iPad, and simulator apps with explicit target selection, bounded app-scoped evidence, source and bundled-asset correlation, and honest build verification. Use for crashes, launch failures, hangs, endless spinners, permissions, widgets, and installed features that fail. Local debugging requires no Apple account.
---

# App debugging

Own target selection, evidence collection, hypothesis tracking, fixes, and verification. Reuse context from apple-distribution: project, symptom/reproduction, selected target, app and extension identities, channel, version/build, artifacts, prior evidence, and authorization. A handoff loads this skill in the current agent; no subagent is required.

## Select the exact app and runtime

Use `detect_project` and `devices` as needed; reuse known values. Use the phone’s `device_id` (CoreDevice UUID) from `devices` for debugging; its `udid` is the separate provisioning identifier. A cached paired device may be unavailable; inspect `connectionState`. A connected-device listing does not establish logging access. Choose a native Mac app, iOS app running on Mac, physical iPhone/iPad, or explicit simulator. Ask only about ambiguity, reproduction details the agent cannot discover, or physical actions such as unlocking/Trust.

`app_debugging` requires an explicit `target` for discovery/capture:

- Mac: `{"platform":"macos","bundle_id":"com.example.app","process":"Example","runtime":"native"}`. Use `runtime=ios-on-mac` for an iOS app running on Mac, or unknown if unestablished.
- Phone/tablet: `{"platform":"ios","device_id":"<CoreDevice UUID>","bundle_id":"com.example.app","process":"Example"}`.
- Simulator: `{"platform":"ios-simulator","simulator_id":"<UUID>","bundle_id":"com.example.app","process":"Example"}`.

Bundle IDs filter unified-log subsystems, which may differ from the app identity. Discover the process name where possible and include it. Treat extension processes separately; use an additional explicitly scoped session when a widget participates.

Use `app_debugging action=probe target=…` first. It reports backend capabilities, versions and limitations. On physical devices, `backend=auto` prefers a supported installed libimobiledevice live backend; otherwise it uses Apple stored-log snapshots. No dependency is installed silently. Use `action=setup` to inspect the optional backend and `action=setup install=true` to preview installation through existing Homebrew when wanted. Reuse explicit installation approval and follow the setup skill's optional device-debugging section; no Apple credentials are needed.

For live device logs, connect/unlock/Trust the selected phone over USB; Apple's wireless discovery alone is insufficient for this backend. `log_scope=app-related` (default) matches messages mentioning the bundle ID, including system launch/lifecycle records. These are not necessarily app-emitted logs. Use `log_scope=process` with a known app process for its own messages; release apps may emit none. The connection banner establishes transport readiness, not captured app records. Inspect the segment's `records`, artifact and scope before claiming evidence was collected. Capture limits and disconnect failures retain partial evidence.

`backend=apple` selects app-scoped `log collect` snapshots: reproduce first; these do not report live readiness and may require administrator authorization on the Mac. Apple `devicectl` operations may need Developer Mode even on a trusted, unlocked phone. Do not request it unless the chosen operation needs it. Do not change device settings, attach a debugger, or assume access to a TestFlight app container, Metro, React Native DevTools, or JavaScript console output.

### When Developer Mode blocks an operation

The probe returns `developer_mode` and a structured `manual_actions` entry only when an attempted operation reports that Developer Mode is disabled. Explain which operation needs it. TestFlight installation itself does not require Developer Mode, and enabling it does not ensure debugger access or JavaScript logs.

Guide the user through Settings → Privacy & Security → Developer Mode → turn on → Restart. After restarting, they unlock the device, tap Turn On to confirm, and enter the passcode on the phone if asked. The phone will disconnect during restart; treat this as expected. Do not request the passcode through chat or tool arguments.

If the switch is missing, keep the phone connected, unlocked and trusted; open Xcode → Window → Devices and Simulators and select it, then recheck Settings. A managed-device policy may block the option; involve its administrator rather than attempting a bypass. See [Apple’s Developer Mode guide](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

The skill supplies guidance and the MCP rechecks access. Do not automatically toggle Developer Mode, restart the phone, or run devmodectl. Once the user completes the on-device steps, call the exact retry in `manual_actions[].retry`; retain the selected target and debugging context. If access still fails or the user prefers to leave the mode off, use the explicit Console/import fallback. The successful probe, not the user completing the instructions, establishes which capabilities are now available.

## Capture before reproduction

1. Use `app_debugging action=start target=…`, optionally `collection=logs|reports|both`, installation channel, and known version/build. Version/build supplied here is labeled user-reported. Show the concrete preview and reuse existing authorization when it covers that exact plan. Confirm using identical arguments and the issued token. Never change auto-confirm policy.
2. Capture persists private session/evidence files and uses existing jobs. Default bounds are 120 seconds, 10 MiB, and 20,000 log lines. Status and Monitor expose readiness. For streaming backends, wait for a segment with `status=ready` before requesting reproduction; an immediate backend failure is not ready. Report snapshots run before live streaming when both are requested; take a new reports-only snapshot after a reproduced crash. Reports-only collection does not require reproduction readiness. For a phone snapshot, reproduce first, then start with `collection=logs` and `lookback_seconds` covering that event (default 120, maximum 3600). `seconds` bounds collection execution separately. Snapshot segments record `capture_mode=snapshot`, the selected device, installed app metadata when available, and the evidence start time.
3. Start the returned Monitor; clients without it can use `jobs action=status job_id=… wait_seconds=600`. Keep inspecting relevant source/assets while capture runs. Do not tight-poll.
4. Record the tap/failure with `app_debugging action=mark session_id=… label=… timestamp=…`; omit timestamp for the current time. Marker writes use the preview/confirm contract too.
5. Inspect `app_debugging action=status session_id=…`. Artifact paths, target/backend, markers, gaps, truncation and imported report identities remain in the manifest. Empty logs do not prove success. Capture text is redacted for known secret patterns, but app logs can still contain personal data; stay app-scoped.
6. `action=cancel` retains partial evidence. `action=resume` rechecks capabilities and requires a fresh preview for a new segment with the same target and limits. After server restart, old active segments are interrupted; the new segment does not bridge the evidence gap. Inactive evidence older than 30 days is pruned on a subsequent approved session creation.

`system_logs` and `crash_reports` are legacy host-Mac tools. Never present their output as evidence from a phone or simulator. Simulator reports require imported evidence with explicit provenance; a shared host report directory is insufficient.

### Mac administrator authorization for native phone snapshots

Apple `log collect` may require root on the Mac. A denied operation is a failed capture, not empty successful evidence. The MCP stays a normal-user process. `use_sudo=true` selects Apple snapshots and is an explicit, previewed opt-in to `sudo -n` for the fixed collection/export/cleanup operations, only with authorization already available to the MCP process. A cached approval in another terminal may not apply. Never ask for passwords through chat or MCP, change sudo policy automatically, or run the whole MCP as root. If unavailable, offer optional normal-user live logging or Console/import. No privileged helper is installed.

### Physical phone fallback

If native snapshot collection is unavailable, or live viewing is required, use Console on the connected Mac: select the specific phone under Devices, start streaming, narrow to the app/extension process, then reproduce. Save/export the relevant interval as UTF-8 `.txt` or `.log` (copy selected messages to a text file if necessary). Import with `app_debugging action=import target=… path=/absolute/path.txt origin="Console, selected phone identity, interval and app filter"`, or supply an existing session_id. Treat Console as a manual fallback. Do not improvise GUI scripts as the normal capture backend. `.logarchive` bundles must be exported to text first.

For crashes, import an app-specific `.ips`/`.crash` exported through Xcode Devices and Simulators or shared from the phone's Settings → Privacy & Security → Analytics & Improvements → Analytics Data. Do not collect unrelated device diagnostics. Report app identity must match; device origin remains user-reported unless the evidence establishes it. A spinner may produce no crash report.

## Diagnose and verify

Maintain a short record of observed facts, hypotheses with confidence, disconfirming evidence, proposed fix, and verification. Correlate installed version/build and artifacts when available; use `asc_builds`/`testflight` only if relevant and credentials already exist. Avoid account setup merely to gather local evidence.

For a spinner, inspect asynchronous error handling and bundled assets/schema as well as runtime evidence. A fallback after an SQL query cannot recover from a missing column before the query returns. Validate shipped SQLite schema and data against queries. A working widget does not validate the main app's queries. Use signing/entitlement tools only when evidence supports that hypothesis.

Preserve the installed build and app state. Offer `app_debugging action=relaunch target=…` separately only when useful, explaining its state change; iOS/simulator relaunch terminates the running instance, while macOS launch activates an existing instance. No console attachment is enabled because cancellation can forward signals to the app. Do not uninstall/reset to get evidence.

Apply source fixes in the app's workspace using its conventions and correctness checks. Verify the same reproduction and identify whether verification used the original TestFlight build, a new distributed build, local Release artifact, simulator, or source/asset tests. Never describe a source reproduction as captured phone evidence or proof that the shipped build is fixed.

Finish with a compact handoff: symptom/reproduction, target/app/extensions and channel, established build identity, timestamped evidence/artifacts, facts versus hypotheses, changes made, checks performed, verification runtime/build, and remaining gaps with exact next calls.
