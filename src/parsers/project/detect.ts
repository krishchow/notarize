import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { type PlistDict, parsePlistDict } from "../../core/plist";
import type { TargetId } from "../../knowledge/targets";

export type ProjectKind =
  | "xcode-workspace"
  | "xcode-project"
  | "swiftpm"
  | "electron"
  | "tauri"
  | "flutter"
  | "react-native"
  | "expo"
  | "app-bundle"
  | "xcarchive"
  | "ipa"
  | "dmg"
  | "pkg"
  | "zip"
  | "binary";

export type Platform = "macOS" | "iOS";

export interface ConfigSnippet {
  file: string;
  description: string;
  snippet: string;
}

export interface DetectedComponent {
  kind: ProjectKind;
  path: string;
  name?: string;
  platforms: Platform[];
  bundleIds: string[];
  teamIds: string[];
  /** Signing-related settings found in the project/config files. */
  signing: Record<string, unknown>;
  findings: string[];
  suggestedTargets: TargetId[];
  configSnippets: ConfigSnippet[];
  envVars: { name: string; description: string }[];
  buildCommands: string[];
}

export interface ProjectReport {
  root: string;
  components: DetectedComponent[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  "Pods",
  ".git",
  "build",
  "Build",
  "DerivedData",
  ".build",
  "dist",
  "out",
  "target",
  ".dart_tool",
  ".expo",
  "vendor",
]);

function component(
  kind: ProjectKind,
  path: string,
  extra: Partial<DetectedComponent> = {},
): DetectedComponent {
  return {
    kind,
    path,
    platforms: [],
    bundleIds: [],
    teamIds: [],
    signing: {},
    findings: [],
    suggestedTargets: [],
    configSnippets: [],
    envVars: [],
    buildCommands: [],
    ...extra,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return undefined;
  }
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs.filter((x) => x !== undefined && x !== null && x !== ""))];
}

// ---------------------------------------------------------------- Xcode

export interface PbxprojSummary {
  bundleIds: string[];
  teamIds: string[];
  codeSignStyles: string[];
  codeSignIdentities: string[];
  sdkRoots: string[];
  hardenedRuntime: string[];
  entitlementsFiles: string[];
  profileSpecifiers: string[];
  productTypes: string[];
  marketingVersions: string[];
  buildNumbers: string[];
  deploymentTargets: { macOS: string[]; iOS: string[] };
}

