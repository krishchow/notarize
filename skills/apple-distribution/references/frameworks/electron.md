# Electron

## Developer ID (direct download) — electron-builder
```jsonc
// package.json → "build"
{
  "appId": "com.company.app",
  "mac": {
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "notarize": true,
    "target": ["dmg", "zip"]
  }
}
```
`build/entitlements.mac.plist` (`entitlements generate preset=electron`): `com.apple.security.cs.allow-jit` = true. Add `allow-unsigned-executable-memory` only for old Electron; `disable-library-validation` only if you load native modules signed by another team; `device.audio-input` / `device.camera` (+ usage strings) for getUserMedia.

Environment for signing + notarization:
- Signing identity: from the keychain automatically, or `CSC_NAME`; CI: `CSC_LINK` (base64 .p12) + `CSC_KEY_PASSWORD`.
- Notarization (API key): `APPLE_API_KEY` = **path** to AuthKey_XXX.p8, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- Build: `npx electron-builder --mac`. Then verify: `inspect_code_signature path=dist/mac*/App.app target=mac-developer-id` and `gatekeeper simulate_download path=dist/App.dmg`.
- Remove legacy `afterSign` notarize hooks if you enable `mac.notarize` (double notarization).

## Electron Forge
```js
packagerConfig: {
  osxSign: {},                       // uses @electron/osx-sign defaults (hardened runtime)
  osxNotarize: { appleApiKey: process.env.APPLE_API_KEY, appleApiKeyId: process.env.APPLE_API_KEY_ID, appleApiIssuer: process.env.APPLE_API_ISSUER },
}
```

## Mac App Store (`mas` target)
- Certificates: Apple Distribution + Mac Installer Distribution; profile MAC_APP_STORE → `build/embedded.provisionprofile` (`mas.provisioningProfile`).
- `mas.entitlements` = `electron-mas` preset (sandbox, network client, user-selected files, application group `TEAMID.bundleid`, allow-jit); `mas.entitlementsInherit` = `electron-mas-inherit` (sandbox + inherit).
- Electron's helpers (GPU/Renderer/Plugin) must also carry provisioning profiles for TestFlight (ITMS-90886).
- Upload the produced .pkg with `upload_build`.

## Common failures
- "The executable does not have the hardened runtime enabled" → `hardenedRuntime: true`.
- App crashes on launch after signing → missing `allow-jit`.
- Native `.node` modules unsigned → electron-builder signs them if they are inside the app; prebuilt binaries under `Resources/` with no extension need signing too (the `sign` tool finds them).
