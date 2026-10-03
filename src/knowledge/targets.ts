import type { CertTypeId } from "./certificate-types";

export const TARGET_IDS = [
  "mac-developer-id",
  "mac-app-store",
  "testflight-mac",
  "ios-app-store",
  "testflight-ios",
  "ios-ad-hoc",
  "ios-development",
  "mac-development",
  "enterprise",
] as const;

export type TargetId = (typeof TARGET_IDS)[number];

export interface TargetInfo {
  id: TargetId;
  title: string;
  platform: "macOS" | "iOS";
  summary: string;
  /** Certificates needed, in keychain, with private key. `alternatives` = any one of. */
  certificates: { role: string; alternatives: CertTypeId[]; when?: string }[];
  profile?: {
    ascType: string;
    required: "always" | "restricted-entitlements";
    embedPath: string;
    needsDevices?: boolean;
  };
  hardenedRuntime: "required" | "recommended" | "optional";
  sandbox: "required" | "optional" | "n/a";
  forbiddenEntitlements: string[];
  packaging: string[];
  /** ExportOptions.plist `method` (Xcode 15.3+ names). */
  exportMethod: string;
  legacyExportMethod?: string;
  steps: string[];
  ascAppRecord: boolean;
  humanSteps: string[];
}

export const TARGETS: Record<TargetId, TargetInfo> = {
  "mac-developer-id": {
    id: "mac-developer-id",
    title: "macOS — Developer ID (direct download, outside the Mac App Store)",
    platform: "macOS",
    summary:
      "Sign every piece of code with your Developer ID Application certificate, hardened runtime and a secure timestamp. Package as .zip/.dmg/.pkg, submit to Apple's notary service, staple the ticket, and distribute from your own website. Gatekeeper then opens it without warnings.",
    certificates: [
      { role: "Sign the app and DMG", alternatives: ["developer-id-application"] },
      {
        role: "Sign .pkg installers",
        alternatives: ["developer-id-installer"],
        when: "only when shipping a .pkg",
      },
    ],
    profile: {
      ascType: "MAC_APP_DIRECT",
      required: "restricted-entitlements",
      embedPath: "Contents/embedded.provisionprofile",
    },
    hardenedRuntime: "required",
    sandbox: "optional",
    forbiddenEntitlements: ["com.apple.security.get-task-allow"],
    packaging: [
      "dmg (recommended for apps)",
      "zip (ditto -c -k --keepParent)",
      "pkg (installers, signed with Developer ID Installer)",
    ],
    exportMethod: "developer-id",
    steps: [
      "Sign inside-out with --options runtime --timestamp (sign tool / Xcode archive + export method developer-id)",
      "Verify (inspect_code_signature)",
      "Package (package tool)",
      "Notarize (notary submit, wait)",
      "Staple (staple) — the .app or .dmg/.pkg, not a .zip",
      "Validate as a user would (gatekeeper simulate_download)",
    ],
    ascAppRecord: false,
    humanSteps: [
      "Paid Apple Developer Program membership (Organization or Individual).",
      "Account Holder creates the Developer ID Application certificate (developer.apple.com → Certificates → + → Developer ID Application) using a CSR from keychain create_csr, or from Xcode → Settings → Accounts → Manage Certificates.",
    ],
  },
  "mac-app-store": {
    id: "mac-app-store",
    title: "macOS — Mac App Store",
    platform: "macOS",
    summary:
      "Sign the app with Apple Distribution plus a Mac App Store provisioning profile, enable App Sandbox, and wrap it in a .pkg signed with Mac Installer Distribution. Upload it to App Store Connect, then submit for review.",
    certificates: [
      { role: "Sign the app", alternatives: ["apple-distribution", "mac-app-distribution-legacy"] },
      { role: "Sign the upload .pkg", alternatives: ["mac-installer-distribution"] },
    ],
    profile: {
      ascType: "MAC_APP_STORE",
      required: "always",
      embedPath: "Contents/embedded.provisionprofile",
    },
    hardenedRuntime: "optional",
    sandbox: "required",
    forbiddenEntitlements: ["com.apple.security.get-task-allow"],
    packaging: [
      "pkg (productbuild --component App.app /Applications --sign 'Mac Installer Distribution / 3rd Party Mac Developer Installer')",
    ],
    exportMethod: "app-store-connect",
    legacyExportMethod: "app-store",
    steps: [
      "Register the bundle ID and enable capabilities (asc_bundle_ids)",
      "Create the app record in App Store Connect (web UI)",
      "Archive with automatic signing + API key (xcode archive) or sign manually with the MAC_APP_STORE profile",
      "Export with method app-store-connect (xcode export) or productbuild a signed pkg (package pkg)",
      "Upload (upload_build or xcode export destination=upload)",
      "Wait for processing (asc_builds wait_processing), then TestFlight or submit for review (app_store)",
    ],
    ascAppRecord: true,
    humanSteps: [
      "Create the app record: App Store Connect → Apps → + → New App (platform macOS, bundle ID, SKU, name).",
      "Accept the Paid Apps agreement for paid apps / IAP (Business section).",
      "Set LSApplicationCategoryType in Info.plist; Mac App Store requires a category.",
    ],
  },
  "testflight-mac": {
    id: "testflight-mac",
    title: "macOS — TestFlight beta",
    platform: "macOS",
    summary:
      "Same build as the Mac App Store. Every executable (including helper apps) must carry an embedded provisioning profile and com.apple.application-identifier, or TestFlight rejects the build (ITMS-90886/90889).",
    certificates: [
      { role: "Sign the app", alternatives: ["apple-distribution", "mac-app-distribution-legacy"] },
      { role: "Sign the upload .pkg", alternatives: ["mac-installer-distribution"] },
    ],
    profile: {
      ascType: "MAC_APP_STORE",
      required: "always",
      embedPath: "Contents/embedded.provisionprofile",
    },
    hardenedRuntime: "optional",
    sandbox: "required",
    forbiddenEntitlements: ["com.apple.security.get-task-allow"],
    packaging: ["pkg"],
    exportMethod: "app-store-connect",
    legacyExportMethod: "app-store",
    steps: [
      "Everything from mac-app-store up to upload",
      "Set export compliance (asc_builds set_encryption_compliance) or add ITSAppUsesNonExemptEncryption to Info.plist",
      "Add the build to a beta group (testflight add_build_to_group); external groups need beta review (testflight submit_beta_review)",
    ],
    ascAppRecord: true,
    humanSteps: ["Create the app record in App Store Connect (web UI)."],
  },
  "ios-app-store": {
    id: "ios-app-store",
    title: "iOS / iPadOS — App Store",
    platform: "iOS",
    summary:
      "Archive with Apple Distribution plus an App Store provisioning profile, export an .ipa with method app-store-connect, upload it, wait for processing, attach the build to a version, and submit for review.",
    certificates: [{ role: "Sign the app", alternatives: ["apple-distribution", "ios-distribution-legacy"] }],
    profile: {
      ascType: "IOS_APP_STORE",
      required: "always",
      embedPath: "Payload/<App>.app/embedded.mobileprovision",
    },
    hardenedRuntime: "optional",
    sandbox: "n/a",
    forbiddenEntitlements: ["get-task-allow"],
    packaging: ["ipa"],
    exportMethod: "app-store-connect",
    legacyExportMethod: "app-store",
    steps: [
      "Register the bundle ID + capabilities (asc_bundle_ids)",
      "Create the app record (web UI)",
      "Archive (xcode archive, automatic signing with API key recommended)",
      "Export + upload (xcode export destination=upload) or upload_build",
      "Wait for processing (asc_builds wait_processing)",
      "Create a version, attach the build, fill metadata, submit (app_store)",
    ],
    ascAppRecord: true,
    humanSteps: [
      "Create the app record in App Store Connect (web UI).",
      "Screenshots, privacy nutrition labels and age rating are usually easiest in the web UI.",
    ],
  },
  "testflight-ios": {
    id: "testflight-ios",
    title: "iOS / iPadOS — TestFlight beta",
    platform: "iOS",
    summary:
      "Same build as the App Store. Internal testers (App Store Connect users) get builds right after processing. External testers need a one-time beta app review per version.",
    certificates: [{ role: "Sign the app", alternatives: ["apple-distribution", "ios-distribution-legacy"] }],
    profile: {
      ascType: "IOS_APP_STORE",
      required: "always",
      embedPath: "Payload/<App>.app/embedded.mobileprovision",
    },
    hardenedRuntime: "optional",
    sandbox: "n/a",
    forbiddenEntitlements: ["get-task-allow"],
    packaging: ["ipa"],
    exportMethod: "app-store-connect",
    legacyExportMethod: "app-store",
    steps: [
      "Archive + export + upload as for ios-app-store",
      "Answer export compliance (asc_builds set_encryption_compliance) or set ITSAppUsesNonExemptEncryption=NO in Info.plist",
      "testflight create_group / add_testers / add_build_to_group; submit_beta_review for external groups",
    ],
    ascAppRecord: true,
    humanSteps: ["Create the app record in App Store Connect (web UI)."],
  },
  "ios-ad-hoc": {
    id: "ios-ad-hoc",
    title: "iOS — Ad Hoc (install on specific registered devices)",
    platform: "iOS",
    summary:
      "Register each device UDID (up to 100 per device family per membership year), create an Ad Hoc profile that includes them, and export an .ipa with method release-testing.",
    certificates: [{ role: "Sign the app", alternatives: ["apple-distribution", "ios-distribution-legacy"] }],
    profile: {
      ascType: "IOS_APP_ADHOC",
      required: "always",
      embedPath: "Payload/<App>.app/embedded.mobileprovision",
      needsDevices: true,
    },
    hardenedRuntime: "optional",
    sandbox: "n/a",
    forbiddenEntitlements: ["get-task-allow"],
    packaging: ["ipa"],
    exportMethod: "release-testing",
    legacyExportMethod: "ad-hoc",
    steps: [
      "Collect UDIDs (devices tool) and register them (asc_devices register)",
      "Create/regenerate the IOS_APP_ADHOC profile (asc_profiles)",
      "Archive + export with method release-testing",
      "Install via Apple Configurator, Xcode Devices window, or an OTA manifest",
    ],
    ascAppRecord: false,
    humanSteps: [],
  },
  "ios-development": {
    id: "ios-development",
    title: "iOS — Development (run/debug on your devices)",
    platform: "iOS",
    summary:
      "Use Apple Development certificates and a development profile that lists your devices. Easiest path: Xcode automatic signing.",
    certificates: [{ role: "Sign the app", alternatives: ["apple-development", "ios-development-legacy"] }],
    profile: {
      ascType: "IOS_APP_DEVELOPMENT",
      required: "always",
      embedPath: "Payload/<App>.app/embedded.mobileprovision",
      needsDevices: true,
    },
    hardenedRuntime: "optional",
    sandbox: "n/a",
    forbiddenEntitlements: [],
    packaging: ["ipa / direct install from Xcode"],
    exportMethod: "debugging",
    legacyExportMethod: "development",
    steps: ["Register devices", "Automatic signing in Xcode, or create IOS_APP_DEVELOPMENT profile"],
    ascAppRecord: false,
    humanSteps: ["Enable Developer Mode on the device (Settings → Privacy & Security → Developer Mode)."],
  },
  "mac-development": {
    id: "mac-development",
    title: "macOS — Development",
    platform: "macOS",
    summary:
      "Apple Development signing for local runs. A MAC_APP_DEVELOPMENT profile listing this Mac's provisioning UDID is needed only for restricted entitlements (iCloud, push, etc.).",
    certificates: [{ role: "Sign the app", alternatives: ["apple-development", "mac-development-legacy"] }],
    profile: {
      ascType: "MAC_APP_DEVELOPMENT",
      required: "restricted-entitlements",
      embedPath: "Contents/embedded.provisionprofile",
      needsDevices: true,
    },
    hardenedRuntime: "optional",
    sandbox: "optional",
    forbiddenEntitlements: [],
    packaging: [],
    exportMethod: "debugging",
    legacyExportMethod: "development",
    steps: ["Automatic signing in Xcode", "Register this Mac (devices + asc_devices) if a profile is needed"],
    ascAppRecord: false,
    humanSteps: [],
  },
  enterprise: {
    id: "enterprise",
    title: "iOS — Enterprise in-house (Apple Developer Enterprise Program only)",
    platform: "iOS",
    summary:
      "Only for proprietary internal apps of organizations enrolled in the Enterprise Program. Uses an In-House distribution certificate and an IOS_APP_INHOUSE profile.",
    certificates: [{ role: "Sign the app", alternatives: ["apple-distribution", "ios-distribution-legacy"] }],
    profile: {
      ascType: "IOS_APP_INHOUSE",
      required: "always",
      embedPath: "Payload/<App>.app/embedded.mobileprovision",
    },
    hardenedRuntime: "optional",
    sandbox: "n/a",
    forbiddenEntitlements: ["get-task-allow"],
    packaging: ["ipa"],
    exportMethod: "enterprise",
    steps: ["Archive", "Export with method enterprise", "Distribute via MDM or internal site"],
    ascAppRecord: false,
    humanSteps: [
      "Requires Apple Developer Enterprise Program membership (separate from the standard program).",
    ],
  },
};

