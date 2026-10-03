import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { cmdStep } from "../core/confirm";
import { ok, output } from "../core/exec";
import { requireMacOS } from "../core/platform";
import { parsePlistDict } from "../core/plist";
import { ToolError } from "../core/result";
import { matchKnownErrors } from "../knowledge/error-catalog";
import { parseSpctl, parseSyspolicyCheck, type SpctlAssessment } from "../parsers/spctl";
import { type Finding, finding, formatFindings, isDirectory, resolveUserPath, scratchDir } from "./shared";
import { defineTool, type ToolContext, withConfirmation } from "./types";

export function spctlArgs(path: string): string[] {
  const ext = extname(path).toLowerCase();
  if (ext === ".pkg") return ["--assess", "--type", "install", "-vvv", path];
  if (ext === ".dmg")
    return ["--assess", "--type", "open", "--context", "context:primary-signature", "-vvv", path];
  return ["--assess", "--type", "execute", "-vvv", path];
}

export async function assess(ctx: ToolContext, path: string): Promise<SpctlAssessment> {
  const r = await ctx.runner.run("spctl", spctlArgs(path), { timeoutMs: 120000 });
  return parseSpctl(output(r), r.code);
}

function explainAssessment(a: SpctlAssessment): Finding[] {
  if (a.accepted) {
    return [finding("info", `Gatekeeper accepts it (source: ${a.source ?? "?"}).`)];
  }
  const known = matchKnownErrors(a.raw, ["gatekeeper", "codesign"]);
  if (known.length)
    return known.map((k) => finding("error", `${k.title}: ${k.explanation}`, k.fix.join("; ")));
  return [
    finding(
      "error",
      `Rejected${a.reason ? ` (${a.reason})` : ""}${a.source ? ` — source=${a.source}` : ""}.`,
    ),
  ];
}

export function quarantineValue(now: Date, agent = "Safari"): string {
  // flags;hex-timestamp;agent;uuid — 0083 marks a downloaded file that Gatekeeper must check.
  return `0083;${Math.floor(now.getTime() / 1000).toString(16)};${agent};${randomUUID().toUpperCase()}`;
}

async function syspolicyCheck(ctx: ToolContext, path: string, mode = "distribution") {
  const r = await ctx.runner.run("syspolicy_check", [mode, path], {
    timeoutMs: 300000,
    logName: "syspolicy_check",
  });
  if (r.spawnError) return { available: false as const };
  return { available: true as const, ...parseSyspolicyCheck(output(r), r.code), logPath: r.logPath };
}

