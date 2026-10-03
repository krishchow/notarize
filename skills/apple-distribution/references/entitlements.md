# Entitlements

Entitlements are key/value pairs embedded in the code signature. Three families:

1. **App Sandbox** (`com.apple.security.app-sandbox` + `network.*`, `files.*`, `device.*`, `personal-information.*`, `automation.*`) — required for the Mac App Store; optional for Developer ID.
2. **Hardened-runtime exceptions** (`com.apple.security.cs.*`) — loosen protections the hardened runtime enables. Keep them minimal.
3. **Capabilities** (`com.apple.developer.*`, `aps-environment`, `keychain-access-groups`, application groups on iOS) — **restricted**: must be granted by a provisioning profile and enabled on the App ID.

Use `entitlements action=explain` for the full catalog; `action=read` to see what a binary actually has; `action=validate` to compare against a profile/target; `action=generate` to create a file.

## Hardened runtime exceptions (risk order)
| Key | Use when | Risk |
|---|---|---|
| `cs.allow-jit` | JS engines with JIT (Electron/V8) | moderate |
| `cs.allow-unsigned-executable-memory` | Old Electron, legacy JITs | high |
| `cs.disable-library-validation` | Loading plug-ins/libraries signed by other teams | high — prefer re-signing bundled libs |
| `cs.allow-dyld-environment-variables` | DYLD_* injection | high |
| `cs.disable-executable-page-protection` | almost never | very high |
| `security.device.audio-input` / `device.camera` | Mic / camera under hardened runtime | n/a (plus usage strings) |
| `security.automation.apple-events` | AppleScript automation of other apps | n/a (+ NSAppleEventsUsageDescription) |

## Rules that bite
- `get-task-allow` must not ship (notarization and App Store reject it).
- Helpers in sandboxed apps: exactly `app-sandbox` + `inherit`, nothing else.
- Profile-granted values support wildcards (`TEAMID.*`); the signed entitlements must be a subset.
- macOS app groups: `<TEAMID>.<name>`; iOS app groups: `group.<name>` (needs the App Groups capability).
- Entitlement present + missing Info.plist usage string ⇒ crash or denied permission at first use.
- Restricted entitlements without an embedded profile ⇒ AMFI kills the app at launch ("no eligible provisioning profiles found").

## Presets (`entitlements action=generate preset=…`)
- `developer-id-minimal` — none (most native apps)
- `electron` — `allow-jit` (+ notes on optional keys)
- `electron-mas` / `electron-mas-inherit` — sandboxed parent / helpers for the Mac App Store
- `tauri` — none for Developer ID
- `sandbox-basic` — sandbox + network client + user-selected files

Capability shorthands: `sandbox, network-client, network-server, files-user-selected-read, files-user-selected-write, downloads, camera, microphone, usb, bluetooth, location, contacts, calendars, photos, apple-events, print, jit, unsigned-executable-memory, disable-library-validation, dyld-env`.
