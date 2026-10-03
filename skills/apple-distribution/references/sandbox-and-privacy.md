# App Sandbox, privacy permissions (TCC) and App Store Connect roles

## Sandbox
A sandboxed app lives in `~/Library/Containers/<bundle-id>` and can only do what its entitlements allow.

Debug loop:
1. Reproduce the failing feature.
2. `system_logs preset=sandbox process=<AppName> last=5m` → each `deny(1) <operation> <target>` line grouped, with the entitlement that would allow it:
   - `network-outbound` → `com.apple.security.network.client`
   - `network-bind` → `network.server`
   - `file-read*/file-write*` in ~/Downloads → `files.downloads.read-write`; ~/Pictures/Music/Movies → `assets.*`; elsewhere → user-selected files via NSOpenPanel + security-scoped bookmarks
   - `appleevent-send` → `scripting-targets` / `automation.apple-events` + usage string
   - `mach-lookup` → embed your XPC service or use an app-group-prefixed name
3. Add the entitlement (`entitlements generate` / edit the file), re-sign, re-test.
4. For the Mac App Store, avoid `temporary-exception.*` keys — they invite review questions.

## Privacy permissions (TCC)
macOS/iOS ask the user before an app accesses the camera, microphone, contacts, calendars, photos, location, Bluetooth, other apps (Apple Events), Desktop/Documents/Downloads, etc.

Each needs:
- An **Info.plist usage string** (`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSContactsUsageDescription`, `NSCalendarsFullAccessUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSLocationWhenInUseUsageDescription`/`NSLocationUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSAppleEventsUsageDescription`, `NSDesktopFolderUsageDescription`, …). Missing ⇒ crash on access (iOS) / denial (macOS) / ITMS-90683 on upload.
- On macOS with hardened runtime or sandbox, the matching **entitlement** (`device.camera`, `device.audio-input`, `personal-information.*`, `automation.apple-events`). Missing ⇒ silently denied.

No Info.plist key exists for Screen Recording, Accessibility, Input Monitoring or Full Disk Access — the user must enable the app in System Settings → Privacy & Security. Accessibility is not available to sandboxed apps.

Tools: `privacy action=audit path=App.app` (frameworks vs usage strings vs entitlements, privacy manifest), `privacy action=tcc_reset service=Camera bundle_id=…` to see the prompt again, `system_logs preset=tcc`.

## Privacy manifests (iOS/iPadOS/tvOS/visionOS/watchOS)
`PrivacyInfo.xcprivacy` declares tracking domains, collected data types and **required-reason APIs**: UserDefaults (`CA92.1`), file timestamps (`C617.1`), system boot time (`35F9.1`), disk space (`E174.1`), active keyboards. Missing declarations ⇒ ITMS-91053; third-party SDKs without manifests ⇒ ITMS-91061. `privacy audit` heuristically scans the binary for these APIs.

## App Store Connect user roles (API key roles)
| Role | Can |
|---|---|
| Account Holder | Everything; only one who can accept agreements and (normally) create Developer ID certificates |
| Admin | Certificates, profiles, IDs, users, apps, TestFlight, submissions |
| App Manager | Apps, builds, TestFlight, metadata, submissions; profiles/IDs with "Access to Certificates, Identifiers & Profiles" |
| Developer | Builds and profiles they're allowed to; limited App Store Connect |
| Marketing / Sales / Finance / Customer Support | Non-technical areas |

API errors: 401 = wrong key/issuer/clock; 403 = role too low **or an agreement awaiting acceptance**.
