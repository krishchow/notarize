import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../tools/types";
import {
  type DeviceLogBackend,
  type DeviceLogScope,
  deviceLogUsbAvailable,
  findDeviceLogTool,
} from "./device-log-backend";
import { ok, output } from "./exec";

const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N}_. ()-]+$/u);
const app = {
  bundle_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/)
    .optional(),
  process: identity.optional(),
};
export const debugTargetSchema = z
  .discriminatedUnion("platform", [
    z
      .object({
        platform: z.literal("macos"),
        ...app,
        runtime: z.enum(["native", "ios-on-mac", "unknown"]).default("unknown"),
      })
      .strict(),
    z
      .object({
        platform: z.literal("ios"),
        device_id: z.string().uuid(),
        bundle_id: z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/),
        process: identity.optional(),
      })
      .strict(),
    z
      .object({
        platform: z.literal("ios-simulator"),
        simulator_id: z.string().uuid(),
        bundle_id: z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/),
        process: identity.optional(),
      })
      .strict(),
  ])
  .refine((t) => t.bundle_id || t.process, "App debugging requires a bundle_id or process.");
export type DebugTarget = z.infer<typeof debugTargetSchema>;
export interface DebugCapabilities {
  target: DebugTarget;
  backend: string;
  logs: boolean;
  reports: boolean;
  relaunch: boolean;
  versions: Record<string, string>;
  gaps: string[];
  developer_mode?: "enabled" | "disabled" | "unknown";
  log_mode?: "stream" | "snapshot";
  log_backend?: "apple-log-collect" | "libimobiledevice";
  log_executable?: string;
  log_scope?: DeviceLogScope;
  device_udid?: string;
  resolved_process?: string;
  installed_app?: { bundle_id: string; name?: string; version?: string; build?: string; observed_at: string };
  manual_actions?: {
    id: "enable_developer_mode";
    required_for: string[];
    steps: string[];
    if_option_missing: string;
    documentation_url: string;
    retry: { tool: "app_debugging"; arguments: { action: "probe"; target: DebugTarget } };
  }[];
  reportNames?: string[];
  reportSizes?: Record<string, number>;
}

