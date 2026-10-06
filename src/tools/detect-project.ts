import { z } from "zod";
import { ok } from "../core/exec";
import { TARGETS } from "../knowledge/targets";
import { detectProject } from "../parsers/project/detect";
import { parseXcodeList } from "../parsers/xcodebuild";
import { resolveUserPath } from "./shared";
import { defineTool } from "./types";

export const detectProjectTool = defineTool({
  name: "detect_project",
  title: "Detect app/project type and current signing setup",
  description:
    "Identify what lives at a path: Xcode project/workspace, SwiftPM package, Electron (electron-builder/forge), Tauri, Flutter, React Native, Expo (managed/bare), or a prebuilt .app/.xcarchive/.ipa/.dmg/.pkg/.zip, plus any fastlane setup (Appfile app_identifier/team_id cross-checked against the project, Fastfile lanes). Reports platforms, bundle IDs, team IDs, current signing configuration, problems found, suggested distribution targets, build commands, and framework-specific config snippets / environment variables to enable signing + notarization (apply them with your editor). Read-only.",
  input: {
    path: z.string().describe("Project directory or artifact path (absolute, or ~/...)."),
    depth: z.number().int().min(0).max(4).optional().describe("Directory scan depth (default 2)."),
  },
  async handler(args, ctx) {
    const root = await resolveUserPath(ctx, args.path);
    const report = await detectProject(root, args.depth ?? 2);

    // Enrich Xcode components with schemes when xcodebuild is available.
    if (ctx.platform.isMac) {
      for (const c of report.components.filter(
        (x) => x.kind === "xcode-project" || x.kind === "xcode-workspace",
      )) {
        const flag = c.kind === "xcode-workspace" ? "-workspace" : "-project";
        const r = await ctx.runner.run("xcodebuild", ["-list", "-json", flag, c.path], { timeoutMs: 120000 });
        if (ok(r)) {
          const list = parseXcodeList(r.stdout);
          if (list) c.signing.schemes = list.schemes;
          if (list?.configurations.length) c.signing.configurations = list.configurations;
        }
      }
    }

    const fastlaneLines = (report.fastlane ?? []).flatMap((f) => [
      `\n• fastlane — ${f.path}`,
      ...(f.appIdentifiers.length ? [`  app_identifier: ${f.appIdentifiers.join(", ")}`] : []),
      ...(f.teamIds.length ? [`  team_id: ${f.teamIds.join(", ")}`] : []),
      ...(f.lanes.length ? [`  lanes: ${f.lanes.map((l) => `fastlane ${l}`).join(", ")}`] : []),
      ...f.findings.map((x) => `  - ${x}`),
    ]);

    if (!report.components.length && !fastlaneLines.length) {
      return {
        summary: `No recognizable Apple app project or artifact found under ${root}.`,
        data: { root, components: [] },
        next_steps: [
          "Point path at the folder containing the .xcodeproj/.xcworkspace, package.json (Electron/RN/Expo), src-tauri, pubspec.yaml, or at a built .app/.ipa/.dmg/.pkg.",
        ],
      };
    }

    const lines = [`Found ${report.components.length} component(s) under ${root}:`];
    if (!report.components.length)
      lines.push("  (no app project recognised; the fastlane lanes may build it with scripts)");
    for (const c of report.components) {
      lines.push(
        `\n• ${c.kind}${c.name ? ` "${c.name}"` : ""} — ${c.platforms.join(", ") || "platform unknown"}`,
        `  path: ${c.path}`,
      );
      if (c.bundleIds.length) lines.push(`  bundle IDs: ${c.bundleIds.join(", ")}`);
      if (c.teamIds.length) lines.push(`  team IDs: ${c.teamIds.join(", ")}`);
      if (c.findings.length) lines.push(...c.findings.map((f) => `  - ${f}`));
      if (c.suggestedTargets.length)
        lines.push(
          `  possible targets: ${c.suggestedTargets.map((t) => `${t} (${TARGETS[t].title.split("—")[1]?.trim() ?? t})`).join("; ")}`,
        );
    }
    lines.push(...fastlaneLines);
    return {
      summary: lines.join("\n"),
      data: report as unknown as Record<string, unknown>,
      next_steps: [
        "Ask the user which distribution target(s) they want (e.g. mac-developer-id for a website download, testflight-ios for beta testers).",
        "distribution_checklist path=<same path> target=<chosen target>",
      ],
    };
  },
});
