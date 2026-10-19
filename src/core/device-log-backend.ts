import { dirname, join } from "node:path";
import { detachedOutput } from "../tools/detached";
import { type ToolContext, type ToolExtra, withConfirmation } from "../tools/types";
import { cmdStep } from "./confirm";
import type { DebugCapabilities } from "./debug-target";
import { ok, output } from "./exec";

export type DeviceLogBackend = "auto" | "apple" | "libimobiledevice";
export type DeviceLogScope = "app-related" | "process";
export interface DeviceLogTool {
  executable: string;
  version: string;
}

export async function deviceLogUsbAvailable(
  ctx: ToolContext,
  tool: DeviceLogTool,
  udid: string,
): Promise<boolean> {
  const command = tool.executable.includes("/") ? join(dirname(tool.executable), "idevice_id") : "idevice_id";
  const result = await ctx.runner.run(command, ["-l"], { timeoutMs: 5000 });
  return ok(result) && result.stdout.split(/\r?\n/).some((id) => id.trim() === udid);
}

/** Probe through the runner so tests never discover the developer machine's packages. */
export async function findDeviceLogTool(ctx: ToolContext): Promise<DeviceLogTool | undefined> {
  if (!ctx.platform.isMac) return;
  for (const executable of [
    "/opt/homebrew/bin/idevicesyslog",
    "/usr/local/bin/idevicesyslog",
    "idevicesyslog",
  ]) {
    const version = await ctx.runner.run(executable, ["--version"], { timeoutMs: 5000 });
    const match = /idevicesyslog\s+(\d+)\.(\d+)\./.exec(output(version));
    if (!ok(version) || !match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 4))
      continue;
    const help = await ctx.runner.run(executable, ["--help"], { timeoutMs: 5000 });
    if (
      ok(help) &&
      ["--udid", "--process", "--match", "--exit", "--no-colors"].every((flag) => output(help).includes(flag))
    )
      return { executable, version: output(version).trim() };
  }
}

export function liveDeviceLogCommand(cap: DebugCapabilities): { cmd: string; args: string[] } {
  if (!cap.device_udid || !cap.log_executable || cap.target.platform !== "ios")
    throw new Error("Debug evidence unavailable: live device logging has no verified tool or selected UDID.");
  const process = cap.target.process ?? cap.resolved_process;
  if (cap.log_scope === "process" && !process)
    throw new Error("Debug evidence unavailable: process logging requires the app's known process name.");
  return {
    cmd: cap.log_executable,
    args: [
      "--udid",
      cap.device_udid,
      "--no-colors",
      "--exit",
      ...(cap.log_scope === "process" ? ["--process", process!] : ["--match", cap.target.bundle_id]),
    ],
  };
}

export async function setupDeviceLogs(ctx: ToolContext, extra: ToolExtra, args: Record<string, unknown>) {
  const installed = await findDeviceLogTool(ctx);
  if (installed)
    return {
      summary: "Optional device logging is ready; no installation needed.",
      data: { ready: true, ...installed },
    };
  let brew: string | undefined;
  if (ctx.platform.isMac)
    for (const candidate of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"]) {
      const result = await ctx.runner.run(candidate, ["--version"], { timeoutMs: 5000 });
      if (ok(result) && /Homebrew\s+\d/.test(output(result))) {
        brew = candidate;
        break;
      }
    }
  if (!args.install || !brew)
    return {
      summary: brew
        ? "Optional live device logging is not installed. Preview installation with app_debugging action=setup install=true."
        : "Optional live device logging is unavailable: install Homebrew separately on the Mac, or use Apple snapshots/Console import.",
      data: { ready: false, homebrew_available: !!brew, optional: true },
      isError: !!args.install && !brew,
    };
  const command = brew;
  return withConfirmation(
    ctx,
    extra,
    args,
    () => ({
      title: "Install optional live iPhone/iPad logging backend",
      steps: [
        cmdStep("Install libimobiledevice and its dependencies with existing Homebrew", command, [
          "install",
          "libimobiledevice",
        ]),
      ],
      warnings: [
        "Optional download and local package installation. Apple credentials are not needed. Homebrew itself is not installed by this action.",
      ],
    }),
    async () => {
      const job = await ctx.jobs.runWithDeadline(
        "app_debugging",
        "Install optional device logging",
        0,
        async (job) => {
          const result = await ctx.runner.run(command, ["install", "libimobiledevice"], {
            signal: job.signal,
            timeoutMs: 10 * 60 * 1000,
            retainOutput: false,
            env: { HOMEBREW_NO_AUTO_UPDATE: "1" },
          });
          if (!ok(result))
            throw new Error(
              "Debug evidence unavailable: optional Homebrew backend installation failed. Inspect Homebrew locally; no logging capability was assumed.",
            );
          const verified = await findDeviceLogTool(ctx);
          if (!verified)
            throw new Error(
              "Debug evidence unavailable: optional backend installation did not produce a supported idevicesyslog executable.",
            );
          job.setMeta("backend", verified);
          return {
            summary: "Optional live device logging installed and verified.",
            data: { ready: true, ...verified },
          };
        },
      );
      return job.done
        ? { ...job.value, data: { ...job.value.data, job_id: job.jobId } }
        : detachedOutput(ctx, job.jobId, "Optional device logging setup");
    },
  );
}
