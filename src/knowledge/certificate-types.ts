/**
 * Apple signing certificate types: how they appear in the developer portal,
 * the App Store Connect API, and the keychain (certificate common name prefix).
 */

export type CertTypeId =
  | "developer-id-application"
  | "developer-id-installer"
  | "apple-distribution"
  | "apple-development"
  | "mac-installer-distribution"
  | "mac-app-distribution-legacy"
  | "ios-distribution-legacy"
  | "ios-development-legacy"
  | "mac-development-legacy"
  | "developer-id-kext";

export interface CertificateTypeInfo {
  id: CertTypeId;
  portalName: string;
  /** App Store Connect API `certificateType` value(s) that create this cert. */
  ascTypes: string[];
  /** Common-name prefixes as shown by `security find-identity`. */
  keychainPrefixes: string[];
  purpose: string;
  usedFor: string[];
  createdBy: string;
  limit?: string;
  notes?: string[];
  legacy?: boolean;
}

export const CERTIFICATE_TYPES: CertificateTypeInfo[] = [
  {
    id: "developer-id-application",
    portalName: "Developer ID Application",
    ascTypes: ["DEVELOPER_ID_APPLICATION_G2", "DEVELOPER_ID_APPLICATION"],
    keychainPrefixes: ["Developer ID Application:"],
    purpose:
      "Sign Mac apps, frameworks, command-line tools, DMGs and zips distributed OUTSIDE the Mac App Store.",
    usedFor: ["mac-developer-id"],
    createdBy:
      "Account Holder only, via developer.apple.com → Certificates or Xcode → Settings → Accounts → Manage Certificates. API keys are usually refused for this type.",
    limit: "5 per team",
    notes: [
      "Revoking a Developer ID Application certificate stops Gatekeeper from launching software signed with it (for new downloads). Do not revoke casually; if the private key is lost, just create another (up to the limit).",
      "Back up the private key (export a .p12) — it cannot be re-downloaded from Apple.",
    ],
  },
  {
    id: "developer-id-installer",
    portalName: "Developer ID Installer",
    ascTypes: [],
    keychainPrefixes: ["Developer ID Installer:"],
    purpose:
      "Sign .pkg installer packages distributed outside the Mac App Store (productsign / productbuild --sign).",
    usedFor: ["mac-developer-id"],
    createdBy: "Account Holder only, via developer.apple.com → Certificates (not available through the API).",
    limit: "5 per team",
  },
  {
    id: "apple-distribution",
    portalName: "Apple Distribution",
    ascTypes: ["DISTRIBUTION"],
    keychainPrefixes: ["Apple Distribution:"],
    purpose:
      "Sign apps for the App Store and TestFlight (iOS, iPadOS, macOS, tvOS, watchOS, visionOS) and for Ad Hoc / Enterprise distribution.",
    usedFor: [
      "ios-app-store",
      "testflight-ios",
      "ios-ad-hoc",
      "mac-app-store",
      "testflight-mac",
      "enterprise",
    ],
    createdBy: "Account Holder or Admin (API key with Admin role works).",
    limit: "3 per team (shared with legacy distribution types)",
  },
  {
    id: "apple-development",
    portalName: "Apple Development",
    ascTypes: ["DEVELOPMENT"],
    keychainPrefixes: ["Apple Development:"],
    purpose: "Sign builds for running/debugging on your own registered devices and Macs.",
    usedFor: ["ios-development", "mac-development"],
    createdBy: "Any team member (Xcode creates these automatically with automatic signing).",
  },
  {
    id: "mac-installer-distribution",
    portalName: "Mac Installer Distribution",
    ascTypes: ["MAC_INSTALLER_DISTRIBUTION"],
    keychainPrefixes: ["3rd Party Mac Developer Installer:", "Mac Installer Distribution:"],
    purpose: "Sign the .pkg that wraps a Mac App Store / Mac TestFlight upload.",
    usedFor: ["mac-app-store", "testflight-mac"],
    createdBy: "Account Holder or Admin.",
  },
  {
    id: "mac-app-distribution-legacy",
    portalName: "Mac App Distribution (legacy)",
    ascTypes: ["MAC_APP_DISTRIBUTION"],
    keychainPrefixes: ["3rd Party Mac Developer Application:"],
    purpose: "Legacy Mac App Store app-signing certificate; superseded by Apple Distribution.",
    usedFor: ["mac-app-store", "testflight-mac"],
    createdBy: "Account Holder or Admin.",
    legacy: true,
  },
  {
    id: "ios-distribution-legacy",
    portalName: "iOS Distribution (legacy)",
    ascTypes: ["IOS_DISTRIBUTION"],
    keychainPrefixes: ["iPhone Distribution:", "iOS Distribution:"],
    purpose: "Legacy iOS distribution certificate; superseded by Apple Distribution.",
    usedFor: ["ios-app-store", "testflight-ios", "ios-ad-hoc"],
    createdBy: "Account Holder or Admin.",
    legacy: true,
  },
  {
    id: "ios-development-legacy",
    portalName: "iOS Development (legacy)",
    ascTypes: ["IOS_DEVELOPMENT"],
    keychainPrefixes: ["iPhone Developer:", "iOS Developer:"],
    purpose: "Legacy iOS development certificate; superseded by Apple Development.",
    usedFor: ["ios-development"],
    createdBy: "Any team member.",
    legacy: true,
  },
  {
    id: "mac-development-legacy",
    portalName: "Mac Development (legacy)",
    ascTypes: ["MAC_APP_DEVELOPMENT"],
    keychainPrefixes: ["Mac Developer:"],
    purpose: "Legacy Mac development certificate; superseded by Apple Development.",
    usedFor: ["mac-development"],
    createdBy: "Any team member.",
    legacy: true,
  },
  {
    id: "developer-id-kext",
    portalName: "Developer ID Kernel Extension",
    ascTypes: ["DEVELOPER_ID_KEXT_G2", "DEVELOPER_ID_KEXT"],
    keychainPrefixes: [],
    purpose: "Sign kernel extensions (requires Apple approval; prefer DriverKit/System Extensions).",
    usedFor: [],
    createdBy: "Account Holder, after Apple grants the kext signing entitlement.",
    legacy: true,
  },
];

