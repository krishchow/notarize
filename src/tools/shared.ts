import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { expandHome } from "../core/config";
import { ok, output } from "../core/exec";
import { requireMacOS } from "../core/platform";
import { asDict, decodeProvisioningProfile, type PlistDict, parsePlistDict } from "../core/plist";
import { ToolError } from "../core/result";
import { APPLE_INTERMEDIATES } from "../knowledge/certificate-types";
import { RISKY_HARDENED_RUNTIME_EXCEPTIONS } from "../knowledge/entitlements";
import { matchKnownErrors } from "../knowledge/error-catalog";
import type { TargetId } from "../knowledge/targets";
import {
  type CodeSignatureInfo,
  parseCodesignDisplay,
  parseCodesignVerify,
  type SignerKind,
  signerKind,
  type VerifyResult,
} from "../parsers/codesign";
import { discoverNestedCode, type NestedCode } from "../parsers/macho";
import { type KeychainIdentity, parseFindIdentity } from "../parsers/security";
import { type CertificateDetails, describeCertificate, splitPemCertificates } from "../parsers/x509";
import type { ToolContext } from "./types";

export interface Finding {
  severity: "error" | "warning" | "info";
  message: string;
  fix?: string;
  path?: string;
}

export function finding(
  severity: Finding["severity"],
  message: string,
  fix?: string,
  path?: string,
): Finding {
  return { severity, message, ...(fix ? { fix } : {}), ...(path ? { path } : {}) };
}

export function formatFindings(findings: Finding[]): string {
  const icon = { error: "✗", warning: "⚠", info: "ℹ" };
  return findings
    .map(
      (f) =>
        `${icon[f.severity]} ${f.message}${f.path ? ` [${f.path}]` : ""}${f.fix ? `\n    → ${f.fix}` : ""}`,
    )
    .join("\n");
}

/** Expand ~, resolve relative paths, and optionally require existence. */
export async function resolveUserPath(ctx: ToolContext, p: string, mustExist = true): Promise<string> {
  const expanded = expandHome(p.trim(), ctx.platform.homeDir);
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
  if (mustExist) {
    try {
      await stat(abs);
    } catch {
      throw new ToolError(`Path does not exist: ${abs}`);
    }
  }
  return abs;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function scratchDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `notarize-${prefix}-`));
}

// ------------------------------------------------------------- identities

export interface EnrichedIdentity extends KeychainIdentity {
  certificate?: CertificateDetails;
}

/** All code-signing identities (cert + private key) with certificate details. */
export async function listIdentities(ctx: ToolContext, keychain?: string): Promise<EnrichedIdentity[]> {
  requireMacOS(ctx.platform, "Listing signing identities");
  const args = ["find-identity", "-p", "codesigning"];
  if (keychain) args.push(keychain);
  const r = await ctx.runner.run("security", args, { timeoutMs: 30000 });
  if (!ok(r)) throw new ToolError(`security find-identity failed: ${output(r)}`);
  const ids: EnrichedIdentity[] = parseFindIdentity(r.stdout);
  const names = [...new Set(ids.map((i) => i.name))];
  for (const name of names) {
    const certs = await findCertificates(ctx, name, keychain);
    for (const id of ids.filter((i) => i.name === name)) {
      id.certificate = certs.find((c) => c.sha1 === id.sha1);
    }
  }
  return ids;
}

/** Certificates (with or without private keys) whose name contains `name`. */
export async function findCertificates(
  ctx: ToolContext,
  name: string,
  keychain?: string,
): Promise<CertificateDetails[]> {
  const args = ["find-certificate", "-a", "-c", name, "-p"];
  if (keychain) args.push(keychain);
  const r = await ctx.runner.run("security", args, { timeoutMs: 30000 });
  if (!ok(r)) return [];
  const out: CertificateDetails[] = [];
  for (const pem of splitPemCertificates(r.stdout)) {
    try {
      out.push(describeCertificate(pem, ctx.now()));
    } catch {
      /* skip unparsable */
    }
  }
  return out;
}

export const DEVELOPER_CERT_PREFIXES = [
  "Developer ID Application",
  "Developer ID Installer",
  "Apple Distribution",
  "Apple Development",
  "3rd Party Mac Developer",
  "Mac Installer Distribution",
  "iPhone Distribution",
  "iPhone Developer",
  "Mac Developer",
];

