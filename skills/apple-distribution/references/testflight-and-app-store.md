# TestFlight and App Store submission

## Prerequisites
- App record exists (manual: `asc_apps action=create_instructions`).
- Build signed for distribution (Apple Distribution + store profile), unique build number, recent Xcode.
- Export compliance: add `ITSAppUsesNonExemptEncryption = NO` to Info.plist if you only use HTTPS/OS crypto (otherwise answer per build with `asc_builds set_encryption_compliance`).

## iOS, TestFlight only: which signing route
1. **No registered devices on the team → sign manually for distribution (the default here).** No device needed. Verified end to end on an Expo app:
   1. `keychain action=create_csr key_name=<name>` → `asc_certificates action=create certificate_type=DISTRIBUTION key_name=<name>` (installs the cert + key) → `asc_profiles action=create profile_type=IOS_APP_STORE bundle_id=<id>` (installs it for Xcode; note the profile name it returns). Then offer to back up the new key with `keychain action=export_p12` (see certificates-and-profiles.md for why: Apple can't reissue it).
   2. Set the app target's Release signing **in the project**: `CODE_SIGN_STYLE = Manual`, `CODE_SIGN_IDENTITY` and `CODE_SIGN_IDENTITY[sdk=iphoneos*] = "Apple Distribution"`, `PROVISIONING_PROFILE_SPECIFIER = "<profile name>"` (Signing & Capabilities, or the app target's XCBuildConfiguration in `project.pbxproj`). Don't pass these as command-line build settings: they'd apply to every target, and CocoaPods/SwiftPM targets fail with "does not support provisioning profiles". With Expo, `prebuild` regenerates `ios/`, so re-apply them after each prebuild.
   3. `xcode action=archive target=testflight-ios signing_style=manual allow_provisioning_updates=false signing_certificate='Apple Distribution' provisioning_profiles={<bundle id>: <profile name>}`. It checks the settings from step 2 and refuses with the exact list if any are missing.
   4. `xcode action=export destination=export target=testflight-ios signing_style=manual signing_certificate='Apple Distribution' provisioning_profiles={<bundle id>: <profile name>}` (ExportOptions method `app-store-connect`, signing style manual). Export does pass the certificate and profile through.
   5. `upload_build path=<the .ipa>`. Allow a few minutes; past the foreground wait it continues as a background job with a Monitor command. (`xcode action=export destination=upload` exports and uploads in one step, but hasn't been verified on this route.)
2. **Automatic signing** (the `xcode` tool's default) needs **one** registered device, because an iOS archive is first signed with a development profile. Without one: "Your team has no devices…". Register one with the setup skill's device step, or use route 1.
3. **Managed Expo apps:** EAS (`eas build` + `eas submit`) does all of this in Expo's cloud with its own credentials. Building locally means `npx expo prebuild -p ios`, then route 1 or 2 against `ios/*.xcworkspace`. Ask which the user wants; don't assume EAS.
4. **Only register a device if they'll install development builds straight onto it.** TestFlight installs and the simulator don't need one, as long as they use route 1, EAS, or a team that already has a device.

## Upload → processing
1. `xcode action=export target=testflight-ios destination=upload` (Xcode projects) or `upload_build path=App.ipa|App.pkg`.
2. `asc_builds action=wait_processing app=<bundle id> build_number=<N>` — 5–30 min; returns a Monitor command when it runs long. States: PROCESSING → VALID (or FAILED/INVALID; App Store Connect emails the ITMS reasons).
   - Before a `builds` record appears, the tool checks `apps/<id>/buildUploads` for the same build number (and `version` when supplied), reports upload progress, and stops on upload validation failure. `PROCESSING` here means Apple has the upload even if the build list is empty. Do not upload it again. If the key/API cannot read upload records, monitoring falls back to the build list.

## App Groups and extensions
- Each app extension needs a bundle ID and signing profile of its own. It ships inside the containing app's archive; it does not need a separate App Store Connect app record.
- Enabling `APP_GROUPS` via the API is only the capability toggle. Register the exact `group.…` identifier via **Apple Developer → Certificates, Identifiers & Profiles → Identifiers → + → App Groups**, then assign it through **App Groups → Configure** on each app and extension App ID. If you're on an **App / App Clip** screen, go back to the first identifier-type screen. Use the correct Developer team/account; App Store Connect tester access does not establish Developer portal access.
- The public API cannot register/assign containers. Refresh profiles after the portal assignment and validate **both** the app and extension entitlements. A profile with `com.apple.security.application-groups=[]` cannot sign a target requesting the shared container.
- If Xcode automatic signing fails with bearer-token authentication but `asc_auth action=test` succeeds, use the manual distribution-signing route above. Do not repeatedly retry the same automatic archive or rotate a working key. Configure identity/profile settings per app/extension Release target, not globally on Pods.

## TestFlight
- **Internal** group: App Store Connect users (up to 100), builds available right after processing, no review.
- **External** group: up to 10,000 testers by email or public link; the first build of each version needs **beta app review** (`testflight submit_beta_review`) — set the beta review contact info once in App Store Connect → TestFlight → Test Information.
- `testflight create_group` → `add_testers` sets up group membership. Until an installable build exists, tester state may remain `NOT_INVITED`; adding membership is not confirmation that Apple sent an email.
- Upload → `asc_builds wait_processing` → answer export compliance → `testflight add_build_to_group` → `testflight testers group_id=<id>` / `testflight status build_id=<id>`. Attaching a build may automatically send the invitation (`INVITED`); don't send a duplicate. If a send/resend is still needed, use `testflight send_invites app=<app> testers=[{email: <email>}]` through confirmation. Apple refuses invitations with "Tester has no installable build" until the tester has access to a testable build. External groups also need beta review.
- Add `set_what_to_test` notes as needed. Report upload success, processing success, group assignment and invitation state as separate outcomes.
- Mac TestFlight additionally requires a provisioning profile in every executable bundle (helpers too) — ITMS-90886/90889.
- Builds expire after 90 days.

## App Store
1. `app_store action=create_version version_string=1.2.0` (must match CFBundleShortVersionString).
2. `app_store action=attach_build version_id=… build_id=…`.
3. `app_store action=update_localization` — description, keywords, What's New, promotional text, support/marketing URL.
4. In the web UI (or `asc_api`): screenshots per device size, privacy nutrition labels, age rating, pricing/availability, App Review contact + notes (+ demo account if login required).
5. `app_store action=submit_for_review` → `review_status`.
6. Manual release: `app_store action=release`; gradual rollout: `phased_release` (7 days).

## Common rejections at upload (ITMS)
See [error-catalog.md](error-catalog.md). Most frequent: 90189 (build number reused), 90062 (version not higher), 90683 (missing usage string), 91053 (privacy manifest API declaration), 90296 (Mac app not sandboxed), 90237 (Mac pkg not signed with installer cert), 90087 (simulator slices).
