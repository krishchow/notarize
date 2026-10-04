import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlist } from "../src/core/plist";
import { matchKnownErrors } from "../src/knowledge/error-catalog";
import { parseCodesignDisplay, parseCodesignVerify, signerKind } from "../src/parsers/codesign";
import { parseCrashReport } from "../src/parsers/ips";
import { discoverNestedCode, isMachO } from "../src/parsers/macho";
import { groupIssues, parseNotaryJson, parseNotaryLog } from "../src/parsers/notarytool";
import { parseLipoArchs, parseOtoolL, parseOtoolLoadCommands } from "../src/parsers/otool";
import { detectProject, summarizePbxproj } from "../src/parsers/project/detect";
import { parseSandboxViolations } from "../src/parsers/sandbox-log";
import { duplicateNames, parseFindCertificateZ, parseFindIdentity } from "../src/parsers/security";
import { parseSpctl } from "../src/parsers/spctl";
import { describeCertificate } from "../src/parsers/x509";
import { parseShowBuildSettings, parseXcodeList, summarizeXcodebuild } from "../src/parsers/xcodebuild";

const fx = (name: string) => readFile(join(__dirname, "fixtures", name), "utf8");

/** Minimal 64-bit little-endian Mach-O header. */
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0]);

describe("codesign", () => {
  it("parses a Developer ID signature with runtime, timestamp and stapled ticket", async () => {
    const info = parseCodesignDisplay(await fx("codesign-devid.txt"));
    expect(info).toMatchObject({
      identifier: "com.example.app",
      teamIdentifier: "ABCDE12345",
      hardenedRuntime: true,
      hasSecureTimestamp: true,
      isAdhoc: false,
      notarizationTicket: "stapled",
      flags: ["runtime"],
      runtimeVersion: "15.0.0",
    });
    expect(info.authorities[0]).toBe("Developer ID Application: Example Corp (ABCDE12345)");
    expect(signerKind(info)).toBe("developer-id");
  });

  it("parses ad-hoc / linker-signed binaries", async () => {
    const info = parseCodesignDisplay(await fx("codesign-adhoc.txt"));
    expect(info.isAdhoc).toBe(true);
    expect(info.flags).toEqual(["adhoc", "linker-signed"]);
    expect(info.teamIdentifier).toBeUndefined();
    expect(info.hasSecureTimestamp).toBe(false);
    expect(signerKind(info)).toBe("adhoc");
  });

  it("detects unsigned code", () => {
    const info = parseCodesignDisplay("/tmp/x: code object is not signed at all");
    expect(signerKind(info)).toBe("unsigned");
  });

  it("extracts problem paths from verify output", async () => {
    const text = await fx("codesign-verify-fail.txt");
    const v = parseCodesignVerify(text, 1);
    expect(v.valid).toBe(false);
    expect(v.problemPaths.map((p) => p.kind)).toEqual(["file added", "file modified", "In subcomponent"]);
    expect(matchKnownErrors(text).map((m) => m.id)).toContain("sealed-resource");
  });
});

