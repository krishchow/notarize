import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { cmdStep } from "../core/confirm";
import { ok, output } from "../core/exec";
import { compareVersions, requireMacOS, xcodeInfo } from "../core/platform";
import { buildPlist, type PlistValue } from "../core/plist";
import { ToolError } from "../core/result";
import { formatMatches, matchKnownErrors } from "../knowledge/error-catalog";
import { TARGET_IDS, TARGETS, type TargetId } from "../knowledge/targets";
import { parseShowBuildSettings, parseXcodeList, summarizeXcodebuild } from "../parsers/xcodebuild";
import { detachedOutput } from "./detached";
import { type Finding, finding, formatFindings, isDirectory, resolveUserPath } from "./shared";
import { defineTool, profileArg, type ToolContext, withConfirmation } from "./types";

async function containerArgs(
  ctx: ToolContext,
  path: string,
): Promise<{ flag: "-workspace" | "-project"; path: string }> {
  const p = await resolveUserPath(ctx, path);
  if (p.endsWith(".xcworkspace")) return { flag: "-workspace", path: p };
  if (p.endsWith(".xcodeproj")) return { flag: "-project", path: p };
  if (await isDirectory(p)) {
    const entries = await readdir(p);
    const ws = entries.find((e) => e.endsWith(".xcworkspace"));
    if (ws) return { flag: "-workspace", path: join(p, ws) };
    const proj = entries.find((e) => e.endsWith(".xcodeproj"));
    if (proj) return { flag: "-project", path: join(p, proj) };
  }
  throw new ToolError(`No .xcworkspace or .xcodeproj at ${p}.`, {
    hint: "Flutter: ios/Runner.xcworkspace or macos/Runner.xcworkspace; React Native: ios/<Name>.xcworkspace (run pod install first).",
  });
}

/** -allowProvisioningUpdates with API-key auth so automatic signing works without an Xcode login. */
async function authArgs(ctx: ToolContext, profile?: string): Promise<string[]> {
  try {
    const c = await ctx.config.resolveAsc(profile);
    if (!c.privateKeyPath || !c.issuerId) return ["-allowProvisioningUpdates"];
    return [
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      c.privateKeyPath,
      "-authenticationKeyID",
      c.keyId,
      "-authenticationKeyIssuerID",
      c.issuerId,
    ];
  } catch {
    return ["-allowProvisioningUpdates"];
  }
}

export async function exportMethodFor(ctx: ToolContext, target: TargetId): Promise<string> {
  const t = TARGETS[target];
  const xc = ctx.platform.isMac ? await xcodeInfo(ctx.runner) : undefined;
  // Xcode 15.3 renamed app-store → app-store-connect, ad-hoc → release-testing, development → debugging.
  if (xc?.xcodeVersion && compareVersions(xc.xcodeVersion, "15.3") < 0 && t.legacyExportMethod)
    return t.legacyExportMethod;
  return t.exportMethod;
}

export function exportOptions(opts: {
  method: string;
  destination: "export" | "upload";
  teamId?: string;
  signingStyle: "automatic" | "manual";
  provisioningProfiles?: Record<string, string>;
  signingCertificate?: string;
}): Record<string, PlistValue> {
  const o: Record<string, PlistValue> = {
    method: opts.method,
    destination: opts.destination,
    signingStyle: opts.signingStyle,
  };
  if (opts.teamId) o.teamID = opts.teamId;
  if (opts.signingStyle === "manual") {
    if (opts.provisioningProfiles) o.provisioningProfiles = opts.provisioningProfiles;
    if (opts.signingCertificate) o.signingCertificate = opts.signingCertificate;
  }
  if (["app-store-connect", "app-store"].includes(opts.method)) {
    o.uploadSymbols = true;
    o.manageAppVersionAndBuildNumber = false;
  }
  return o;
}

