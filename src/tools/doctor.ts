import { z } from "zod";
import { ok } from "../core/exec";
import { compareVersions, macOSVersion, xcodeInfo } from "../core/platform";
import { currentSdkRequirement, SDK_REQUIREMENTS_LAST_REVIEWED } from "../knowledge/sdk-requirements";
import {
  certificatesWithoutKeys,
  type Finding,
  finding,
  formatFindings,
  intermediateStatus,
  listIdentities,
} from "./shared";
import { defineTool } from "./types";

const TOOLS = [
  "codesign",
  "notarytool",
  "stapler",
  "altool",
  "productbuild",
  "pkgbuild",
  "productsign",
  "spctl",
  "security",
  "hdiutil",
  "ditto",
  "openssl",
  "xcodebuild",
  "devicectl",
  "simctl",
];

export const doctorTool = defineTool({
  name: "doctor",
  title: "Check this Mac's signing/notarization readiness",
  description:
    "Start here. Checks macOS and Xcode / Command Line Tools versions against App Store minimums, required CLIs (codesign, notarytool, stapler, altool, productbuild…), keychain signing identities (expired, missing private keys, duplicates), Apple intermediate certificates, App Store Connect API key configuration and the notarytool keychain profile. Returns a checklist with exact fixes. Read-only.",
  input: {
    profile: z
      .string()
      .optional()
      .describe("Credential profile to check (default profile / env vars if omitted)."),
  },
  async handler(args, ctx) {
    const findings: Finding[] = [];
    const data: Record<string, unknown> = { platform: ctx.platform.os };

    // ---- App Store Connect credentials work everywhere
    const p8s = await ctx.config.listDiscoveredP8();
    let ascConfigured = false;
    try {
      const creds = await ctx.config.resolveAsc(args.profile);
      ascConfigured = true;
      data.appStoreConnect = {
        configured: true,
        keyId: creds.keyId,
        issuerId: creds.issuerId ?? "(individual key)",
        source: creds.source,
        privateKeyPath: creds.privateKeyPath,
      };
      findings.push(
        finding(
          "info",
          `App Store Connect API key ${creds.keyId} configured (${creds.source}).`,
          "Validate it with asc_auth action=test.",
        ),
      );
    } catch (e) {
      data.appStoreConnect = { configured: false, discoveredKeys: p8s };
      findings.push(
        finding(
          "warning",
          `No App Store Connect API key configured${p8s.length ? ` (found ${p8s.map((p) => p.path).join(", ")})` : ""}.`,
          "Needed for portal automation, notarization and uploads. Create a Team key (App Store Connect → Users and Access → Integrations → App Store Connect API, role Admin or App Manager) then asc_auth action=configure.",
        ),
      );
      void e;
    }

    if (!ctx.platform.isMac) {
      findings.push(
        finding(
          "warning",
          `Running on ${ctx.platform.os}: only App Store Connect API and file inspection tools work here.`,
          "Run this server on a Mac for signing, notarization and Gatekeeper tools.",
        ),
      );
      return {
        summary: `doctor (${ctx.platform.os})\n${formatFindings(findings)}`,
        data: { ...data, findings },
        next_steps: ascConfigured ? ["asc_auth action=test"] : ["asc_auth action=configure"],
      };
    }

    // ---- macOS + Xcode
    const macos = await macOSVersion(ctx.runner);
    const xc = await xcodeInfo(ctx.runner);
    data.macOS = macos;
    data.xcode = xc;
    const req = currentSdkRequirement(ctx.now());
    if (!xc.developerDir) {
      findings.push(
        finding(
          "error",
          "No developer tools selected.",
          "Install Xcode from the App Store (or `xcode-select --install` for Command Line Tools), then `sudo xcode-select -s /Applications/Xcode.app`.",
        ),
      );
    } else if (xc.isCommandLineToolsOnly || !xc.xcodeVersion) {
      findings.push(
        finding(
          "warning",
          "Only Command Line Tools are active (no full Xcode). codesign/notarytool/stapler work; xcodebuild archive, altool uploads and iOS builds need Xcode.",
          "Install Xcode and run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.",
        ),
      );
    } else if (req && compareVersions(xc.xcodeVersion, req.minXcode) < 0) {
      findings.push(
        finding(
          "warning",
          `Xcode ${xc.xcodeVersion} is older than the App Store Connect minimum (Xcode ${req.minXcode}, ${req.sdks}, since ${req.effective}). Uploads will be rejected; Developer ID notarization still works.`,
          `Update Xcode. Requirements last reviewed ${SDK_REQUIREMENTS_LAST_REVIEWED}; confirm at ${req.source}.`,
        ),
      );
    } else {
      findings.push(
        finding("info", `Xcode ${xc.xcodeVersion} (${xc.buildVersion ?? "?"}) at ${xc.developerDir}.`),
      );
    }

    // ---- CLIs
    const tools: Record<string, string | null> = {};
    for (const t of TOOLS) {
      const r = await ctx.runner.run("xcrun", ["--find", t], { timeoutMs: 15000 });
      if (ok(r)) tools[t] = r.stdout.trim();
      else {
        const w = await ctx.runner.run("/usr/bin/which", [t], { timeoutMs: 5000 });
        tools[t] = ok(w) ? w.stdout.trim() : null;
      }
    }
    data.tools = tools;
    const missing = Object.entries(tools)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const critical = missing.filter((m) =>
      ["codesign", "notarytool", "stapler", "security", "spctl"].includes(m),
    );
    if (critical.length)
      findings.push(
        finding(
          "error",
          `Missing critical tools: ${critical.join(", ")}.`,
          "Install Xcode 13+ (notarytool ships with Xcode 13+).",
        ),
      );
    else if (missing.length)
      findings.push(finding("info", `Optional tools not found: ${missing.join(", ")}.`));

    // ---- Identities
    try {
      const ids = await listIdentities(ctx);
      const orphanCerts = await certificatesWithoutKeys(ctx, ids);
      data.identities = ids.map((i) => ({
        name: i.name,
        sha1: i.sha1,
        type: i.typeName,
        valid: i.valid,
        invalidReason: i.invalidReason,
        expires: i.certificate?.validTo,
      }));
      data.certificatesWithoutPrivateKey = orphanCerts.map((c) => ({
        name: c.commonName,
        sha1: c.sha1,
        expires: c.validTo,
      }));
      const valid = ids.filter((i) => i.valid);
      const byType = (t: string) => valid.filter((i) => i.type === t);
      if (!ids.length) {
        findings.push(
          finding(
            "warning",
            "No code signing identities in the keychain.",
            "signing_identities explains which certificate you need; keychain create_csr → asc_certificates create.",
          ),
        );
      }
      for (const [type, label] of [
        ["developer-id-application", "Developer ID Application (outside the Mac App Store)"],
        ["apple-distribution", "Apple Distribution (App Store / TestFlight)"],
        ["apple-development", "Apple Development (local development)"],
      ] as const) {
        const n = byType(type).length;
        findings.push(finding(n ? "info" : "info", `${label}: ${n ? `${n} valid identity(ies)` : "none"}.`));
      }
      for (const i of ids.filter((x) => !x.valid))
        findings.push(
          finding(
            "warning",
            `Invalid identity "${i.name}" (${i.invalidReason ?? "invalid"}).`,
            "Remove it from the keychain to avoid ambiguity.",
            i.sha1,
          ),
        );
      for (const i of valid.filter((x) => (x.certificate?.daysUntilExpiry ?? 999) < 30))
        findings.push(finding("warning", `"${i.name}" expires in ${i.certificate?.daysUntilExpiry} days.`));
      if (orphanCerts.length)
        findings.push(
          finding(
            "warning",
            `${orphanCerts.length} developer certificate(s) in the keychain have no private key (cannot sign): ${orphanCerts.map((c) => c.commonName).join("; ")}.`,
            "Import the .p12 from the Mac that created the CSR, or create a new certificate.",
          ),
        );
      const names = valid.map((i) => i.name);
      const dups = names.filter((n, i) => names.indexOf(n) !== i);
      if (dups.length)
        findings.push(
          finding(
            "warning",
            `Duplicate identity names: ${[...new Set(dups)].join("; ")} — codesign will say "ambiguous".`,
            "Sign using the SHA-1 hash, or delete the older certificate.",
          ),
        );
      const inter = await intermediateStatus(ctx);
      data.intermediates = inter;
      for (const im of inter.filter((x) => !x.found && !x.name.includes("G1")))
        findings.push(
          finding(
            "info",
            `${im.name} not found in login/System keychains (${im.neededFor}).`,
            "Only needed if codesign reports 'unable to build chain' / errSecInternalComponent: keychain action=install_intermediates.",
          ),
        );
    } catch (e) {
      findings.push(finding("error", `Could not read keychain identities: ${(e as Error).message}`));
    }

    // ---- notary profile
    const notaryProfile = await ctx.config.notaryProfile(undefined, args.profile).catch(() => undefined);
    data.notaryKeychainProfile = notaryProfile ?? null;
    if (!notaryProfile)
      findings.push(
        finding(
          "info",
          "No notarytool keychain profile configured.",
          ascConfigured
            ? "notary action=store_credentials (reuses your API key) — or pass API key flags per call."
            : "Configure an API key first, then notary action=store_credentials.",
        ),
      );

    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.filter((f) => f.severity === "warning").length;
    return {
      summary: `doctor: macOS ${macos ?? "?"}, ${xc.xcodeVersion ? `Xcode ${xc.xcodeVersion}` : "no Xcode"} — ${errors} error(s), ${warnings} warning(s)\n${formatFindings(findings)}`,
      data: { ...data, findings },
      next_steps: [
        "detect_project path=<your app or project> to see what you are shipping",
        "distribution_checklist path=<…> target=<mac-developer-id|mac-app-store|testflight-ios|ios-app-store|…>",
      ],
    };
  },
});
