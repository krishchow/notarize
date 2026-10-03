import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { ok } from "../core/exec";
import { compareVersions, requireMacOS } from "../core/platform";
import { ToolError } from "../core/result";
import { CERTIFICATE_TYPES } from "../knowledge/certificate-types";
import { NOTARIZATION_MIN_SDK } from "../knowledge/sdk-requirements";
import { TARGET_IDS } from "../knowledge/targets";
import { discoverNestedCode, isMachO } from "../parsers/macho";
import { parseLipoArchs, parseOtoolL, parseOtoolLoadCommands } from "../parsers/otool";
import {
  certificatesWithoutKeys,
  extractIpa,
  type Finding,
  finding,
  formatFindings,
  inspectSignature,
  isDirectory,
  listIdentities,
  resolveUserPath,
} from "./shared";
import { defineTool } from "./types";

export const signingIdentitiesTool = defineTool({
  name: "signing_identities",
  title: "List keychain signing identities and certificates",
  description:
    "List code-signing identities (certificate + private key) in the keychain with type (Developer ID Application/Installer, Apple Distribution, Apple Development, Mac Installer Distribution…), team ID, SHA-1, expiry and validity; also lists developer certificates that are missing their private key and explains which certificate each distribution target needs. Read-only.",
  input: {
    keychain: z.string().optional().describe("Specific keychain path (default: user search list)."),
    include_reference: z
      .boolean()
      .optional()
      .describe("Include the certificate-type reference table (default true)."),
  },
  async handler(args, ctx) {
    const ids = await listIdentities(ctx, args.keychain);
    const orphans = await certificatesWithoutKeys(ctx, ids);
    const lines = [`${ids.length} code-signing identit${ids.length === 1 ? "y" : "ies"}:`];
    for (const i of ids) {
      const exp = i.certificate
        ? ` expires ${i.certificate.validTo.slice(0, 10)}${i.certificate.expired ? " (EXPIRED)" : ""}`
        : "";
      lines.push(
        `${i.valid ? "✓" : "✗"} ${i.name}  [${i.typeName ?? "unknown type"}]  SHA-1 ${i.sha1}${exp}${i.invalidReason ? `  (${i.invalidReason})` : ""}`,
      );
    }
    if (orphans.length) {
      lines.push(
        "",
        "Certificates WITHOUT a private key (cannot sign — import the .p12 from the Mac that created them, or create new ones):",
      );
      for (const c of orphans)
        lines.push(`  • ${c.commonName} (SHA-1 ${c.sha1}, expires ${c.validTo.slice(0, 10)})`);
    }
    const reference =
      args.include_reference === false
        ? undefined
        : CERTIFICATE_TYPES.filter((c) => !c.legacy).map((c) => ({
            type: c.portalName,
            purpose: c.purpose,
            createdBy: c.createdBy,
            limit: c.limit,
          }));
    return {
      summary: lines.join("\n"),
      data: {
        identities: ids.map((i) => ({
          name: i.name,
          sha1: i.sha1,
          type: i.typeName,
          teamId: i.teamId,
          valid: i.valid,
          invalidReason: i.invalidReason,
          validTo: i.certificate?.validTo,
          daysUntilExpiry: i.certificate?.daysUntilExpiry,
        })),
        certificatesWithoutPrivateKey: orphans,
        certificateTypes: reference,
      },
      next_steps: ids.some((i) => i.type === "developer-id-application" && i.valid)
        ? ["sign / notarize_and_staple for Developer ID distribution"]
        : [
            "Missing a certificate? keychain action=create_csr → asc_certificates action=create (or the portal for Developer ID)",
          ],
    };
  },
});

