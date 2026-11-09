import { z } from "zod";
import { contextError, digest, readContext, writeContext } from "../core/apple-context";
import { ok } from "../core/exec";
import { parseShowBuildSettings } from "../parsers/xcodebuild";
import { detachedOutput } from "./detached";
import { resolveUserPath } from "./shared";
import { defineTool, withConfirmation } from "./types";

const settingsKeys = [
  "PRODUCT_NAME",
  "PRODUCT_TYPE",
  "PRODUCT_BUNDLE_IDENTIFIER",
  "SDKROOT",
  "SDK_NAME",
  "SDK_VERSION",
  "PLATFORM_NAME",
  "EFFECTIVE_PLATFORM_NAME",
  "SUPPORTED_PLATFORMS",
  "IPHONEOS_DEPLOYMENT_TARGET",
  "MACOSX_DEPLOYMENT_TARGET",
  "TVOS_DEPLOYMENT_TARGET",
  "WATCHOS_DEPLOYMENT_TARGET",
  "XROS_DEPLOYMENT_TARGET",
  "SWIFT_VERSION",
  "SWIFT_STRICT_CONCURRENCY",
  "CODE_SIGN_ENTITLEMENTS",
  "INFOPLIST_FILE",
];
export const platformSnapshotSchema = z.object({
  schema: z.literal(1),
  snapshot_id: z.string(),
  fingerprint: z.string(),
  observed_at: z.string(),
  facts: z.object({
    host: z.string(),
    path: z.string().optional(),
    scheme: z.string().optional(),
    configuration: z.string(),
    destination: z.string().optional(),
    beta_policy: z.enum(["stable_only", "allow_beta"]),
    toolchain: z.object({
      selected_developer_dir: z.string().optional(),
      effective_developer_dir: z.string().optional(),
      xcode_version: z.string().optional(),
      build_version: z.string().optional(),
      sdks: z.string().optional(),
      mcp_bridge_available: z.boolean().optional(),
    }),
    targets: z.array(z.object({ target: z.string(), settings: z.record(z.string(), z.string()) })),
    gaps: z.array(z.string()),
  }),
});
export type PlatformSnapshot = z.infer<typeof platformSnapshotSchema>;