/** Developer certificates present in the keychain WITHOUT a private key. */
export async function certificatesWithoutKeys(
  ctx: ToolContext,
  identities: KeychainIdentity[],
): Promise<CertificateDetails[]> {
  const have = new Set(identities.map((i) => i.sha1));
  const seen = new Set<string>();
  const out: CertificateDetails[] = [];
  for (const prefix of DEVELOPER_CERT_PREFIXES) {
    for (const c of await findCertificates(ctx, prefix)) {
      if (!have.has(c.sha1) && !seen.has(c.sha1) && c.commonName?.startsWith(prefix)) {
        seen.add(c.sha1);
        out.push(c);
      }
    }
  }
  return out;
}

export interface IntermediateStatus {
  name: string;
  url: string;
  neededFor: string;
  found: boolean;
}

export async function intermediateStatus(ctx: ToolContext): Promise<IntermediateStatus[]> {
  const results: IntermediateStatus[] = [];
  for (const im of APPLE_INTERMEDIATES) {
    const certs = [
      ...(await findCertificates(ctx, im.commonName)),
      ...(await findCertificates(ctx, im.commonName, "/Library/Keychains/System.keychain")),
    ];
    const wantOU = /\((G\d)\)/.exec(im.name)?.[1];
    const found = certs.some((c) =>
      wantOU === "G1"
        ? !c.organizationalUnit || /Certification Authority/.test(c.organizationalUnit)
        : c.organizationalUnit === wantOU,
    );
    results.push({ name: im.name, url: im.url, neededFor: im.neededFor, found });
  }
  return results;
}

/** Pick the best identity for a target/type: valid, not expired, latest expiry. */
export function pickIdentity(
  identities: EnrichedIdentity[],
  types: string[],
  teamId?: string,
): EnrichedIdentity | undefined {
  return identities
    .filter((i) => i.valid && i.type && types.includes(i.type) && (!teamId || i.teamId === teamId))
    .filter((i) => !i.certificate?.expired)
    .sort((a, b) => (b.certificate?.validTo ?? "").localeCompare(a.certificate?.validTo ?? ""))[0];
}

// ------------------------------------------------------------- signatures

export async function readSignedEntitlements(ctx: ToolContext, path: string): Promise<PlistDict | undefined> {
  const r = await ctx.runner.run("codesign", ["-d", "--entitlements", "-", "--xml", path], {
    timeoutMs: 30000,
  });
  let text = r.stdout;
  if (!ok(r) || !text.includes("<plist")) {
    const legacy = await ctx.runner.run("codesign", ["-d", "--entitlements", ":-", path], {
      timeoutMs: 30000,
    });
    text = legacy.stdout;
  }
  const start = text.indexOf("<?xml") >= 0 ? text.indexOf("<?xml") : text.indexOf("<plist");
  if (start === -1) return undefined;
  try {
    return parsePlistDict(text.slice(start));
  } catch {
    return undefined;
  }
}

export interface ComponentSignature {
  path: string;
  relativePath: string;
  kind: string;
  signer: SignerKind;
  identifier?: string;
  teamId?: string;
  authority?: string;
  hardenedRuntime: boolean;
  secureTimestamp: boolean;
  flags: string[];
  issues: string[];
}

export interface SignatureReport {
  path: string;
  artifactType: "bundle" | "binary" | "pkg" | "dmg";
  signed: boolean;
  signer: SignerKind;
  display?: CodeSignatureInfo;
  verify?: VerifyResult;
  entitlements?: PlistDict;
  embeddedProfile?: { path: string; name?: string; teamId?: string; type?: string; expiration?: string };
  nested: ComponentSignature[];
  nestedTruncated: boolean;
  pkg?: { status: string; notarized: boolean; chain: string[] };
  findings: Finding[];
}

const MAX_NESTED = 80;

