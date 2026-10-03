export interface LinkedLibrary {
  path: string;
  compatibilityVersion?: string;
  currentVersion?: string;
  weak?: boolean;
}

/** Parse `otool -L <binary>`. For fat binaries the first architecture's list is used. */
export function parseOtoolL(text: string): LinkedLibrary[] {
  const libs: LinkedLibrary[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!/^\s/.test(line)) continue;
    const m = /^\s+(.+?) \(compatibility version ([^,]+), current version ([^,)]+)(, weak)?\)/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    libs.push({ path: m[1], compatibilityVersion: m[2], currentVersion: m[3], weak: !!m[4] });
  }
  return libs;
}

export interface BuildVersion {
  platform: string;
  minos?: string;
  sdk?: string;
}

export interface LoadCommandInfo {
  buildVersions: BuildVersion[];
  rpaths: string[];
  /** LC_ID_DYLIB install name (dylibs/frameworks). */
  installName?: string;
  hasCodeSignature: boolean;
  encrypted: boolean;
}

const PLATFORMS: Record<string, string> = {
  "1": "macOS",
  "2": "iOS",
  "3": "tvOS",
  "4": "watchOS",
  "5": "bridgeOS",
  "6": "macCatalyst",
  "7": "iOS-simulator",
  "8": "tvOS-simulator",
  "9": "watchOS-simulator",
  "10": "DriverKit",
  "11": "visionOS",
  "12": "visionOS-simulator",
  MACOS: "macOS",
  IOS: "iOS",
  TVOS: "tvOS",
  WATCHOS: "watchOS",
  MACCATALYST: "macCatalyst",
  IOSSIMULATOR: "iOS-simulator",
  XROS: "visionOS",
};

/** Parse `otool -l <binary>` for build versions, rpaths, install name. */
export function parseOtoolLoadCommands(text: string): LoadCommandInfo {
  const info: LoadCommandInfo = { buildVersions: [], rpaths: [], hasCodeSignature: false, encrypted: false };
  const blocks = text.split(/^Load command \d+$/m);
  for (const block of blocks) {
    const cmd = /^\s*cmd (\S+)/m.exec(block)?.[1];
    if (!cmd) continue;
    switch (cmd) {
      case "LC_BUILD_VERSION": {
        const platform = /^\s*platform (\S+)/m.exec(block)?.[1] ?? "?";
        info.buildVersions.push({
          platform: PLATFORMS[platform] ?? platform,
          minos: /^\s*minos (\S+)/m.exec(block)?.[1],
          sdk: /^\s*sdk (\S+)/m.exec(block)?.[1],
        });
        break;
      }
      case "LC_VERSION_MIN_MACOSX":
      case "LC_VERSION_MIN_IPHONEOS":
      case "LC_VERSION_MIN_TVOS":
      case "LC_VERSION_MIN_WATCHOS":
        info.buildVersions.push({
          platform: cmd.includes("MACOSX") ? "macOS" : cmd.includes("IPHONEOS") ? "iOS" : cmd.slice(15),
          minos: /^\s*version (\S+)/m.exec(block)?.[1],
          sdk: /^\s*sdk (\S+)/m.exec(block)?.[1],
        });
        break;
      case "LC_RPATH": {
        const p = /^\s*path (.+?) \(offset \d+\)/m.exec(block)?.[1];
        if (p && !info.rpaths.includes(p)) info.rpaths.push(p);
        break;
      }
      case "LC_ID_DYLIB":
        info.installName = /^\s*name (.+?) \(offset \d+\)/m.exec(block)?.[1];
        break;
      case "LC_CODE_SIGNATURE":
        info.hasCodeSignature = true;
        break;
      case "LC_ENCRYPTION_INFO":
      case "LC_ENCRYPTION_INFO_64":
        if (/^\s*cryptid 1/m.test(block)) info.encrypted = true;
        break;
    }
  }
  return info;
}

/** Parse `lipo -archs`. */
export function parseLipoArchs(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}
