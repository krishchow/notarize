# App debugging skill and MCP handoff

Historical implementation proposal, prepared 2026-10-18 from a real Meitian Hanzi TestFlight failure. The implementation and current validation limits are documented in [app-debugging.md](app-debugging.md); the proposal below is preserved as the original design context.

## Intended experience

The user says “the app keeps loading,” connects their iPhone if needed, unlocks it and taps Trust. The existing apple-distribution entrypoint routes to a dedicated app-debugging skill. That skill selects the correct target, captures evidence, correlates it with the source and exact shipped build, proposes or implements a fix, and verifies it. The same flow must handle **macOS apps and iPhone/iPad apps**, plus simulators. Do not assume every app runs on the Mac hosting MCP.

Only ask the user for information the agent cannot discover: ambiguous device/app selection, exact reproduction steps, physical trust/unlock prompts, or approval for concrete state changes. A debugging request should not force an Apple-account setup flow when local evidence collection needs no account.

## Observed failure motivating this work

Repository: `/Users/krish/projects/Hanzi-Study-Tool`; Expo/React Native app in `artifacts/daily-hanzi`; bundle ID `com.meitianhanzi.app`.

- The widget worked; tapping Explore Character left the detail screen spinning.
- `app/character/[id].tsx` awaited character metadata and stroke data in `Promise.all`, with no catch/finally. A rejected query never cleared loading.
- `db/CharacterDB.ts` selected `rad_strokes`, but the committed `assets/characters.db` lacked that column. Running the query locally reproduced `no such column: rad_strokes`.
- Commit `0ac9258` changed the generator and query and bumped the asset version to 2, but explicitly left regeneration as follow-up. The generated asset was not updated. The apparent fallback to an empty array ran after the SQL query, so it could not handle a nonexistent column.
- Repair in the app workspace: regenerate both data assets from available local sources, bump asset version to 3, handle detail-screen errors with retry/back, and validate the shipped SQLite schema/data as part of the correctness gate. Regeneration produced 9,574 characters; web metadata was unchanged.

This is a source/asset reproduction, **not proof from a captured phone log**. Do not describe the shipped build as verified until its artifact or device evidence has been checked. A spinner need not produce a crash report. Working widgets do not prove all app queries work.

## Current capabilities verified in this repo

| Existing capability | Actual scope | Appropriate use |
|---|---|---|
| `detect_project` | Local project/artifact inspection | Detect framework, bundle IDs and candidate platforms; runtime target still needs selection |
| `devices` | Mac identity, connected-device discovery via devicectl, simulator discovery | Select an exact device; discovery does not establish logging support |
| `system_logs` | Host macOS `log show`; no device selector | Mac unified logging only today |
| `crash_reports` | Mac DiagnosticReports directories | Host crash reports only today; no connected iOS collection |
| `inspect_code_signature`, `entitlements`, `inspect_binary` | Local artifacts | Distribution, signing and binary hypotheses |
| `asc_builds`, `testflight` | Apple account/build metadata | Match a TestFlight version/build and testing state; these do not stream runtime logs |
| `jobs` and Monitor helpers | Existing durable background-operation infrastructure | Reuse for bounded capture, cancellation and resume |

Read `src/tools/diagnostics.ts`, `src/core/jobs.ts`, `src/core/monitor.ts`, `src/prompts/index.ts`, `skills/apple-distribution/SKILL.md`, and `docs/agent-integration.md` before implementation. `docs/tools.md` is generated. Existing `debug-sandbox` prompt uses host logs; route it by target or document its macOS restriction.

## Skill routing and responsibilities

Keep `apple-distribution` as the public entrypoint. When the symptom concerns launch, a crash, a hang, an endless spinner, permissions, widgets, or a feature failing after installation, hand off to a new `skills/app-debugging/SKILL.md` (proposed name). The handoff can load a skill in the current agent; it need not require a subagent feature.

Pass a compact context object: project path, symptom, known reproduction steps, platform, selected device, app bundle ID, extension IDs, installation channel (TestFlight/App Store/development/other), version/build, existing artifacts, and evidence already collected. Preserve user authorization and do not repeat discovery or setup unnecessarily.

The debug skill owns target selection, capture, hypothesis tracking, verification and a handoff report. It calls existing distribution tools when signing is implicated; it should not turn every runtime failure into a signing checklist.

## Target-aware tool design

Recommended direction: extend the existing log/report tool surfaces with a shared selector backed by separate platform adapters, preserving existing macOS callers. Alternative new tools are acceptable if they share the same target/evidence contract. Names below describe a proposal, not available actions.

```ts
type DebugTarget =
  | { platform: 'macos'; bundle_id?: string; process?: string }
  | { platform: 'ios'; device_id: string; bundle_id: string }
  | { platform: 'ios-simulator'; simulator_id: string; bundle_id: string };
```

