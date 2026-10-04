import { copyFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { cmdStep, type Plan, type PlanStep } from "../core/confirm";
import { ok, output } from "../core/exec";
import { FOREGROUND_SECONDS } from "../core/jobs";
import { requireMacOS } from "../core/platform";
import {
  asDict,
  buildPlist,
  decodeProvisioningProfile,
  type PlistDict,
  type PlistValue,
} from "../core/plist";
import { ToolError } from "../core/result";
import { formatMatches, matchKnownErrors } from "../knowledge/error-catalog";
import { TARGET_IDS, TARGETS, type TargetId } from "../knowledge/targets";
import { discoverNestedCode, type NestedCode } from "../parsers/macho";
import { detachedOutput } from "./detached";
import {
  formatFindings,
  inspectSignature,
  isDirectory,
  listIdentities,
  pathExists,
  pickIdentity,
  readSignedEntitlements,
  resolveUserPath,
  scratchDir,
} from "./shared";
import { defineTool, type ToolContext, withConfirmation } from "./types";

export interface SignSettings {
  identity: string;
  keychain?: string;
  runtime: boolean;
  timestamp: boolean;
  /** Entitlements for the outermost item. */
  entitlements?: string;
  /** relativePath → entitlements file for nested items. */
  nestedEntitlements?: Record<string, string>;
  /** Entitlements for nested executables / helper apps / XPC services without an explicit entry. */
  defaultNestedEntitlements?: string;
  /** Keep existing entitlements of nested items that have no explicit file. */
  preserveNestedEntitlements: boolean;
  nested: boolean;
}

export interface SignStep {
  path: string;
  relativePath: string;
  kind: string;
  args: string[];
}

const ENTITLED_KINDS = new Set(["app", "xpc", "appex", "executable", "systemextension"]);

export function codesignArgs(
  item: NestedCode | { path: string; kind: string; relativePath: string },
  s: SignSettings,
  isRoot: boolean,
): string[] {
  const adhoc = s.identity === "-";
  const args = ["--force", "--sign", s.identity];
  if (s.keychain) args.push("--keychain", s.keychain);
  if (s.timestamp && !adhoc) args.push("--timestamp");
  if (s.runtime && item.kind !== "dmg") args.push("--options", "runtime");
  let ent: string | undefined;
  if (isRoot) ent = s.entitlements;
  else
    ent =
      s.nestedEntitlements?.[item.relativePath] ??
      (ENTITLED_KINDS.has(item.kind) ? s.defaultNestedEntitlements : undefined);
  if (ent) args.push("--entitlements", ent);
  else if (!isRoot && s.preserveNestedEntitlements && ENTITLED_KINDS.has(item.kind))
    args.push("--preserve-metadata=entitlements");
  args.push(item.path);
  return args;
}

export async function buildSignSteps(root: string, s: SignSettings): Promise<SignStep[]> {
  const ext = extname(root).toLowerCase();
  if (ext === ".dmg") {
    return [
      {
        path: root,
        relativePath: basename(root),
        kind: "dmg",
        args: codesignArgs({ path: root, kind: "dmg", relativePath: "." }, { ...s, runtime: false }, true),
      },
    ];
  }
  const items =
    s.nested && (await isDirectory(root))
      ? await discoverNestedCode(root)
      : [{ path: root, relativePath: ".", kind: "executable" as const, depth: 0 }];
  return items.map((it) => ({
    path: it.path,
    relativePath: it.relativePath,
    kind: it.kind,
    args: codesignArgs(it, s, it.relativePath === "." || it.path === root),
  }));
}

export async function runSignSteps(
  ctx: ToolContext,
  steps: SignStep[],
  onProgress?: (msg: string) => void,
): Promise<{ signed: number; failed?: { step: SignStep; output: string } }> {
  let n = 0;
  for (const step of steps) {
    onProgress?.(`codesign ${step.relativePath} (${n + 1}/${steps.length})`);
    // The first signature is where macOS shows a keychain access dialog if the key
    // isn't pre-authorized for codesign; nobody can click it in unattended runs, so
    // fail fast instead of hanging for minutes per item.
    const timeoutMs = n === 0 && step.args[2] !== "-" ? codesignPromptTimeoutMs() : 300000;
    const r = await ctx.runner.run("codesign", step.args, { timeoutMs, logName: "codesign" });
    if (r.timedOut && n === 0) {
      return { signed: 0, failed: { step, output: KEYCHAIN_PROMPT_MESSAGE } };
    }
    if (!ok(r)) return { signed: n, failed: { step, output: output(r) } };
    n++;
  }
  return { signed: n };
}

export const KEYCHAIN_PROMPT_MESSAGE =
  "codesign timed out waiting for keychain access (keychain access prompt). macOS is probably showing a dialog asking to allow codesign to use the private key, or the keychain is locked. Fix: click 'Always Allow' on the Mac's screen; or unlock it (security unlock-keychain ~/Library/Keychains/login.keychain-db); or pre-authorize codesign once: security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <keychain password> ~/Library/Keychains/login.keychain-db. Over SSH or in CI nobody can answer the dialog — unlock the keychain first.";

export function codesignPromptTimeoutMs(): number {
  const s = Number(process.env.NOTARIZE_MCP_CODESIGN_PROMPT_TIMEOUT);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 45000;
}

/** Resolve "auto"/name/SHA-1 into an identity string, defaulting by target. */
export async function resolveIdentity(
  ctx: ToolContext,
  identity: string | undefined,
  target: TargetId | undefined,
  teamId?: string,
): Promise<string> {
  if (identity && identity !== "auto") return identity;
  if (!target)
    throw new ToolError("identity is required (name, SHA-1, '-' for ad-hoc, or 'auto' with a target).");
  const ids = await listIdentities(ctx);
  const t = TARGETS[target];
  const types = t.certificates[0].alternatives;
  const pick = pickIdentity(ids, types, teamId);
  if (!pick)
    throw new ToolError(`No valid ${types.join(" / ")} identity in the keychain for ${target}.`, {
      hint: "signing_identities shows what you have; keychain create_csr → asc_certificates create (or the developer portal for Developer ID).",
    });
  // Use the SHA-1 to avoid "ambiguous" errors when names repeat.
  return pick.sha1;
}

function signPlan(
  title: string,
  steps: SignStep[],
  extraSteps: PlanStep[] = [],
  warnings: string[] = [],
): Plan {
  const shown = steps.length > 40 ? [...steps.slice(0, 20), ...steps.slice(-5)] : steps;
  return {
    title,
    steps: [
      ...extraSteps,
      ...shown.map((s) => cmdStep(`Sign ${s.kind} ${s.relativePath}`, "codesign", s.args)),
      ...(steps.length > shown.length
        ? [{ description: `… ${steps.length - shown.length} more nested items (inside-out order)` }]
        : []),
      { description: "Verify: codesign --verify --deep --strict, then report readiness findings" },
    ],
    warnings,
  };
}

export const signTool = defineTool({
  name: "sign",
  title: "Code sign an app, bundle, binary or DMG (inside-out)",
  description:
    "Signs nested code deepest-first (frameworks, dylibs, helpers, XPC services, app extensions, extra Mach-Os, Node .node modules) and then the outer bundle — never relying on --deep. Defaults for distribution: hardened runtime (--options runtime) and secure timestamp. identity can be a keychain name, SHA-1, '-' (ad-hoc, local testing only) or 'auto' with a target (picks the newest valid Developer ID Application / Apple Distribution / Apple Development identity). Supports per-component entitlements (e.g. Electron helpers), preserving nested entitlements, clearing extended attributes first, and embedding a provisioning profile. Preview → confirm.",
  mutating: true,
  input: {
    path: z.string().describe(".app / .framework / .appex / .xpc / Mach-O binary / .dmg"),
    identity: z
      .string()
      .optional()
      .describe("Identity name, SHA-1, '-' for ad-hoc, or 'auto' (needs target)."),
    target: z
      .enum(TARGET_IDS)
      .optional()
      .describe("Distribution target (drives identity choice and readiness checks)."),
    team_id: z.string().optional().describe("Restrict 'auto' identity selection to this team."),
    entitlements: z.string().optional().describe("Entitlements plist for the outer bundle/binary."),
    nested_entitlements: z
      .record(z.string(), z.string())
      .optional()
      .describe("Map of nested relative path → entitlements plist."),
    default_nested_entitlements: z
      .string()
      .optional()
      .describe(
        "Entitlements for nested executables/helper apps without an explicit entry (e.g. Electron's entitlementsInherit).",
      ),
    preserve_nested_entitlements: z
      .boolean()
      .optional()
      .describe("Keep existing entitlements on nested items without an explicit file (default true)."),
    hardened_runtime: z.boolean().optional().describe("Default true (required for notarization)."),
    timestamp: z.boolean().optional().describe("Default true unless ad-hoc."),
    sign_nested: z.boolean().optional().describe("Sign nested code inside-out first (default true)."),
    clear_xattrs: z.boolean().optional().describe("Run xattr -cr before signing (default true)."),
    embed_profile: z.string().optional().describe("Provisioning profile to embed before signing."),
    keychain: z.string().optional().describe("Keychain containing the identity."),
    max_wait_seconds: z
      .number()
      .int()
      .min(5)
      .max(3600)
      .optional()
      .describe("Foreground wait before continuing as a background job (default 90)."),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "Code signing");
    const path = await resolveUserPath(ctx, args.path);
    if (extname(path).toLowerCase() === ".pkg")
      throw new ToolError("Installer packages are signed with productsign — use package action=sign_pkg.");
    const resolve = async (p?: string) => (p ? resolveUserPath(ctx, p) : undefined);
    const identity = await resolveIdentity(ctx, args.identity, args.target, args.team_id);
    const isIos = !!args.target && TARGETS[args.target].platform === "iOS";
    const settings: SignSettings = {
      identity,
      keychain: await resolve(args.keychain),
      runtime: args.hardened_runtime ?? !isIos,
      timestamp: args.timestamp ?? identity !== "-",
      entitlements: await resolve(args.entitlements),
      nestedEntitlements: args.nested_entitlements
        ? Object.fromEntries(
            await Promise.all(
              Object.entries(args.nested_entitlements).map(
                async ([k, v]) => [k, (await resolve(v))!] as const,
              ),
            ),
          )
        : undefined,
      defaultNestedEntitlements: await resolve(args.default_nested_entitlements),
      preserveNestedEntitlements: args.preserve_nested_entitlements ?? true,
      nested: args.sign_nested ?? true,
    };
    const steps = await buildSignSteps(path, settings);
    const isBundle = await isDirectory(path);
    const pre: PlanStep[] = [];
    const profile = await resolve(args.embed_profile);
    const profileDest =
      profile && isBundle
        ? (await pathExists(join(path, "Contents")))
          ? join(path, "Contents", "embedded.provisionprofile")
          : join(path, "embedded.mobileprovision")
        : undefined;
    if (profileDest) pre.push({ description: `Embed ${basename(profile!)} at ${profileDest}` });
    if (args.clear_xattrs !== false && isBundle)
      pre.push(cmdStep("Remove extended attributes (avoids 'detritus' errors)", "xattr", ["-cr", path]));
    const warnings: string[] = [];
    if (identity === "-")
      warnings.push("Ad-hoc signatures are only valid on this Mac; they cannot be notarized or distributed.");
    if (args.target === "mac-developer-id" && !settings.runtime)
      warnings.push("Hardened runtime disabled — notarization will fail.");

    return withConfirmation(
      ctx,
      extra,
      args,
      () => signPlan(`Sign ${basename(path)} with ${identity}`, steps, pre, warnings),
      async () => {
        const job = await ctx.jobs.runWithDeadline(
          "sign",
          `Sign ${basename(path)}`,
          (args.max_wait_seconds ?? FOREGROUND_SECONDS) * 1000,
          async (j) => {
            if (profileDest) await copyFile(profile!, profileDest);
            if (args.clear_xattrs !== false && isBundle)
              await ctx.runner.run("xattr", ["-cr", path], { timeoutMs: 120000 });
            const res = await runSignSteps(ctx, steps, (m) => {
              j.progress(m);
              void extra.progress(m);
            });
            if (res.failed) {
              const known = matchKnownErrors(res.failed.output);
              return {
                summary: `Signing FAILED at ${res.failed.step.relativePath} (after ${res.signed} item(s)):\n${res.failed.output.slice(0, 1500)}${known.length ? `\n\n${formatMatches(known)}` : ""}`,
                data: {
                  signed: res.signed,
                  failedAt: res.failed.step.relativePath,
                  output: res.failed.output,
                  knownErrors: known,
                },
                isError: true,
              };
            }
            const report = await inspectSignature(ctx, path, {
              target: args.target,
              deep: steps.length < 200,
            });
            return {
              summary: `Signed ${res.signed} item(s) in ${basename(path)}. Verify: ${report.verify?.valid ? "valid" : "INVALID"}.\n${formatFindings(report.findings) || "No problems found."}`,
              data: {
                signed: res.signed,
                verify: report.verify?.valid,
                findings: report.findings,
                signer: report.signer,
              },
              next_steps:
                args.target === "mac-developer-id" || (!args.target && report.signer === "developer-id")
                  ? ["package action=dmg (optional)", "notarize_and_staple path=<app or dmg>"]
                  : ["inspect_code_signature to review"],
            };
          },
        );
        if (!job.done) return detachedOutput(ctx, job.jobId, `Signing ${basename(path)}`);
        return job.value;
      },
    );
  },
});