describe("security", () => {
  it("parses identities including invalid ones and finds duplicates", async () => {
    const ids = parseFindIdentity(await fx("find-identity.txt"));
    expect(ids).toHaveLength(4);
    const expired = ids.find((i) => i.sha1.startsWith("3333"));
    expect(expired).toMatchObject({ valid: false, invalidReason: "CSSMERR_TP_CERT_EXPIRED" });
    const devid = ids.find((i) => i.sha1.startsWith("1111"));
    expect(devid).toMatchObject({ valid: true, type: "developer-id-application", teamId: "ABCDE12345" });
    expect(ids.find((i) => i.sha1.startsWith("2222"))?.type).toBe("apple-development");
    expect(duplicateNames(ids)).toEqual(["Developer ID Application: Example Corp (ABCDE12345)"]);
  });

  it("parses find-certificate -Z output", () => {
    const out = parseFindCertificateZ(
      'SHA-256 hash: AB\nSHA-1 hash: 1111111111111111111111111111111111111111\nkeychain: "/x"\nattributes:\n    "labl"<blob>="Developer ID Application: X (ABCDE12345)"\n',
    );
    expect(out).toEqual([
      { sha1: "1111111111111111111111111111111111111111", label: "Developer ID Application: X (ABCDE12345)" },
    ]);
  });

  it("describes X.509 certificates (type, team, expiry, fingerprint)", async () => {
    const d = describeCertificate(await fx("devid-app.pem"), new Date("2027-01-01"));
    expect(d).toMatchObject({
      commonName: "Developer ID Application: Example Corp (ABCDE12345)",
      teamId: "ABCDE12345",
      type: { id: "developer-id-application" },
      expired: false,
    });
    expect(d.sha1).toMatch(/^[0-9A-F]{40}$/);
    expect(describeCertificate(await fx("devid-app.pem"), new Date("2040-01-01")).expired).toBe(true);
  });
});

describe("spctl", () => {
  it("parses accepted notarized apps", () => {
    const a = parseSpctl(
      "/Applications/Example.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example Corp (ABCDE12345)\n",
      0,
    );
    expect(a).toMatchObject({ accepted: true, notarized: true, source: "Notarized Developer ID" });
  });

  it("parses rejections with reasons", () => {
    const a = parseSpctl(
      "/tmp/x.dmg: rejected (the code is valid but does not seem to be an app)\norigin=Developer ID Application: X (ABCDE12345)",
      3,
    );
    expect(a.accepted).toBe(false);
    expect(a.reason).toMatch(/does not seem to be an app/);
    const b = parseSpctl(
      "/tmp/Example.app: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: X",
      3,
    );
    expect(b.source).toBe("Unnotarized Developer ID");
    expect(matchKnownErrors(b.raw).map((m) => m.id)).toContain("gk-unnotarized");
  });
});

describe("notarytool", () => {
  it("parses submit/info/history JSON, tolerating leading progress text", () => {
    expect(
      parseNotaryJson(
        'Conducting pre-submission checks...\n{"id":"abc","message":"Processing complete","status":"Accepted"}',
      ),
    ).toMatchObject({ id: "abc", status: "Accepted" });
    const h = parseNotaryJson(
      '{"history":[{"id":"1","status":"Invalid","name":"a.zip","createdDate":"2026"}],"message":"ok"}',
    );
    expect(h.history?.[0]).toMatchObject({ id: "1", status: "Invalid" });
  });

  it("parses developer logs, explains and groups issues", async () => {
    const log = parseNotaryLog(await fx("notary-log-invalid.json"));
    expect(log.status).toBe("Invalid");
    expect(log.issues).toHaveLength(3);
    expect(log.issues[0].explanation?.id).toBe("notary-no-hardened-runtime");
    const groups = groupIssues(log.issues);
    expect(groups[0]).toMatchObject({
      count: 2,
      message: "The executable does not have the hardened runtime enabled.",
    });
    expect(groups[1].explanation?.id).toBe("notary-no-timestamp");
  });
});