export const PROFILE_TYPES = [
  "IOS_APP_DEVELOPMENT",
  "IOS_APP_STORE",
  "IOS_APP_ADHOC",
  "IOS_APP_INHOUSE",
  "MAC_APP_DEVELOPMENT",
  "MAC_APP_STORE",
  "MAC_APP_DIRECT",
  "TVOS_APP_DEVELOPMENT",
  "TVOS_APP_STORE",
  "TVOS_APP_ADHOC",
  "TVOS_APP_INHOUSE",
  "MAC_CATALYST_APP_DEVELOPMENT",
  "MAC_CATALYST_APP_STORE",
  "MAC_CATALYST_APP_DIRECT",
] as const;

/** Which certificate types a profile type accepts (for create-profile validation). */
export function certTypesForProfile(profileType: string): string[] {
  if (/DEVELOPMENT$/.test(profileType)) return ["DEVELOPMENT", "IOS_DEVELOPMENT", "MAC_APP_DEVELOPMENT"];
  if (/DIRECT$/.test(profileType)) return ["DEVELOPER_ID_APPLICATION_G2", "DEVELOPER_ID_APPLICATION"];
  if (profileType.startsWith("MAC_APP_STORE") || profileType === "MAC_CATALYST_APP_STORE")
    return ["DISTRIBUTION", "MAC_APP_DISTRIBUTION"];
  return ["DISTRIBUTION", "IOS_DISTRIBUTION"];
}

export function profileNeedsDevices(profileType: string): boolean {
  return /DEVELOPMENT$|ADHOC$/.test(profileType);
}