export const xcodeTool = defineTool({
  name: "xcode",
  title: "Xcode: schemes, signing settings, archive, export / upload",
  description:
    "action=schemes: list schemes/targets/configurations. action=signing_settings: signing-related build settings per target (team, style, identity, profile, hardened runtime, entitlements, versions) with problems flagged. action=archive (confirm): `xcodebuild archive` for generic/platform=macOS|iOS with automatic signing + -allowProvisioningUpdates using the App Store Connect API key (Xcode then creates/fetches certificates and profiles itself — the easiest path), optional team/settings overrides; runs as a background job with a Monitor command if slow. action=export (confirm): writes ExportOptions.plist for the target (developer-id, app-store-connect, release-testing, debugging, enterprise) and runs -exportArchive; destination=upload sends it straight to App Store Connect.",
  mutating: true,
  input: {
    action: z.enum(["schemes", "signing_settings", "archive", "export"]),
    path: z
      .string()
      .optional()
      .describe(".xcworkspace / .xcodeproj or the folder containing it (schemes/signing_settings/archive)."),
    scheme: z.string().optional(),
    configuration: z.string().optional().describe("Default Release."),
    target: z.enum(TARGET_IDS).optional().describe("Distribution target (platform + export method)."),
    team_id: z.string().optional(),
    archive_path: z.string().optional().describe("archive output / export input (.xcarchive)."),
    export_path: z.string().optional().describe("export: output folder."),
    destination: z
      .enum(["export", "upload"])
      .optional()
      .describe("export: 'upload' sends the build to App Store Connect."),
    signing_style: z.enum(["automatic", "manual"]).optional().describe("Default automatic."),
    provisioning_profiles: z
      .record(z.string(), z.string())
      .optional()
      .describe("manual: bundle ID → profile name or UUID."),
    signing_certificate: z
      .string()
      .optional()
      .describe("manual: e.g. 'Apple Distribution' or 'Developer ID Application'."),
    build_settings: z
      .record(z.string(), z.string())
      .optional()
      .describe("Extra KEY=VALUE overrides (e.g. CURRENT_PROJECT_VERSION)."),
    allow_provisioning_updates: z
      .boolean()
      .optional()
      .describe("Let Xcode create/download certificates and profiles (default true)."),
    profile: profileArg,
    max_wait_seconds: z
      .number()
      .int()
      .min(5)
      .max(3600)
      .optional()
      .describe("Foreground wait before handing off to a background job (default 120)."),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "xcodebuild");
    const configuration = args.configuration ?? "Release";

    if (args.action === "schemes") {
      if (!args.path) throw new ToolError("path is required.");
      const c = await containerArgs(ctx, args.path);
      const r = await ctx.runner.run("xcodebuild", ["-list", "-json", c.flag, c.path], { timeoutMs: 180000 });
      const list = parseXcodeList(r.stdout);
      if (!list) throw new ToolError(`xcodebuild -list failed: ${output(r).slice(0, 800)}`);
      return {
        summary: `${list.kind} ${list.name}\nSchemes: ${list.schemes.join(", ")}\nTargets: ${list.targets.join(", ") || "(see project)"}\nConfigurations: ${list.configurations.join(", ") || "Debug, Release"}`,
        data: { ...list, container: c },
      };
    }

    if (args.action === "signing_settings") {
      if (!args.path || !args.scheme) throw new ToolError("path and scheme are required.");
      const c = await containerArgs(ctx, args.path);
      const r = await ctx.runner.run(
        "xcodebuild",
        [
          "-showBuildSettings",
          "-json",
          c.flag,
          c.path,
          "-scheme",
          args.scheme,
          "-configuration",
          configuration,
        ],
        { timeoutMs: 300000 },
      );
      const targets = parseShowBuildSettings(r.stdout);
      if (!targets.length)
        throw new ToolError(`xcodebuild -showBuildSettings failed: ${output(r).slice(0, 800)}`);
      const findings: Finding[] = [];
      for (const t of targets) {
        const s = t.settings;
        const isApp =
          s.WRAPPER_EXTENSION === "app" || s.PRODUCT_TYPE === "com.apple.product-type.application";
        if (!s.DEVELOPMENT_TEAM)
          findings.push(
            finding(
              "error",
              `${t.target}: DEVELOPMENT_TEAM not set.`,
              "Pass team_id to archive or set it in Signing & Capabilities.",
            ),
          );
        if (s.PLATFORM_NAME === "macosx" && isApp && s.ENABLE_HARDENED_RUNTIME !== "YES")
          findings.push(
            finding(
              "warning",
              `${t.target}: ENABLE_HARDENED_RUNTIME is not YES (required for notarization).`,
            ),
          );
        if (
          s.CODE_SIGN_STYLE === "Manual" &&
          !s.PROVISIONING_PROFILE_SPECIFIER &&
          s.PLATFORM_NAME !== "macosx"
        )
          findings.push(
            finding("warning", `${t.target}: manual signing without PROVISIONING_PROFILE_SPECIFIER.`),
          );
        if (s.CODE_SIGN_STYLE === "Automatic" && s.PROVISIONING_PROFILE_SPECIFIER)
          findings.push(
            finding(
              "error",
              `${t.target}: automatic signing but PROVISIONING_PROFILE_SPECIFIER is set (conflicting provisioning settings).`,
              "Clear PROVISIONING_PROFILE_SPECIFIER or switch to manual.",
            ),
          );
      }
      return {
        summary: `${targets.length} target(s) for scheme ${args.scheme} (${configuration}):\n${targets
          .map(
            (t) =>
              `• ${t.target}: ${t.settings.PRODUCT_BUNDLE_IDENTIFIER ?? "?"} team=${t.settings.DEVELOPMENT_TEAM ?? "—"} style=${t.settings.CODE_SIGN_STYLE ?? "?"} identity=${t.settings.CODE_SIGN_IDENTITY ?? "?"} version=${t.settings.MARKETING_VERSION ?? "?"}(${t.settings.CURRENT_PROJECT_VERSION ?? "?"})`,
          )
          .join("\n")}${findings.length ? `\n\n${formatFindings(findings)}` : ""}`,
        data: { targets, findings },
      };
    }

    if (args.action === "archive") {
      if (!args.path || !args.scheme) throw new ToolError("path and scheme are required.");
      const c = await containerArgs(ctx, args.path);
      const platform = args.target ? TARGETS[args.target].platform : undefined;
      if (!platform) throw new ToolError("target is required for archive (it decides the platform).");
      const archivePath = args.archive_path
        ? await resolveUserPath(ctx, args.archive_path, false)
        : join(dirname(c.path), "build", `${args.scheme}.xcarchive`);
      const cmd = [
        "archive",
        c.flag,
        c.path,
        "-scheme",
        args.scheme,
        "-configuration",
        configuration,
        "-destination",
        `generic/platform=${platform}`,
        "-archivePath",
        archivePath,
        ...(args.allow_provisioning_updates === false ? [] : await authArgs(ctx, args.profile)),
        ...(args.team_id ? [`DEVELOPMENT_TEAM=${args.team_id}`] : []),
        ...(args.signing_style
          ? [`CODE_SIGN_STYLE=${args.signing_style === "manual" ? "Manual" : "Automatic"}`]
          : []),
        ...Object.entries(args.build_settings ?? {}).map(([k, v]) => `${k}=${v}`),
      ];
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Archive ${args.scheme} (${configuration}, ${platform})`,
          steps: [cmdStep("xcodebuild archive", "xcodebuild", cmd)],
          notes:
            args.allow_provisioning_updates === false
              ? []
              : [
                  "-allowProvisioningUpdates lets Xcode create Apple Development/Distribution certificates and provisioning profiles in your account if they are missing.",
                ],
        }),
        async () => {
          const job = await ctx.jobs.runWithDeadline(
            "archive",
            `Archive ${args.scheme}`,
            (args.max_wait_seconds ?? 120) * 1000,
            async (j) => {
              j.progress("xcodebuild archive running");
              const r = await ctx.runner.run("xcodebuild", cmd, {
                timeoutMs: 7200000,
                logName: "xcodebuild-archive",
                signal: j.signal,
                onOutput: (o) => j.log(o),
              });
              const sum = summarizeXcodebuild(output(r));
              if (!ok(r) || !sum.succeeded) {
                const known = matchKnownErrors(sum.errors.join("\n") || output(r));
                return {
                  summary: `Archive FAILED.\n${sum.errors.slice(0, 15).join("\n")}${known.length ? `\n\n${formatMatches(known)}` : ""}\nFull log: ${r.logPath ?? "(not written)"}`,
                  data: { errors: sum.errors, knownErrors: known, logPath: r.logPath },
                  isError: true,
                };
              }
              return {
                summary: `Archived to ${archivePath}.${sum.warnings.length ? ` (${sum.warnings.length} warnings)` : ""}`,
                data: { archivePath, warnings: sum.warnings.slice(0, 10), logPath: r.logPath },
                next_steps: [
                  `xcode action=export archive_path=${archivePath} target=${args.target}${TARGETS[args.target!].ascAppRecord ? " destination=upload" : ""}`,
                ],
              };
            },
          );
          if (!job.done)
            return detachedOutput(ctx, job.jobId, `xcodebuild archive of ${args.scheme}`, [
              "Archives typically take 1–20 minutes depending on project size.",
            ]);
          return job.value;
        },
      );
    }

    // export
    if (!args.archive_path || !args.target) throw new ToolError("archive_path and target are required.");
    const archive = await resolveUserPath(ctx, args.archive_path);
    const method = await exportMethodFor(ctx, args.target);
    const exportPath = args.export_path
      ? await resolveUserPath(ctx, args.export_path, false)
      : join(dirname(archive), `${basename(archive, extname(archive))}-${method}`);
    const opts = exportOptions({
      method,
      destination: args.destination ?? "export",
      teamId: args.team_id,
      signingStyle: args.signing_style ?? "automatic",
      provisioningProfiles: args.provisioning_profiles,
      signingCertificate: args.signing_certificate,
    });
    const optsPath = join(exportPath, "ExportOptions.plist");
    const cmd = [
      "-exportArchive",
      "-archivePath",
      archive,
      "-exportPath",
      exportPath,
      "-exportOptionsPlist",
      optsPath,
      ...(args.allow_provisioning_updates === false ? [] : await authArgs(ctx, args.profile)),
    ];
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Export ${basename(archive)} (${method}${args.destination === "upload" ? ", upload to App Store Connect" : ""})`,
        steps: [
          { description: `Write ${optsPath}`, command: buildPlist(opts) },
          cmdStep("xcodebuild -exportArchive", "xcodebuild", cmd),
        ],
        destructive: args.destination === "upload",
        warnings:
          args.destination === "upload"
            ? ["Uploads the build to App Store Connect (build numbers cannot be reused)."]
            : [],
      }),
      async () => {
        await mkdir(exportPath, { recursive: true });
        await writeFile(optsPath, buildPlist(opts));
        const job = await ctx.jobs.runWithDeadline(
          "export",
          `Export ${basename(archive)}`,
          (args.max_wait_seconds ?? 120) * 1000,
          async (j) => {
            j.progress(`xcodebuild -exportArchive (${method})`);
            const r = await ctx.runner.run("xcodebuild", cmd, {
              timeoutMs: 7200000,
              logName: "xcodebuild-export",
              signal: j.signal,
              onOutput: (o) => j.log(o),
            });
            const sum = summarizeXcodebuild(output(r));
            if (!ok(r) || !sum.succeeded) {
              const known = matchKnownErrors(output(r));
              return {
                summary: `Export FAILED.\n${sum.errors.slice(0, 15).join("\n")}${known.length ? `\n\n${formatMatches(known)}` : ""}`,
                data: { errors: sum.errors, knownErrors: known, logPath: r.logPath },
                isError: true,
              };
            }
            const files = await readdir(exportPath).catch(() => []);
            const next =
              args.destination === "upload"
                ? ["asc_builds action=wait_processing app=<bundle id> build_number=<CFBundleVersion>"]
                : args.target === "mac-developer-id"
                  ? [
                      `notarize_and_staple path=${join(exportPath, files.find((f) => f.endsWith(".app")) ?? "<App>.app")}`,
                    ]
                  : TARGETS[args.target!].ascAppRecord
                    ? [
                        `upload_build path=${join(exportPath, files.find((f) => /\.(ipa|pkg)$/.test(f)) ?? "<file>")}`,
                      ]
                    : [];
            return {
              summary: `Exported to ${exportPath}: ${files.join(", ")}${args.destination === "upload" ? "\nUploaded to App Store Connect." : ""}`,
              data: { exportPath, files, exportOptions: opts },
              next_steps: next,
            };
          },
        );
        if (!job.done)
          return detachedOutput(
            ctx,
            job.jobId,
            `Export of ${basename(archive)}${args.destination === "upload" ? " + upload" : ""}`,
          );
        return job.value;
      },
    );
  },
});