| Target | Logs adapter | Reports adapter | Evidence restrictions |
|---|---|---|---|
| macOS | Existing unified log query; add bounded live capture if useful | Existing local DiagnosticReports | Label host/process; distinguish native Mac from iOS app running on Mac |
| Physical iPhone/iPad | Implement device capability probe and supported bounded capture backend | Implement supported device report collection/import | Check trust, lock state, OS/Xcode compatibility and backend availability; never fall back silently to host logs |
| iOS simulator | Explicit simulator log backend | Simulator report backend with proven provenance | Do not guess simulator ownership from a shared host report directory |

Default omission can retain legacy host behavior for old callers. The new skill must select an explicit target. Return the resolved platform/device in every result, including failures. Reject contradictory selectors and ambiguous multi-device selection. Missing permission/backend is distinct from a successful empty capture.

Physical-device implementation needs a feasibility spike before promising complete automation. Inspect installed `xcrun devicectl ... --help` and validate commands against hardware. Device enumeration does not imply a supported general-purpose live log stream. If considering optional libimobiledevice tooling, probe its version/capabilities; do not silently install it or assert parity with Apple's unified logging. Offer Console/manual log import as an explicit fallback when automation cannot capture the necessary stream.

TestFlight constraints must be first-class: do not assume debugger attachment, private app-container access, Metro, React Native DevTools, or JavaScript console output is available. System logs can omit JS errors or redact data. Development/simulator reproduction may be necessary, but preserve the original installed build and state. Do not uninstall/reset the app to obtain logs. Trust prompts, unlock and reproduction taps may still need the human. Request Developer Mode only for operations that actually require it.

## Capture lifecycle and output contract

1. Discover project and targets; reuse known bundle ID and installation channel. Query build metadata only when relevant and credentials are available.
2. Probe capabilities on the selected target and explain the exact supported capture method. Detect whether widget extensions need separate filtering.
3. Start a bounded capture **before** asking the user to reproduce. Return promptly with a durable session/job ID and the supported Monitor command. Record a timestamp marker for the tap/failure.
4. Allow status, cancellation, disconnect/reconnect and resume. Apply time, byte and line limits; clean up spawned processes. Do not hold an MCP request open indefinitely or poll in a tight loop.
5. Return concise relevant excerpts with artifact paths, timestamps, backend, target, app/process identity, build identity if established, truncation, redaction and capability gaps. Keep observed facts separate from hypotheses and confidence.
6. Inspect relevant source/bundled assets in parallel with capture. Diagnose an SQL/schema failure as app/data logic; do not recommend broad entitlement changes from the symptom alone.
7. Verify the fix through the same reproduction and record whether verification used the installed TestFlight build, a local Release build, a simulator, or a source-level check.

Suggested session fields: schema version, session ID, platform, device ID, bundle/process/extension IDs, installation channel, app version/build, Xcode/OS/backend versions, start/end times, reproduction markers, artifact locations, findings, unsupported capabilities and next exact tool calls. Redact sensitive content before returning excerpts; default to app-scoped collection and bounded retention. Avoid collecting whole-device diagnostics unless needed and explicitly authorized.

Honor the repository's confirmation contract. Calls that create persistent evidence files or change device/app state need the existing `withConfirmation` path; do not silently treat file-producing capture as read-only. Prepare a concrete capture plan up front, reuse its authorization during that session, and preserve explicit preview/confirm tokens. Never change auto-confirm settings. Distinguish transient bounded queries from capture actions that persist files, install, launch, reset, register devices or upload diagnostics.

## Verification and shipping plan

1. Add the shared target resolver and capability model, preserving legacy host tests.
2. Spike device backends with an unlocked, trusted physical iPhone and a TestFlight app; document exactly which logs/reports are accessible. Confirm a simulator path separately. Record sanitized fixtures and unsupported cases.
3. Implement bounded capture/report adapters using `CommandRunner.run(cmd, argv[])`, existing jobs, redaction and confirmation primitives. Never interpolate user input into a shell.
4. Add the debug skill and entrypoint routing. Update MCP prompts and expose the guide via the repository's resource registration as appropriate. Avoid stale macOS-only prompt instructions for iOS apps.
5. Test routing, target isolation, missing tooling, locked/untrusted/disconnected devices, multiple devices, cancellation, truncation, no-error results, report provenance, permissions, token handling and redaction. An iPhone request must never return host logs as if they came from the phone.
6. Acceptance demos: a macOS launch/permission failure, an iOS TestFlight spinner without a crash, an iOS crash with an accessible report, a simulator failure, and a device/backend that cannot capture logs. The last case must return a truthful fallback, not “no error found.”
7. Run `pnpm run check`, regenerate tool docs using the documented docs test command, and add a changeset for shipped skill/tool behavior. This proposal alone is docs-only and needs no changeset.

## First task for the next implementer

Start with physical-device capture feasibility plus the target contract. Use the Meitian Hanzi spinner as the non-crash acceptance case. Establish what evidence an ordinary connected phone can provide before writing a skill that promises “connect phone and I handle debugging.” Preserve equivalent macOS support throughout.