describe("xcodebuild", () => {
  it("parses -list -json for projects and workspaces", () => {
    expect(
      parseXcodeList(
        '{"project":{"configurations":["Debug","Release"],"name":"Ex","schemes":["Ex"],"targets":["Ex","ExTests"]}}',
      ),
    ).toEqual({
      kind: "project",
      name: "Ex",
      schemes: ["Ex"],
      targets: ["Ex", "ExTests"],
      configurations: ["Debug", "Release"],
    });
    expect(
      parseXcodeList('Command line invocation...\n{"workspace":{"name":"W","schemes":["A","B"]}}')?.kind,
    ).toBe("workspace");
  });

  it("filters -showBuildSettings -json to signing keys", () => {
    const s = parseShowBuildSettings(
      JSON.stringify([
        {
          target: "Ex",
          action: "build",
          buildSettings: { DEVELOPMENT_TEAM: "ABCDE12345", CODE_SIGN_STYLE: "Automatic", UNRELATED: "x" },
        },
      ]),
    );
    expect(s).toEqual([
      { target: "Ex", settings: { DEVELOPMENT_TEAM: "ABCDE12345", CODE_SIGN_STYLE: "Automatic" } },
    ]);
  });

  it("summarizes errors", () => {
    const s = summarizeXcodebuild(
      "error: No profiles for 'com.example.app' were found: Xcode couldn't find any Mac App Store provisioning profiles\n** ARCHIVE FAILED **",
    );
    expect(s.succeeded).toBe(false);
    expect(s.errors).toHaveLength(2);
    expect(matchKnownErrors(s.errors.join("\n")).map((m) => m.id)).toContain("xc-no-profile");
  });
});

describe("otool", () => {
  it("parses linked libraries and load commands", async () => {
    const libs = parseOtoolL(await fx("otool-libs.txt"));
    expect(libs.map((l) => l.path)).toContain("@rpath/Sparkle.framework/Versions/B/Sparkle");
    expect(libs.find((l) => l.path.includes("CoreLocation"))?.weak).toBe(true);
    const lc = parseOtoolLoadCommands(await fx("otool-loadcmds.txt"));
    expect(lc.buildVersions).toEqual([{ platform: "macOS", minos: "12.0", sdk: "15.2" }]);
    expect(lc.rpaths).toEqual(["@executable_path/../Frameworks"]);
    expect(lc.hasCodeSignature).toBe(true);
    expect(parseLipoArchs("x86_64 arm64\n")).toEqual(["x86_64", "arm64"]);
  });
});

describe("sandbox log", () => {
  it("groups violations and suggests entitlements", async () => {
    const v = parseSandboxViolations(await fx("sandbox-log.txt"), "/Users/jane");
    expect(v[0]).toMatchObject({ operation: "network-outbound", count: 2 });
    expect(v[0].suggestion?.entitlement).toBe("com.apple.security.network.client");
    const byOp = Object.fromEntries(v.map((x) => [x.operation, x.suggestion?.entitlement]));
    expect(byOp["file-read-data"]).toBe("com.apple.security.files.downloads.read-write");
    expect(byOp["file-write-create"]).toBe("com.apple.security.files.user-selected.read-write");
    expect(byOp["appleevent-send"]).toBe("com.apple.security.automation.apple-events");
  });
});

describe("crash reports", () => {
  it("recognizes CODESIGNING kills", async () => {
    const c = parseCrashReport(await fx("crash-codesigning.ips"));
    expect(c).toMatchObject({
      process: "Example",
      bundleId: "com.example.app",
      terminationNamespace: "CODESIGNING",
      isSigningRelated: true,
    });
    expect(c.explanations.map((e) => e.id)).toContain("rt-codesigning-crash");
  });

  it("recognizes dyld library validation failures", async () => {
    const c = parseCrashReport(await fx("crash-dyld.ips"));
    expect(c.terminationNamespace).toBe("DYLD");
    expect(c.explanations.map((e) => e.id)).toEqual(
      expect.arrayContaining(["rt-library-validation", "rt-library-not-loaded"]),
    );
  });

  it("parses legacy .crash text", () => {
    const c = parseCrashReport(
      "Process:               Example [123]\nIdentifier:            com.example.app\nException Type:        EXC_CRASH (SIGKILL (Code Signature Invalid))\nTermination Reason:    Namespace CODESIGNING, Code 1 Invalid Page\n",
    );
    expect(c).toMatchObject({
      bundleId: "com.example.app",
      terminationNamespace: "CODESIGNING",
      isSigningRelated: true,
    });
  });
});