/** Full signature inspection used by inspect_code_signature, notarization preflight, and checklists. */
export async function inspectSignature(
  ctx: ToolContext,
  path: string,
  opts: { target?: TargetId; deep?: boolean } = {},
): Promise<SignatureReport> {
  requireMacOS(ctx.platform, "Inspecting code signatures");
  const ext = extname(path).toLowerCase();
  if (ext === ".pkg") return inspectPkg(ctx, path);

  const isBundle = await isDirectory(path);
  const report: SignatureReport = {
    path,
    artifactType: ext === ".dmg" ? "dmg" : isBundle ? "bundle" : "binary",
    signed: false,
    signer: "unsigned",
    nested: [],
    nestedTruncated: false,
    findings: [],
  };

  const disp = await ctx.runner.run("codesign", ["-dvvv", path], { timeoutMs: 60000 });
  const display = parseCodesignDisplay(output(disp));
  report.display = display;
  report.signed = ok(disp) && display.isSigned;
  report.signer = report.signed ? signerKind(display) : "unsigned";

  const ver = await ctx.runner.run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", path], {
    timeoutMs: 180000,
    logName: "codesign-verify",
  });
  report.verify = parseCodesignVerify(output(ver), ver.code);

  if (report.signed && report.artifactType !== "dmg") {
    report.entitlements = await readSignedEntitlements(ctx, path);
  }

  if (isBundle) {
    for (const prof of ["Contents/embedded.provisionprofile", "embedded.mobileprovision"]) {
      const p = join(path, prof);
      if (await pathExists(p)) {
        try {
          const pl = await decodeProvisioningProfile(ctx.runner, p, ctx.platform.isMac);
          report.embeddedProfile = {
            path: prof,
            name: pl.Name as string,
            teamId: (pl.TeamIdentifier as string[] | undefined)?.[0],
            type: profileKind(pl),
            expiration: pl.ExpirationDate instanceof Date ? pl.ExpirationDate.toISOString() : undefined,
          };
        } catch {
          report.embeddedProfile = { path: prof };
        }
      }
    }
  }

  if (isBundle && opts.deep !== false) {
    const nested = (await discoverNestedCode(path)).filter((n) => n.relativePath !== ".");
    report.nestedTruncated = nested.length > MAX_NESTED;
    for (const n of nested.slice(0, MAX_NESTED)) {
      report.nested.push(await inspectComponent(ctx, n, display.teamIdentifier, report.signer));
    }
  }

  report.findings = signatureFindings(report, opts.target);
  return report;
}

async function inspectComponent(
  ctx: ToolContext,
  n: NestedCode,
  rootTeam?: string,
  rootSigner?: SignerKind,
): Promise<ComponentSignature> {
  const r = await ctx.runner.run("codesign", ["-dvvv", n.path], { timeoutMs: 30000 });
  const info = parseCodesignDisplay(output(r));
  const signed = ok(r) && info.isSigned;
  const signer = signed ? signerKind(info) : "unsigned";
  const issues: string[] = [];
  if (!signed) issues.push("unsigned");
  else {
    if (signer === "adhoc") issues.push("ad-hoc signature");
    if (!info.hardenedRuntime && ["executable", "app", "xpc", "appex", "systemextension"].includes(n.kind))
      issues.push("hardened runtime not enabled");
    if (rootSigner === "developer-id" && ["apple-development", "apple-distribution"].includes(signer))
      issues.push(`signed with ${info.authorities[0]} instead of Developer ID`);
    if (!info.hasSecureTimestamp && signer !== "apple") issues.push("no secure timestamp");
    if (rootTeam && info.teamIdentifier && info.teamIdentifier !== rootTeam && signer !== "apple")
      issues.push(`different Team ID (${info.teamIdentifier} vs ${rootTeam})`);
  }
  return {
    path: n.path,
    relativePath: n.relativePath,
    kind: n.kind,
    signer,
    identifier: info.identifier,
    teamId: info.teamIdentifier,
    authority: info.authorities[0],
    hardenedRuntime: info.hardenedRuntime,
    secureTimestamp: info.hasSecureTimestamp,
    flags: info.flags,
    issues,
  };
}

