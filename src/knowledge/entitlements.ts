/**
 * Entitlement catalog. Drives entitlements explain/validate/generate and the
 * capability ↔ portal cross-checks.
 */

export type EntitlementKind =
  | "sandbox"
  | "hardened-runtime"
  | "capability"
  | "identity"
  | "debug"
  | "managed";

export interface EntitlementInfo {
  key: string;
  title: string;
  kind: EntitlementKind;
  platforms: ("macOS" | "iOS")[];
  description: string;
  /** Needs a provisioning profile that grants it (restricted entitlement). */
  requiresProfile: boolean;
  /** App Store Connect bundleIdCapabilities capabilityType to enable. */
  ascCapability?: string;
  /** Info.plist key the user-facing prompt needs. */
  usageDescriptionKey?: string;
  risk?: string;
  notes?: string[];
}

const mac = ["macOS"] as ("macOS" | "iOS")[];
const ios = ["iOS"] as ("macOS" | "iOS")[];
const both = ["macOS", "iOS"] as ("macOS" | "iOS")[];

export const ENTITLEMENTS: EntitlementInfo[] = [
  // --- App Sandbox (macOS) ---
  {
    key: "com.apple.security.app-sandbox",
    title: "App Sandbox",
    kind: "sandbox",
    platforms: mac,
    description:
      "Runs the app in a container (~/Library/Containers/<bundle-id>) with access only to what other entitlements grant. Required for the Mac App Store; optional for Developer ID.",
    requiresProfile: false,
    notes: [
      "Sandbox violations are logged as 'Sandbox: <proc>(<pid>) deny(1) <operation> <path>' — use system_logs preset=sandbox.",
    ],
  },
  {
    key: "com.apple.security.network.client",
    title: "Outgoing network connections",
    kind: "sandbox",
    platforms: mac,
    description: "Allow outbound TCP/UDP (HTTP requests, websockets). Most sandboxed apps need this.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.network.server",
    title: "Incoming network connections",
    kind: "sandbox",
    platforms: mac,
    description: "Allow listening sockets (local servers, Bonjour advertising).",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.files.user-selected.read-only",
    title: "User-selected files (read-only)",
    kind: "sandbox",
    platforms: mac,
    description: "Read files the user picks in an Open panel or drags onto the app.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.files.user-selected.read-write",
    title: "User-selected files (read/write)",
    kind: "sandbox",
    platforms: mac,
    description: "Read/write files the user picks in Open/Save panels.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.files.downloads.read-write",
    title: "Downloads folder",
    kind: "sandbox",
    platforms: mac,
    description: "Read/write the user's Downloads folder.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.files.bookmarks.app-scope",
    title: "Security-scoped bookmarks",
    kind: "sandbox",
    platforms: mac,
    description: "Persist access to user-selected files/folders across launches.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.assets.pictures.read-write",
    title: "Pictures folder",
    kind: "sandbox",
    platforms: mac,
    description:
      "Read/write ~/Pictures (a .read-only variant also exists; same pattern for music and movies).",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.device.camera",
    title: "Camera",
    kind: "sandbox",
    platforms: mac,
    description:
      "Camera access. Needed under App Sandbox AND under the hardened runtime, plus NSCameraUsageDescription; without it the capture silently fails or the app is killed.",
    requiresProfile: false,
    usageDescriptionKey: "NSCameraUsageDescription",
  },
  {
    key: "com.apple.security.device.audio-input",
    title: "Microphone (hardened runtime / sandbox)",
    kind: "hardened-runtime",
    platforms: mac,
    description:
      "Microphone access under the hardened runtime and App Sandbox. Pair with NSMicrophoneUsageDescription.",
    requiresProfile: false,
    usageDescriptionKey: "NSMicrophoneUsageDescription",
  },
  {
    key: "com.apple.security.device.microphone",
    title: "Microphone (legacy sandbox key)",
    kind: "sandbox",
    platforms: mac,
    description: "Older sandbox microphone key; modern projects use com.apple.security.device.audio-input.",
    requiresProfile: false,
    usageDescriptionKey: "NSMicrophoneUsageDescription",
  },
  {
    key: "com.apple.security.device.usb",
    title: "USB devices",
    kind: "sandbox",
    platforms: mac,
    description: "Talk to USB devices from a sandboxed app.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.device.bluetooth",
    title: "Bluetooth",
    kind: "sandbox",
    platforms: mac,
    description: "Use Bluetooth from a sandboxed app (also needs NSBluetoothAlwaysUsageDescription).",
    requiresProfile: false,
    usageDescriptionKey: "NSBluetoothAlwaysUsageDescription",
  },
  {
    key: "com.apple.security.print",
    title: "Printing",
    kind: "sandbox",
    platforms: mac,
    description: "Print from a sandboxed app.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.personal-information.location",
    title: "Location",
    kind: "sandbox",
    platforms: mac,
    description: "Location Services from a sandboxed / hardened app. Pair with NSLocationUsageDescription.",
    requiresProfile: false,
    usageDescriptionKey: "NSLocationUsageDescription",
  },
  {
    key: "com.apple.security.personal-information.addressbook",
    title: "Contacts",
    kind: "sandbox",
    platforms: mac,
    description: "Contacts access. Pair with NSContactsUsageDescription.",
    requiresProfile: false,
    usageDescriptionKey: "NSContactsUsageDescription",
  },
  {
    key: "com.apple.security.personal-information.calendars",
    title: "Calendars",
    kind: "sandbox",
    platforms: mac,
    description: "Calendar/Reminders access. Pair with NSCalendarsFullAccessUsageDescription (macOS 14+).",
    requiresProfile: false,
    usageDescriptionKey: "NSCalendarsFullAccessUsageDescription",
  },
  {
    key: "com.apple.security.personal-information.photos-library",
    title: "Photos library",
    kind: "sandbox",
    platforms: mac,
    description: "Photos library access. Pair with NSPhotoLibraryUsageDescription.",
    requiresProfile: false,
    usageDescriptionKey: "NSPhotoLibraryUsageDescription",
  },
  {
    key: "com.apple.security.automation.apple-events",
    title: "Apple Events automation",
    kind: "hardened-runtime",
    platforms: mac,
    description:
      "Send Apple Events to other apps (AppleScript automation). Required under the hardened runtime, plus NSAppleEventsUsageDescription; the user is prompted per target app.",
    requiresProfile: false,
    usageDescriptionKey: "NSAppleEventsUsageDescription",
  },
  {
    key: "com.apple.security.scripting-targets",
    title: "Scripting targets",
    kind: "sandbox",
    platforms: mac,
    description: "Sandbox-friendly scoped Apple Events access to specific apps' scripting access groups.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.application-groups",
    title: "App Groups",
    kind: "capability",
    platforms: both,
    description:
      "Shared containers between apps/extensions from the same team. macOS groups are '<TEAMID>.<name>'; iOS groups are 'group.<name>' and need the App Groups capability in a profile.",
    requiresProfile: true,
    ascCapability: "APP_GROUPS",
    notes: [
      "On macOS, team-prefixed groups work without a profile under Developer ID, but since macOS 15 accessing another app's group container may prompt unless the group is authorized by a profile.",
    ],
  },
  {
    key: "com.apple.security.inherit",
    title: "Inherit sandbox",
    kind: "sandbox",
    platforms: mac,
    description:
      "For helper executables launched by a sandboxed app: inherit the parent's sandbox. Use ONLY together with com.apple.security.app-sandbox and nothing else.",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.temporary-exception.files.absolute-path.read-only",
    title: "Temporary exception: absolute path access",
    kind: "sandbox",
    platforms: mac,
    description:
      "Sandbox escape hatch for specific paths. App Review scrutinizes temporary exceptions heavily.",
    requiresProfile: false,
    risk: "Likely to draw App Review questions; prefer user-selected files + bookmarks.",
  },
  // --- Hardened runtime exceptions ---
  {
    key: "com.apple.security.cs.allow-jit",
    title: "Allow JIT (MAP_JIT)",
    kind: "hardened-runtime",
    platforms: mac,
    description:
      "Lets the process create writable+executable memory with MAP_JIT. Required by JavaScript engines with JIT (Electron/V8, some WebView/JS runtimes, LuaJIT).",
    requiresProfile: false,
    risk: "Moderate — narrowest of the executable-memory exceptions; prefer it over allow-unsigned-executable-memory.",
  },
  {
    key: "com.apple.security.cs.allow-unsigned-executable-memory",
    title: "Allow unsigned executable memory",
    kind: "hardened-runtime",
    platforms: mac,
    description:
      "Allows writable+executable memory without MAP_JIT. Needed by some older Electron versions and legacy JITs.",
    requiresProfile: false,
    risk: "High — weakens code-injection protection. Remove if allow-jit suffices.",
  },
  {
    key: "com.apple.security.cs.disable-executable-page-protection",
    title: "Disable executable page protection",
    kind: "hardened-runtime",
    platforms: mac,
    description: "Disables all executable memory protections. Almost never needed.",
    requiresProfile: false,
    risk: "Very high — avoid.",
  },
  {
    key: "com.apple.security.cs.disable-library-validation",
    title: "Disable library validation",
    kind: "hardened-runtime",
    platforms: mac,
    description:
      "Allows loading frameworks, plug-ins, or native modules signed by OTHER teams (or ad-hoc). Needed for apps that load third-party plug-ins or unsigned native modules.",
    requiresProfile: false,
    risk: "High — any library on disk could be injected. Prefer re-signing bundled libraries with your own Team ID.",
  },
  {
    key: "com.apple.security.cs.allow-dyld-environment-variables",
    title: "Allow DYLD_* environment variables",
    kind: "hardened-runtime",
    platforms: mac,
    description: "Honor DYLD_INSERT_LIBRARIES etc. Usually a sign of a packaging workaround.",
    requiresProfile: false,
    risk: "High — enables library injection.",
  },
  {
    key: "com.apple.security.cs.debugger",
    title: "Debugger",
    kind: "hardened-runtime",
    platforms: mac,
    description: "Lets this app attach to other processes as a debugger (only for developer tools).",
    requiresProfile: false,
  },
  {
    key: "com.apple.security.get-task-allow",
    title: "get-task-allow (debuggable) — macOS",
    kind: "debug",
    platforms: mac,
    description:
      "Lets debuggers attach. Xcode adds it to Debug builds. Notarization REJECTS binaries with it; App Store distribution strips/rejects it.",
    requiresProfile: false,
    risk: "Must not ship. Build the Release configuration / remove CODE_SIGN_INJECT_BASE_ENTITLEMENTS.",
  },
  {
    key: "get-task-allow",
    title: "get-task-allow (debuggable) — iOS",
    kind: "debug",
    platforms: ios,
    description:
      "Present only in development-signed iOS builds; must be false/absent in App Store, Ad Hoc and Enterprise builds.",
    requiresProfile: true,
  },
  // --- Identity entitlements injected from profiles ---
  {
    key: "com.apple.application-identifier",
    title: "Application identifier (macOS)",
    kind: "identity",
    platforms: mac,
    description:
      "<TEAMID>.<bundle-id>. Must match the embedded profile. Required for Mac App Store/TestFlight builds and any app using restricted entitlements.",
    requiresProfile: true,
  },
  {
    key: "application-identifier",
    title: "Application identifier (iOS)",
    kind: "identity",
    platforms: ios,
    description: "<TEAMID>.<bundle-id>; copied from the provisioning profile at signing time.",
    requiresProfile: true,
  },
  {
    key: "com.apple.developer.team-identifier",
    title: "Team identifier",
    kind: "identity",
    platforms: both,
    description: "Your 10-character Team ID; must match the profile and signing certificate.",
    requiresProfile: true,
  },
  {
    key: "keychain-access-groups",
    title: "Keychain sharing",
    kind: "capability",
    platforms: both,
    description:
      "Share keychain items between your apps. Values are '<TEAMID>.<group>' (or $(AppIdentifierPrefix)…).",
    requiresProfile: true,
  },
  // --- Capabilities (restricted; need portal capability + profile) ---
  {
    key: "aps-environment",
    title: "Push Notifications (iOS)",
    kind: "capability",
    platforms: ios,
    description: "'development' or 'production'. Distribution profiles grant 'production'.",
    requiresProfile: true,
    ascCapability: "PUSH_NOTIFICATIONS",
  },
  {
    key: "com.apple.developer.aps-environment",
    title: "Push Notifications (macOS)",
    kind: "capability",
    platforms: mac,
    description: "macOS push entitlement; needs a profile (MAC_APP_DIRECT for Developer ID apps).",
    requiresProfile: true,
    ascCapability: "PUSH_NOTIFICATIONS",
  },
  {
    key: "com.apple.developer.icloud-container-identifiers",
    title: "iCloud containers",
    kind: "capability",
    platforms: both,
    description: "CloudKit / iCloud Documents containers.",
    requiresProfile: true,
    ascCapability: "ICLOUD",
  },
  {
    key: "com.apple.developer.icloud-services",
    title: "iCloud services",
    kind: "capability",
    platforms: both,
    description: "CloudKit and/or CloudDocuments.",
    requiresProfile: true,
    ascCapability: "ICLOUD",
  },
  {
    key: "com.apple.developer.ubiquity-kvstore-identifier",
    title: "iCloud key-value store",
    kind: "capability",
    platforms: both,
    description: "NSUbiquitousKeyValueStore.",
    requiresProfile: true,
    ascCapability: "ICLOUD",
  },
  {
    key: "com.apple.developer.ubiquity-container-identifiers",
    title: "iCloud Documents containers",
    kind: "capability",
    platforms: both,
    description: "iCloud Drive document containers.",
    requiresProfile: true,
    ascCapability: "ICLOUD",
  },
  {
    key: "com.apple.developer.associated-domains",
    title: "Associated Domains",
    kind: "capability",
    platforms: both,
    description:
      "Universal links, shared web credentials, App Clips (applinks:, webcredentials:). Needs apple-app-site-association on the domain.",
    requiresProfile: true,
    ascCapability: "ASSOCIATED_DOMAINS",
  },
  {
    key: "com.apple.developer.applesignin",
    title: "Sign in with Apple",
    kind: "capability",
    platforms: both,
    description: "['Default'].",
    requiresProfile: true,
    ascCapability: "APPLE_ID_AUTH",
  },
  {
    key: "com.apple.developer.in-app-payments",
    title: "Apple Pay",
    kind: "capability",
    platforms: both,
    description: "Merchant IDs for Apple Pay.",
    requiresProfile: true,
    ascCapability: "APPLE_PAY",
  },
  {
    key: "com.apple.developer.healthkit",
    title: "HealthKit",
    kind: "capability",
    platforms: ios,
    description: "HealthKit access (plus NSHealthShareUsageDescription / NSHealthUpdateUsageDescription).",
    requiresProfile: true,
    ascCapability: "HEALTHKIT",
    usageDescriptionKey: "NSHealthShareUsageDescription",
  },
  {
    key: "com.apple.developer.homekit",
    title: "HomeKit",
    kind: "capability",
    platforms: ios,
    description: "HomeKit (plus NSHomeKitUsageDescription).",
    requiresProfile: true,
    ascCapability: "HOMEKIT",
    usageDescriptionKey: "NSHomeKitUsageDescription",
  },
  {
    key: "com.apple.developer.game-center",
    title: "Game Center",
    kind: "capability",
    platforms: both,
    description: "Game Center.",
    requiresProfile: true,
    ascCapability: "GAME_CENTER",
  },
  {
    key: "com.apple.developer.siri",
    title: "SiriKit",
    kind: "capability",
    platforms: ios,
    description: "SiriKit intents.",
    requiresProfile: true,
    ascCapability: "SIRIKIT",
  },
  {
    key: "com.apple.developer.networking.networkextension",
    title: "Network Extensions",
    kind: "capability",
    platforms: both,
    description:
      "VPN / content filter / DNS proxy providers. Developer ID variants use '-systemextension' suffixed values.",
    requiresProfile: true,
    ascCapability: "NETWORK_EXTENSIONS",
  },
  {
    key: "com.apple.developer.networking.vpn.api",
    title: "Personal VPN",
    kind: "capability",
    platforms: both,
    description: "NEVPNManager personal VPN.",
    requiresProfile: true,
    ascCapability: "PERSONAL_VPN",
  },
  {
    key: "com.apple.developer.networking.wifi-info",
    title: "Access Wi-Fi Information",
    kind: "capability",
    platforms: ios,
    description: "Read current Wi-Fi SSID/BSSID.",
    requiresProfile: true,
    ascCapability: "ACCESS_WIFI_INFORMATION",
  },
  {
    key: "com.apple.developer.nfc.readersession.formats",
    title: "NFC Tag Reading",
    kind: "capability",
    platforms: ios,
    description: "Core NFC (plus NFCReaderUsageDescription).",
    requiresProfile: true,
    ascCapability: "NFC_TAG_READING",
    usageDescriptionKey: "NFCReaderUsageDescription",
  },
  {
    key: "com.apple.developer.default-data-protection",
    title: "Data Protection",
    kind: "capability",
    platforms: ios,
    description: "Default file protection class.",
    requiresProfile: true,
    ascCapability: "DATA_PROTECTION",
  },
  {
    key: "com.apple.developer.system-extension.install",
    title: "System Extension install",
    kind: "capability",
    platforms: mac,
    description: "Install DriverKit / Network / Endpoint Security system extensions.",
    requiresProfile: true,
    ascCapability: "SYSTEM_EXTENSION_INSTALL",
  },
  {
    key: "com.apple.developer.endpoint-security.client",
    title: "Endpoint Security client",
    kind: "managed",
    platforms: mac,
    description:
      "Endpoint Security framework. Apple must approve the request for this managed capability first.",
    requiresProfile: true,
  },
  {
    key: "com.apple.developer.driverkit",
    title: "DriverKit",
    kind: "managed",
    platforms: mac,
    description: "DriverKit drivers (managed capability; request from Apple).",
    requiresProfile: true,
  },
];