/** devicectl's JSON file is its supported automation interface. Scratch output is removed. */
export async function deviceJson(
  ctx: ToolContext,
  args: string[],
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const dir = await mkdtemp(join(tmpdir(), "notarize-probe-"));
  try {
    const path = join(dir, "result.json");
    const r = await ctx.runner.run(
      "xcrun",
      ["devicectl", ...args, "--timeout", "15", "--json-output", path],
      { timeoutMs: 20000, signal },
    );
    if (!ok(r)) throw new Error(`Debug evidence unavailable: ${output(r)}`);
    const json = JSON.parse(await readFile(path, "utf8"));
    if (json.error || json.info?.outcome === "failed")
      throw new Error("Debug evidence unavailable: device command failed.");
    return json;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function reportFilter(target: DebugTarget): string {
  // Identity is schema-restricted; escaping is still explicit for predicate values.
  const value = (target.process ?? target.bundle_id!).replace(/['\\]/g, "\\$&");
  return `Name CONTAINS[c] '${value}'`;
}

function deviceCapabilityFailure(cap: DebugCapabilities, operation: string, error: unknown): void {
  const message = String(error);
  cap.gaps.push(message);
  if (!/Developer Mode is disabled|CoreDeviceError error 10005/.test(message)) return;
  cap.developer_mode = "disabled";
  const existing = cap.manual_actions?.find((action) => action.id === "enable_developer_mode");
  if (existing) {
    existing.required_for.push(operation);
    return;
  }
  cap.manual_actions = [
    {
      id: "enable_developer_mode",
      required_for: [operation],
      steps: [
        "On the selected iPhone/iPad, open Settings → Privacy & Security → Developer Mode and turn it on.",
        "Tap Restart. The device will disconnect while restarting.",
        "After restart, unlock the device, tap Turn On when asked to confirm Developer Mode, and enter the passcode on the device if requested.",
        "Keep the device connected and unlocked, then retry the capability probe. Access is verified again; enabling Developer Mode does not guarantee TestFlight debugging access.",
      ],
      if_option_missing:
        "Connect and unlock the device, tap Trust if prompted, then open Xcode → Window → Devices and Simulators and select the device. Recheck Settings → Privacy & Security. If a managed-device policy blocks the setting, contact its administrator; do not bypass the restriction.",
      documentation_url:
        "https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device",
      retry: { tool: "app_debugging", arguments: { action: "probe", target: cap.target } },
    },
  ];
}

export function debugCapabilityNextSteps(cap: DebugCapabilities): string[] {
  return [
    ...(cap.manual_actions ?? []).flatMap((action) => [
      `Developer Mode is needed for: ${action.required_for.join(", ")}.`,
      ...action.steps,
      `If the switch is missing: ${action.if_option_missing}`,
      `Apple guide: ${action.documentation_url}`,
      `After completing the on-device steps, call ${action.retry.tool} with ${JSON.stringify(action.retry.arguments)}.`,
    ]),
    ...cap.gaps,
  ];
}

export async function probeDebugTarget(
  ctx: ToolContext,
  target: DebugTarget,
  backend: DeviceLogBackend = "auto",
  scope: DeviceLogScope = "app-related",
): Promise<DebugCapabilities> {
  const cap: DebugCapabilities = {
    target,
    backend:
      target.platform === "macos"
        ? "macos-unified-log"
        : target.platform === "ios"
          ? "devicectl"
          : "simctl-unified-log",
    logs: false,
    reports: false,
    relaunch: false,
    versions: {},
    gaps: [],
  };
  if (!ctx.platform.isMac) {
    cap.gaps.push(
      "Debug evidence unavailable: live collection requires macOS; import local evidence instead.",
    );
    return cap;
  }
  const version = await ctx.runner.run("xcodebuild", ["-version"], { timeoutMs: 15000 });
  if (ok(version)) cap.versions.xcode = version.stdout.trim();
  const os = await ctx.runner.run("sw_vers", ["-productVersion"], { timeoutMs: 5000 });
  if (ok(os)) cap.versions.host_os = os.stdout.trim();
  if (target.platform === "macos") {
    const r = await ctx.runner.run("/usr/bin/log", ["help", "stream"], { timeoutMs: 5000 });
    // Apple log prints valid help with EX_USAGE (64), rather than exit 0.
    cap.logs = (ok(r) || r.code === 64) && /usage: log stream/i.test(output(r));
    cap.reports = true;
    cap.relaunch = !!target.bundle_id;
    if (!cap.logs) cap.gaps.push("Debug evidence unavailable: macOS log stream is unavailable.");
    cap.gaps.push("Unified logs can omit private data, JavaScript exceptions, and non-logged failures.");
    return cap;
  }
  try {
    if (target.platform === "ios-simulator") {
      const r = await ctx.runner.run("xcrun", ["simctl", "list", "devices", "available", "--json"], {
        timeoutMs: 15000,
      });
      if (!ok(r)) throw new Error(`Debug evidence unavailable: ${output(r)}`);
      const devices = Object.values(JSON.parse(r.stdout).devices ?? {}).flat() as {
        udid: string;
        state: string;
        isAvailable?: boolean;
      }[];
      const device = devices.find((d) => d.udid.toLowerCase() === target.simulator_id.toLowerCase());
      const runtime = Object.entries(JSON.parse(r.stdout).devices ?? {}).find(([, entries]) =>
        (entries as { udid: string }[]).some(
          (d) => d.udid.toLowerCase() === target.simulator_id.toLowerCase(),
        ),
      );
      if (runtime) cap.versions.simulator_runtime = runtime[0];
      if (device?.state !== "Booted" || device.isAvailable === false)
        throw new Error(
          "Debug evidence unavailable: selected simulator is missing or shut down. Boot it explicitly before capture.",
        );
      cap.logs = true;
      cap.relaunch = true;
      cap.gaps.push(
        "Simulator crash reports require import with verified simulator provenance; shared host report directories are not searched.",
      );
    } else {
      const json = await deviceJson(ctx, ["list", "devices"]);
      const device = (json.result?.devices ?? []).find(
        (d: any) => d.identifier?.toLowerCase() === target.device_id.toLowerCase(),
      );
      if (
        device?.connectionProperties?.pairingState !== "paired" ||
        device.connectionProperties?.tunnelState === "unavailable"
      )
        throw new Error(
          "Debug evidence unavailable: selected phone is disconnected, untrusted, or unavailable. Connect, unlock, and Trust it, then probe again.",
        );
      if (json.info?.version) cap.versions.devicectl = String(json.info.version);
      if (device.deviceProperties?.osVersionNumber)
        cap.versions.os = String(device.deviceProperties.osVersionNumber);
      const mode = device.deviceProperties?.developerModeStatus;
      cap.developer_mode = mode === "enabled" || mode === "disabled" ? mode : "unknown";
      const lock = await deviceJson(ctx, ["device", "info", "lockState", "--device", target.device_id]);
      if (lock.result?.passcodeRequired !== false)
        throw new Error("Debug evidence unavailable: unlock the selected phone and probe again.");
      const udid = device.hardwareProperties?.udid;
      if (typeof udid === "string" && /^[A-Za-z0-9-]{8,80}$/.test(udid)) cap.device_udid = udid;
      const logHelp = await ctx.runner.run("/usr/bin/log", ["help", "collect"], { timeoutMs: 5000 });
      const help = output(logHelp);
      if (
        cap.device_udid &&
        (ok(logHelp) || logHelp.code === 64) &&
        ["--device-udid", "--predicate", "--start", "--size", "--output"].every((flag) => help.includes(flag))
      ) {
        cap.logs = true;
        cap.log_mode = "snapshot";
        cap.log_backend = "apple-log-collect";
      }
      try {
        const files = await deviceJson(ctx, [
          "device",
          "info",
          "files",
          "--device",
          target.device_id,
          "--domain-type",
          "systemCrashLogs",
          "--no-recurse",
          "--filter",
          reportFilter(target),
        ]);
        if (!Array.isArray(files.result?.files))
          throw new Error("Debug evidence unavailable: unsupported devicectl report listing schema.");
        cap.reportNames = files.result.files
          .map((f: any) => f.name)
          .filter(
            (name: unknown): name is string =>
              typeof name === "string" &&
              /^[^/\\]+\.(ips|crash)$/.test(name) &&
              name.toLowerCase().includes((target.process ?? target.bundle_id).toLowerCase()),
          )
          .slice(0, 10);
        cap.reportSizes = Object.fromEntries(
          files.result.files
            .filter(
              (f: any) => cap.reportNames!.includes(f.name) && Number.isSafeInteger(f.size) && f.size >= 0,
            )
            .map((f: any) => [f.name, f.size]),
        );
        if (cap.reportNames!.some((name) => cap.reportSizes![name] === undefined))
          throw new Error(
            "Debug evidence unavailable: report sizes are missing; bounded transfer cannot be guaranteed. Import an app-specific report instead.",
          );
        cap.reports = true;
      } catch (e) {
        deviceCapabilityFailure(cap, "crash-report access", e);
      }
      // Listing apps is also a capability check; never enable Developer Mode automatically.
      try {
        const apps = await deviceJson(ctx, [
          "device",
          "info",
          "apps",
          "--device",
          target.device_id,
          "--filter",
          `bundleIdentifier == '${target.bundle_id}'`,
        ]);
        const installed = Array.isArray(apps.result?.apps)
          ? apps.result.apps.find((app: any) => app.bundleIdentifier === target.bundle_id)
          : undefined;
        cap.relaunch = !!installed;
        if (installed) {
          cap.installed_app = {
            bundle_id: installed.bundleIdentifier,
            name: installed.name,
            version: installed.version,
            build: installed.bundleVersion,
            observed_at: ctx.now().toISOString(),
          };
          if (!target.process && typeof installed.url === "string") {
            try {
              const processes = await deviceJson(ctx, [
                "device",
                "info",
                "processes",
                "--device",
                target.device_id,
              ]);
              const root = installed.url.endsWith("/") ? installed.url : installed.url + "/";
              const process = (processes.result?.runningProcesses ?? []).find(
                (p: any) =>
                  typeof p.executable === "string" &&
                  p.executable.startsWith(root) &&
                  !p.executable.slice(root.length).includes("/"),
              );
              if (process) {
                const name = decodeURIComponent(process.executable.slice(root.length));
                if (identity.safeParse(name).success) cap.resolved_process = name;
              }
            } catch {
              cap.gaps.push(
                "App process discovery was unavailable; supply the known process name to narrow logs.",
              );
            }
          }
        }
      } catch (e) {
        deviceCapabilityFailure(cap, "app inspection / launch capability check", e);
      }
      const live = backend === "apple" ? undefined : await findDeviceLogTool(ctx);
      const usb = live && cap.device_udid ? await deviceLogUsbAvailable(ctx, live, cap.device_udid) : false;
      if (live && usb && cap.device_udid && (scope !== "process" || target.process || cap.resolved_process)) {
        cap.logs = true;
        cap.log_mode = "stream";
        cap.log_backend = "libimobiledevice";
        cap.log_executable = live.executable;
        cap.log_scope = scope;
        cap.versions.idevicesyslog = live.version;
      } else if (backend === "libimobiledevice") {
        cap.logs = false;
        delete cap.log_mode;
        delete cap.log_backend;
        cap.gaps.push(
          live && !usb
            ? "Debug evidence unavailable: live logging cannot see the selected phone over USB. Reconnect, unlock and Trust it, then probe again. Apple wireless discovery alone is insufficient for this backend."
            : "Debug evidence unavailable: requested live backend requires supported idevicesyslog, a device UDID, and a known process for process scope. Run app_debugging action=setup to inspect the optional dependency.",
        );
      }
      if (backend === "auto" && live && !usb)
        cap.gaps.push(
          "Optional live logging is installed but the selected phone is not visible over USB. Reconnect/unlock/Trust for live capture; Apple snapshot availability is separate.",
        );
      cap.gaps.push(
        cap.log_backend === "libimobiledevice"
          ? scope === "process"
            ? "Live logs include the named app process only. Release apps may emit no accessible messages; an empty stream does not prove health."
            : "Live logs match messages referencing the selected bundle ID. These include system launch/lifecycle records, not necessarily app-emitted logs or JavaScript errors. Use log_scope=process with a known process for app-owned messages."
          : cap.logs
            ? "Phone logs use an Apple log collect snapshot of stored unified logs. Reproduce first, then collect the recent window. Collection may require administrator authorization. Optional normal-user live logging can be checked with app_debugging action=setup."
            : "Debug evidence unavailable: no supported device log backend. Run app_debugging action=setup for optional live logging, or use Console text export/import.",
      );
    }
  } catch (e) {
    cap.gaps.push(String(e));
  }
  return cap;
}

export function debugLogCommand(target: DebugTarget): { cmd: string; args: string[] } {
  if (target.platform === "ios")
    throw new Error("Debug evidence unavailable: physical-device passive log streaming is unsupported.");
  // A bundle ID is a subsystem hint, not proof that every app log uses that subsystem.
  const filters = target.bundle_id ? [`subsystem == ${JSON.stringify(target.bundle_id)}`] : [];
  if (target.process) filters.push(`process == ${JSON.stringify(target.process)}`);
  const args = ["stream", "--style", "compact", "--level", "debug", "--predicate", filters.join(" OR ")];
  return target.platform === "macos"
    ? { cmd: "/usr/bin/log", args }
    : { cmd: "xcrun", args: ["simctl", "spawn", target.simulator_id, "log", ...args] };
}
