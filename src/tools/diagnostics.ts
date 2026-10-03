import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { cmdStep } from "../core/confirm";
import { ok, output } from "../core/exec";
import { tail } from "../core/logs";
import { jobMonitor } from "../core/monitor";
import { requireMacOS } from "../core/platform";
import { asArray, asDict, type PlistDict, parsePlistDict } from "../core/plist";
import { ToolError } from "../core/result";
import { entitlementInfo } from "../knowledge/entitlements";
import { PRIVACY_RESOURCES, REQUIRED_REASON_APIS, TCC_SERVICES } from "../knowledge/privacy-keys";
import { parseCrashReport } from "../parsers/ips";
import { parseOtoolL } from "../parsers/otool";
import { readBundleInfo } from "../parsers/project/detect";
import { parseSandboxViolations } from "../parsers/sandbox-log";
import {
  type Finding,
  finding,
  formatFindings,
  isDirectory,
  pathExists,
  readSignedEntitlements,
  resolveUserPath,
  scratchDir,
} from "./shared";
import { defineTool, withConfirmation } from "./types";

// ------------------------------------------------------------------ system_logs

const PRESETS: Record<string, { predicate: string; description: string }> = {
  gatekeeper: {
    predicate:
      'process == "syspolicyd" OR subsystem BEGINSWITH "com.apple.syspolicy" OR process == "XprotectService"',
    description: "Gatekeeper / notarization ticket checks / XProtect",
  },
  amfi: {
    predicate:
      'process == "amfid" OR process == "taskgated" OR process == "taskgated-helper" OR sender == "AppleMobileFileIntegrity" OR eventMessage CONTAINS "AMFI"',
    description: "Code signature enforcement, entitlement/profile validation (apps killed at launch)",
  },
  sandbox: {
    predicate: 'sender == "Sandbox" OR eventMessage CONTAINS "Sandbox: "',
    description: "App Sandbox denials (deny(1) <operation> <target>)",
  },
  tcc: {
    predicate: 'subsystem == "com.apple.TCC" OR process == "tccd"',
    description: "Privacy permission (TCC) prompts, grants and denials",
  },
  launch: {
    predicate: 'process == "launchd" OR process == "runningboardd" OR subsystem == "com.apple.dyld"',
    description: "Launch failures, dyld errors",
  },
};