// ------------------------------------------------------------------ resign

/** Entitlements to sign with when (re)signing for a profile. */
export function entitlementsFromProfile(
  profile: PlistDict,
  existing?: PlistDict,
  target?: TargetId,
): PlistDict {
  const granted = asDict(profile.Entitlements) ?? {};
  const out: PlistDict = {};
  // Start from the app's existing entitlements (minus identity keys), then apply the profile's identity keys.
  for (const [k, v] of Object.entries(existing ?? {})) {
    if (
      /application-identifier|team-identifier|get-task-allow|keychain-access-groups|aps-environment/.test(k)
    )
      continue;
    out[k] = v;
  }
  for (const k of [
    "application-identifier",
    "com.apple.application-identifier",
    "com.apple.developer.team-identifier",
    "aps-environment",
    "com.apple.developer.aps-environment",
    "get-task-allow",
    "com.apple.security.get-task-allow",
    "beta-reports-active",
  ]) {
    if (granted[k] !== undefined) out[k] = granted[k];
  }
  if (Array.isArray(granted["keychain-access-groups"])) {
    // Default to the app's own access group (<TEAMID>.<bundle-id>).
    const appId = (out["application-identifier"] ?? out["com.apple.application-identifier"]) as
      | string
      | undefined;
    if (appId) out["keychain-access-groups"] = [appId];
  }
  if (target && TARGETS[target].forbiddenEntitlements.length)
    for (const k of TARGETS[target].forbiddenEntitlements) delete out[k];
  return out;
}

