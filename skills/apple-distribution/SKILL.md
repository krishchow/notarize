---
name: apple-distribution
description: Ship macOS and iOS apps — code signing, Developer ID, notarization + stapling, certificates, provisioning profiles, App IDs/capabilities, entitlements, App Store Connect, TestFlight, App Store submission, and debugging Gatekeeper / sandbox / TCC privacy / "app is damaged" / notarization rejections. Use whenever someone wants to sign, notarize, distribute, upload, or fix launch/permission problems for an Xcode, Electron, Tauri, Flutter, React Native/Expo, SwiftPM or prebuilt .app/.dmg/.pkg/.ipa — even if they don't know the Apple terminology.
---

# Apple app distribution

Take someone with **zero Apple-platform context** from "I have an app" to a signed, notarized download, a TestFlight build, or an App Store submission, and debug anything that goes wrong along the way.

You have the **`notarize` MCP server** (tools named `doctor`, `detect_project`, `distribution_checklist`, `sign`, `notarize_and_staple`, `asc_*`, …). Prefer its tools to hand-written shell commands: they encode Apple's rules, explain failures and ask for confirmation before changing anything. If the server isn't available, use the raw commands in [No-MCP fallback](#no-mcp-fallback).

**Prerequisite: the `setup` skill.** This skill assumes the App Store Connect API key is installed and the project's bundle ID and team are confirmed.
- If a tool reports "No App Store Connect API key configured", or a project's bundle ID hasn't been confirmed with the user, run the **`setup`** skill first (`/notarize:setup`).
- To check the key quickly, run `node <setup skill dir>/scripts/setup.mjs check`. It prints JSON, and `"ready": true` means the credentials are fine.
- The key's conventional home is `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8` (mode 600). `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY_PATH` are exported from `~/.zshrc`, and the same values are saved as a notarize-mcp profile.

## 1. Mental model (explain this to the user in plain words)

| Concept | What it is | When you need it |
|---|---|---|
| **Apple Developer Program** | Paid membership ($99/yr) that unlocks certificates, notarization and App Store Connect | Every distribution path except local development |
| **Code signing** | Cryptographic signature on every executable so macOS/iOS can tell who made it and that it wasn't modified | Always |
| **Certificates** | Your signing identity = Apple-issued certificate **+ the private key on your Mac** (a .cer without the key is useless) | Always |
| **Developer ID** | Certificate type for Mac apps distributed **outside** the Mac App Store (website, GitHub releases, Homebrew) | Direct macOS downloads |
| **Notarization** | Apple scans the Developer ID–signed app and issues a *ticket*; **stapling** attaches it so Gatekeeper trusts it offline | Direct macOS downloads |
| **Gatekeeper** | macOS check on first launch of downloaded apps ("cannot be opened", "is damaged") | Testing direct downloads |
| **App ID / Bundle ID** | Reverse-DNS identifier registered with Apple (com.company.app); capabilities (iCloud, push, …) hang off it | Store, TestFlight, profiles |
| **Provisioning profile** | Apple-signed file tying App ID + certificates (+ devices) + allowed entitlements together | All iOS builds; Mac App Store; Mac apps using restricted capabilities |
| **Entitlements** | Key/values in the signature declaring capabilities (sandbox, camera, iCloud, JIT…) | Sandbox, hardened-runtime exceptions, capabilities |
| **App Store Connect** | Where app records, builds, TestFlight, metadata, review and release live; also has an API (one API key powers most automation here) | Store / TestFlight |
| **TestFlight** | Beta distribution: internal testers (team members, no review) or external testers (email/public link, beta review) | Betas, iOS & Mac |
| **Xcode / SDKs** | Build tools + platform SDKs. App Store uploads require a recent Xcode (doctor checks the current minimum) | Building / uploading |
| **Devices / cloud testing** | Registered UDIDs for development & Ad Hoc; simulators; TestFlight; Xcode Cloud (via `asc_api`) | Testing on hardware |

### Distribution targets (pick one with the user)
- `mac-developer-id`: a downloadable Mac app (website/GitHub). It needs a Developer ID Application certificate, hardened runtime, notarization and stapling.
- `mac-app-store` / `testflight-mac`: needs Apple Distribution and Mac Installer Distribution certificates, a MAC_APP_STORE profile, App Sandbox, and an upload.
- `ios-app-store` / `testflight-ios`: needs Apple Distribution, an IOS_APP_STORE profile, an app record, and an upload.
- `ios-ad-hoc`: installs on up to 100 registered devices without the store.
- `ios-development` / `mac-development`: run on your own devices.
- `enterprise`: Enterprise Program only.

Details: [references/targets.md](references/targets.md).

## 2. Zero-context workflow

1. **`doctor`**: checks the machine (Xcode, CLIs, identities, intermediates, API key, notary profile). Fix errors first.
2. **`detect_project path=…`**: identifies what the app is, its bundle IDs and team, and its current signing config. It also returns framework-specific config snippets and env vars.
3. **Ask the user which target(s) they want**, unless it's obvious. Explain the trade-off in one or two sentences, e.g. "Website download → Developer ID + notarization; App Store → review + sandbox".
4. **`distribution_checklist path=… target=…`**: the ordered list of what is missing. Each item names the exact tool call or manual step that fixes it.
5. Work through the blocking items **in order**, re-running the checklist after a few fixes.
6. **Build and sign.**
   - Xcode-based (incl. Flutter/RN): `xcode action=archive`, then `xcode action=export`. Automatic signing plus the API key lets Xcode create certificates and profiles itself.
   - Electron/Tauri: use the framework's signing config, using the snippets from `detect_project`.
   - Prebuilt or other: `sign` (inside-out) or `resign`.
7. **Verify** with `inspect_code_signature path=… target=…`. Fix every ✗ before continuing.
8. **Ship.**
   - Developer ID: optionally `package action=dmg identity=auto`, then `notarize_and_staple`, then `gatekeeper action=simulate_download`.
   - Store/TestFlight: `upload_build` (or export with `destination=upload`), then `asc_builds action=wait_processing`, then `testflight …` or `app_store …`.
9. Offer **`ci_config`** to automate it.

### Things only the human can do (give them exact click paths)
- **Enroll** in the Apple Developer Program at developer.apple.com/programs/enroll. Organizations need a D-U-N-S number, and approval can take days.
- **Accept agreements.** The Account Holder accepts updated agreements at developer.apple.com/account and in App Store Connect → Business. A 403 mentioning "agreement" means this step is pending.
- **Create an App Store Connect API key.** Go to App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → "+" and pick the **Admin** role (App Manager works for most store and TestFlight tasks). The **.p8 can be downloaded only once**. Then store it per [Where the API key lives](#where-the-api-key-lives) and run `asc_auth action=configure` (or set the env vars).
- **Create the app record.** App Store Connect → Apps → + → New App (`asc_apps action=create_instructions`). The API can't do this.
- **Create Developer ID certificates.** Normally the **Account Holder** does this in the portal with a CSR from `keychain create_csr`, then imports it with `keychain import_certificate`.
- **Fill in store details.** Screenshots, privacy "nutrition labels", age rating, pricing and Paid Apps banking/tax are easiest in the web UI.
- **Enable Developer Mode** on iOS devices used for development: Settings → Privacy & Security.

### Where the API key lives

One convention, so every project, the MCP server, `xcodebuild`, `altool` and EAS find the same key:

- **File:** `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`, `chmod 600`. This is Apple's own default search path, and the MCP server finds a key here with no configuration. Never put the .p8 inside a repo.
- **Env vars** (shell profile, e.g. `~/.zshrc`; the MCP server inherits them from the client that launched it):
  ```bash
  export ASC_KEY_ID=ABC123DEFG
  export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  export ASC_PRIVATE_KEY_PATH=$HOME/.appstoreconnect/private_keys/AuthKey_ABC123DEFG.p8
  ```
- **Resolution order** in the server: explicit `profile` argument → env vars (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH`, or inline `ASC_PRIVATE_KEY` for CI) → saved profile from `asc_auth configure` (`~/.config/notarize-mcp/config.json`, stores only the path) → an `AuthKey_<KEYID>.p8` found in the default directory.
- Env vars are read when the MCP server starts, so restart Claude Code after changing them. Run `asc_auth action=status` to see which source is active, then `asc_auth action=test`.
- Pass the **path**, never the key contents, through tool arguments or chat. Other tools want the same values under different names (`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` for Electron/Tauri); derive them from the `ASC_*` vars rather than storing a second copy.

## 3. Long-running operations: never block, use a Monitor

**Notarization usually takes 2–15 minutes** but can take an hour or more, especially for a team's first submissions or during Apple backlogs. **App Store Connect build processing** takes 5–30 minutes, and archives and uploads can also be slow. The tools handle this:

- `notarize_and_staple`, `notary submit|wait` and `asc_builds wait_processing` wait in the foreground for about 90 seconds. `xcode archive|export`, `upload_build`, `sign` and `resign` wait longer before handing off. Anything still running continues in a **background job** inside the MCP server.
- The result then has `status: "running"`, a `job_id`, the Apple `submission_id` (for notarization), and a **`monitor`** object. That object holds a ready-to-run `command`, a `description`, `timeout_ms` and a `fallback_command`.

**In Claude Code, always start a Monitor** with exactly that command:

```
Monitor({ command: <monitor.command>, description: <monitor.description>, timeout_ms: 1800000 })
```

- `notarize-mcp watch-job <job_id> --state-dir …` prints one line per status change, e.g. `notarize_and_staple job_ab12: running — Waiting for Apple (submission …)`. It ends with exactly one terminal line:
  - `SUCCEEDED — …`: exit 0.
  - `FAILED — …`: exit 1.
  - `LOST — …`: exit 3. The MCP server stopped. Apple still has the submission, so use the `fallback_command` or `notary action=status submission_id=…`.
- Monitors expire after 30 minutes. **If it expires without a terminal line, start it again** with the same command. That is not a failure.
- **Keep working while it runs**, and tell the user it is in progress. Useful work meanwhile: prepare the DMG/release notes, the CI workflow, App Store metadata, or the next target.
- When the terminal line arrives, call **`jobs action=status job_id=…`** to get the full result.
  - `notarize_and_staple` has already stapled and run a Gatekeeper assessment by then.
  - After `notary submit`, run `staple action=staple` yourself.
  - On failure, the result explains every issue. Fix them, re-sign and re-submit.
- **Don't re-submit the same build while a submission is pending.** Check `notary action=history` if unsure. Don't sleep-loop in Bash, and don't call `jobs status` in a tight loop.
- If the server restarted (job lost) or you only have a submission ID: `Monitor({ command: "<notarize-mcp> watch-notarization <submission-id>", … })`. It polls Apple every 30 seconds, then exits 0 on Accepted and 1 on Invalid, printing the top issues.
- Clients without a Monitor tool: call `jobs action=status job_id=… wait_seconds=600` (or `notary action=wait submission_id=…`) repeatedly, telling the user between calls.
- **New session or restarted server?** Run `jobs action=list` first. Jobs from earlier sessions are listed; a **LOST** notarization still has its Apple `submission_id`. Follow its next steps (`notary action=status`, `watch-notarization`, then `staple`) instead of re-submitting. `notary submit` and `notarize_and_staple` refuse duplicates while a live job is notarizing the same artifact.
- In **CI**, `xcrun notarytool submit … --wait` is fine because blocking a CI job is harmless (see `ci_config`).

## 4. Plan + confirm protocol

Every tool that changes something returns a **PREVIEW** first and changes nothing. This covers signing, keychain imports, notarization uploads, App Store Connect writes and file overwrites. The preview shows exact commands and API calls, any warnings, and a `confirm_token`.
1. Show the user the preview in plain words: what will happen and anything irreversible.
2. Only after they agree, call the **same tool with identical arguments** plus `confirm_token`. If arguments change you get a new preview, which is intended.
3. `destructive: true` previews need explicit approval: revoking certificates, deleting profiles or bundle IDs, uploads, submitting for review, releasing. **Revoking a Developer ID certificate breaks already-shipped apps for new users**, so only do it if the key leaked.
4. Never fabricate a token. Tokens expire after 10 minutes.
5. **Unattended runs** (CI, scheduled agents): the operator may set `NOTARIZE_MCP_AUTO_CONFIRM`.
   - `safe` auto-runs non-destructive actions.
   - A list such as `sign,package,notary:submit,staple` auto-runs only those.
   - Auto-run results carry `auto_confirmed: true`.
   - Destructive actions still return a preview unless explicitly listed. Never try to work around a preview.
6. If `sign` fails with a **keychain access prompt** message, someone must click "Always Allow" on the Mac or unlock the keychain. Tell the user rather than retrying in a loop. `doctor` also flags locked keychains, SSH sessions and unaccepted Xcode licenses.

## 5. Golden rules

- **Sign inside-out, never `codesign --deep` for signing.** Nested frameworks, dylibs, helpers, XPC services, extensions and `.node` modules get signed first, the outer bundle last. The `sign` tool does this.
- Developer ID needs `--options runtime` (hardened runtime) and `--timestamp` on every Mach-O, and **no `get-task-allow`**. That means a Release build, not Debug.
- **Make all modifications before signing.** Copying resources, editing Info.plist, `install_name_tool`, `strip` or `lipo` after signing breaks the seal.
- **Notarize the exact bytes you ship.** Zip with `ditto -c -k --keepParent` (not `zip`); `package action=zip` does this. Staple the `.app`/`.dmg`/`.pkg`, not a `.zip`. Re-zip after stapling.
- Developer ID ≠ Apple Distribution. Direct downloads need Developer ID; the stores need Apple Distribution (+ Mac Installer Distribution for Mac). The wrong one gives "not signed with a valid Developer ID" or ITMS-90034.
- **Restricted entitlements need a provisioning profile**, even for Developer ID. This covers iCloud, push, associated domains, Sign in with Apple, keychain groups and network extensions. Without one the app is killed at launch: embed a MAC_APP_DIRECT profile.
- **Mac App Store means sandbox.** Helpers get `app-sandbox` + `inherit` only.
- Private keys live in the keychain. Back up identities with `keychain export_p12`, store secrets in env vars or CI secrets, and pass `password_env` names rather than passwords. Never paste .p8 or .p12 contents into chat.
- **Build numbers are single-use** in App Store Connect. Bump `CFBundleVersion` for every upload.
- Prefer letting Xcode manage signing (automatic + API key) for Xcode-based projects. Use manual signing (`sign`, `asc_profiles`) for non-Xcode builds or when automatic signing can't express what you need.

## 6. Debugging playbook

| Symptom | Do this |
|---|---|
| "cannot be opened because the developer cannot be verified" / "Apple could not verify…" | `gatekeeper action=assess` → usually not notarized/stapled → `notarize_and_staple` |
| "is damaged and can't be opened" | `inspect_code_signature` on the *downloaded* copy (`gatekeeper simulate_download`) — invalid/broken signature, often modified after signing or unsigned nested code |
| Notarization **Invalid** | `notary action=log submission_id=…` (grouped issues + fixes) → fix → re-sign → resubmit |
| codesign `errSecInternalComponent`, "unable to build chain", "ambiguous" | `doctor`; `keychain install_intermediates`; unlock keychain / partition list in CI; sign with SHA-1 |
| App crashes instantly / "Killed: 9" | `crash_reports process=…`, `system_logs preset=amfi` — missing profile for restricted entitlements, library validation, invalid signature |
| Feature silently fails in a sandboxed app | Reproduce → `system_logs preset=sandbox process=<name> last=5m` → add suggested entitlement → re-sign |
| Camera/mic/contacts/… permission never asked or crash on access | `privacy action=audit` (usage strings + entitlements), `privacy action=tcc_reset` to re-test, `system_logs preset=tcc` |
| Xcode "No profiles for …", "doesn't include signing certificate" | `xcode archive` with API key (automatic), or `asc_profiles create/regenerate` |
| Upload ITMS-xxxxx | The error text maps through the catalog in the upload result; see [references/error-catalog.md](references/error-catalog.md) |
| Build stuck "processing" | `asc_builds wait_processing` (Monitor) — check email from App Store Connect if FAILED/INVALID |

More detail: [references/gatekeeper-debugging.md](references/gatekeeper-debugging.md), [references/sandbox-and-privacy.md](references/sandbox-and-privacy.md), [references/notarization.md](references/notarization.md), [references/entitlements.md](references/entitlements.md).

## 7. Per-framework notes
- **Xcode / SwiftUI / AppKit / UIKit**: `xcode` tool; set `ENABLE_HARDENED_RUNTIME=YES` for Mac targets.
- **Electron**: electron-builder `mac.hardenedRuntime`, entitlements with `allow-jit`, `mac.notarize` + `APPLE_API_KEY*` env vars, MAS needs separate entitlements → [references/frameworks/electron.md](references/frameworks/electron.md)
- **Tauri**: `bundle.macOS.signingIdentity`, `APPLE_API_*` env vars (note `APPLE_API_KEY` = key **ID** in Tauri) → [references/frameworks/tauri.md](references/frameworks/tauri.md)
- **Flutter**: `ios/Runner.xcworkspace` / `macos/Runner.xcworkspace` with the `xcode` tool, or `flutter build ipa --export-options-plist` → [references/frameworks/flutter.md](references/frameworks/flutter.md)
- **React Native / Expo**: `pod install` + `xcode` tool. Expo managed apps build either locally (`npx expo prebuild -p ios`, then the `xcode` tool) or with EAS (`eas credentials`, `eas submit` with the same API key); ask the user which → [references/frameworks/react-native-expo.md](references/frameworks/react-native-expo.md)
- **Prebuilt artifacts / CLI tools**: [references/prebuilt-artifacts.md](references/prebuilt-artifacts.md)
- **CI**: [references/ci.md](references/ci.md)

## 8. Communicating with the user
- Lead with what you'll do and why in plain language, then show the preview. Avoid jargon dumps; define a term the first time ("a provisioning profile — Apple's permission slip that says this app may use iCloud on these devices").
- After each milestone, summarize the state: what's signed, what's notarized, what's uploaded, and what's next.
- When something is manual, give the exact URL and click path and say what value to bring back (Key ID, Issuer ID, path to the .p8, etc.).

## No-MCP fallback

If the MCP tools are unavailable, the equivalent commands are below. These run on macOS, and you must always show them to the user before running anything that changes state.

```bash
security find-identity -v -p codesigning                       # identities
codesign -dvvv --entitlements - App.app                        # inspect
codesign --verify --deep --strict --verbose=4 App.app          # verify
# sign nested code first (each framework/dylib/helper), then:
codesign --force --sign "Developer ID Application: NAME (TEAMID)" --options runtime --timestamp \
  --entitlements App.entitlements App.app
ditto -c -k --sequesterRsrc --keepParent App.app App.zip       # zip for notarization
xcrun notarytool store-credentials notary --key AuthKey_ID.p8 --key-id ID --issuer ISSUER
xcrun notarytool submit App.zip --keychain-profile notary --wait   # or without --wait + `notarytool wait <id>` in a background shell
xcrun notarytool log <submission-id> --keychain-profile notary
xcrun stapler staple App.app && xcrun stapler validate App.app
spctl --assess --type execute -vvv App.app                     # .pkg: --type install; .dmg: --type open --context context:primary-signature
xattr -w com.apple.quarantine "0083;$(printf %x $(date +%s));Safari;" App.app   # simulate a download (on a copy)
log show --last 5m --predicate 'sender == "Sandbox"'           # sandbox denials
xcodebuild archive -scheme S -destination 'generic/platform=iOS' -archivePath S.xcarchive \
  -allowProvisioningUpdates -authenticationKeyPath AuthKey_ID.p8 -authenticationKeyID ID -authenticationKeyIssuerID ISSUER
xcodebuild -exportArchive -archivePath S.xcarchive -exportPath out -exportOptionsPlist ExportOptions.plist
xcrun altool --upload-package App.ipa --type ios --apiKey ID --apiIssuer ISSUER
```