/** Regex-level summary of a project.pbxproj (good enough for detection). */
export function summarizePbxproj(text: string): PbxprojSummary {
  const all = (key: string) =>
    uniq([...text.matchAll(new RegExp(`\\b${key} = ("([^"]*)"|([^;\\s]+));`, "g"))].map((m) => m[2] ?? m[3]));
  return {
    bundleIds: all("PRODUCT_BUNDLE_IDENTIFIER"),
    teamIds: all("DEVELOPMENT_TEAM"),
    codeSignStyles: all("CODE_SIGN_STYLE"),
    codeSignIdentities: uniq([...all("CODE_SIGN_IDENTITY"), ...all('"CODE_SIGN_IDENTITY\\[sdk=[^\\]]+\\]"')]),
    sdkRoots: all("SDKROOT"),
    hardenedRuntime: all("ENABLE_HARDENED_RUNTIME"),
    entitlementsFiles: all("CODE_SIGN_ENTITLEMENTS"),
    profileSpecifiers: all("PROVISIONING_PROFILE_SPECIFIER"),
    productTypes: uniq([...text.matchAll(/productType = "([^"]+)";/g)].map((m) => m[1])),
    marketingVersions: all("MARKETING_VERSION"),
    buildNumbers: all("CURRENT_PROJECT_VERSION"),
    deploymentTargets: {
      macOS: all("MACOSX_DEPLOYMENT_TARGET"),
      iOS: all("IPHONEOS_DEPLOYMENT_TARGET"),
    },
  };
}

function platformsFromPbx(s: PbxprojSummary): Platform[] {
  const p: Platform[] = [];
  if (s.sdkRoots.includes("macosx") || s.deploymentTargets.macOS.length) p.push("macOS");
  if (s.sdkRoots.includes("iphoneos") || s.deploymentTargets.iOS.length) p.push("iOS");
  return p;
}

function targetsFor(platforms: Platform[]): TargetId[] {
  const t: TargetId[] = [];
  if (platforms.includes("macOS")) t.push("mac-developer-id", "mac-app-store", "testflight-mac");
  if (platforms.includes("iOS")) t.push("testflight-ios", "ios-app-store", "ios-ad-hoc");
  return t;
}

async function detectXcode(
  dir: string,
  path: string,
  kind: "xcode-project" | "xcode-workspace",
): Promise<DetectedComponent> {
  const name = basename(path).replace(/\.(xcodeproj|xcworkspace)$/, "");
  const c = component(kind, path, { name });
  let pbxPaths: string[] = [];
  if (kind === "xcode-project") {
    pbxPaths = [join(path, "project.pbxproj")];
  } else {
    const contents = await readText(join(path, "contents.xcworkspacedata"));
    const refs = [...(contents ?? "").matchAll(/location = "group:([^"]+\.xcodeproj)"/g)].map((m) => m[1]);
    pbxPaths = refs.filter((r) => !r.startsWith("Pods/")).map((r) => join(dir, r, "project.pbxproj"));
    c.signing.projects = refs;
    if (refs.some((r) => r.startsWith("Pods/")))
      c.findings.push("CocoaPods workspace: always build the .xcworkspace, not the .xcodeproj.");
  }
  const summaries: PbxprojSummary[] = [];
  for (const p of pbxPaths) {
    const text = await readText(p);
    if (text) summaries.push(summarizePbxproj(text));
  }
  const merged = summaries.reduce<PbxprojSummary | undefined>((acc, s) => {
    if (!acc) return s;
    for (const k of Object.keys(s) as (keyof PbxprojSummary)[]) {
      if (k === "deploymentTargets") {
        acc.deploymentTargets.macOS = uniq([...acc.deploymentTargets.macOS, ...s.deploymentTargets.macOS]);
        acc.deploymentTargets.iOS = uniq([...acc.deploymentTargets.iOS, ...s.deploymentTargets.iOS]);
      } else {
        (acc[k] as string[]) = uniq([...(acc[k] as string[]), ...(s[k] as string[])]);
      }
    }
    return acc;
  }, undefined);
  if (merged) {
    c.bundleIds = merged.bundleIds;
    c.teamIds = merged.teamIds;
    c.platforms = platformsFromPbx(merged);
    c.signing = {
      ...c.signing,
      codeSignStyle: merged.codeSignStyles,
      codeSignIdentity: merged.codeSignIdentities,
      hardenedRuntime: merged.hardenedRuntime,
      entitlementsFiles: merged.entitlementsFiles,
      provisioningProfileSpecifiers: merged.profileSpecifiers,
      productTypes: merged.productTypes,
      marketingVersion: merged.marketingVersions,
      buildNumber: merged.buildNumbers,
    };
    if (!merged.teamIds.length)
      c.findings.push(
        "DEVELOPMENT_TEAM is not set — pass team_id when archiving or set it in Signing & Capabilities.",
      );
    if (c.platforms.includes("macOS") && !merged.hardenedRuntime.includes("YES"))
      c.findings.push(
        "ENABLE_HARDENED_RUNTIME is not YES for macOS targets — required for notarization (Developer ID).",
      );
    if (merged.codeSignStyles.includes("Manual"))
      c.findings.push(
        "Manual signing is configured — profiles/certificates must be installed explicitly (or switch to Automatic + API key).",
      );
  }
  c.suggestedTargets = targetsFor(c.platforms);
  const flag = kind === "xcode-workspace" ? "-workspace" : "-project";
  c.buildCommands = [
    `xcodebuild -list -json ${flag} ${relative(dir, path) || basename(path)}`,
    "Use the `xcode` tool: action=archive (automatic signing with -allowProvisioningUpdates + API key), then action=export",
  ];
  return c;
}

// ---------------------------------------------------------------- SwiftPM

async function detectSwiftPM(dir: string): Promise<DetectedComponent | undefined> {
  const pkg = await readText(join(dir, "Package.swift"));
  if (!pkg) return undefined;
  const name = /name:\s*"([^"]+)"/.exec(pkg)?.[1];
  const execs = [...pkg.matchAll(/\.executableTarget\(\s*name:\s*"([^"]+)"/g)].map((m) => m[1]);
  const platforms: Platform[] = [];
  if (/\.macOS\(/.test(pkg)) platforms.push("macOS");
  if (/\.iOS\(/.test(pkg)) platforms.push("iOS");
  const c = component("swiftpm", join(dir, "Package.swift"), {
    name,
    platforms: platforms.length ? platforms : ["macOS"],
    signing: { executableTargets: execs },
    suggestedTargets: ["mac-developer-id"],
  });
  c.findings.push(
    execs.length
      ? "Command-line executables can be Developer ID signed (hardened runtime + timestamp) and notarized inside a .zip or .pkg. Bare binaries cannot be stapled; Gatekeeper checks the ticket online."
      : "Library package: nothing to sign on its own.",
  );
  c.buildCommands = [
    "swift build -c release --arch arm64 --arch x86_64",
    "sign (identity Developer ID Application, hardened runtime) → package zip or pkg → notarize",
  ];
  return c;
}

// ---------------------------------------------------------------- Electron

function electronSnippets(appId: string): {
  snippets: ConfigSnippet[];
  env: { name: string; description: string }[];
} {
  return {
    snippets: [
      {
        file: 'package.json ("build" key) or electron-builder.yml',
        description: "electron-builder: hardened runtime, entitlements, notarization",
        snippet: JSON.stringify(
          {
            build: {
              appId,
              mac: {
                hardenedRuntime: true,
                gatekeeperAssess: false,
                entitlements: "build/entitlements.mac.plist",
                entitlementsInherit: "build/entitlements.mac.plist",
                notarize: true,
                target: ["dmg", "zip"],
              },
            },
          },
          null,
          2,
        ),
      },
      {
        file: "forge.config.js (Electron Forge alternative)",
        description: "Forge: osxSign + osxNotarize with an App Store Connect API key",
        snippet: `packagerConfig: {\n  osxSign: {},\n  osxNotarize: {\n    appleApiKey: process.env.APPLE_API_KEY,        // path to AuthKey_XXXX.p8\n    appleApiKeyId: process.env.APPLE_API_KEY_ID,\n    appleApiIssuer: process.env.APPLE_API_ISSUER,\n  },\n}`,
      },
      {
        file: "build/entitlements.mac.plist",
        description: "Electron needs JIT under the hardened runtime (entitlements generate preset=electron)",
        snippet:
          '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>com.apple.security.cs.allow-jit</key>\n\t<true/>\n</dict>\n</plist>',
      },
    ],
    env: [
      {
        name: "CSC_NAME",
        description:
          "Signing identity name (or let electron-builder pick 'Developer ID Application' from the keychain)",
      },
      {
        name: "CSC_LINK / CSC_KEY_PASSWORD",
        description: "CI only: base64/path of the Developer ID .p12 and its password",
      },
      { name: "APPLE_API_KEY", description: "electron-builder/@electron/notarize: PATH to AuthKey_<ID>.p8" },
      { name: "APPLE_API_KEY_ID", description: "API key ID" },
      { name: "APPLE_API_ISSUER", description: "API key issuer ID" },
    ],
  };
}

async function detectElectron(dir: string, pkg: any): Promise<DetectedComponent> {
  const builderFiles = [
    "electron-builder.yml",
    "electron-builder.yaml",
    "electron-builder.json",
    "electron-builder.json5",
    "electron-builder.config.js",
  ];
  const builderFile = (
    await Promise.all(builderFiles.map(async (f) => ((await exists(join(dir, f))) ? f : undefined)))
  ).find(Boolean);
  const forgeFile = (await exists(join(dir, "forge.config.js")))
    ? "forge.config.js"
    : (await exists(join(dir, "forge.config.ts")))
      ? "forge.config.ts"
      : undefined;
  const build = pkg.build ?? {};
  const builderText = builderFile ? await readText(join(dir, builderFile)) : undefined;
  const appId: string | undefined =
    build.appId ?? (builderText ? /appId:\s*["']?([\w.-]+)/.exec(builderText)?.[1] : undefined);
  const mac = build.mac ?? {};
  const c = component("electron", join(dir, "package.json"), {
    name: pkg.productName ?? pkg.name,
    platforms: ["macOS"],
    bundleIds: appId ? [appId] : [],
    signing: {
      electronVersion: pkg.devDependencies?.electron ?? pkg.dependencies?.electron,
      packager: forgeFile || pkg.config?.forge ? "electron-forge" : "electron-builder",
      builderConfigFile: builderFile ?? (pkg.build ? "package.json#build" : undefined),
      forgeConfigFile: forgeFile,
      mac: Object.keys(mac).length ? mac : undefined,
      mas: build.mas,
      afterSign: build.afterSign,
    },
    suggestedTargets: ["mac-developer-id", "mac-app-store"],
  });
  if (!appId) c.findings.push("No appId found — set build.appId to a reverse-DNS bundle identifier.");
  if (builderText && /hardenedRuntime:\s*false/.test(builderText))
    c.findings.push("hardenedRuntime is false — notarization will fail.");
  if (mac.hardenedRuntime === false)
    c.findings.push("mac.hardenedRuntime is false — notarization will fail.");
  if (build.afterSign)
    c.findings.push(
      `Custom afterSign hook (${build.afterSign}) — modern electron-builder notarizes natively via mac.notarize; check for double notarization.`,
    );
  const { snippets, env } = electronSnippets(appId ?? "com.example.app");
  c.configSnippets = snippets;
  c.envVars = env;
  c.buildCommands =
    forgeFile || pkg.config?.forge
      ? ["npx electron-forge make --platform darwin"]
      : ["npx electron-builder --mac"];
  c.findings.push(
    "After building, verify with inspect_code_signature and gatekeeper simulate_download on the produced .dmg.",
  );
  return c;
}

// ---------------------------------------------------------------- Tauri

async function detectTauri(dir: string): Promise<DetectedComponent | undefined> {
  const confPath = ["src-tauri/tauri.conf.json", "tauri.conf.json"].map((p) => join(dir, p));
  let file: string | undefined;
  let conf: any;
  for (const p of confPath) {
    conf = await readJson(p);
    if (conf) {
      file = p;
      break;
    }
  }
  if (!conf || !file) {
    if (await exists(join(dir, "src-tauri", "Tauri.toml")))
      return component("tauri", join(dir, "src-tauri", "Tauri.toml"), {
        platforms: ["macOS"],
        findings: ["Tauri.toml config detected; signing keys live under [bundle.macOS]."],
        suggestedTargets: ["mac-developer-id"],
      });
    return undefined;
  }
  const v2 = conf.identifier !== undefined || conf.bundle !== undefined;
  const bundle = v2 ? (conf.bundle ?? {}) : (conf.tauri?.bundle ?? {});
  const identifier: string | undefined = v2 ? conf.identifier : bundle.identifier;
  const macOS = bundle.macOS ?? {};
  const iOS = bundle.iOS ?? {};
  const platforms: Platform[] = ["macOS"];
  if (await exists(join(dir, "src-tauri", "gen", "apple"))) platforms.push("iOS");
  const c = component("tauri", file, {
    name: conf.productName ?? conf.package?.productName,
    platforms,
    bundleIds: identifier ? [identifier] : [],
    teamIds: iOS.developmentTeam ? [iOS.developmentTeam] : [],
    signing: { tauriMajor: v2 ? 2 : 1, macOS, iOS: Object.keys(iOS).length ? iOS : undefined },
    suggestedTargets: platforms.includes("iOS")
      ? ["mac-developer-id", "testflight-ios", "ios-app-store"]
      : ["mac-developer-id", "mac-app-store"],
  });
  if (macOS.hardenedRuntime === false)
    c.findings.push("bundle.macOS.hardenedRuntime is false — notarization will fail.");
  if (!macOS.signingIdentity)
    c.findings.push("bundle.macOS.signingIdentity not set — set it or export APPLE_SIGNING_IDENTITY.");
  c.configSnippets = [
    {
      file: relative(dir, file),
      description:
        "Tauri v2 macOS signing (notarization runs automatically when APPLE_API_* env vars are set)",
      snippet: JSON.stringify(
        {
          bundle: {
            macOS: {
              signingIdentity: "Developer ID Application: <Name> (<TEAMID>)",
              hardenedRuntime: true,
              entitlements: "./Entitlements.plist",
            },
          },
        },
        null,
        2,
      ),
    },
  ];
  c.envVars = [
    {
      name: "APPLE_SIGNING_IDENTITY",
      description: "Keychain identity name, e.g. 'Developer ID Application: Name (TEAMID)'",
    },
    {
      name: "APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD",
      description: "CI only: base64 .p12 + password (Tauri imports it into a temp keychain)",
    },
    { name: "APPLE_API_ISSUER", description: "App Store Connect API issuer ID (enables notarization)" },
    { name: "APPLE_API_KEY", description: "Tauri: the API key ID (NOT the path)" },
    { name: "APPLE_API_KEY_PATH", description: "Path to AuthKey_<ID>.p8" },
  ];
  c.buildCommands = [
    "npm run tauri build -- --bundles app,dmg",
    ...(platforms.includes("iOS") ? ["npm run tauri ios build -- --export-method app-store-connect"] : []),
  ];
  return c;
}

// ---------------------------------------------------------------- Flutter / RN / Expo

async function nativeIds(dir: string, sub: string): Promise<{ bundleIds: string[]; teamIds: string[] }> {
  const bundleIds: string[] = [];
  const teamIds: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await readdir(join(dir, sub), { withFileTypes: true });
  } catch {
    return { bundleIds, teamIds };
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith(".xcodeproj")) {
      const text = await readText(join(dir, sub, e.name, "project.pbxproj"));
      if (text) {
        const s = summarizePbxproj(text);
        bundleIds.push(...s.bundleIds);
        teamIds.push(...s.teamIds);
      }
    }
  }
  return { bundleIds: uniq(bundleIds), teamIds: uniq(teamIds) };
}

async function detectFlutter(dir: string): Promise<DetectedComponent | undefined> {
  const pubspec = await readText(join(dir, "pubspec.yaml"));
  if (!pubspec || !/^\s*flutter:/m.test(pubspec)) return undefined;
  const platforms: Platform[] = [];
  const ids = { bundleIds: [] as string[], teamIds: [] as string[] };
  for (const [sub, plat] of [
    ["ios", "iOS"],
    ["macos", "macOS"],
  ] as const) {
    if (await exists(join(dir, sub, "Runner.xcodeproj"))) {
      platforms.push(plat);
      const n = await nativeIds(dir, sub);
      ids.bundleIds.push(...n.bundleIds);
      ids.teamIds.push(...n.teamIds);
    }
  }
  const c = component("flutter", join(dir, "pubspec.yaml"), {
    name: /^name:\s*(\S+)/m.exec(pubspec)?.[1],
    platforms,
    bundleIds: uniq(ids.bundleIds),
    teamIds: uniq(ids.teamIds),
    signing: { version: /^version:\s*(\S+)/m.exec(pubspec)?.[1] },
    suggestedTargets: targetsFor(platforms),
  });
  c.findings.push(
    "pubspec 'version: x.y.z+N' sets CFBundleShortVersionString (x.y.z) and CFBundleVersion (N); bump N for every upload.",
  );
  if (platforms.includes("iOS"))
    c.buildCommands.push(
      "flutter build ipa --release --export-options-plist ios/ExportOptions.plist (generate it with xcode export)",
    );
  if (platforms.includes("macOS"))
    c.buildCommands.push(
      "flutter build macos --release → sign/notarize build/macos/Build/Products/Release/<App>.app, or xcode archive with macos/Runner.xcworkspace",
    );
  return c;
}

async function detectReactNativeOrExpo(dir: string, pkg: any): Promise<DetectedComponent | undefined> {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const isExpo = !!deps.expo;
  const isRN = !!deps["react-native"];
  if (!isExpo && !isRN) return undefined;
  const hasIos = await exists(join(dir, "ios"));
  const ids = hasIos ? await nativeIds(dir, "ios") : { bundleIds: [], teamIds: [] };
  if (isExpo) {
    const appJson = (await readJson(join(dir, "app.json"))) ?? {};
    const expo = appJson.expo ?? appJson;
    const eas = await readJson(join(dir, "eas.json"));
    const c = component("expo", join(dir, "package.json"), {
      name: expo.name ?? pkg.name,
      platforms: ["iOS"],
      bundleIds: uniq([expo.ios?.bundleIdentifier, ...ids.bundleIds]),
      teamIds: uniq([expo.ios?.appleTeamId, ...ids.teamIds]),
      signing: {
        workflow: hasIos ? "bare / prebuild (ios/ exists)" : "managed (no ios/ dir)",
        buildNumber: expo.ios?.buildNumber,
        version: expo.version,
        easBuildProfiles: eas?.build ? Object.keys(eas.build) : undefined,
        easSubmitIos: eas?.submit?.production?.ios,
        appConfigDynamic:
          (await exists(join(dir, "app.config.js"))) || (await exists(join(dir, "app.config.ts"))),
      },
      suggestedTargets: ["testflight-ios", "ios-app-store"],
    });
    if (!expo.ios?.bundleIdentifier && !ids.bundleIds.length)
      c.findings.push("expo.ios.bundleIdentifier is not set.");
    c.findings.push(
      hasIos
        ? "ios/ exists: you can build locally with the xcode tool (workspace ios/*.xcworkspace after `npx pod-install`) or keep using EAS."
        : "Managed workflow: EAS Build manages certificates/profiles remotely (`eas credentials`). This server can still create the API key setup, bundle ID, app record checks and TestFlight steps. Or run `npx expo prebuild -p ios` to build locally.",
    );
    c.configSnippets = [
      {
        file: "eas.json",
        description: "EAS Submit with an App Store Connect API key",
        snippet: JSON.stringify(
          {
            submit: {
              production: {
                ios: {
                  ascAppId: "<numeric App ID from asc_apps>",
                  ascApiKeyPath: "./AuthKey_<ID>.p8",
                  ascApiKeyIssuerId: "<issuer>",
                  ascApiKeyId: "<key id>",
                },
              },
            },
          },
          null,
          2,
        ),
      },
    ];
    c.buildCommands = ["eas build -p ios --profile production", "eas submit -p ios --latest"];
    return c;
  }
  const c = component("react-native", join(dir, "package.json"), {
    name: pkg.name,
    platforms: hasIos ? ["iOS"] : [],
    bundleIds: ids.bundleIds,
    teamIds: ids.teamIds,
    signing: { reactNative: deps["react-native"], macos: !!deps["react-native-macos"] },
    suggestedTargets: ["testflight-ios", "ios-app-store", "ios-ad-hoc"],
  });
  if (deps["react-native-macos"]) c.platforms.push("macOS");
  c.findings.push("Run `cd ios && pod install`, then build the ios/<Name>.xcworkspace with the xcode tool.");
  c.buildCommands = [
    "cd ios && pod install",
    "xcode action=archive workspace=ios/<Name>.xcworkspace scheme=<Name>",
  ];
  return c;
}

// ---------------------------------------------------------------- Prebuilt artifacts

export async function readBundleInfo(appPath: string): Promise<PlistDict | undefined> {
  for (const p of [join(appPath, "Contents", "Info.plist"), join(appPath, "Info.plist")]) {
    try {
      return parsePlistDict(new Uint8Array(await readFile(p)));
    } catch {
      /* next */
    }
  }
  return undefined;
}

async function detectArtifact(path: string): Promise<DetectedComponent | undefined> {
  const ext = extname(path).toLowerCase();
  if (ext === ".app") {
    const info = await readBundleInfo(path);
    const isMac = await exists(join(path, "Contents"));
    const c = component("app-bundle", path, {
      name: (info?.CFBundleName as string) ?? basename(path, ".app"),
      platforms: [isMac ? "macOS" : "iOS"],
      bundleIds: info?.CFBundleIdentifier ? [String(info.CFBundleIdentifier)] : [],
      signing: {
        version: info?.CFBundleShortVersionString,
        build: info?.CFBundleVersion,
        minimumSystemVersion: info?.LSMinimumSystemVersion ?? info?.MinimumOSVersion,
        embeddedProfile: (await exists(join(path, "Contents", "embedded.provisionprofile")))
          ? "Contents/embedded.provisionprofile"
          : (await exists(join(path, "embedded.mobileprovision")))
            ? "embedded.mobileprovision"
            : undefined,
      },
      suggestedTargets: isMac ? ["mac-developer-id"] : ["ios-ad-hoc"],
    });
    c.findings.push(
      "Prebuilt bundle: inspect_code_signature first; use sign/resign to (re)sign, then notarize_and_staple (macOS).",
    );
    return c;
  }
  if (ext === ".xcarchive") {
    let info: PlistDict | undefined;
    try {
      info = parsePlistDict(new Uint8Array(await readFile(join(path, "Info.plist"))));
    } catch {
      /* ignore */
    }
    const props = (info?.ApplicationProperties ?? {}) as PlistDict;
    const appPath = String(props.ApplicationPath ?? "");
    return component("xcarchive", path, {
      name: String(info?.Name ?? basename(path, ".xcarchive")),
      platforms:
        appPath.includes("Applications/") && (await exists(join(path, "Products", appPath, "Contents")))
          ? ["macOS"]
          : ["iOS"],
      bundleIds: props.CFBundleIdentifier ? [String(props.CFBundleIdentifier)] : [],
      teamIds: props.Team ? [String(props.Team)] : [],
      signing: {
        signingIdentity: props.SigningIdentity,
        version: props.CFBundleShortVersionString,
        build: props.CFBundleVersion,
        applicationPath: appPath,
      },
      findings: ["Export it with the xcode tool (action=export) using the right method for your target."],
      suggestedTargets: ["mac-developer-id", "testflight-ios", "ios-app-store"],
    });
  }
  const simple: Record<string, [ProjectKind, Platform[], TargetId[], string]> = {
    ".ipa": [
      "ipa",
      ["iOS"],
      ["testflight-ios", "ios-ad-hoc"],
      "Upload with upload_build, or resign for another profile.",
    ],
    ".dmg": [
      "dmg",
      ["macOS"],
      ["mac-developer-id"],
      "Check with gatekeeper assess; notarize + staple the DMG itself.",
    ],
    ".pkg": [
      "pkg",
      ["macOS"],
      ["mac-developer-id", "mac-app-store"],
      "pkgutil --check-signature via inspect_code_signature; notarize + staple, or upload for the Mac App Store.",
    ],
    ".zip": [
      "zip",
      ["macOS"],
      ["mac-developer-id"],
      "Zips can be notarized but not stapled; staple the app inside and re-zip.",
    ],
  };
  if (simple[ext]) {
    const [kind, platforms, targets, note] = simple[ext];
    return component(kind, path, {
      name: basename(path),
      platforms,
      suggestedTargets: targets,
      findings: [note],
    });
  }
  return undefined;
}

// ---------------------------------------------------------------- Entry point

/** Detect what kind of app/project lives at `root` (a directory or an artifact). */
export async function detectProject(root: string, maxDepth = 2): Promise<ProjectReport> {
  const st = await stat(root);
  const artifact = await detectArtifact(root);
  if (artifact) return { root, components: [artifact] };
  if (!st.isDirectory()) {
    return {
      root,
      components: [
        component("binary", root, {
          name: basename(root),
          platforms: ["macOS"],
          suggestedTargets: ["mac-developer-id"],
        }),
      ],
    };
  }

  const components: DetectedComponent[] = [];
  const claimed = new Set<string>();

  async function scanDir(dir: string, depth: number): Promise<void> {
    const pkg = await readJson(join(dir, "package.json"));
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.electron) components.push(await detectElectron(dir, pkg));
      const rn = await detectReactNativeOrExpo(dir, pkg);
      if (rn) {
        components.push(rn);
        claimed.add(join(dir, "ios"));
      }
    }
    const tauri = await detectTauri(dir);
    if (tauri) {
      components.push(tauri);
      claimed.add(join(dir, "src-tauri"));
    }
    const flutter = await detectFlutter(dir);
    if (flutter) {
      components.push(flutter);
      claimed.add(join(dir, "ios"));
      claimed.add(join(dir, "macos"));
    }
    const spm = await detectSwiftPM(dir);
    if (spm) components.push(spm);

    let entries: Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const workspaces = entries.filter((e) => e.isDirectory() && e.name.endsWith(".xcworkspace"));
    const projects = entries.filter((e) => e.isDirectory() && e.name.endsWith(".xcodeproj"));
    if (!claimed.has(dir)) {
      for (const w of workspaces)
        components.push(await detectXcode(dir, join(dir, w.name), "xcode-workspace"));
      // Projects referenced by a workspace in the same dir are covered by it.
      if (!workspaces.length)
        for (const p of projects) components.push(await detectXcode(dir, join(dir, p.name), "xcode-project"));
    } else if (workspaces.length || projects.length) {
      const owner = components.find((c) => ["flutter", "react-native", "expo"].includes(c.kind));
      if (owner)
        owner.signing.nativeProjects = [...workspaces, ...projects].map((e) =>
          relative(root, join(dir, e.name)),
        );
    }
    for (const e of entries) {
      if (e.isDirectory() && /\.(app|xcarchive)$/.test(e.name) && depth === 0) {
        const a = await detectArtifact(join(dir, e.name));
        if (a) components.push(a);
      }
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      if (/\.(xcodeproj|xcworkspace|app|xcarchive|framework|bundle|lproj|xcassets)$/.test(e.name)) continue;
      await scanDir(join(dir, e.name), depth + 1);
    }
  }

  await scanDir(root, 0);
  return { root, components };
}
