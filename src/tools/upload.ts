import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { cmdStep, type PlanStep } from "../core/confirm";
import { ok, output } from "../core/exec";
import { FOREGROUND_SECONDS } from "../core/jobs";
import { requireMacOS } from "../core/platform";
import { parsePlistDict } from "../core/plist";
import { ToolError } from "../core/result";
import { formatMatches, matchKnownErrors } from "../knowledge/error-catalog";
import { detachedOutput } from "./detached";
import { pathExists, resolveUserPath } from "./shared";
import { defineTool, profileArg, type ToolContext, withConfirmation } from "./types";

async function ipaInfo(
  ctx: ToolContext,
  ipa: string,
): Promise<{ bundleId?: string; version?: string; build?: string }> {
  const list = await ctx.runner.run("unzip", ["-Z1", ipa], { timeoutMs: 60000 });
  const plistEntry = list.stdout.split("\n").find((l) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(l.trim()));
  if (!plistEntry) return {};
  const r = await ctx.runner.run("unzip", ["-p", ipa, plistEntry.trim()], { timeoutMs: 60000, binary: true });
  try {
    const info = parsePlistDict(r.stdoutBytes ?? r.stdout);
    return {
      bundleId: info.CFBundleIdentifier as string,
      version: info.CFBundleShortVersionString as string,
      build: info.CFBundleVersion as string,
    };
  } catch {
    return {};
  }
}

