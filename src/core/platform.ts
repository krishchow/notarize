import { homedir } from "node:os";
import type { CommandRunner } from "./exec";
import { ok } from "./exec";
import { ToolError } from "./result";

export interface PlatformInfo {
  os: NodeJS.Platform;
  isMac: boolean;
  homeDir: string;
}

export function detectPlatform(): PlatformInfo {
  const os = (process.env.NOTARIZE_MCP_PLATFORM as NodeJS.Platform | undefined) ?? process.platform;
  return { os, isMac: os === "darwin", homeDir: process.env.NOTARIZE_MCP_HOME ?? homedir() };
}

export function requireMacOS(platform: PlatformInfo, feature: string): void {
  if (!platform.isMac) {
    throw new ToolError(`${feature} requires macOS (this server is running on ${platform.os}).`, {
      hint: "Run this MCP server on the Mac that holds your signing identities. App Store Connect API tools and file inspection tools still work on other platforms.",
    });
  }
}

/** Resolve a developer tool through xcrun (falls back to PATH lookup). */
export async function findTool(runner: CommandRunner, name: string): Promise<string | undefined> {
  const r = await runner.run("xcrun", ["--find", name], { timeoutMs: 15000 });
  if (ok(r) && r.stdout.trim()) return r.stdout.trim();
  const w = await runner.run("/usr/bin/which", [name], { timeoutMs: 5000 });
  if (ok(w) && w.stdout.trim()) return w.stdout.trim();
  return undefined;
}

export interface XcodeInfo {
  developerDir?: string;
  xcodeVersion?: string;
  buildVersion?: string;
  isCommandLineToolsOnly: boolean;
}

export async function xcodeInfo(runner: CommandRunner): Promise<XcodeInfo> {
  const sel = await runner.run("xcode-select", ["-p"], { timeoutMs: 10000 });
  const developerDir = ok(sel) ? sel.stdout.trim() : undefined;
  const v = await runner.run("xcodebuild", ["-version"], { timeoutMs: 30000 });
  let xcodeVersion: string | undefined;
  let buildVersion: string | undefined;
  if (ok(v)) {
    xcodeVersion = /Xcode\s+([\d.]+)/.exec(v.stdout)?.[1];
    buildVersion = /Build version\s+(\S+)/.exec(v.stdout)?.[1];
  }
  return {
    developerDir,
    xcodeVersion,
    buildVersion,
    isCommandLineToolsOnly: !!developerDir && developerDir.includes("CommandLineTools"),
  };
}

export async function macOSVersion(runner: CommandRunner): Promise<string | undefined> {
  const r = await runner.run("sw_vers", ["-productVersion"], { timeoutMs: 5000 });
  return ok(r) ? r.stdout.trim() : undefined;
}

/** Compare dotted versions: returns -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