export const gatekeeperTool = defineTool({
  name: "gatekeeper",
  title: "Test Gatekeeper acceptance like an end user",
  description:
    "action=assess: spctl assessment with the right type for .app (execute), .pkg (install) and .dmg (open, primary signature), explaining rejections (unnotarized, no usable signature, wrong certificate…). action=syspolicy_check: Apple's macOS 14+ pre-distribution checker (`syspolicy_check distribution|notary-submission`). action=simulate_download: copy the artifact to a temp folder, add the com.apple.quarantine attribute exactly like a Safari download (mounting DMGs / extracting zips), then assess it, check the stapled ticket and run syspolicy_check — the closest thing to a user's first launch. launch=true (confirm) also opens the app and collects Gatekeeper/AMFI log lines.",
  mutating: true,
  input: {
    action: z.enum(["assess", "syspolicy_check", "simulate_download"]),
    path: z.string().describe(".app, .dmg, .pkg or .zip"),
    mode: z
      .enum(["distribution", "notary-submission"])
      .optional()
      .describe("syspolicy_check mode (default distribution)."),
    launch: z
      .boolean()
      .optional()
      .describe("simulate_download: also launch the quarantined copy (requires confirmation)."),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "Gatekeeper checks");
    const path = await resolveUserPath(ctx, args.path);

    if (args.action === "assess") {
      const a = await assess(ctx, path);
      const f = explainAssessment(a);
      return {
        summary: `${basename(path)}: ${a.accepted ? "ACCEPTED" : "REJECTED"}${a.source ? ` (source=${a.source})` : ""}${a.origin ? `\norigin=${a.origin}` : ""}\n${formatFindings(f)}`,
        data: { assessment: a, findings: f },
        next_steps: a.accepted
          ? ["gatekeeper action=simulate_download for a full download simulation"]
          : [
              "inspect_code_signature path=<same>",
              "notarize_and_staple if it is signed with Developer ID but not notarized",
            ],
      };
    }

    if (args.action === "syspolicy_check") {
      const r = await syspolicyCheck(ctx, path, args.mode);
      if (!r.available)
        throw new ToolError("syspolicy_check is not available (requires macOS 14 Sonoma or later).");
      return {
        summary: `syspolicy_check ${args.mode ?? "distribution"}: ${r.passed ? "PASSED" : "issues found"}\n${r.raw.slice(0, 3000)}`,
        data: r,
      };
    }

    // simulate_download
    const run = async (): Promise<Awaited<ReturnType<typeof simulate>>> => simulate(ctx, path, !!args.launch);
    if (!args.launch) {
      const res = await run();
      return res;
    }
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Simulate a download of ${basename(path)} and launch it`,
        steps: [
          { description: "Copy to a temporary folder and apply com.apple.quarantine (as Safari would)" },
          { description: "Assess with spctl / syspolicy_check / stapler validate" },
          { description: "Open the quarantined copy (a Gatekeeper dialog may appear on screen)" },
          { description: "Collect syspolicyd / AMFI log lines from the launch" },
        ],
        warnings: ["The app will actually run on this Mac."],
      }),
      run,
    );
  },
});

async function simulate(ctx: ToolContext, path: string, launch: boolean) {
  const dir = await scratchDir("download");
  const name = basename(path);
  const copy = join(dir, name);
  const findings: Finding[] = [];
  const qv = quarantineValue(ctx.now());
  const cp = await ctx.runner.run("ditto", [path, copy], { timeoutMs: 600000 });
  if (!ok(cp)) throw new ToolError(`Copy failed: ${output(cp)}`);
  await ctx.runner.run("xattr", ["-w", "com.apple.quarantine", qv, copy], { timeoutMs: 30000 });

  const ext = extname(path).toLowerCase();
  const results: Record<string, unknown> = { tempDir: dir, quarantine: qv };
  let appToCheck: string | undefined;
  let mountPoint: string | undefined;

  if (ext === ".dmg") {
    const dmgAssess = await assess(ctx, copy);
    results.dmgAssessment = dmgAssess;
    findings.push(...explainAssessment(dmgAssess).map((f) => ({ ...f, message: `DMG: ${f.message}` })));
    const st = await ctx.runner.run("stapler", ["validate", copy], { timeoutMs: 60000 });
    results.dmgStapled = ok(st);
    if (!ok(st))
      findings.push(
        finding(
          "warning",
          "DMG has no stapled ticket (offline users may be blocked).",
          "staple action=staple path=<dmg>",
        ),
      );
    const att = await ctx.runner.run(
      "hdiutil",
      ["attach", "-nobrowse", "-readonly", "-noautoopen", "-plist", copy],
      { timeoutMs: 120000 },
    );
    if (ok(att)) {
      try {
        const pl = parsePlistDict(att.stdout);
        const ents = (pl["system-entities"] as Record<string, unknown>[] | undefined) ?? [];
        mountPoint = ents.map((e) => e["mount-point"] as string | undefined).find(Boolean);
      } catch {
        /* ignore */
      }
    }
    if (mountPoint) {
      const apps = (await readdir(mountPoint)).filter((f) => f.endsWith(".app"));
      if (apps[0]) appToCheck = join(mountPoint, apps[0]);
    } else findings.push(finding("error", `Could not mount the DMG: ${output(att).slice(0, 300)}`));
  } else if (ext === ".zip") {
    const out = join(dir, "extracted");
    const x = await ctx.runner.run("ditto", ["-x", "-k", copy, out], { timeoutMs: 600000 });
    if (!ok(x)) throw new ToolError(`Unzip failed: ${output(x)}`);
    // Archive Utility propagates the quarantine attribute to extracted items.
    await ctx.runner.run("xattr", ["-w", "-r", "com.apple.quarantine", qv, out], { timeoutMs: 120000 });
    const apps = (await readdir(out)).filter((f) => f.endsWith(".app"));
    appToCheck = apps[0] ? join(out, apps[0]) : undefined;
    if (!appToCheck) findings.push(finding("warning", "No .app at the top level of the zip."));
  } else if (ext === ".pkg") {
    const a = await assess(ctx, copy);
    results.pkgAssessment = a;
    findings.push(...explainAssessment(a));
  } else if (await isDirectory(copy)) {
    await ctx.runner.run("xattr", ["-w", "-r", "com.apple.quarantine", qv, copy], { timeoutMs: 120000 });
    appToCheck = copy;
  }

  if (appToCheck) {
    const a = await assess(ctx, appToCheck);
    results.appAssessment = a;
    findings.push(...explainAssessment(a).map((f) => ({ ...f, message: `App: ${f.message}` })));
    const st = await ctx.runner.run("stapler", ["validate", appToCheck], { timeoutMs: 60000 });
    results.appStapled = ok(st);
    if (!ok(st) && ext !== ".dmg")
      findings.push(
        finding(
          "warning",
          "App has no stapled ticket — first launch needs an internet connection to verify notarization.",
          "staple the .app before zipping/distributing",
        ),
      );
    const sp = await syspolicyCheck(ctx, appToCheck);
    if (sp.available) {
      results.syspolicyCheck = { passed: sp.passed, issues: sp.issues.slice(0, 20), logPath: sp.logPath };
      if (!sp.passed)
        findings.push(
          finding(
            "error",
            `syspolicy_check distribution reported issues: ${sp.issues.slice(0, 5).join(" | ")}`,
          ),
        );
    }
    if (launch) {
      const started = ctx.now();
      await ctx.runner.run("open", [appToCheck], { timeoutMs: 30000 });
      await new Promise((r) => setTimeout(r, 5000));
      const secs = Math.max(30, Math.ceil((Date.now() - started.getTime()) / 1000) + 5);
      const logs = await ctx.runner.run(
        "log",
        [
          "show",
          "--style",
          "compact",
          "--last",
          `${secs}s`,
          "--predicate",
          'process == "syspolicyd" OR process == "amfid" OR subsystem == "com.apple.syspolicy" OR process == "taskgated"',
        ],
        { timeoutMs: 120000, logName: "launch-logs" },
      );
      const relevant = logs.stdout
        .split("\n")
        .filter(
          (l) =>
            new RegExp(basename(appToCheck!, ".app"), "i").test(l) ||
            /deny|reject|not notarized|malware|translocat/i.test(l),
        )
        .slice(-40);
      results.launchLogs = relevant;
      results.launchLogPath = logs.logPath;
    }
  }
  if (mountPoint) await ctx.runner.run("hdiutil", ["detach", mountPoint, "-quiet"], { timeoutMs: 60000 });

  const rejected = findings.some((f) => f.severity === "error");
  return {
    summary: `Simulated download of ${name}: ${rejected ? "users WILL see a Gatekeeper block/warning" : "Gatekeeper should open it without warnings"}.\n${formatFindings(findings)}`,
    data: { ...results, findings },
    next_steps: rejected
      ? ["inspect_code_signature path=<original>", "notarize_and_staple path=<original>"]
      : [],
  };
}

export const quarantineTool = defineTool({
  name: "quarantine",
  title: "Read / set / clear the com.apple.quarantine attribute",
  description:
    "action=get: show the quarantine attribute (flags, time, downloading agent) — present on downloaded files and what triggers Gatekeeper. action=set (confirm): add it to test first-launch behaviour. action=clear (confirm): remove it (recursive) — this only bypasses Gatekeeper on THIS Mac and is not a distribution fix. action=clear_all_xattrs (confirm): `xattr -cr`, the fix for codesign's 'resource fork, Finder information, or similar detritus not allowed'.",
  mutating: true,
  input: {
    action: z.enum(["get", "set", "clear", "clear_all_xattrs"]),
    path: z.string(),
    recursive: z
      .boolean()
      .optional()
      .describe("set/clear: apply to bundle contents too (default true for directories)."),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "quarantine");
    const path = await resolveUserPath(ctx, args.path);
    if (args.action === "get") {
      const r = await ctx.runner.run("xattr", ["-p", "com.apple.quarantine", path], { timeoutMs: 15000 });
      if (!ok(r)) return { summary: `${basename(path)} is not quarantined.`, data: { quarantined: false } };
      const [flags, ts, agent, uuid] = r.stdout.trim().split(";");
      const when = Number.parseInt(ts, 16);
      return {
        summary: `${basename(path)} is quarantined: flags=${flags} agent=${agent || "?"} time=${Number.isFinite(when) ? new Date(when * 1000).toISOString() : ts}`,
        data: {
          quarantined: true,
          raw: r.stdout.trim(),
          flags,
          agent,
          uuid,
          time: Number.isFinite(when) ? new Date(when * 1000).toISOString() : undefined,
        },
      };
    }
    const recursive = args.recursive ?? (await isDirectory(path));
    let cmd: string[];
    let title: string;
    const warnings: string[] = [];
    if (args.action === "set") {
      cmd = ["-w", ...(recursive ? ["-r"] : []), "com.apple.quarantine", quarantineValue(ctx.now()), path];
      title = `Quarantine ${basename(path)}`;
    } else if (args.action === "clear") {
      cmd = [recursive ? "-dr" : "-d", "com.apple.quarantine", path];
      title = `Remove quarantine from ${basename(path)}`;
      warnings.push(
        "This only lets the app open on THIS Mac. Users downloading it will still be blocked unless it is signed with Developer ID, notarized and stapled.",
      );
    } else {
      cmd = ["-cr", path];
      title = `Remove ALL extended attributes under ${basename(path)}`;
      warnings.push(
        "If the bundle is already signed, removing attributes does not invalidate it, but re-sign afterwards if codesign complained about detritus.",
      );
    }
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({ title, steps: [cmdStep(title, "xattr", cmd)], warnings }),
      async () => {
        const r = await ctx.runner.run("xattr", cmd, { timeoutMs: 120000 });
        if (!ok(r) && args.action !== "clear") throw new ToolError(`xattr failed: ${output(r)}`);
        return { summary: `Done: ${title}.`, data: { path, action: args.action } };
      },
    );
  },
});
