import { join } from "node:path";
import { HEARTBEAT_MS, type JobStateFile, readJobState } from "../core/jobs";
import { defaultJobsDir } from "../core/logs";
import { ToolError } from "../core/result";
import { groupIssues, parseNotaryJson } from "../parsers/notarytool";
import { fetchLog, notaryAuth } from "../tools/notary";
import type { ToolContext } from "../tools/types";

/**
 * Shell-friendly watchers designed for Claude Code's Monitor tool (or any
 * background shell): each status change is printed as ONE line, and the
 * process exits when a terminal state is reached.
 *
 * Exit codes: 0 success · 1 failure (job failed / notarization Invalid) ·
 * 2 usage or lookup error · 3 lost (server stopped while the job was running).
 */

export interface WatchIO {
  print(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const defaultIO: WatchIO = {
  print: (line) => process.stdout.write(`${line}\n`),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

function oneLine(text: string | undefined, max = 400): string {
  return (text ?? "").replace(/\s*\n\s*/g, " · ").slice(0, max);
}

export async function watchJob(
  jobId: string,
  opts: { stateDir?: string; intervalMs?: number; staleMs?: number; maxMs?: number } = {},
  io: WatchIO = defaultIO,
): Promise<number> {
  const dir = opts.stateDir ?? defaultJobsDir();
  const path = join(dir, `${jobId}.json`);
  const interval = opts.intervalMs ?? 10_000;
  const stale = opts.staleMs ?? HEARTBEAT_MS * 4;
  const started = io.now();
  let last = "";
  let seen = false;
  for (;;) {
    const s: JobStateFile | undefined = readJobState(path);
    if (!s) {
      if (!seen && io.now() - started > 30_000) {
        io.print(`${jobId}: NOT FOUND — no state file at ${path}`);
        return 2;
      }
    } else {
      seen = true;
      const label = `${s.name} ${s.id}`;
      if (s.status !== "running") {
        const failed = s.status !== "succeeded" || s.resultIsError;
        io.print(
          `${label}: ${failed ? "FAILED" : "SUCCEEDED"}${s.status === "cancelled" ? " (cancelled)" : ""} — ${oneLine(s.summary ?? s.error ?? s.progress)}`,
        );
        return failed ? 1 : 0;
      }
      const sub = s.meta?.submissionId ? ` [submission ${s.meta.submissionId}]` : "";
      const line = `${label}: running — ${s.progress ?? s.description}${sub}`;
      if (line !== last) {
        io.print(line);
        last = line;
      }
      if (io.now() - Date.parse(s.updatedAt) > stale) {
        io.print(
          `${label}: LOST — the MCP server stopped updating this job (pid ${s.pid}).${s.meta?.submissionId ? ` Apple keeps processing submission ${s.meta.submissionId}; use notary action=status / watch-notarization.` : ""}`,
        );
        return 3;
      }
    }
    if (opts.maxMs && io.now() - started > opts.maxMs) {
      io.print(
        `${jobId}: still running after ${Math.round(opts.maxMs / 60000)} min — re-run this watcher to keep waiting.`,
      );
      return 4;
    }
    await io.sleep(interval);
  }
}

export async function watchNotarization(
  ctx: ToolContext,
  submissionId: string,
  opts: { keychainProfile?: string; profile?: string; intervalMs?: number; maxMs?: number } = {},
  io: WatchIO = defaultIO,
): Promise<number> {
  let auth: Awaited<ReturnType<typeof notaryAuth>>;
  try {
    auth = await notaryAuth(ctx, opts.keychainProfile, opts.profile);
  } catch (e) {
    io.print(`notarization ${submissionId}: ERROR — ${(e as Error).message}`);
    return 2;
  }
  const started = io.now();
  let last = "";
  let failures = 0;
  try {
    for (;;) {
      const r = await ctx.runner.run(
        "xcrun",
        ["notarytool", "info", submissionId, ...auth.args, "--output-format", "json"],
        {
          timeoutMs: 120_000,
        },
      );
      const s = parseNotaryJson(r.stdout);
      if (r.code !== 0 || !s.status) {
        failures++;
        if (failures >= 5) {
          io.print(`notarization ${submissionId}: ERROR — ${oneLine(r.stderr || r.stdout, 300)}`);
          return 2;
        }
      } else {
        failures = 0;
        if (s.status !== last) {
          last = s.status;
          if (s.status === "In Progress")
            io.print(`notarization ${submissionId}: In Progress (${s.name ?? ""})`);
        }
        if (s.status === "Accepted") {
          io.print(
            `notarization ${submissionId}: ACCEPTED — staple the artifact now (staple action=staple).`,
          );
          return 0;
        }
        if (s.status !== "In Progress") {
          const log = await fetchLog(ctx, submissionId, auth);
          const top = log ? groupIssues(log.issues).slice(0, 3) : [];
          io.print(
            `notarization ${submissionId}: ${s.status.toUpperCase()} — ${top.length ? top.map((g) => `${g.message}${g.count > 1 ? ` ×${g.count}` : ""}`).join(" | ") : oneLine(log?.statusSummary ?? s.message)}`,
          );
          return 1;
        }
      }
      if (opts.maxMs && io.now() - started > opts.maxMs) {
        io.print(`notarization ${submissionId}: still In Progress — re-run this watcher to keep waiting.`);
        return 4;
      }
      await io.sleep(opts.intervalMs ?? 30_000);
    }
  } finally {
    await auth.cleanup();
  }
}

/** Parse `--flag value` pairs after positional args. */
export function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      if (inline !== undefined) flags[k] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = "true";
    } else positional.push(a);
  }
  return { positional, flags };
}

export function requireArg(v: string | undefined, usage: string): string {
  if (!v) throw new ToolError(`Usage: ${usage}`);
  return v;
}