export const uploadBuildTool = defineTool({
  name: "upload_build",
  title: "Upload an .ipa / .pkg to App Store Connect",
  description:
    "Uploads a distribution-signed .ipa (iOS/tvOS/visionOS) or Mac App Store .pkg to App Store Connect with `xcrun altool` using your API key (flags detected from the installed Xcode; the .p8 is placed in ~/.appstoreconnect/private_keys if altool needs it there). Reads the bundle ID / version / build from IPAs, looks up the app record, and continues as a background job with a Monitor command for large uploads. Afterwards use asc_builds wait_processing. For Xcode projects, `xcode action=export destination=upload` is an alternative.",
  mutating: true,
  input: {
    path: z.string().describe(".ipa or .pkg"),
    platform: z
      .enum(["ios", "macos", "appletvos", "visionos"])
      .optional()
      .describe("Default: ios for .ipa, macos for .pkg."),
    app_id: z
      .string()
      .optional()
      .describe("Numeric App Store Connect app id (looked up from the bundle ID when possible)."),
    bundle_id: z.string().optional(),
    version: z.string().optional().describe("CFBundleShortVersionString (for .pkg)."),
    build_number: z.string().optional().describe("CFBundleVersion (for .pkg)."),
    profile: profileArg,
    max_wait_seconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe("Foreground wait before handing off to a background job (default 90)."),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "Uploading builds");
    const file = await resolveUserPath(ctx, args.path);
    const ext = extname(file).toLowerCase();
    if (ext !== ".ipa" && ext !== ".pkg") throw new ToolError("upload_build expects an .ipa or .pkg.");
    const creds = await ctx.config.resolveAsc(args.profile);
    if (!creds.issuerId) throw new ToolError("altool uploads need a Team API key (with issuer ID).");
    const meta = ext === ".ipa" ? await ipaInfo(ctx, file) : {};
    const bundleId = args.bundle_id ?? meta.bundleId;
    const version = args.version ?? meta.version;
    const build = args.build_number ?? meta.build;
    let appId = args.app_id;
    if (!appId && bundleId) {
      try {
        const client = await ctx.asc(args.profile);
        const res = await client.list("apps", { "filter[bundleId]": bundleId }, 5);
        appId = res.data.find((a) => a.attributes?.bundleId === bundleId)?.id;
        if (!appId)
          throw new ToolError(`No App Store Connect app record for ${bundleId}.`, {
            hint: "asc_apps action=create_instructions",
          });
      } catch (e) {
        if (e instanceof ToolError && /app record/.test(e.message)) throw e;
      }
    }
    const help = await ctx.runner.run("xcrun", ["altool", "--help"], { timeoutMs: 60000 });
    const helpText = output(help);
    if (help.spawnError || /unable to find utility "altool"/i.test(helpText))
      throw new ToolError("altool not available — install Xcode (not just Command Line Tools).");
    const supportsPackage = helpText.includes("--upload-package");
    const supportsP8Flag = helpText.includes("--p8-file-path");
    const keyDir = join(ctx.platform.homeDir, ".appstoreconnect", "private_keys");
    const keyDest = join(keyDir, `AuthKey_${creds.keyId}.p8`);
    const needsCopy = !supportsP8Flag && !(await pathExists(keyDest));
    const type = args.platform ?? (ext === ".ipa" ? "ios" : "macos");
    const cmd = supportsPackage
      ? [
          "altool",
          "--upload-package",
          file,
          "--type",
          type,
          "--apiKey",
          creds.keyId,
          "--apiIssuer",
          creds.issuerId,
          ...(supportsP8Flag && creds.privateKeyPath ? ["--p8-file-path", creds.privateKeyPath] : []),
          ...(appId ? ["--apple-id", appId] : []),
          ...(bundleId ? ["--bundle-id", bundleId] : []),
          ...(version ? ["--bundle-short-version-string", version] : []),
          ...(build ? ["--bundle-version", build] : []),
          "--output-format",
          "json",
        ]
      : [
          "altool",
          "--upload-app",
          "-f",
          file,
          "-t",
          type,
          "--apiKey",
          creds.keyId,
          "--apiIssuer",
          creds.issuerId,
          "--output-format",
          "json",
        ];
    const steps: PlanStep[] = [];
    if (needsCopy) steps.push({ description: `Copy the API key to ${keyDest} (where altool looks for it)` });
    steps.push(
      cmdStep(
        `Upload ${basename(file)}${bundleId ? ` (${bundleId} ${version ?? "?"} build ${build ?? "?"})` : ""}`,
        "xcrun",
        cmd,
      ),
    );
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Upload ${basename(file)} to App Store Connect`,
        steps,
        destructive: true,
        warnings: ["A build number can only be uploaded once per version."],
      }),
      async () => {
        if (needsCopy) {
          if (!creds.privateKeyPath)
            throw new ToolError("The API key must be a file on disk for altool (set privateKeyPath).");
          await mkdir(keyDir, { recursive: true, mode: 0o700 });
          await copyFile(creds.privateKeyPath, keyDest);
        }
        const job = await ctx.jobs.runWithDeadline(
          "upload",
          `Upload ${basename(file)}`,
          (args.max_wait_seconds ?? FOREGROUND_SECONDS) * 1000,
          async (j) => {
            j.progress(`Uploading ${basename(file)}`);
            const r = await ctx.runner.run("xcrun", cmd, {
              timeoutMs: 7200000,
              logName: "altool-upload",
              signal: j.signal,
              onOutput: (o) => j.log(o),
            });
            const text = output(r);
            if (!ok(r) || /ERROR ITMS-|"success-message"\s*:\s*null|product-errors/i.test(text)) {
              const known = matchKnownErrors(text, ["upload", "codesign"]);
              return {
                summary: `Upload FAILED:\n${text.slice(-2000)}${known.length ? `\n\n${formatMatches(known)}` : ""}`,
                data: { output: text.slice(-4000), knownErrors: known, logPath: r.logPath },
                isError: true,
              };
            }
            return {
              summary: `Uploaded ${basename(file)}. App Store Connect now processes it (usually 5–30 minutes).`,
              data: { bundleId, version, build, appId, logPath: r.logPath },
              next_steps: [
                `asc_builds action=wait_processing app=${bundleId ?? appId ?? "<bundle id>"} build_number=${build ?? "<CFBundleVersion>"}`,
              ],
            };
          },
        );
        if (!job.done)
          return detachedOutput(ctx, job.jobId, `Upload of ${basename(file)} to App Store Connect`);
        return job.value;
      },
    );
  },
});
