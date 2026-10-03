/**
 * Privacy (TCC) knowledge: Info.plist usage descriptions ↔ frameworks ↔ TCC
 * services ↔ macOS entitlements, plus iOS privacy-manifest required-reason APIs.
 */

export interface PrivacyResource {
  id: string;
  title: string;
  /** Info.plist keys; any one satisfies the requirement unless `allRequired`. */
  usageKeys: string[];
  platforms: ("macOS" | "iOS")[];
  /** Linked frameworks that suggest this resource may be used. */
  frameworks: string[];
  /** Service name for `tccutil reset <Service>`. */
  tccService?: string;
  /** macOS entitlement needed under hardened runtime/sandbox. */
  macEntitlement?: string;
  notes?: string;
}

export const PRIVACY_RESOURCES: PrivacyResource[] = [
  {
    id: "camera",
    title: "Camera",
    usageKeys: ["NSCameraUsageDescription"],
    platforms: ["macOS", "iOS"],
    frameworks: ["AVFoundation", "AVKit", "VisionKit"],
    tccService: "Camera",
    macEntitlement: "com.apple.security.device.camera",
  },
  {
    id: "microphone",
    title: "Microphone",
    usageKeys: ["NSMicrophoneUsageDescription"],
    platforms: ["macOS", "iOS"],
    frameworks: ["AVFoundation", "AVFAudio", "Speech"],
    tccService: "Microphone",
    macEntitlement: "com.apple.security.device.audio-input",
  },
  {
    id: "location",
    title: "Location",
    usageKeys: [
      "NSLocationWhenInUseUsageDescription",
      "NSLocationAlwaysAndWhenInUseUsageDescription",
      "NSLocationUsageDescription",
    ],
    platforms: ["macOS", "iOS"],
    frameworks: ["CoreLocation", "MapKit"],
    macEntitlement: "com.apple.security.personal-information.location",
    notes: "MapKit alone does not require location permission; only CLLocationManager usage does.",
  },
  {
    id: "contacts",
    title: "Contacts",
    usageKeys: ["NSContactsUsageDescription"],
    platforms: ["macOS", "iOS"],
    frameworks: ["Contacts", "ContactsUI", "AddressBook"],
    tccService: "AddressBook",
    macEntitlement: "com.apple.security.personal-information.addressbook",
  },
  {
    id: "calendars",
    title: "Calendars",
    usageKeys: [
      "NSCalendarsFullAccessUsageDescription",
      "NSCalendarsWriteOnlyAccessUsageDescription",
      "NSCalendarsUsageDescription",
    ],
    platforms: ["macOS", "iOS"],
    frameworks: ["EventKit", "EventKitUI"],
    tccService: "Calendar",
    macEntitlement: "com.apple.security.personal-information.calendars",
  },
  {
    id: "reminders",
    title: "Reminders",
    usageKeys: ["NSRemindersFullAccessUsageDescription", "NSRemindersUsageDescription"],
    platforms: ["macOS", "iOS"],
    frameworks: ["EventKit"],
    tccService: "Reminders",
    macEntitlement: "com.apple.security.personal-information.calendars",
  },
  {
    id: "photos",
    title: "Photos",
    usageKeys: ["NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription"],
    platforms: ["macOS", "iOS"],
    frameworks: ["Photos", "PhotosUI"],
    tccService: "Photos",
    macEntitlement: "com.apple.security.personal-information.photos-library",
    notes: "PHPickerViewController (PhotosUI) does not need permission; direct PHPhotoLibrary access does.",
  },
  {
    id: "bluetooth",
    title: "Bluetooth",
    usageKeys: ["NSBluetoothAlwaysUsageDescription"],
    platforms: ["macOS", "iOS"],
    frameworks: ["CoreBluetooth"],
    tccService: "BluetoothAlways",
    macEntitlement: "com.apple.security.device.bluetooth",
  },
  {
    id: "speech",
    title: "Speech recognition",
    usageKeys: ["NSSpeechRecognitionUsageDescription"],
    platforms: ["macOS", "iOS"],
    frameworks: ["Speech"],
    tccService: "SpeechRecognition",
  },
  {
    id: "motion",
    title: "Motion & fitness",
    usageKeys: ["NSMotionUsageDescription"],
    platforms: ["iOS"],
    frameworks: ["CoreMotion"],
    tccService: "Motion",
  },
  {
    id: "health",
    title: "Health",
    usageKeys: ["NSHealthShareUsageDescription", "NSHealthUpdateUsageDescription"],
    platforms: ["iOS"],
    frameworks: ["HealthKit"],
  },
  {
    id: "homekit",
    title: "HomeKit",
    usageKeys: ["NSHomeKitUsageDescription"],
    platforms: ["iOS"],
    frameworks: ["HomeKit"],
    tccService: "Willow",
  },
  {
    id: "faceid",
    title: "Face ID",
    usageKeys: ["NSFaceIDUsageDescription"],
    platforms: ["iOS"],
    frameworks: ["LocalAuthentication"],
  },
  {
    id: "tracking",
    title: "App Tracking Transparency",
    usageKeys: ["NSUserTrackingUsageDescription"],
    platforms: ["iOS", "macOS"],
    frameworks: ["AppTrackingTransparency", "AdSupport"],
  },
  {
    id: "local-network",
    title: "Local network",
    usageKeys: ["NSLocalNetworkUsageDescription"],
    platforms: ["iOS", "macOS"],
    frameworks: ["Network", "MultipeerConnectivity"],
    notes:
      "Also declare NSBonjourServices for Bonjour browsing. macOS 15+ prompts for local network access too.",
  },
  {
    id: "apple-events",
    title: "Automation (Apple Events)",
    usageKeys: ["NSAppleEventsUsageDescription"],
    platforms: ["macOS"],
    frameworks: ["ScriptingBridge", "OSAKit"],
    tccService: "AppleEvents",
    macEntitlement: "com.apple.security.automation.apple-events",
  },
  {
    id: "nfc",
    title: "NFC",
    usageKeys: ["NFCReaderUsageDescription"],
    platforms: ["iOS"],
    frameworks: ["CoreNFC"],
  },
  {
    id: "media-library",
    title: "Media library",
    usageKeys: ["NSAppleMusicUsageDescription"],
    platforms: ["iOS"],
    frameworks: ["MediaPlayer", "MusicKit"],
    tccService: "MediaLibrary",
  },
  {
    id: "screen-capture",
    title: "Screen recording",
    usageKeys: [],
    platforms: ["macOS"],
    frameworks: ["ScreenCaptureKit"],
    tccService: "ScreenCapture",
    notes:
      "No Info.plist key: the user must enable the app in System Settings → Privacy & Security → Screen & System Audio Recording.",
  },
  {
    id: "accessibility",
    title: "Accessibility",
    usageKeys: [],
    platforms: ["macOS"],
    frameworks: [],
    tccService: "Accessibility",
    notes:
      "No Info.plist key; AXIsProcessTrustedWithOptions prompts and the user enables it in System Settings. Not allowed for sandboxed Mac App Store apps.",
  },
  {
    id: "files-desktop",
    title: "Desktop / Documents / Downloads folders",
    usageKeys: [
      "NSDesktopFolderUsageDescription",
      "NSDocumentsFolderUsageDescription",
      "NSDownloadsFolderUsageDescription",
    ],
    platforms: ["macOS"],
    frameworks: [],
    tccService: "SystemPolicyDesktopFolder",
    notes:
      "Non-sandboxed apps reading these folders trigger a TCC prompt on first access; provide the usage strings.",
  },
  {
    id: "removable-volumes",
    title: "Removable / network volumes",
    usageKeys: ["NSRemovableVolumesUsageDescription", "NSNetworkVolumesUsageDescription"],
    platforms: ["macOS"],
    frameworks: [],
    tccService: "SystemPolicyRemovableVolumes",
  },
];

