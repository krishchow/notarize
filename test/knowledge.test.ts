import { describe, expect, it } from "vitest";
import {
  CERTIFICATE_TYPES,
  classifyAscCertificateType,
  classifyCertificateName,
  teamIdFromCertName,
} from "../src/knowledge/certificate-types";
import {
  CAPABILITY_SHORTHANDS,
  ENTITLEMENT_PRESETS,
  ENTITLEMENTS,
  entitlementInfo,
} from "../src/knowledge/entitlements";
import { ERROR_CATALOG, matchKnownErrors } from "../src/knowledge/error-catalog";
import { PRIVACY_RESOURCES } from "../src/knowledge/privacy-keys";
import { currentSdkRequirement } from "../src/knowledge/sdk-requirements";
import { certTypesForProfile, TARGET_IDS, TARGETS } from "../src/knowledge/targets";

describe("knowledge base consistency", () => {
  it("has unique ids/keys", () => {
    const uniq = (xs: string[]) => new Set(xs).size === xs.length;
    expect(uniq(ERROR_CATALOG.map((e) => e.id))).toBe(true);
    expect(uniq(ENTITLEMENTS.map((e) => e.key))).toBe(true);
    expect(uniq(CERTIFICATE_TYPES.map((c) => c.id))).toBe(true);
    expect(uniq(PRIVACY_RESOURCES.map((p) => p.id))).toBe(true);
  });

  it("targets reference known certificate types", () => {
    const ids = new Set(CERTIFICATE_TYPES.map((c) => c.id));
    for (const id of TARGET_IDS) {
      const t = TARGETS[id];
      expect(t.id).toBe(id);
      for (const c of t.certificates) for (const alt of c.alternatives) expect(ids.has(alt)).toBe(true);
    }
  });

  it("presets and shorthands only use catalogued or well-formed keys", () => {
    for (const p of ENTITLEMENT_PRESETS)
      for (const k of Object.keys(p.entitlements)) expect(entitlementInfo(k), k).toBeDefined();
    for (const v of Object.values(CAPABILITY_SHORTHANDS))
      for (const k of Object.keys(v)) expect(k.startsWith("com.apple.")).toBe(true);
  });

  it("classifies certificate names and ASC types", () => {
    expect(classifyCertificateName("Developer ID Installer: X (ABCDE12345)")?.id).toBe(
      "developer-id-installer",
    );
    expect(classifyCertificateName("3rd Party Mac Developer Installer: X (ABCDE12345)")?.id).toBe(
      "mac-installer-distribution",
    );
    expect(classifyCertificateName("iPhone Distribution: X (ABCDE12345)")?.id).toBe(
      "ios-distribution-legacy",
    );
    expect(classifyAscCertificateType("DISTRIBUTION")?.id).toBe("apple-distribution");
    expect(teamIdFromCertName("Apple Development: a@b.c (QWERTY1234)")).toBe("QWERTY1234");
    expect(certTypesForProfile("MAC_APP_DIRECT")).toContain("DEVELOPER_ID_APPLICATION_G2");
    expect(certTypesForProfile("IOS_APP_STORE")).toContain("DISTRIBUTION");
  });

  it("explains a no-devices archive failure instead of repeating -allowProvisioningUpdates", () => {
    const log = [
      "error: No profiles for 'com.absurdism.radarrconnect' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'com.absurdism.radarrconnect'.",
      "error: Your team has no devices from which to generate a provisioning profile. Connect a device to use or manually add device IDs in Certificates, Identifiers & Profiles.",
    ].join("\n");
    const ids = matchKnownErrors(log).map((m) => m.id);
    expect(ids).toContain("xc-no-devices");
    expect(ids).not.toContain("xc-no-profile");
    expect(matchKnownErrors(log)[0].fix.join("\n")).toMatch(/signing_style=manual/);
  });

  it("matches representative real-world error messages", () => {
    const cases: [string, string][] = [
      ["/x/App.app: errSecInternalComponent", "errSecInternalComponent"],
      [
        'App.app: ambiguous (matches "Developer ID Application: X" and "Developer ID Application: X")',
        "ambiguous-identity",
      ],
      ["App.app: resource fork, Finder information, or similar detritus not allowed", "detritus"],
      ["The binary is not signed with a valid Developer ID certificate.", "notary-not-developer-id"],
      [
        'CloudKit query for App.app (2/abc) failed due to "Record not found".\nThe staple and validate action failed! Error 65.',
        "staple-error-65",
      ],
      [
        'error: No signing certificate "Mac Development" found: No "Mac Development" signing certificate matching team ID',
        "xc-no-certificate",
      ],
      [
        "ITMS-90189: Redundant Binary Upload. You've already uploaded a build with build number '7'",
        "itms-90189",
      ],
      ["ITMS-91053: Missing API declaration - Your app's code references one or more APIs", "itms-91053"],
      ["“Example” is damaged and can’t be opened. You should move it to the Trash.", "gk-damaged"],
      ["Apple could not verify “Example” is free of malware that may harm your Mac", "gk-unverified"],
    ];
    for (const [text, id] of cases)
      expect(
        matchKnownErrors(text).map((m) => m.id),
        text,
      ).toContain(id);
  });

  it("finds the SDK requirement in force on a date", () => {
    expect(currentSdkRequirement(new Date("2025-06-01"))?.minXcode).toBe("16.0");
    expect(currentSdkRequirement(new Date("2026-10-01"))?.minXcode).toBe("26.0");
    expect(currentSdkRequirement(new Date("2020-01-01"))).toBeUndefined();
  });
});