export const inspectCodeSignatureTool = defineTool({
  name: "inspect_code_signature",
  title: "Inspect and verify a code signature",
  description:
    "Deep inspection of a signed .app/.framework/.appex/.dylib/binary/.dmg/.pkg/.ipa: signer and certificate chain, team ID, hardened runtime, secure timestamp, stapled ticket, entitlements, embedded provisioning profile, strict deep verification, and every nested component (unsigned, ad-hoc, missing runtime/timestamp, mismatched Team IDs). Pass a target to get readiness findings for that distribution path. Read-only.",
  input: {
    path: z.string().describe("Path to the artifact."),
    target: z.enum(TARGET_IDS).optional().describe("Distribution target to evaluate readiness for."),
    deep: z.boolean().optional().describe("Inspect nested code individually (default true)."),
  },
  async handler(args, ctx) {
    requireMacOS(ctx.platform, "inspect_code_signature");
    let path = await resolveUserPath(ctx, args.path);
    if (extname(path).toLowerCase() === ".ipa") path = await extractIpa(ctx, path);
    const r = await inspectSignature(ctx, path, { target: args.target, deep: args.deep });
    const d = r.display;
    const head = r.pkg
      ? `Package ${path}\nStatus: ${r.pkg.status}\nNotarized: ${r.pkg.notarized ? "yes" : "no"}\nChain: ${r.pkg.chain.join(" → ")}`
      : [
          `${path}`,
          `Signed: ${r.signed ? `yes (${r.signer})` : "NO"}`,
          d?.authorities.length ? `Authority: ${d.authorities.join(" → ")}` : undefined,
          d?.identifier ? `Identifier: ${d.identifier}` : undefined,
          d?.teamIdentifier ? `Team ID: ${d.teamIdentifier}` : undefined,
          r.signed
            ? `Hardened runtime: ${d?.hardenedRuntime ? "yes" : "no"} · Secure timestamp: ${d?.hasSecureTimestamp ? "yes" : "no"} · Ticket: ${d?.notarizationTicket ?? "unknown"}`
            : undefined,
          r.verify ? `Verify (deep, strict): ${r.verify.valid ? "valid" : "INVALID"}` : undefined,
          r.entitlements ? `Entitlements: ${Object.keys(r.entitlements).join(", ") || "(none)"}` : undefined,
          r.embeddedProfile
            ? `Embedded profile: ${r.embeddedProfile.name ?? r.embeddedProfile.path} (${r.embeddedProfile.type ?? "?"})`
            : undefined,
          r.nested.length
            ? `Nested code: ${r.nested.length} item(s), ${r.nested.filter((n) => n.issues.length).length} with issues`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n");
    const errors = r.findings.filter((f) => f.severity === "error");
    return {
      summary: `${head}\n\n${r.findings.length ? formatFindings(r.findings) : "No problems found."}`,
      data: {
        ...r,
        display: d ? { ...d, raw: undefined } : undefined,
        verify: r.verify
          ? {
              valid: r.verify.valid,
              messages: r.verify.messages.slice(0, 30),
              problemPaths: r.verify.problemPaths,
            }
          : undefined,
      } as unknown as Record<string, unknown>,
      next_steps: errors.length
        ? ["Fix the errors above (sign tool re-signs inside-out), then inspect again."]
        : args.target === "mac-developer-id" || r.signer === "developer-id"
          ? [
              "notarize_and_staple path=<artifact>",
              "gatekeeper action=simulate_download to test as a user would",
            ]
          : [],
    };
  },
});

export const inspectBinaryTool = defineTool({
  name: "inspect_binary",
  title: "Inspect Mach-O binaries (archs, SDK, linked libraries)",
  description:
    "For a Mach-O file or every Mach-O in a bundle: architectures (lipo), platform / minimum OS / SDK version (LC_BUILD_VERSION), linked libraries and @rpath entries (otool). Flags binaries built with an SDK older than 10.9 (notarization rejects them), simulator slices in device builds, and @rpath libraries that are not embedded. Read-only.",
  input: {
    path: z.string().describe("Binary or bundle path."),
    max_files: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max binaries to inspect in a bundle (default 40)."),
  },
  async handler(args, ctx) {
    requireMacOS(ctx.platform, "inspect_binary");
    const root = await resolveUserPath(ctx, args.path);
    const targets: string[] = [];
    if (await isDirectory(root)) {
      const nested = await discoverNestedCode(root);
      for (const n of nested) {
        if (n.kind === "dylib" || n.kind === "executable" || n.kind === "node-module") targets.push(n.path);
        else targets.push(...(await mainExecutables(n.path)));
      }
    } else if (await isMachO(root)) targets.push(root);
    else throw new ToolError(`${root} is not a Mach-O binary or bundle.`);

    const limit = args.max_files ?? 40;
    const results = [];
    const findings: Finding[] = [];
    for (const bin of targets.slice(0, limit)) {
      const archs = await ctx.runner.run("lipo", ["-archs", bin], { timeoutMs: 15000 });
      const libs = await ctx.runner.run("otool", ["-L", bin], { timeoutMs: 15000 });
      const lc = await ctx.runner.run("otool", ["-l", bin], { timeoutMs: 15000 });
      const info = {
        path: bin.startsWith(root) ? bin.slice(root.length + 1) || bin : bin,
        archs: ok(archs) ? parseLipoArchs(archs.stdout) : [],
        ...parseOtoolLoadCommands(lc.stdout),
        linked: ok(libs) ? parseOtoolL(libs.stdout).map((l) => l.path) : [],
      };
      results.push(info);
      for (const bv of info.buildVersions) {
        if (bv.platform === "macOS" && bv.sdk && compareVersions(bv.sdk, NOTARIZATION_MIN_SDK) < 0)
          findings.push(
            finding(
              "error",
              `Built with macOS SDK ${bv.sdk} (< 10.9) — notarization rejects it.`,
              "Rebuild with a modern SDK or remove it.",
              info.path,
            ),
          );
        if (/simulator/.test(bv.platform))
          findings.push(
            finding(
              "error",
              `Contains a ${bv.platform} slice — App Store uploads reject simulator code (ITMS-90087).`,
              "Use XCFrameworks or lipo -remove the slice before signing.",
              info.path,
            ),
          );
      }
      for (const lib of info.linked.filter(
        (l) => l.startsWith("/usr/local/") || l.startsWith("/opt/homebrew/"),
      ))
        findings.push(
          finding(
            "error",
            `Links ${lib}, which won't exist on users' Macs.`,
            "Bundle the library and rewrite the install name with install_name_tool (before signing).",
            info.path,
          ),
        );
    }
    if (targets.length > limit)
      findings.push(finding("info", `Inspected ${limit} of ${targets.length} binaries.`));
    return {
      summary: `${results.length} binar${results.length === 1 ? "y" : "ies"} inspected.\n${results
        .slice(0, 15)
        .map(
          (r) =>
            `• ${r.path}: ${r.archs.join("+") || "?"} ${r.buildVersions.map((b) => `${b.platform} min ${b.minos} sdk ${b.sdk}`).join(", ")}`,
        )
        .join("\n")}${findings.length ? `\n\n${formatFindings(findings)}` : ""}`,
      data: { binaries: results, findings },
    };
  },
});

async function mainExecutables(bundle: string): Promise<string[]> {
  for (const dir of [join(bundle, "Contents", "MacOS"), bundle]) {
    try {
      const files = await readdir(dir);
      const out: string[] = [];
      for (const f of files) if (await isMachO(join(dir, f))) out.push(join(dir, f));
      if (out.length) return out;
    } catch {
      /* next */
    }
  }
  return [];
}