export function profileKind(pl: PlistDict): string {
  const ent = asDict(pl.Entitlements) ?? {};
  const platforms = (pl.Platform as string[] | undefined) ?? [];
  const isMac = platforms.includes("OSX") || platforms.includes("macOS");
  const hasDevices = Array.isArray(pl.ProvisionedDevices) && pl.ProvisionedDevices.length > 0;
  const getTaskAllow = ent["get-task-allow"] === true || ent["com.apple.security.get-task-allow"] === true;
  if (pl.ProvisionsAllDevices === true)
    return isMac ? "MAC_APP_DIRECT (Developer ID)" : "IOS_APP_INHOUSE (Enterprise)";
  if (getTaskAllow) return isMac ? "MAC_APP_DEVELOPMENT" : "IOS_APP_DEVELOPMENT";
  if (hasDevices) return isMac ? "MAC_APP_DEVELOPMENT/ADHOC" : "IOS_APP_ADHOC";
  return isMac ? "MAC_APP_STORE" : "IOS_APP_STORE";
}

function signatureFindings(r: SignatureReport, target?: TargetId): Finding[] {
  const f: Finding[] = [];
  const d = r.display;
  const ent = r.entitlements ?? {};
  if (!r.signed) {
    f.push(finding("error", "Not signed.", "Sign it with the sign tool."));
    return f;
  }
  if (r.verify && !r.verify.valid) {
    const known = matchKnownErrors(r.verify.messages.join("\n"));
    f.push(
      finding(
        "error",
        `Signature does not verify: ${r.verify.messages.slice(0, 3).join(" | ")}`,
        known[0]?.fix.join("; ") ?? "Re-sign after all modifications (sign tool).",
      ),
    );
    for (const p of r.verify.problemPaths.slice(0, 10)) f.push(finding("error", p.kind, undefined, p.path));
  }
  if (r.signer === "adhoc")
    f.push(finding("warning", "Ad-hoc signature (no identity). Fine for local testing only."));
  const isDist = !target || !["ios-development", "mac-development"].includes(target);
  if (isDist && (ent["com.apple.security.get-task-allow"] === true || ent["get-task-allow"] === true)) {
    f.push(
      finding(
        "error",
        "get-task-allow entitlement present (debuggable build).",
        "Build the Release configuration; notarization and App Store reject this.",
      ),
    );
  }
  for (const k of RISKY_HARDENED_RUNTIME_EXCEPTIONS) {
    if (ent[k] === true)
      f.push(finding("warning", `Hardened-runtime exception ${k} is enabled.`, "Keep only if required."));
  }

  const devIdTarget = target === "mac-developer-id";
  if (devIdTarget || (!target && r.signer === "developer-id")) {
    if (r.signer !== "developer-id")
      f.push(
        finding(
          "error",
          `Signed with ${d?.authorities[0] ?? r.signer}, not Developer ID Application.`,
          "Re-sign with your Developer ID Application identity.",
        ),
      );
    if (r.artifactType !== "dmg" && !d?.hardenedRuntime)
      f.push(
        finding(
          "error",
          "Hardened runtime is not enabled.",
          "Sign with --options runtime (sign tool does this).",
        ),
      );
    if (!d?.hasSecureTimestamp) f.push(finding("error", "No secure timestamp.", "Sign with --timestamp."));
    if (r.artifactType === "bundle" && d?.notarizationTicket !== "stapled")
      f.push(
        finding(
          "info",
          "No stapled notarization ticket.",
          "notarize_and_staple (or staple after notarizing).",
        ),
      );
  }
  if (target === "mac-app-store" || target === "testflight-mac") {
    if (!["apple-distribution", "mac-app-store"].includes(r.signer))
      f.push(
        finding(
          "error",
          "Not signed with Apple Distribution.",
          "Export with method app-store-connect or sign with Apple Distribution.",
        ),
      );
    if (ent["com.apple.security.app-sandbox"] !== true)
      f.push(
        finding(
          "error",
          "App Sandbox not enabled (required for the Mac App Store).",
          "Add com.apple.security.app-sandbox (entitlements generate).",
        ),
      );
    if (!r.embeddedProfile)
      f.push(
        finding(
          "error",
          "No Contents/embedded.provisionprofile.",
          "Embed a MAC_APP_STORE profile (provisioning_profiles embed).",
        ),
      );
    if (!ent["com.apple.application-identifier"])
      f.push(
        finding(
          "warning",
          "Missing com.apple.application-identifier entitlement (required for TestFlight).",
          "Sign with the profile's entitlements.",
        ),
      );
  }
  if (target === "ios-app-store" || target === "testflight-ios" || target === "ios-ad-hoc") {
    if (!["apple-distribution"].includes(r.signer))
      f.push(
        finding(
          "error",
          "Not signed with Apple Distribution.",
          "Export with the right method (xcode export).",
        ),
      );
    if (!r.embeddedProfile) f.push(finding("error", "No embedded.mobileprovision."));
  }

  // Restricted entitlements without a profile (macOS)
  const restricted = Object.keys(ent).filter(
    (k) =>
      k.startsWith("com.apple.developer.") ||
      k === "keychain-access-groups" ||
      k === "com.apple.application-identifier",
  );
  if (restricted.length && r.artifactType === "bundle" && !r.embeddedProfile) {
    f.push(
      finding(
        "error",
        `Restricted entitlements (${restricted.slice(0, 4).join(", ")}) require an embedded provisioning profile; the app will be killed at launch.`,
        "Create a profile with these capabilities (asc_profiles) and embed it (provisioning_profiles embed), or drop the entitlements.",
      ),
    );
  }

  const badNested = r.nested.filter((n) => n.issues.length);
  for (const n of badNested.slice(0, 20)) {
    const severity = n.issues.some((i) => i === "unsigned" || i.startsWith("different Team"))
      ? "error"
      : "warning";
    f.push(
      finding(
        severity,
        `Nested ${n.kind}: ${n.issues.join(", ")}`,
        "Sign nested code inside-out (sign tool).",
        n.relativePath,
      ),
    );
  }
  if (badNested.length > 20)
    f.push(finding("warning", `…and ${badNested.length - 20} more nested items with issues.`));
  if (r.nestedTruncated)
    f.push(finding("info", `Only the first ${MAX_NESTED} nested code items were inspected.`));
  return f;
}