export const resignTool = defineTool({
  name: "resign",
  title: "Re-sign a prebuilt .app or .ipa for a new identity/profile",
  description:
    "Re-signs a prebuilt artifact you have rights to distribute (no source needed): copies it to output_path, optionally replaces the embedded provisioning profile, derives entitlements from the profile (keeping existing capability entitlements, swapping application/team identifiers, dropping get-task-allow for distribution), signs inside-out, and repackages .ipa files. App extensions inside an IPA need their own profiles via extension_profiles. Preview → confirm.",
  mutating: true,
  input: {
    path: z.string().describe(".app or .ipa to re-sign (left untouched; a copy is written)."),
    output_path: z
      .string()
      .optional()
      .describe("Where to write the re-signed artifact (default <name>-resigned.<ext> next to the input)."),
    identity: z.string().optional().describe("Identity name / SHA-1 / 'auto' (with target)."),
    target: z.enum(TARGET_IDS).optional(),
    profile: z.string().optional().describe("New provisioning profile for the main app."),
    extension_profiles: z
      .record(z.string(), z.string())
      .optional()
      .describe("Bundle-relative path of each .appex → profile."),
    entitlements: z
      .string()
      .optional()
      .describe("Explicit entitlements for the main app (otherwise derived)."),
    max_wait_seconds: z
      .number()
      .int()
      .min(5)
      .max(3600)
      .optional()
      .describe("Foreground wait before continuing as a background job (default 90)."),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "Re-signing");
    const src = await resolveUserPath(ctx, args.path);
    const ext = extname(src).toLowerCase();
    if (ext === ".xcarchive")
      throw new ToolError("For .xcarchive use xcode action=export with the export method you need.");
    if (ext !== ".app" && ext !== ".ipa") throw new ToolError("resign supports .app and .ipa.");
    const out = args.output_path
      ? await resolveUserPath(ctx, args.output_path, false)
      : join(dirname(src), `${basename(src, ext)}-resigned${ext}`);
    const identity = await resolveIdentity(ctx, args.identity, args.target);
    const profile = args.profile ? await resolveUserPath(ctx, args.profile) : undefined;
    const isDist = !args.target || !["ios-development", "mac-development"].includes(args.target);

    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Re-sign ${basename(src)} → ${out}`,
        steps: [
          {
            description: ext === ".ipa" ? "Extract the IPA to a temporary folder" : `Copy the app to ${out}`,
          },
          ...(profile
            ? [{ description: `Embed ${basename(profile)} and derive entitlements from it` }]
            : [{ description: "Keep the existing embedded profile / entitlements" }]),
          ...Object.entries(args.extension_profiles ?? {}).map(([p, prof]) => ({
            description: `Embed ${basename(prof)} into ${p}`,
          })),
          {
            description: `Sign all nested code inside-out with ${identity}${isDist ? " (hardened runtime + timestamp for macOS)" : ""}`,
          },
          ...(ext === ".ipa" ? [{ description: `Zip Payload/ into ${out}` }] : []),
        ],
        warnings: ["Only re-sign software you own or are licensed to redistribute."],
      }),
      async () => {
        const job = await ctx.jobs.runWithDeadline(
          "resign",
          `Re-sign ${basename(src)}`,
          (args.max_wait_seconds ?? FOREGROUND_SECONDS) * 1000,
          async (j) => {
            const work = await scratchDir("resign");
            let app: string;
            if (ext === ".ipa") {
              const x = await ctx.runner.run("ditto", ["-x", "-k", src, work], { timeoutMs: 600000 });
              if (!ok(x)) throw new ToolError(`Extract failed: ${output(x)}`);
              const apps = (await readdir(join(work, "Payload"))).filter((f) => f.endsWith(".app"));
              if (!apps[0]) throw new ToolError("No app in Payload/.");
              app = join(work, "Payload", apps[0]);
            } else {
              const c = await ctx.runner.run("ditto", [src, out], { timeoutMs: 600000 });
              if (!ok(c)) throw new ToolError(`Copy failed: ${output(c)}`);
              app = out;
            }
            const isMacApp = await pathExists(join(app, "Contents"));
            const profilePath = isMacApp
              ? join(app, "Contents", "embedded.provisionprofile")
              : join(app, "embedded.mobileprovision");
            const entDir = await scratchDir("resign-ent");
            const nestedEnt: Record<string, string> = {};

            // Extensions first
            for (const [rel, prof] of Object.entries(args.extension_profiles ?? {})) {
              const appex = join(app, rel);
              const pp = await resolveUserPath(ctx, prof);
              const dest = isMacApp
                ? join(appex, "Contents", "embedded.provisionprofile")
                : join(appex, "embedded.mobileprovision");
              await copyFile(pp, dest);
              const pl = await decodeProvisioningProfile(ctx.runner, pp, true);
              const existing = await readSignedEntitlements(ctx, appex);
              const f = join(entDir, `${basename(rel)}.plist`);
              await writeFile(
                f,
                buildPlist(entitlementsFromProfile(pl, existing, args.target) as PlistValue),
              );
              nestedEnt[rel] = f;
            }

            let mainEnt = args.entitlements ? await resolveUserPath(ctx, args.entitlements) : undefined;
            if (!mainEnt) {
              const existing = await readSignedEntitlements(ctx, app);
              let derived: PlistDict | undefined = existing;
              if (profile) {
                await copyFile(profile, profilePath);
                derived = entitlementsFromProfile(
                  await decodeProvisioningProfile(ctx.runner, profile, true),
                  existing,
                  args.target,
                );
              } else if (existing && isDist) {
                derived = { ...existing };
                delete derived["get-task-allow"];
                delete derived["com.apple.security.get-task-allow"];
              }
              if (derived) {
                mainEnt = join(entDir, "main.plist");
                await writeFile(mainEnt, buildPlist(derived as PlistValue));
              }
            } else if (profile) await copyFile(profile, profilePath);

            await ctx.runner.run("xattr", ["-cr", app], { timeoutMs: 120000 });
            const steps = await buildSignSteps(app, {
              identity,
              runtime: isMacApp,
              timestamp: identity !== "-",
              entitlements: mainEnt,
              nestedEntitlements: nestedEnt,
              preserveNestedEntitlements: true,
              nested: true,
            });
            const res = await runSignSteps(ctx, steps, (m) => j.progress(m));
            if (res.failed) {
              const known = matchKnownErrors(res.failed.output);
              return {
                summary: `Re-signing FAILED at ${res.failed.step.relativePath}:\n${res.failed.output.slice(0, 1500)}\n${formatMatches(known)}`,
                data: { failedAt: res.failed.step.relativePath },
                isError: true,
              };
            }
            if (ext === ".ipa") {
              const z1 = await ctx.runner.run(
                "ditto",
                ["-c", "-k", "--sequesterRsrc", "--keepParent", join(work, "Payload"), out],
                { timeoutMs: 600000 },
              );
              if (!ok(z1)) throw new ToolError(`Zip failed: ${output(z1)}`);
            }
            const report = await inspectSignature(ctx, app, { target: args.target });
            return {
              summary: `Re-signed ${res.signed} item(s) → ${out}. Verify: ${report.verify?.valid ? "valid" : "INVALID"}.\n${formatFindings(report.findings)}`,
              data: { output: out, signed: res.signed, findings: report.findings },
            };
          },
        );
        if (!job.done) return detachedOutput(ctx, job.jobId, `Re-signing ${basename(src)}`);
        return job.value;
      },
    );
  },
});