export function entitlementInfo(key: string): EntitlementInfo | undefined {
  return ENTITLEMENTS.find((e) => e.key === key);
}

export const RISKY_HARDENED_RUNTIME_EXCEPTIONS = [
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-executable-page-protection",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-dyld-environment-variables",
];

/** Keys that are added by provisioning and fine to differ from the source .entitlements file. */
export const PROFILE_INJECTED_KEYS = new Set([
  "com.apple.application-identifier",
  "application-identifier",
  "com.apple.developer.team-identifier",
  "keychain-access-groups",
  "get-task-allow",
  "com.apple.security.get-task-allow",
  "beta-reports-active",
  "aps-environment",
  "com.apple.developer.aps-environment",
]);

export type EntitlementsDict = Record<string, unknown>;

export interface EntitlementPreset {
  id: string;
  title: string;
  description: string;
  entitlements: EntitlementsDict;
  notes: string[];
}

export const ENTITLEMENT_PRESETS: EntitlementPreset[] = [
  {
    id: "developer-id-minimal",
    title: "Developer ID — minimal (hardened runtime, no exceptions)",
    description: "Most native Swift/ObjC apps need no entitlements for Developer ID distribution.",
    entitlements: {},
    notes: [
      "An empty entitlements dict is valid; hardened runtime is enabled by the --options runtime flag, not by an entitlement.",
    ],
  },
  {
    id: "electron",
    title: "Electron — Developer ID (main app + helpers)",
    description: "V8 needs JIT. Apply to the app and every Helper (Renderer/GPU/Plugin).",
    entitlements: {
      "com.apple.security.cs.allow-jit": true,
    },
    notes: [
      "Electron < 12 may also need com.apple.security.cs.allow-unsigned-executable-memory.",
      "Add com.apple.security.cs.disable-library-validation only if you load native modules signed by another team.",
      "Add com.apple.security.device.audio-input / camera (+ usage strings) if the app uses getUserMedia.",
    ],
  },
  {
    id: "electron-mas",
    title: "Electron — Mac App Store (parent app)",
    description: "Sandboxed Electron main app for the Mac App Store.",
    entitlements: {
      "com.apple.security.app-sandbox": true,
      "com.apple.security.network.client": true,
      "com.apple.security.files.user-selected.read-write": true,
      "com.apple.security.application-groups": ["$(TeamIdentifierPrefix)$(CFBundleIdentifier)"],
      "com.apple.security.cs.allow-jit": true,
    },
    notes: [
      "Replace the application group with '<TEAMID>.<bundle-id>' literally if your tool does not expand variables.",
      "Helpers use the electron-mas-inherit preset.",
    ],
  },
  {
    id: "electron-mas-inherit",
    title: "Electron — Mac App Store (helpers / child processes)",
    description: "Child processes inherit the parent sandbox.",
    entitlements: {
      "com.apple.security.app-sandbox": true,
      "com.apple.security.inherit": true,
    },
    notes: ["Do not add other keys alongside com.apple.security.inherit."],
  },
  {
    id: "tauri",
    title: "Tauri — Developer ID",
    description: "Tauri (WKWebView) apps generally need no hardened-runtime exceptions.",
    entitlements: {},
    notes: ["Add network.client/server and app-sandbox only for Mac App Store builds."],
  },
  {
    id: "sandbox-basic",
    title: "Sandboxed app — basic (Mac App Store)",
    description: "Typical sandbox baseline for a document/network app.",
    entitlements: {
      "com.apple.security.app-sandbox": true,
      "com.apple.security.network.client": true,
      "com.apple.security.files.user-selected.read-write": true,
    },
    notes: ["Add device/personal-information keys only for features you actually use (App Review checks)."],
  },
];