async function inspectPkg(ctx: ToolContext, path: string): Promise<SignatureReport> {
  const r = await ctx.runner.run("pkgutil", ["--check-signature", path], { timeoutMs: 60000 });
  const text = output(r);
  const status = /Status:\s*(.+)/.exec(text)?.[1]?.trim() ?? (ok(r) ? "signed" : "no signature");
  const notarized = /Notarization:\s*trusted by the Apple notary service/i.test(text);
  const chain = [...text.matchAll(/^\s*\d+\.\s*(.+)$/gm)].map((m) => m[1].trim());
  const signed = !/no signature/i.test(status) && ok(r);
  const leaf = chain[0] ?? "";
  const findings: Finding[] = [];
  if (!signed)
    findings.push(
      finding(
        "error",
        "Package is not signed.",
        "package action=pkg (productsign) with a Developer ID Installer or Mac Installer Distribution identity.",
      ),
    );
  else if (
    !/^Developer ID Installer|^3rd Party Mac Developer Installer|^Mac Installer Distribution/.test(leaf)
  )
    findings.push(finding("warning", `Signed by "${leaf}" — expected an Installer certificate.`));
  if (signed && /^Developer ID Installer/.test(leaf) && !notarized)
    findings.push(finding("info", "Not notarized (or ticket not stapled).", "notarize_and_staple"));
  return {
    path,
    artifactType: "pkg",
    signed,
    signer: signed ? (/^Developer ID/.test(leaf) ? "developer-id" : "unknown") : "unsigned",
    nested: [],
    nestedTruncated: false,
    pkg: { status, notarized, chain },
    findings,
  };
}

/** For .ipa: extract to a temp dir and return the Payload/*.app path. */
export async function extractIpa(ctx: ToolContext, ipa: string): Promise<string> {
  const dir = await scratchDir("ipa");
  const r = ctx.platform.isMac
    ? await ctx.runner.run("ditto", ["-x", "-k", ipa, dir], { timeoutMs: 300000 })
    : await ctx.runner.run("unzip", ["-q", ipa, "-d", dir], { timeoutMs: 300000 });
  if (!ok(r)) throw new ToolError(`Could not extract ${basename(ipa)}: ${output(r)}`);
  const payload = join(dir, "Payload");
  const apps = (await readdir(payload)).filter((f) => f.endsWith(".app"));
  if (!apps.length) throw new ToolError("No .app found in Payload/ of the IPA.");
  return join(payload, apps[0]);
}