export const systemLogsTool = defineTool({
  name: "system_logs",
  title: "Query macOS unified logs for signing / sandbox / privacy problems",
  description:
    "Runs `log show` with a preset predicate: gatekeeper (syspolicyd, XProtect), amfi (code signature & entitlement enforcement), sandbox (deny lines → parsed into violations with the entitlement that would allow each), tcc (privacy permission decisions), launch (dyld/launchd), or a custom predicate. Optionally narrow to a process / app name. Reproduce the problem first, then call this with a short window (e.g. last=5m). Read-only.",
  input: {
    preset: z.enum(["gatekeeper", "amfi", "sandbox", "tcc", "launch", "custom"]),
    predicate: z.string().optional().describe("custom: NSPredicate for `log show --predicate`."),
    process: z.string().optional().describe("Only lines mentioning this process / app name."),
    last: z
      .string()
      .regex(/^\d+[smhd]$/)
      .optional()
      .describe("Time window like 5m, 1h (default 10m)."),
    max_lines: z.number().int().min(10).max(2000).optional().describe("Lines to return (default 200)."),
  },
  async handler(args, ctx) {
    requireMacOS(ctx.platform, "system_logs");
    let predicate = args.preset === "custom" ? args.predicate : PRESETS[args.preset].predicate;
    if (!predicate) throw new ToolError("predicate is required for preset=custom.");
    if (args.process) {
      const p = args.process.replace(/"/g, "");
      predicate = `(${predicate}) AND (process == "${p}" OR eventMessage CONTAINS[c] "${p}")`;
    }
    const r = await ctx.runner.run(
      "log",
      ["show", "--style", "compact", "--info", "--last", args.last ?? "10m", "--predicate", predicate],
      {
        timeoutMs: 300000,
        logName: `log-${args.preset}`,
      },
    );
    if (!ok(r) && !r.stdout) throw new ToolError(`log show failed: ${output(r)}`);
    const lines = r.stdout.split("\n").filter((l) => l.trim() && !/^Timestamp\s+Ty/.test(l));
    const max = args.max_lines ?? 200;
    const data: Record<string, unknown> = {
      predicate,
      totalLines: lines.length,
      lines: lines.slice(-max),
      logPath: r.logPath,
    };
    let summary = `${lines.length} log line(s) for ${args.preset}${args.process ? ` / ${args.process}` : ""} in the last ${args.last ?? "10m"}.`;
    if (args.preset === "sandbox") {
      const v = parseSandboxViolations(r.stdout, ctx.platform.homeDir);
      data.violations = v;
      if (v.length)
        summary += `\nSandbox violations:\n${v
          .slice(0, 25)
          .map(
            (x) =>
              `• ${x.process} ${x.operation} ${x.target ?? ""} (×${x.count})\n    → ${x.suggestion?.entitlement ? `${x.suggestion.entitlement}: ` : ""}${x.suggestion?.advice ?? ""}`,
          )
          .join("\n")}`;
    } else if (lines.length) {
      summary += `\n${tail(lines.join("\n"), 40)}`;
    }
    if (!lines.length)
      summary += " Reproduce the issue (launch the app / trigger the feature) and query again.";
    return { summary, data };
  },
});

// ------------------------------------------------------------------ crash_reports

export const crashReportsTool = defineTool({
  name: "crash_reports",
  title: "Find and explain recent crash reports",
  description:
    "Lists recent .ips/.crash reports from ~/Library/Logs/DiagnosticReports (and /Library/Logs/DiagnosticReports) for a process or bundle ID and explains signing-related terminations: CODESIGNING kills (invalid signature, missing provisioning profile for restricted entitlements), dyld 'Library not loaded' and library-validation Team ID mismatches. Read-only.",
  input: {
    process: z.string().optional().describe("Process / app name or bundle ID to match (omit for all)."),
    limit: z.number().int().min(1).max(50).optional().describe("Max reports (default 10)."),
  },
  async handler(args, ctx) {
    const dirs = [
      join(ctx.platform.homeDir, "Library", "Logs", "DiagnosticReports"),
      "/Library/Logs/DiagnosticReports",
    ];
    const files: { path: string; mtime: number }[] = [];
    for (const d of dirs) {
      try {
        for (const f of await readdir(d)) {
          if (!/\.(ips|crash)$/.test(f)) continue;
          if (args.process && !f.toLowerCase().includes(args.process.toLowerCase().split(".").pop()!))
            continue;
          const p = join(d, f);
          files.push({ path: p, mtime: (await stat(p)).mtimeMs });
        }
      } catch {
        /* missing dir */
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const reports = [];
    for (const f of files.slice(0, args.limit ?? 10)) {
      try {
        const s = parseCrashReport(await readFile(f.path, "utf8"));
        if (
          args.process &&
          ![s.process, s.bundleId, basename(f.path)].some((x) =>
            x?.toLowerCase().includes(args.process!.toLowerCase()),
          )
        )
          continue;
        reports.push({ file: f.path, modified: new Date(f.mtime).toISOString(), ...s });
      } catch {
        /* unreadable */
      }
    }
    if (!reports.length)
      return {
        summary: `No crash reports found${args.process ? ` for ${args.process}` : ""}.`,
        data: { reports: [] },
      };
    return {
      summary: reports
        .map(
          (r) =>
            `• ${r.modified.slice(0, 19)} ${r.process ?? "?"} ${r.appVersion ?? ""} — ${r.exceptionType ?? ""} ${r.terminationNamespace ? `[${r.terminationNamespace}${r.terminationIndicator ? `: ${r.terminationIndicator}` : ""}]` : ""}${r.isSigningRelated ? " ← signing-related" : ""}${r.explanations.length ? `\n    ${r.explanations.map((e) => `${e.title}: ${e.fix[0]}`).join("\n    ")}` : ""}`,
        )
        .join("\n"),
      data: { reports },
    };
  },
});

// ------------------------------------------------------------------ privacy

export async function scanRequiredReasonApis(binary: string): Promise<string[]> {
  const buf = await readFile(binary);
  return REQUIRED_REASON_APIS.filter((c) =>
    c.markers.some((m) => buf.includes(Buffer.from(m, "latin1"))),
  ).map((c) => c.category);
}

async function mainExecutable(app: string, info?: PlistDict): Promise<string | undefined> {
  const exe = info?.CFBundleExecutable as string | undefined;
  for (const p of [exe && join(app, "Contents", "MacOS", exe), exe && join(app, exe)])
    if (p && (await pathExists(p))) return p;
  return undefined;
}

export const privacyTool = defineTool({
  name: "privacy",
  title: "Audit privacy permissions (TCC) / reset prompts",
  description:
    "action=audit: for an .app, cross-checks linked frameworks (camera, microphone, location, contacts, photos, Bluetooth…) against Info.plist NS*UsageDescription strings and macOS hardened-runtime/sandbox entitlements, and scans for privacy-manifest required-reason APIs (UserDefaults, file timestamps, boot time, disk space) vs PrivacyInfo.xcprivacy — the causes of silent permission failures, crashes on first access, and ITMS-90683 / ITMS-91053 rejections. action=tcc_reset (confirm): `tccutil reset <Service> <bundle-id>` so the permission prompt appears again for testing.",
  mutating: true,
  input: {
    action: z.enum(["audit", "tcc_reset"]),
    path: z.string().optional().describe("audit: the .app bundle."),
    service: z
      .enum(TCC_SERVICES)
      .optional()
      .describe("tcc_reset: TCC service (All resets everything for the bundle)."),
    bundle_id: z
      .string()
      .optional()
      .describe("tcc_reset: bundle ID (omit to reset the service for ALL apps)."),
  },
  async handler(args, ctx, extra) {
    if (args.action === "tcc_reset") {
      requireMacOS(ctx.platform, "tccutil");
      if (!args.service) throw new ToolError("service is required.");
      const cmd = ["reset", args.service, ...(args.bundle_id ? [args.bundle_id] : [])];
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Reset ${args.service} permission${args.bundle_id ? ` for ${args.bundle_id}` : " for ALL apps"}`,
          steps: [cmdStep("Reset TCC decision", "tccutil", cmd)],
          warnings: args.bundle_id
            ? []
            : ["Without bundle_id this resets the permission for every app on this Mac."],
          destructive: !args.bundle_id,
        }),
        async () => {
          const r = await ctx.runner.run("tccutil", cmd, { timeoutMs: 30000 });
          if (!ok(r)) throw new ToolError(`tccutil failed: ${output(r)}`);
          return {
            summary: `Reset ${args.service}${args.bundle_id ? ` for ${args.bundle_id}` : ""}. Relaunch the app to see the prompt again.`,
            data: { ok: true },
          };
        },
      );
    }

    if (!args.path) throw new ToolError("path is required for audit.");
    const app = await resolveUserPath(ctx, args.path);
    if (!(await isDirectory(app))) throw new ToolError("audit expects an .app bundle.");
    const info = (await readBundleInfo(app)) ?? {};
    const isMac = await pathExists(join(app, "Contents"));
    const platform = isMac ? "macOS" : "iOS";
    const exe = await mainExecutable(app, info);
    const findings: Finding[] = [];

    let frameworks: string[] = [];
    if (exe && ctx.platform.isMac) {
      const r = await ctx.runner.run("otool", ["-L", exe], { timeoutMs: 30000 });
      if (ok(r))
        frameworks = parseOtoolL(r.stdout)
          .map((l) => /\/([^/]+)\.framework\//.exec(l.path)?.[1])
          .filter((x): x is string => !!x);
    }
    const ent = ctx.platform.isMac ? ((await readSignedEntitlements(ctx, app)) ?? {}) : {};
    const resources = [];
    for (const res of PRIVACY_RESOURCES.filter((r) => r.platforms.includes(platform))) {
      const linked = res.frameworks.filter((f) => frameworks.includes(f));
      const keysPresent = res.usageKeys.filter(
        (k) => typeof info[k] === "string" && (info[k] as string).trim(),
      );
      const entOk = res.macEntitlement ? ent[res.macEntitlement] === true : undefined;
      resources.push({
        id: res.id,
        linkedFrameworks: linked,
        usageKeysPresent: keysPresent,
        entitlementPresent: entOk,
      });
      if (isMac && res.macEntitlement && entOk && res.usageKeys.length && !keysPresent.length)
        findings.push(
          finding(
            "error",
            `${res.title}: entitlement ${res.macEntitlement} present but no ${res.usageKeys.join(" / ")} in Info.plist — the app is terminated when it requests access.`,
            `Add ${res.usageKeys[0]}.`,
          ),
        );
      if (
        isMac &&
        res.macEntitlement &&
        keysPresent.length &&
        !entOk &&
        (ent["com.apple.security.app-sandbox"] === true || Object.keys(ent).length)
      )
        findings.push(
          finding(
            "warning",
            `${res.title}: usage string present but ${res.macEntitlement} is not in the signed entitlements — under hardened runtime/sandbox access is silently denied.`,
            `Add ${res.macEntitlement} and re-sign.`,
          ),
        );
      if (linked.length && res.usageKeys.length && !keysPresent.length)
        findings.push(
          finding(
            "warning",
            `${res.title}: links ${linked.join(", ")} but has no ${res.usageKeys.join(" / ")}. If the app accesses ${res.title.toLowerCase()}, it will crash/be denied (and App Store upload fails with ITMS-90683).`,
            res.notes,
          ),
        );
      if (!res.usageKeys.length && linked.length && res.notes)
        findings.push(finding("info", `${res.title}: ${res.notes}`));
    }

    // Privacy manifest
    const manifestPath = [
      join(app, "PrivacyInfo.xcprivacy"),
      join(app, "Contents", "Resources", "PrivacyInfo.xcprivacy"),
    ];
    let manifest: PlistDict | undefined;
    for (const p of manifestPath) {
      if (await pathExists(p)) {
        try {
          manifest = parsePlistDict(new Uint8Array(await readFile(p)));
        } catch {
          findings.push(finding("error", `PrivacyInfo.xcprivacy at ${p} is not a valid plist.`));
        }
      }
    }
    const declared = asArray(manifest?.NSPrivacyAccessedAPITypes)
      .map((x) => asDict(x)?.NSPrivacyAccessedAPIType as string | undefined)
      .filter((x): x is string => !!x);
    const detected = exe ? await scanRequiredReasonApis(exe) : [];
    for (const cat of detected.filter((c) => !declared.includes(c))) {
      const c = REQUIRED_REASON_APIS.find((x) => x.category === cat)!;
      findings.push(
        finding(
          platform === "iOS" ? "warning" : "info",
          `Binary appears to use ${c.title} APIs (${cat}) but PrivacyInfo.xcprivacy does not declare it.${platform === "iOS" ? " App Store uploads get ITMS-91053." : ""}`,
          `Declare it with a reason code, e.g. ${c.commonReasons.map((r) => `${r.code} (${r.meaning})`).join("; ")}. Heuristic symbol scan — verify.`,
        ),
      );
    }
    if (!manifest && platform === "iOS")
      findings.push(
        finding(
          "warning",
          "No PrivacyInfo.xcprivacy in the app bundle.",
          "Add a privacy manifest (Xcode → New File → App Privacy).",
        ),
      );
    if (isMac && ent["com.apple.security.automation.apple-events"] && !info.NSAppleEventsUsageDescription)
      findings.push(
        finding(
          "error",
          "Apple Events entitlement without NSAppleEventsUsageDescription — automation requests fail.",
        ),
      );

    for (const k of Object.keys(ent)) {
      const e = entitlementInfo(k);
      if (
        e?.usageDescriptionKey &&
        ent[k] === true &&
        !info[e.usageDescriptionKey] &&
        !findings.some((f) => f.message.includes(k))
      )
        findings.push(finding("error", `${k} requires ${e.usageDescriptionKey} in Info.plist.`));
    }
    return {
      summary: `Privacy audit of ${basename(app)} (${platform}): ${findings.filter((f) => f.severity !== "info").length} issue(s).\n${formatFindings(findings) || "No issues found."}\nNote: screen recording, accessibility and input monitoring have no Info.plist key — users grant them in System Settings → Privacy & Security.`,
      data: {
        platform,
        frameworks,
        resources,
        entitlements: Object.keys(ent),
        privacyManifest: manifest ? { declared } : null,
        requiredReasonApisDetected: detected,
        findings,
      },
      next_steps: [
        "After fixing, reset prompts with privacy action=tcc_reset and watch system_logs preset=tcc while testing.",
      ],
    };
  },
});

// ------------------------------------------------------------------ devices

export const devicesTool = defineTool({
  name: "devices",
  title: "List this Mac's UDID, connected devices and simulators",
  description:
    "Collects device identifiers needed for development / Ad Hoc provisioning: this Mac's provisioning UDID (system_profiler), connected iPhones/iPads/Apple TVs/Vision Pros (`xcrun devicectl list devices`), and available simulators (`xcrun simctl`). Register them with asc_devices action=register. Read-only.",
  input: {
    include_simulators: z.boolean().optional().describe("Include simulators (default false)."),
  },
  async handler(args, ctx) {
    requireMacOS(ctx.platform, "devices");
    const data: Record<string, unknown> = {};
    const hw = await ctx.runner.run("system_profiler", ["SPHardwareDataType", "-json"], { timeoutMs: 60000 });
    if (ok(hw)) {
      try {
        const h = JSON.parse(hw.stdout).SPHardwareDataType?.[0] ?? {};
        data.thisMac = {
          name: h.machine_name,
          model: h.machine_model,
          chip: h.chip_type ?? h.cpu_type,
          provisioningUDID: h.provisioning_UDID ?? h.platform_UUID,
          hardwareUUID: h.platform_UUID,
          note: "Register provisioningUDID (platform MAC_OS) for macOS development/Developer ID profiles that need devices.",
        };
      } catch {
        /* ignore */
      }
    }
    const tmp = join(await scratchDir("devicectl"), "devices.json");
    const dc = await ctx.runner.run("xcrun", ["devicectl", "list", "devices", "--json-output", tmp], {
      timeoutMs: 60000,
    });
    if (ok(dc)) {
      try {
        const j = JSON.parse(await readFile(tmp, "utf8"));
        data.connected = (j.result?.devices ?? []).map((d: any) => ({
          name: d.deviceProperties?.name,
          udid: d.hardwareProperties?.udid,
          platform: d.hardwareProperties?.platform,
          model: d.hardwareProperties?.marketingName ?? d.hardwareProperties?.productType,
          os: d.deviceProperties?.osVersionNumber,
          pairing: d.connectionProperties?.pairingState,
          developerMode: d.deviceProperties?.developerModeStatus,
        }));
      } catch {
        data.connected = [];
      } finally {
        await unlink(tmp).catch(() => {});
      }
    } else data.connectedError = output(dc).slice(0, 300);
    if (args.include_simulators) {
      const sim = await ctx.runner.run("xcrun", ["simctl", "list", "devices", "available", "-j"], {
        timeoutMs: 60000,
      });
      if (ok(sim)) {
        const j = JSON.parse(sim.stdout);
        data.simulators = Object.entries(j.devices ?? {}).flatMap(([runtime, devs]) =>
          (devs as any[]).map((d) => ({
            runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
            name: d.name,
            udid: d.udid,
            state: d.state,
          })),
        );
      }
    }
    const mac = data.thisMac as { provisioningUDID?: string; name?: string } | undefined;
    const connected =
      (data.connected as { name: string; udid: string; platform: string }[] | undefined) ?? [];
    return {
      summary: [
        mac
          ? `This Mac: ${mac.name ?? "?"} — provisioning UDID ${mac.provisioningUDID ?? "?"}`
          : "This Mac: unknown",
        `Connected devices: ${connected.length ? connected.map((d) => `${d.name} (${d.platform}) ${d.udid}`).join("; ") : "none"}`,
        args.include_simulators
          ? `Simulators: ${(data.simulators as unknown[] | undefined)?.length ?? 0}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      data,
      next_steps: [
        "asc_devices action=register name=<…> udid=<…> platform=<IOS|MAC_OS>",
        "then asc_profiles action=regenerate for development/ad-hoc profiles",
      ],
    };
  },
});

// ------------------------------------------------------------------ jobs

export const jobsTool = defineTool({
  name: "jobs",
  title: "Status of long-running background jobs",
  description:
    "Long operations (xcodebuild archive/export, notarization waits, uploads, build processing) continue in the background when they exceed max_wait_seconds. action=list / status (optionally wait up to wait_seconds) / tail (recent output) / cancel (confirm).",
  mutating: true,
  input: {
    action: z.enum(["list", "status", "tail", "cancel"]),
    job_id: z.string().optional(),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(900)
      .optional()
      .describe("status: wait up to this long for completion."),
    lines: z.number().int().min(1).max(1000).optional().describe("tail: number of lines (default 80)."),
  },
  async handler(args, ctx, extra) {
    if (args.action === "list") {
      const list = ctx.jobs.list().map(({ lines: _l, result: _r, ...j }) => j);
      return {
        summary: list.length
          ? list
              .map((j) => `• ${j.id} ${j.name} — ${j.status}${j.progress ? ` (${j.progress})` : ""}`)
              .join("\n")
          : "No jobs.",
        data: { jobs: list },
      };
    }
    if (!args.job_id) throw new ToolError("job_id is required.");
    let job = ctx.jobs.get(args.job_id);
    if (!job) throw new ToolError(`Unknown job ${args.job_id} (jobs do not survive a server restart).`);
    if (args.action === "status") {
      if (args.wait_seconds && job.status === "running")
        job = (await ctx.jobs.wait(args.job_id, args.wait_seconds * 1000)) ?? job;
      const { lines, ...rest } = job;
      const resultSummary = (job.result as { summary?: string } | undefined)?.summary;
      return {
        summary: `${job.id} ${job.name}: ${job.status}${job.progress && job.status === "running" ? ` — ${job.progress}` : ""}${job.error ? `\nError: ${job.error}` : ""}${resultSummary ? `\n\n${resultSummary}` : ""}`,
        data: { ...rest, recentOutput: lines.slice(-20) },
        next_steps:
          job.status === "running"
            ? [
                `Monitor: ${jobMonitor({ jobId: job.id, description: job.description, stateDir: ctx.jobs.stateDir }).command}`,
                `or jobs action=status job_id=${job.id} wait_seconds=600`,
              ]
            : [],
      };
    }
    if (args.action === "tail") {
      return {
        summary: job.lines.slice(-(args.lines ?? 80)).join("\n") || "(no output yet)",
        data: { status: job.status },
      };
    }
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Cancel job ${job!.id} (${job!.name})`,
        steps: [{ description: "Send SIGTERM to the running process" }],
      }),
      async () => ({
        summary: ctx.jobs.cancel(args.job_id!) ? "Cancellation requested." : "Job is not running.",
        data: {},
      }),
    );
  },
});
