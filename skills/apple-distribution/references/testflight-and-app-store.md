# TestFlight and App Store submission

## Prerequisites
- App record exists (manual: `asc_apps action=create_instructions`).
- Build signed for distribution (Apple Distribution + store profile), unique build number, recent Xcode.
- Export compliance: add `ITSAppUsesNonExemptEncryption = NO` to Info.plist if you only use HTTPS/OS crypto (otherwise answer per build with `asc_builds set_encryption_compliance`).

## Upload → processing
1. `xcode action=export target=testflight-ios destination=upload` (Xcode projects) or `upload_build path=App.ipa|App.pkg`.
2. `asc_builds action=wait_processing app=<bundle id> build_number=<N>` — 5–30 min; returns a Monitor command when it runs long. States: PROCESSING → VALID (or FAILED/INVALID; App Store Connect emails the ITMS reasons).

## TestFlight
- **Internal** group: App Store Connect users (up to 100), builds available right after processing, no review.
- **External** group: up to 10,000 testers by email or public link; the first build of each version needs **beta app review** (`testflight submit_beta_review`) — set the beta review contact info once in App Store Connect → TestFlight → Test Information.
- `testflight create_group` → `add_testers` → `add_build_to_group` → `set_what_to_test`.
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
