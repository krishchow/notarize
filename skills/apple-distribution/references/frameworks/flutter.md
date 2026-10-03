# Flutter

Flutter wraps native Xcode projects: `ios/Runner.xcworkspace` and `macos/Runner.xcworkspace`.

## Versioning
`pubspec.yaml` `version: 1.2.0+42` → CFBundleShortVersionString `1.2.0`, CFBundleVersion `42`. Bump `+N` for every App Store / TestFlight upload.

## iOS → TestFlight / App Store
1. Bundle ID: set in Xcode (Runner target → Signing & Capabilities) or `PRODUCT_BUNDLE_IDENTIFIER` in `ios/Runner.xcodeproj`.
2. Either:
   - `flutter build ios --release --no-codesign` then `xcode action=archive path=ios/Runner.xcworkspace scheme=Runner target=testflight-ios` → `xcode action=export … destination=upload`, or
   - generate ExportOptions with `xcode export` once and run `flutter build ipa --release --export-options-plist ios/ExportOptions.plist`, then `upload_build path=build/ios/ipa/*.ipa`.
3. `asc_builds wait_processing` → `testflight …`.

## macOS → Developer ID
1. In `macos/Runner/*.entitlements` Flutter enables the sandbox by default (`DebugProfile.entitlements`, `Release.entitlements`) — keep it for the Mac App Store; for Developer ID you may remove it, but keep `network.client` if sandboxed.
2. `ENABLE_HARDENED_RUNTIME = YES` for the Runner target.
3. `xcode action=archive path=macos/Runner.xcworkspace scheme=Runner target=mac-developer-id` → `xcode action=export target=mac-developer-id` → `notarize_and_staple path=<export>/Runner.app` (or rename via PRODUCT_NAME).
   Or: `flutter build macos --release` → `sign path=build/macos/Build/Products/Release/<App>.app identity=auto target=mac-developer-id` → `notarize_and_staple`.