/** Capability shorthands accepted by `entitlements generate`. */
export const CAPABILITY_SHORTHANDS: Record<string, EntitlementsDict> = {
  sandbox: { "com.apple.security.app-sandbox": true },
  "network-client": { "com.apple.security.network.client": true },
  "network-server": { "com.apple.security.network.server": true },
  "files-user-selected-read": { "com.apple.security.files.user-selected.read-only": true },
  "files-user-selected-write": { "com.apple.security.files.user-selected.read-write": true },
  downloads: { "com.apple.security.files.downloads.read-write": true },
  camera: { "com.apple.security.device.camera": true },
  microphone: { "com.apple.security.device.audio-input": true },
  usb: { "com.apple.security.device.usb": true },
  bluetooth: { "com.apple.security.device.bluetooth": true },
  location: { "com.apple.security.personal-information.location": true },
  contacts: { "com.apple.security.personal-information.addressbook": true },
  calendars: { "com.apple.security.personal-information.calendars": true },
  photos: { "com.apple.security.personal-information.photos-library": true },
  "apple-events": { "com.apple.security.automation.apple-events": true },
  print: { "com.apple.security.print": true },
  jit: { "com.apple.security.cs.allow-jit": true },
  "unsigned-executable-memory": { "com.apple.security.cs.allow-unsigned-executable-memory": true },
  "disable-library-validation": { "com.apple.security.cs.disable-library-validation": true },
  "dyld-env": { "com.apple.security.cs.allow-dyld-environment-variables": true },
};
