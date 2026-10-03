import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchKnownErrors } from "../src/knowledge/error-catalog";
import { parseCodesignDisplay, parseCodesignVerify, signerKind } from "../src/parsers/codesign";
import { parseNotaryJson } from "../src/parsers/notarytool";
import { parseLipoArchs, parseOtoolL, parseOtoolLoadCommands } from "../src/parsers/otool";
import { parseFindIdentity } from "../src/parsers/security";
import { parseSpctl, parseSyspolicyCheck } from "../src/parsers/spctl";
import { parseXcodeList } from "../src/parsers/xcodebuild";

/**
 * Parsers against REAL macOS output recorded by scripts/record-fixtures.sh.
 * Each case is skipped when its recording is absent (e.g. on Linux before anyone recorded).
 */
const DIR = join(__dirname, "fixtures", "recorded");
const has = (f: string) => existsSync(join(DIR, f));
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const exitOf = (f: string) => (has(`${f}.exit`) ? Number(read(`${f}.exit`).trim()) : 0);

describe("recorded macOS output", () => {
  it.skipIf(!has("codesign-linker-signed.txt"))("linker-signed executable is ad-hoc", () => {
    const info = parseCodesignDisplay(read("codesign-linker-signed.txt"));
    expect(info.isAdhoc).toBe(true);
    expect(info.flags).toContain("linker-signed");
  });

  it.skipIf(!has("codesign-unsigned-bundle.txt"))(
    "unsigned bundle is not reported as properly signed",
    () => {
      const info = parseCodesignDisplay(read("codesign-unsigned-bundle.txt"));
      expect(["unsigned", "adhoc"]).toContain(signerKind(info));
    },
  );

  it.skipIf(!has("codesign-adhoc-runtime.txt"))("ad-hoc + hardened runtime bundle", () => {
    const info = parseCodesignDisplay(read("codesign-adhoc-runtime.txt"));
    expect(info.isAdhoc).toBe(true);
    expect(info.hardenedRuntime).toBe(true);
    expect(info.identifier).toBe("com.example.notarize-smoke");
    expect(info.hasSecureTimestamp).toBe(false);
  });

  it.skipIf(!has("codesign-verify-valid.txt"))("verify succeeds on an intact bundle", () => {
    const v = parseCodesignVerify(read("codesign-verify-valid.txt"), exitOf("codesign-verify-valid.txt"));
    expect(v.valid).toBe(true);
  });

  it.skipIf(!has("codesign-verify-tampered.txt"))("verify explains a modified resource", () => {
    const text = read("codesign-verify-tampered.txt");
    const v = parseCodesignVerify(text, exitOf("codesign-verify-tampered.txt"));
    expect(v.valid).toBe(false);
    expect(matchKnownErrors(text).map((m) => m.id)).toContain("sealed-resource");
  });

  it.skipIf(!has("spctl-adhoc-app.txt"))("Gatekeeper rejects ad-hoc apps", () => {
    const a = parseSpctl(read("spctl-adhoc-app.txt"), exitOf("spctl-adhoc-app.txt"));
    expect(a.accepted).toBe(false);
  });

  it.skipIf(!has("security-find-identity.txt"))("find-identity parses every identity line", () => {
    const text = read("security-find-identity.txt");
    const lines = text.split("\n").filter((l) => /^\s*\d+\)\s+[0-9A-F]{40}\s+"/.test(l));
    const unique = new Set(lines.map((l) => /([0-9A-F]{40})/.exec(l)![1]));
    expect(parseFindIdentity(text)).toHaveLength(unique.size);
  });

  it.skipIf(!has("otool-libs-recorded.txt"))("otool -L lists the nested dylib", () => {
    expect(parseOtoolL(read("otool-libs-recorded.txt")).map((l) => l.path)).toContain(
      "@rpath/libhello.dylib",
    );
  });

  it.skipIf(!has("otool-loadcmds-recorded.txt"))("otool -l yields platform, SDK and rpath", () => {
    const lc = parseOtoolLoadCommands(read("otool-loadcmds-recorded.txt"));
    expect(lc.buildVersions[0]?.platform).toBe("macOS");
    expect(lc.buildVersions[0]?.sdk).toMatch(/^\d+\.\d+/);
    expect(lc.rpaths).toContain("@executable_path/../Frameworks");
  });

  it.skipIf(!has("lipo-archs.txt"))("lipo reports both architectures", () => {
    expect(parseLipoArchs(read("lipo-archs.txt"))).toEqual(expect.arrayContaining(["arm64", "x86_64"]));
  });

  it.skipIf(!has("xcodebuild-version.txt"))("xcodebuild -version format", () => {
    expect(read("xcodebuild-version.txt")).toMatch(/Xcode \d+(\.\d+)*\nBuild version \S+/);
  });

  it.skipIf(!has("xcodebuild-list.json"))("xcodebuild -list -json", () => {
    const list = parseXcodeList(read("xcodebuild-list.json"));
    expect(list?.schemes).toContain("Pkg");
  });

  it.skipIf(!has("syspolicy-check.txt"))("syspolicy_check output parses", () => {
    const r = parseSyspolicyCheck(read("syspolicy-check.txt"), exitOf("syspolicy-check.txt"));
    expect(r.passed).toBe(false);
  });

  it.skipIf(!has("altool-help.txt"))("altool supports a known upload flag", () => {
    expect(read("altool-help.txt")).toMatch(/--upload-package|--upload-app/);
  });

  it.skipIf(!has("notarytool-help.txt"))("notarytool exposes the subcommands we use", () => {
    const help = read("notarytool-help.txt");
    for (const sub of ["submit", "info", "log", "history", "wait", "store-credentials"])
      expect(help).toContain(sub);
  });

  it.skipIf(!has("notarytool-history.json"))("notarytool history JSON", () => {
    expect(Array.isArray(parseNotaryJson(read("notarytool-history.json")).history)).toBe(true);
  });
});