describe("Mach-O discovery (inside-out signing order)", () => {
  it("orders nested code deepest-first and skips symlinks + main executables", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "nested-")), "Example.app");
    const c = join(root, "Contents");
    const fw = join(c, "Frameworks", "Sparkle.framework");
    await mkdir(join(c, "MacOS"), { recursive: true });
    await mkdir(join(fw, "Versions", "B", "Resources", "Updater.app", "Contents", "MacOS"), {
      recursive: true,
    });
    await mkdir(join(c, "Resources", "bin"), { recursive: true });
    await mkdir(join(c, "XPCServices", "Worker.xpc", "Contents", "MacOS"), { recursive: true });
    await writeFile(join(c, "Info.plist"), buildPlist({ CFBundleExecutable: "Example" }));
    await writeFile(join(c, "MacOS", "Example"), MACHO);
    await writeFile(join(fw, "Versions", "B", "Sparkle"), MACHO);
    await writeFile(
      join(fw, "Versions", "B", "Resources", "Updater.app", "Contents", "MacOS", "Updater"),
      MACHO,
    );
    await symlink("B", join(fw, "Versions", "Current"));
    await symlink("Versions/Current/Sparkle", join(fw, "Sparkle"));
    await writeFile(join(c, "Frameworks", "libfoo.dylib"), MACHO);
    await writeFile(join(c, "Resources", "bin", "ffmpeg"), MACHO);
    await chmod(join(c, "Resources", "bin", "ffmpeg"), 0o755);
    await writeFile(join(c, "Resources", "notes.txt"), "hello");
    await writeFile(join(c, "XPCServices", "Worker.xpc", "Contents", "MacOS", "Worker"), MACHO);

    expect(await isMachO(join(c, "Frameworks", "libfoo.dylib"))).toBe(true);
    expect(await isMachO(join(c, "Resources", "notes.txt"))).toBe(false);

    const items = await discoverNestedCode(root);
    const rels = items.map((i) => i.relativePath);
    expect(rels.at(-1)).toBe(".");
    expect(rels).not.toContain("Contents/MacOS/Example");
    expect(rels).not.toContain("Contents/Frameworks/Sparkle.framework/Sparkle");
    const idx = (p: string) => rels.indexOf(p);
    expect(
      idx("Contents/Frameworks/Sparkle.framework/Versions/B/Resources/Updater.app"),
    ).toBeGreaterThanOrEqual(0);
    expect(idx("Contents/Frameworks/Sparkle.framework/Versions/B/Resources/Updater.app")).toBeLessThan(
      idx("Contents/Frameworks/Sparkle.framework/Versions/B"),
    );
    expect(idx("Contents/Frameworks/libfoo.dylib")).toBeGreaterThanOrEqual(0);
    expect(idx("Contents/Resources/bin/ffmpeg")).toBeGreaterThanOrEqual(0);
    expect(idx("Contents/XPCServices/Worker.xpc")).toBeGreaterThanOrEqual(0);
    expect(rels).not.toContain("Contents/Resources/notes.txt");
  });
});