export const applePlatformContextTool = defineTool({
  name: "apple_platform_context",
  title: "Apple project and toolchain context",
  description:
    "inspect reads the effective Xcode version, SDK list, MCP bridge presence, and selected project/scheme build settings per target. snapshot (confirm) inspects and saves this context in private MCP state for feature investigations. get reads a saved snapshot without running Xcode. Non-Mac inspection reports gaps. No Apple credentials needed. SDK/build settings do not prove runtime hardware support or compilation. Xcode may resolve project dependencies while evaluating build settings; select a trusted project.",
  mutating: true,
  input: {
    action: z
      .enum(["inspect", "snapshot", "get"])
      .describe("Read current facts, save a context snapshot, or read saved facts."),
    path: z
      .string()
      .optional()
      .describe("Exact .xcodeproj or .xcworkspace path; use detect_project to locate it."),
    scheme: z
      .string()
      .optional()
      .describe("Required with path: explicit scheme for per-target build settings."),
    configuration: z.string().default("Debug").describe("Build configuration to inspect."),
    destination: z
      .string()
      .optional()
      .describe("Explicit xcodebuild destination, e.g. generic/platform=iOS or generic/platform=macOS."),
    developer_dir: z
      .string()
      .optional()
      .describe("Optional per-command DEVELOPER_DIR override; never changes global xcode-select."),
    beta_policy: z
      .enum(["stable_only", "allow_beta"])
      .default("stable_only")
      .describe("Whether this investigation may recommend beta APIs; does not install or change Xcode."),
    snapshot_id: z.string().optional().describe("get: ID returned by snapshot."),
  },
  async handler(args, ctx, extra) {
    if (args.action === "get") {
      if (!args.snapshot_id) throw contextError("snapshot_id is required for get.");
      const snapshot = await readContext(ctx, "projects", args.snapshot_id, platformSnapshotSchema);
      if (!snapshot)
        throw contextError("project snapshot not found; run apple_platform_context action=snapshot first.");
      return {
        summary: `Cached project context observed ${snapshot.observed_at}; not a live inspection.`,
        data: { snapshot, source: "cache" },
      };
    }
    if (!!args.path !== !!args.scheme) throw contextError("path and scheme must be supplied together.");
    const path = args.path ? await resolveUserPath(ctx, args.path) : undefined;
    if (path && !/\.(xcodeproj|xcworkspace)$/.test(path))
      throw contextError("path must name an explicit .xcodeproj or .xcworkspace.");
    const developerDir = args.developer_dir
      ? await resolveUserPath(ctx, args.developer_dir)
      : process.env.DEVELOPER_DIR;
    const selection = {
      path,
      scheme: args.scheme,
      configuration: args.configuration,
      destination: args.destination,
      developer_dir: developerDir,
      beta_policy: args.beta_policy,
    };
    const snapshot_id = digest(selection);
    const inspect = async () => {
      const job = await ctx.jobs.runWithDeadline(
        "apple-platform-context",
        "Inspect Apple toolchain and project context",
        10000,
        async (j) => {
          j.setMeta("snapshotId", snapshot_id);
          const toolchain: PlatformSnapshot["facts"]["toolchain"] = {};
          const gaps: string[] = [];
          let targets: PlatformSnapshot["facts"]["targets"] = [];
          if (ctx.platform.isMac) {
            const run = (cmd: string, argv: string[], timeoutMs = 15000) =>
              ctx.runner.run(cmd, argv, {
                env: developerDir ? { DEVELOPER_DIR: developerDir } : undefined,
                timeoutMs,
                signal: j.signal,
              });
            const selected = await run("xcode-select", ["-p"], 5000);
            toolchain.selected_developer_dir = ok(selected) ? selected.stdout.trim() : undefined;
            toolchain.effective_developer_dir = developerDir ?? toolchain.selected_developer_dir;
            const version = await run("xcodebuild", ["-version"]);
            if (ok(version)) {
              toolchain.xcode_version = /Xcode\s+(\S+)/.exec(version.stdout)?.[1];
              toolchain.build_version = /Build version\s+(\S+)/.exec(version.stdout)?.[1];
            }
            if (!toolchain.xcode_version) gaps.push("Selected Xcode version could not be established.");
            const sdks = await run("xcodebuild", ["-showsdks"], 15000);
            if (ok(sdks)) toolchain.sdks = sdks.stdout.trim().slice(0, 16000);
            else gaps.push("Installed SDK list could not be read.");
            toolchain.mcp_bridge_available = ok(await run("xcrun", ["--find", "mcpbridge"], 5000));
            if (path && args.scheme) {
              j.progress("Reading effective per-target build settings");
              const argv = [
                "-showBuildSettings",
                "-json",
                path.endsWith(".xcworkspace") ? "-workspace" : "-project",
                path,
                "-scheme",
                args.scheme,
                "-configuration",
                args.configuration,
              ];
              if (args.destination) argv.push("-destination", args.destination);
              const settings = await run("xcodebuild", argv, 60000);
              if (!ok(settings))
                throw contextError(
                  "xcodebuild could not read build settings; inspect the selected project, scheme and destination.",
                );
              targets = parseShowBuildSettings(settings.stdout, settingsKeys);
              if (!targets.length)
                throw contextError(
                  "xcodebuild returned no readable target settings; no project snapshot was saved.",
                );
            } else
              gaps.push(
                "No project/scheme selected; deployment targets, app frameworks and extension structure are unverified.",
              );
          } else
            gaps.push(
              "Xcode and build SDKs cannot be inspected on this host. Use a Mac runner to establish effective settings and compile.",
            );
          gaps.push(
            "Physical device model, runtime capabilities, permissions and user configuration have not been probed.",
          );
          gaps.push(
            "No feature code was compiled or exercised by this inspection; inspect app imports and extension source separately.",
          );
          const facts = {
            host: ctx.platform.os,
            path,
            scheme: args.scheme,
            configuration: args.configuration,
            destination: args.destination,
            beta_policy: args.beta_policy,
            toolchain,
            targets,
            gaps,
          };
          const snapshot: PlatformSnapshot = {
            schema: 1,
            snapshot_id,
            fingerprint: digest(facts),
            observed_at: ctx.now().toISOString(),
            facts,
          };
          if (args.action === "snapshot") {
            if (j.signal.aborted) throw contextError("inspection cancelled; no snapshot saved.");
            await writeContext(ctx, "projects", snapshot_id, snapshot);
          }
          return {
            summary: `${args.action === "snapshot" ? "Saved" : "Inspected"} Apple context: ${toolchain.xcode_version ? `Xcode ${toolchain.xcode_version}` : "toolchain unverified"}, ${targets.length} target(s).`,
            data: { snapshot, saved: args.action === "snapshot" },
            next_steps: [
              "apple_feature_context action=discover device=iphone-18-pro",
              "Read notarize://guides/apple-platform-context before recommending feature compatibility.",
            ],
          };
        },
      );
      return job.done ? job.value : detachedOutput(ctx, job.jobId, "Apple platform context inspection");
    };
    if (args.action === "inspect") return inspect();
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: "Save Apple project context",
        steps: [
          {
            description: `Inspect ${path ?? "the selected toolchain"}${args.scheme ? ` scheme ${args.scheme}` : ""} and save private MCP state; global Xcode selection is unchanged.`,
          },
        ],
      }),
      inspect,
    );
  },
});