export function certType(id: CertTypeId): CertificateTypeInfo {
  return CERTIFICATE_TYPES.find((c) => c.id === id)!;
}

/** Classify a keychain identity / certificate common name. */
export function classifyCertificateName(name: string): CertificateTypeInfo | undefined {
  return CERTIFICATE_TYPES.find((c) => c.keychainPrefixes.some((p) => name.startsWith(p)));
}

/** Map an App Store Connect `certificateType` to our type info. */
export function classifyAscCertificateType(ascType: string): CertificateTypeInfo | undefined {
  return CERTIFICATE_TYPES.find((c) => c.ascTypes.includes(ascType));
}

/** "Developer ID Application: Jane Doe (ABCDE12345)" → "ABCDE12345" */
export function teamIdFromCertName(name: string): string | undefined {
  return /\(([A-Z0-9]{10})\)\s*$/.exec(name)?.[1];
}

export const ASC_CERTIFICATE_TYPES = [
  "DEVELOPMENT",
  "DISTRIBUTION",
  "DEVELOPER_ID_APPLICATION",
  "DEVELOPER_ID_APPLICATION_G2",
  "DEVELOPER_ID_KEXT",
  "DEVELOPER_ID_KEXT_G2",
  "MAC_INSTALLER_DISTRIBUTION",
  "MAC_APP_DISTRIBUTION",
  "MAC_APP_DEVELOPMENT",
  "IOS_DEVELOPMENT",
  "IOS_DISTRIBUTION",
  "PASS_TYPE_ID",
  "PASS_TYPE_ID_WITH_NFC",
] as const;

/** Apple intermediate CAs needed to build a trust chain for signing identities. */
export const APPLE_INTERMEDIATES = [
  {
    name: "Apple Worldwide Developer Relations Certification Authority (G3)",
    commonName: "Apple Worldwide Developer Relations Certification Authority",
    url: "https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer",
    neededFor: "Apple Development / Apple Distribution / Mac Installer Distribution certificates",
  },
  {
    name: "Developer ID Certification Authority (G2)",
    commonName: "Developer ID Certification Authority",
    url: "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer",
    neededFor: "Developer ID Application / Installer certificates issued since 2022",
  },
  {
    name: "Developer ID Certification Authority (G1)",
    commonName: "Developer ID Certification Authority",
    url: "https://www.apple.com/certificateauthority/DeveloperIDCA.cer",
    neededFor: "Older Developer ID certificates (pre-2022)",
  },
];