describe("project detection", () => {
  const pbx = `
    buildSettings = {
      PRODUCT_BUNDLE_IDENTIFIER = com.example.app;
      DEVELOPMENT_TEAM = ABCDE12345;
      CODE_SIGN_STYLE = Automatic;
      SDKROOT = macosx;
      ENABLE_HARDENED_RUNTIME = YES;
      CODE_SIGN_ENTITLEMENTS = Example/Example.entitlements;
      MARKETING_VERSION = 1.2;
      CURRENT_PROJECT_VERSION = 7;
    };
    productType = "com.apple.product-type.application";
  `;

  it("summarizes pbxproj signing settings", () => {
    const s = summarizePbxproj(pbx);
    expect(s).toMatchObject({
      bundleIds: ["com.example.app"],
      teamIds: ["ABCDE12345"],
      hardenedRuntime: ["YES"],
      entitlementsFiles: ["Example/Example.entitlements"],
    });
  });

  it("detects Xcode, Electron, Tauri, Flutter and Expo projects", async () => {
    const base = await mkdtemp(join(tmpdir(), "detect-"));
    // Xcode
    const xc = join(base, "xcode");
    await mkdir(join(xc, "Example.xcodeproj"), { recursive: true });
    await writeFile(join(xc, "Example.xcodeproj", "project.pbxproj"), pbx);
    // Electron
    const el = join(base, "electron");
    await mkdir(el);
    await writeFile(
      join(el, "package.json"),
      JSON.stringify({
        name: "el",
        devDependencies: { electron: "^33.0.0" },
        build: { appId: "com.example.el", mac: { hardenedRuntime: false } },
      }),
    );
    // Tauri v2
    const ta = join(base, "tauri");
    await mkdir(join(ta, "src-tauri"), { recursive: true });
    await writeFile(
      join(ta, "src-tauri", "tauri.conf.json"),
      JSON.stringify({ productName: "Ta", identifier: "com.example.ta", bundle: { macOS: {} } }),
    );
    // Flutter
    const fl = join(base, "flutter");
    await mkdir(join(fl, "ios", "Runner.xcodeproj"), { recursive: true });
    await writeFile(
      join(fl, "pubspec.yaml"),
      "name: flapp\nversion: 1.0.0+3\nflutter:\n  uses-material-design: true\n",
    );
    await writeFile(
      join(fl, "ios", "Runner.xcodeproj", "project.pbxproj"),
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.flapp;\nSDKROOT = iphoneos;",
    );
    // Expo managed
    const ex = join(base, "expo");
    await mkdir(ex);
    await writeFile(
      join(ex, "package.json"),
      JSON.stringify({ name: "ex", dependencies: { expo: "^52.0.0", "react-native": "0.76.0" } }),
    );
    await writeFile(
      join(ex, "app.json"),
      JSON.stringify({ expo: { name: "Ex", ios: { bundleIdentifier: "com.example.ex" } } }),
    );

    const xr = await detectProject(xc);
    expect(xr.components[0]).toMatchObject({
      kind: "xcode-project",
      bundleIds: ["com.example.app"],
      platforms: ["macOS"],
    });

    const er = await detectProject(el);
    expect(er.components[0].kind).toBe("electron");
    expect(er.components[0].findings.join("\n")).toMatch(/hardenedRuntime is false/);

    const tr = await detectProject(ta);
    expect(tr.components[0]).toMatchObject({ kind: "tauri", bundleIds: ["com.example.ta"] });
    expect(tr.components[0].findings.join("\n")).toMatch(/signingIdentity not set/);

    const fr = await detectProject(fl);
    expect(fr.components.map((c) => c.kind)).toEqual(["flutter"]);
    expect(fr.components[0]).toMatchObject({ platforms: ["iOS"], bundleIds: ["com.example.flapp"] });

    const exr = await detectProject(ex);
    expect(exr.components[0]).toMatchObject({ kind: "expo", bundleIds: ["com.example.ex"] });
    expect(exr.components[0].signing.workflow).toMatch(/managed/);
    // Managed Expo offers the local route as well as EAS, and doesn't pick one for the user.
    expect(exr.components[0].buildCommands.join("\n")).toMatch(/expo prebuild -p ios[\s\S]*eas build/);
    expect(exr.components[0].findings.join("\n")).toMatch(/Ask the user which/);
  });

  it("detects prebuilt .app bundles", async () => {
    const app = join(await mkdtemp(join(tmpdir(), "art-")), "Pre.app");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(
      join(app, "Contents", "Info.plist"),
      buildPlist({ CFBundleIdentifier: "com.pre.app", CFBundleShortVersionString: "2.0" }),
    );
    const r = await detectProject(app);
    expect(r.components[0]).toMatchObject({
      kind: "app-bundle",
      platforms: ["macOS"],
      bundleIds: ["com.pre.app"],
    });
  });
});