export const TCC_SERVICES = [
  "All",
  "Accessibility",
  "AddressBook",
  "AppleEvents",
  "BluetoothAlways",
  "Calendar",
  "Camera",
  "ListenEvent",
  "MediaLibrary",
  "Microphone",
  "Motion",
  "Photos",
  "PostEvent",
  "Reminders",
  "ScreenCapture",
  "SpeechRecognition",
  "SystemPolicyAllFiles",
  "SystemPolicyDesktopFolder",
  "SystemPolicyDocumentsFolder",
  "SystemPolicyDownloadsFolder",
  "SystemPolicyNetworkVolumes",
  "SystemPolicyRemovableVolumes",
  "Willow",
] as const;

/** iOS/iPadOS/tvOS/visionOS/watchOS privacy manifest required-reason API categories. */
export interface RequiredReasonCategory {
  category: string;
  title: string;
  /** Byte markers searched in the binary (symbol / selector / class names). */
  markers: string[];
  commonReasons: { code: string; meaning: string }[];
}

export const REQUIRED_REASON_APIS: RequiredReasonCategory[] = [
  {
    category: "NSPrivacyAccessedAPICategoryUserDefaults",
    title: "User defaults",
    markers: ["NSUserDefaults"],
    commonReasons: [
      { code: "CA92.1", meaning: "Access info from the same app that wrote it" },
      { code: "1C8F.1", meaning: "Shared via App Group with apps/extensions of the same developer" },
    ],
  },
  {
    category: "NSPrivacyAccessedAPICategoryFileTimestamp",
    title: "File timestamp APIs",
    markers: [
      "\u0000_stat\u0000",
      "\u0000_fstat\u0000",
      "\u0000_lstat\u0000",
      "\u0000_fstatat\u0000",
      "\u0000_getattrlist\u0000",
      "\u0000_getattrlistbulk\u0000",
      "NSFileModificationDate",
      "NSFileCreationDate",
      "contentModificationDate",
      "creationDate",
    ],
    commonReasons: [
      { code: "C617.1", meaning: "Timestamps of files inside the app container / app group" },
      { code: "3B52.1", meaning: "Timestamps of files the user granted access to" },
      { code: "DDA9.1", meaning: "Display timestamps to the user" },
    ],
  },
  {
    category: "NSPrivacyAccessedAPICategorySystemBootTime",
    title: "System boot time",
    markers: ["systemUptime", "\u0000_mach_absolute_time\u0000"],
    commonReasons: [{ code: "35F9.1", meaning: "Measure elapsed time between in-app events" }],
  },
  {
    category: "NSPrivacyAccessedAPICategoryDiskSpace",
    title: "Disk space",
    markers: [
      "\u0000_statfs\u0000",
      "\u0000_statvfs\u0000",
      "\u0000_fstatfs\u0000",
      "\u0000_fstatvfs\u0000",
      "NSFileSystemFreeSize",
      "NSFileSystemSize",
      "volumeAvailableCapacity",
    ],
    commonReasons: [
      { code: "E174.1", meaning: "Check there is enough space before writing files" },
      { code: "85F4.1", meaning: "Display disk space to the user" },
    ],
  },
  {
    category: "NSPrivacyAccessedAPICategoryActiveKeyboards",
    title: "Active keyboards",
    markers: ["activeInputModes"],
    commonReasons: [{ code: "3EC4.1", meaning: "Custom keyboard app determining active keyboards" }],
  },
];
