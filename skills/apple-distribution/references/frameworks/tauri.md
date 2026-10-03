# Tauri

## Tauri v2 — macOS Developer ID
`src-tauri/tauri.conf.json`:
```json
{
  "identifier": "com.company.app",
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Company (TEAMID)",
      "hardenedRuntime": true,
      "entitlements": "./Entitlements.plist"
    }
  }
}
```
Environment:
- `APPLE_SIGNING_IDENTITY` (overrides config), CI: `APPLE_CERTIFICATE` (base64 .p12) + `APPLE_CERTIFICATE_PASSWORD`.
- Notarization with API key: `APPLE_API_ISSUER`, **`APPLE_API_KEY` = the key ID** (not the path — differs from Electron!), `APPLE_API_KEY_PATH` = path to the .p8.
- Build: `npm run tauri build -- --bundles app,dmg` (universal: `--target universal-apple-darwin`). Tauri notarizes and staples when the env vars are set.

Tauri apps (WKWebView) rarely need hardened-runtime exceptions. Sidecar binaries (`externalBin`) must be signed too — Tauri signs them; verify with `inspect_code_signature`.

## Mac App Store
Add `com.apple.security.app-sandbox` + `network.client` to the entitlements, embed a MAC_APP_STORE profile (`bundle.macOS.files: {"embedded.provisionprofile": "path"}`), sign with Apple Distribution, build a pkg (`package action=pkg target=mac-app-store`) and upload.

## iOS (Tauri mobile)
`bundle.iOS.developmentTeam` = Team ID; `npm run tauri ios build -- --export-method app-store-connect` produces an .ipa → `upload_build`.
