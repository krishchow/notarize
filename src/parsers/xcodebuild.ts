export interface XcodeList {
  kind: "project" | "workspace";
  name: string;
  schemes: string[];
  targets: string[];
  configurations: string[];
}

/** Parse `xcodebuild -list -json`. */
export function parseXcodeList(text: string): XcodeList | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let j: any;
  try {
    j = JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
  const p = j.project ?? j.workspace;
  if (!p) return undefined;
  return {
    kind: j.project ? "project" : "workspace",
    name: p.name,
    schemes: p.schemes ?? [],
    targets: p.targets ?? [],
    configurations: p.configurations ?? [],
  };
}

export const SIGNING_SETTING_KEYS = [
  "PRODUCT_NAME",
  "PRODUCT_BUNDLE_IDENTIFIER",
  "PRODUCT_TYPE",
  "WRAPPER_EXTENSION",
  "SDKROOT",
  "PLATFORM_NAME",
  "SUPPORTED_PLATFORMS",
  "MACOSX_DEPLOYMENT_TARGET",
  "IPHONEOS_DEPLOYMENT_TARGET",
  "DEVELOPMENT_TEAM",
  "CODE_SIGN_STYLE",
  "CODE_SIGN_IDENTITY",
  "CODE_SIGN_ENTITLEMENTS",
  "CODE_SIGN_INJECT_BASE_ENTITLEMENTS",
  "OTHER_CODE_SIGN_FLAGS",
  "PROVISIONING_PROFILE_SPECIFIER",
  "PROVISIONING_PROFILE",
  "ENABLE_HARDENED_RUNTIME",
  "ENABLE_APP_SANDBOX",
  "ENABLE_USER_SELECTED_FILES",
  "MARKETING_VERSION",
  "CURRENT_PROJECT_VERSION",
  "INFOPLIST_FILE",
  "GENERATE_INFOPLIST_FILE",
  "INFOPLIST_KEY_LSApplicationCategoryType",
  "INFOPLIST_KEY_NSHumanReadableCopyright",
  "SKIP_INSTALL",
  "ARCHS",
  "SWIFT_VERSION",
];

export interface TargetSigningSettings {
  target: string;
  settings: Record<string, string>;
}

/** Parse `xcodebuild -showBuildSettings -json`, keeping only signing-relevant keys. */
export function parseShowBuildSettings(text: string, keys = SIGNING_SETTING_KEYS): TargetSigningSettings[] {
  const start = text.indexOf("[");
  if (start === -1) return [];
  let arr: any[];
  try {
    arr = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  return arr.map((entry) => {
    const bs = entry.buildSettings ?? {};
    const settings: Record<string, string> = {};
    for (const k of keys) if (bs[k] !== undefined && bs[k] !== "") settings[k] = String(bs[k]);
    return { target: entry.target ?? bs.TARGET_NAME ?? "?", settings };
  });
}

export interface XcodebuildSummary {
  succeeded: boolean;
  errors: string[];
  warnings: string[];
}

/** Pull `error:` / `warning:` lines out of xcodebuild output. */
export function summarizeXcodebuild(text: string): XcodebuildSummary {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/(^|\s)error:/.test(line) || /^\*\* .* FAILED \*\*/.test(line)) {
      if (!errors.includes(line)) errors.push(line);
    } else if (/(^|\s)warning:/.test(line) && warnings.length < 30) {
      if (!warnings.includes(line)) warnings.push(line);
    }
  }
  return {
    succeeded: /\*\* (ARCHIVE|EXPORT|BUILD) SUCCEEDED \*\*/.test(text) && errors.length === 0,
    errors: errors.slice(0, 40),
    warnings,
  };
}
