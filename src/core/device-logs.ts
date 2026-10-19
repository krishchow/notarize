import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/types";
import type { DebugCapabilities } from "./debug-target";
import { ok, output, type RunOptions, type RunResult } from "./exec";

export function deviceLogPredicate(cap: DebugCapabilities): string {
  const process = cap.target.process ?? cap.resolved_process;
  const filters = cap.target.bundle_id ? [`subsystem == ${JSON.stringify(cap.target.bundle_id)}`] : [];
  if (process) filters.push(`process == ${JSON.stringify(process)}`);
  if (!filters.length) throw new Error("Debug evidence unavailable: device logs require an app identity.");
  return filters.join(" OR ");
}

export function deviceLogCollectArgs(
  cap: DebugCapabilities,
  archive: string,
  since: Date,
  bytes: number,
): string[] {
  if (cap.target.platform !== "ios" || !cap.device_udid)
    throw new Error("Debug evidence unavailable: selected phone has no resolved UDID for log collection.");
  return [
    "collect",
    "--device-udid",
    cap.device_udid,
    "--start",
    `@${Math.floor(since.getTime() / 1000)}`,
    "--size",
    `${Math.max(1, Math.floor(bytes / 1024))}k`,
    "--predicate",
    deviceLogPredicate(cap),
    "--output",
    archive,
  ];
}

async function archiveSize(path: string, signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw new Error("Debug evidence unavailable: device log collection stopped.");
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await archiveSize(join(path, name), signal);
  return bytes;
}

/** Apple device archive collection and filtered export. Never retains the raw archive. */
export async function collectDeviceLogs(
  ctx: ToolContext,
  cap: DebugCapabilities,
  since: Date,
  bytes: number,
  opts: RunOptions,
  useSudo = false,
): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "notarize-device-logs-"));
  const archive = join(dir, "app.logarchive");
  try {
    const args = deviceLogCollectArgs(cap, archive, since, bytes);
    // sudo is opt-in, noninteractive, and never receives a password through MCP.
    const r = await ctx.runner.run(
      useSudo ? "/usr/bin/sudo" : "/usr/bin/log",
      useSudo ? ["-n", "--", "/usr/bin/log", ...args] : args,
      { signal: opts.signal, timeoutMs: opts.timeoutMs },
    );
    if (!ok(r)) {
      const message = output(r);
      if (/root|privileg|not permitted|permission denied|password is required|not allowed/i.test(message))
        throw new Error(
          "Debug evidence unavailable: Apple device log collection requires administrator authorization on this Mac. Retry with use_sudo=true only if this MCP process already has approved noninteractive sudo access. A cached authorization in a different terminal may not apply. MCP never requests your password. Console/import remains available.",
        );
      throw new Error(`Debug evidence unavailable: device log collection failed: ${message}`);
    }
    if (!opts.signal)
      throw new Error("Debug session invalid: device capture requires a cancellation signal.");
    let size: number;
    if (useSudo) {
      const usage = await ctx.runner.run("/usr/bin/sudo", ["-n", "--", "/usr/bin/du", "-sk", archive], {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      });
      const blocks = /^(\d+)\s/.exec(usage.stdout);
      if (!ok(usage) || !blocks)
        throw new Error("Debug evidence unavailable: unable to verify privileged archive size.");
      size = Number(blocks[1]) * 1024;
    } else size = await archiveSize(archive, opts.signal);
    if (size > bytes)
      throw new Error(
        "Debug evidence unavailable: device log archive exceeds the approved byte limit; raw archive discarded.",
      );
    const exportArgs = [
      "show",
      "--archive",
      archive,
      "--style",
      "compact",
      "--info",
      "--debug",
      "--start",
      `@${Math.floor(since.getTime() / 1000)}`,
      "--predicate",
      deviceLogPredicate(cap),
    ];
    return await ctx.runner.run(
      useSudo ? "/usr/bin/sudo" : "/usr/bin/log",
      useSudo ? ["-n", "--", "/usr/bin/log", ...exportArgs] : exportArgs,
      opts,
    );
  } finally {
    await cleanupDeviceArchive(ctx, dir, useSudo);
  }
}

async function cleanupDeviceArchive(ctx: ToolContext, dir: string, useSudo: boolean): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    if (!useSudo || !["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    // This is an internally generated private scratch path, never a tool argument.
    const removed = await ctx.runner.run("/usr/bin/sudo", ["-n", "--", "/bin/rm", "-rf", "--", dir], {
      timeoutMs: 10000,
    });
    if (!ok(removed))
      throw new Error(
        `Debug evidence unavailable: raw archive cleanup failed in private temporary directory ${dir}. Administrator cleanup is required.`,
      );
  }
}
