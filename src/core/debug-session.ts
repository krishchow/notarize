import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CrashSummary, parseCrashReport } from "../parsers/ips";
import type { ToolContext } from "../tools/types";
import { type DebugCapabilities, type DebugTarget, debugLogCommand, deviceJson } from "./debug-target";
import { liveDeviceLogCommand } from "./device-log-backend";
import { collectDeviceLogs } from "./device-logs";
import { ok, type RunOptions, type RunResult } from "./exec";
import { classifyJobState, readJobState } from "./jobs";
import { defaultJobsDir } from "./logs";
import { redact, redactDeep } from "./redact";

export interface DebugLimits {
  seconds: number;
  bytes: number;
  lines: number;
}
export interface DebugSegment {
  id: string;
  job_id?: string;
  backend: string;
  capture_mode?: "stream" | "snapshot";
  log_scope?: DebugCapabilities["log_scope"];
  connected?: boolean;
  evidence_start?: string;
  installed_app?: DebugCapabilities["installed_app"];
  started_at: string;
  ended_at?: string;
  status: "starting" | "ready" | "complete" | "failed" | "cancelled" | "interrupted";
  ready_at?: string;
  reason?: string;
  truncated?: boolean;
  bytes?: number;
  lines?: number;
  records?: number;
  artifact?: string;
  excerpts?: string;
  reports?: { artifact: string; summary: CrashSummary }[];
}
export interface DebugSession {
  schema: 1;
  session_id: string;
  target: DebugTarget;
  created_at: string;
  updated_at: string;
  installation_channel: string;
  build: { version?: string; number?: string; source: "user-reported" | "unknown" };
  versions: Record<string, string>;
  gaps: string[];
  limits: DebugLimits;
  segments: DebugSegment[];
  markers: { timestamp: string; recorded_at: string; label: string }[];
  imports: {
    artifact: string;
    imported_at: string;
    origin: string;
    provenance: string;
    summary?: CrashSummary;
    excerpts?: string;
  }[];
  redaction: string;
}
export function debugRoot(ctx: ToolContext): string {
  return join(ctx.jobs.stateDir ?? defaultJobsDir(ctx.platform.os, ctx.platform.homeDir), "debugging");
}
function sessionDir(ctx: ToolContext, id: string): string {
  if (!/^debug_[a-f0-9]{24}$/.test(id)) throw new Error("Debug session invalid: malformed session_id.");
  return join(debugRoot(ctx), id);
}
export async function loadDebugSession(ctx: ToolContext, id: string): Promise<DebugSession> {
  const path = join(sessionDir(ctx, id), "session.json");
  const s = JSON.parse(await readFile(path, "utf8")) as DebugSession;
  if (s.schema !== 1 || s.session_id !== id) throw new Error("Debug session invalid: unsupported manifest.");
  for (const seg of s.segments) {
    const persisted =
      seg.job_id && !ctx.jobs.get(seg.job_id) && ctx.jobs.stateDir
        ? readJobState(join(ctx.jobs.stateDir, `${seg.job_id}.json`))
        : undefined;
    const activeElsewhere =
      persisted &&
      classifyJobState(persisted).foreign &&
      !classifyJobState(persisted).lost &&
      persisted.status === "running";
    if (
      ["starting", "ready"].includes(seg.status) &&
      !activeElsewhere &&
      (!seg.job_id || ctx.jobs.get(seg.job_id)?.status !== "running")
    ) {
      seg.status = "interrupted";
      seg.reason = "Capture continuity was lost; resume starts a separately authorized segment.";
    }
  }
  return s;
}
const locks = new Map<string, Promise<unknown>>();
async function writeManifest(ctx: ToolContext, s: DebugSession): Promise<void> {
  const dir = sessionDir(ctx, s.session_id);
  s.updated_at = ctx.now().toISOString();
  const tmp = join(dir, `session-${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(debugRedactDeep(s), null, 2), { mode: 0o600 });
  await rename(tmp, join(dir, "session.json"));
}
export async function updateDebugSession(
  ctx: ToolContext,
  id: string,
  mutate: (s: DebugSession) => void,
): Promise<DebugSession> {
  const key = sessionDir(ctx, id);
  const previous = locks.get(key) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      const s = await loadDebugSession(ctx, id);
      mutate(s);
      await writeManifest(ctx, s);
      return s;
    });
  locks.set(key, task);
  try {
    return await task;
  } finally {
    if (locks.get(key) === task) locks.delete(key);
  }
}

/** Redact the complete bounded buffer, so chunk boundaries cannot expose credentials. */
export function redactDebugEvidence(text: string, truncated = false): string {
  let safe = truncated ? text.slice(0, Math.max(0, text.lastIndexOf("\n") + 1)) : text;
  safe = safe.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    "[REDACTED PRIVATE KEY]",
  );
  safe = redact(safe)
    .replace(/\b(Bearer\s+)[^\s"']+/gi, "$1***")
    .replace(
      /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi,
      "$1$2***",
    );
  return safe;
}
export function debugRedactDeep<T>(value: T): T {
  const base = redactDeep(value);
  if (typeof base === "string") return redactDebugEvidence(base) as T;
  if (Array.isArray(base)) return base.map((v) => debugRedactDeep(v)) as T;
  if (base && typeof base === "object")
    return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, debugRedactDeep(v)])) as T;
  return base;
}
export function debugExcerpts(text: string): string {
  const safe = redactDebugEvidence(text);
  const lines = safe.split("\n");
  const relevant = lines.filter((line) => /error|fail|exception|denied|sqlite|schema|loading/i.test(line));
  return (relevant.length ? relevant : lines).slice(-40).join("\n").slice(-4000);
}
export async function createDebugSession(
  ctx: ToolContext,
  cap: DebugCapabilities,
  limits: DebugLimits,
  channel: string,
  version?: string,
  build?: string,
): Promise<DebugSession> {
  await mkdir(debugRoot(ctx), { recursive: true, mode: 0o700 });
  // Retention only runs inside an approved write action. Never prune active captures.
  for (const name of await readdir(debugRoot(ctx))) {
    if (!/^debug_[a-f0-9]{24}$/.test(name)) continue;
    try {
      const old = await loadDebugSession(ctx, name);
      if (
        Date.parse(old.updated_at) < ctx.now().getTime() - 30 * 86400000 &&
        !old.segments.some((s) => ["starting", "ready"].includes(s.status))
      )
        await rm(sessionDir(ctx, name), { recursive: true });
    } catch {
      /* Leave unknown or unreadable state alone. */
    }
  }
  const id = `debug_${randomBytes(12).toString("hex")}`;
  await mkdir(sessionDir(ctx, id), { mode: 0o700 });
  const time = ctx.now().toISOString();
  const s: DebugSession = {
    schema: 1,
    session_id: id,
    target: cap.target,
    created_at: time,
    updated_at: time,
    installation_channel: channel,
    build: { version, number: build, source: version || build ? "user-reported" : "unknown" },
    versions: cap.versions,
    gaps: cap.gaps,
    limits,
    segments: [],
    markers: [],
    imports: [],
    redaction:
      "Known secret patterns and credential fields masked before persistence; app-scoped logs can still contain personal data.",
  };
  await writeManifest(ctx, s);
  return s;
}
export async function writeDebugArtifact(
  ctx: ToolContext,
  id: string,
  content: string,
  extension = "log",
): Promise<string> {
  const path = join(sessionDir(ctx, id), `${randomBytes(12).toString("hex")}.${extension}`);
  await writeFile(path, redactDebugEvidence(content), { mode: 0o600, flag: "wx" });
  return path;
}
export function matchesReport(target: DebugTarget, summary: CrashSummary): boolean {
  if (summary.bundleId && target.bundle_id) return summary.bundleId === target.bundle_id;
  return !!target.process && summary.process === target.process;
}

/** Only inspect explicit crash-report metadata, never infer simulator ownership from a path. */
export function debugReportOrigin(raw: string): { simulatorIds: string[]; simulated: boolean } {
  const records: Record<string, unknown>[] = [];
  const nl = raw.indexOf("\n");
  try {
    records.push(JSON.parse(nl < 0 ? raw : raw.slice(0, nl)));
    if (nl >= 0) records.push(JSON.parse(raw.slice(nl + 1)));
  } catch {
    /* Legacy text reports have no established simulator identifier. */
  }
  const simulatorIds = records
    .flatMap((record) => [record.simulatorUDID, record.simulatorIdentifier])
    .filter((id): id is string => typeof id === "string");
  return {
    simulatorIds,
    simulated:
      simulatorIds.length > 0 ||
      records.some(
        (record) =>
          record.is_simulated === true ||
          record.is_simulated === 1 ||
          record.isSimulated === true ||
          record.isSimulated === 1,
      ),
  };
}
export function reportTargetMatches(target: DebugTarget, raw: string, summary: CrashSummary): boolean {
  if (!matchesReport(target, summary)) return false;
  const origin = debugReportOrigin(raw);
  if (origin.simulated && target.platform !== "ios-simulator") return false;
  if (
    target.platform === "ios-simulator" &&
    origin.simulatorIds.some((id) => id.toLowerCase() !== target.simulator_id.toLowerCase())
  )
    return false;
  if (target.platform === "ios" && /Mac OS X|macOS/i.test(summary.osVersion ?? "")) return false;
  return true;
}

async function collectReports(
  ctx: ToolContext,
  session: DebugSession,
  cap: DebugCapabilities,
  signal: AbortSignal,
  budget: { bytes: number; truncated: boolean },
  segmentId: string,
): Promise<{ artifact: string; summary: CrashSummary }[]> {
  const reports: { artifact: string; summary: CrashSummary }[] = [];
  if (!cap.reports) return reports;
  const retain = async (raw: string, summary: CrashSummary) => {
    const report = {
      artifact: await writeDebugArtifact(ctx, session.session_id, raw, "ips"),
      summary: debugRedactDeep(summary),
    };
    reports.push(report);
    // Preserve each completed report even if the next transfer disconnects or is cancelled.
    await updateDebugSession(ctx, session.session_id, (current) => {
      const segment = current.segments.find((s) => s.id === segmentId)!;
      segment.reports ??= [];
      segment.reports.push(report);
    });
  };
  if (session.target.platform === "ios") {
    // Individual reports only. This copy is covered by the capture preview.
    for (const name of cap.reportNames ?? []) {
      if (signal.aborted) break;
      const expectedSize = cap.reportSizes?.[name];
      if (expectedSize === undefined || expectedSize > budget.bytes) {
        budget.truncated = true;
        break;
      }
      const scratch = await mkdtemp(join(tmpdir(), "notarize-report-"));
      const destination = join(scratch, "report.ips");
      try {
        await deviceJson(
          ctx,
          [
            "device",
            "copy",
            "from",
            "--device",
            session.target.device_id,
            "--domain-type",
            "systemCrashLogs",
            "--source",
            name,
            "--destination",
            destination,
          ],
          signal,
        );
        const info = await stat(destination);
        if (!info.isFile() || info.size > budget.bytes || info.size > expectedSize) {
          budget.truncated = true;
          break;
        }
        budget.bytes -= info.size;
        const raw = await readFile(destination, "utf8");
        const summary = parseCrashReport(raw);
        if (reportTargetMatches(session.target, raw, summary)) await retain(raw, summary);
      } finally {
        await rm(scratch, { force: true, recursive: true });
      }
    }
  } else if (session.target.platform === "macos") {
    for (const dir of [
      join(ctx.platform.homeDir, "Library/Logs/DiagnosticReports"),
      "/Library/Logs/DiagnosticReports",
    ]) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Debug evidence unavailable: host crash-report directory is unreadable.");
        continue;
      }
      const candidates = [];
      for (const name of names) {
        if (signal.aborted) break;
        if (!/\.(ips|crash)$/.test(name)) continue;
        const appName = session.target.process ?? session.target.bundle_id!;
        if (
          !name.toLowerCase().startsWith(appName.toLowerCase() + "-") &&
          !name.toLowerCase().startsWith(appName.toLowerCase() + "_") &&
          !name.toLowerCase().startsWith(appName.toLowerCase() + ".")
        )
          continue;
        const p = join(dir, name);
        const info = await stat(p);
        if (info.isFile() && info.size <= session.limits.bytes) candidates.push({ p, time: info.mtimeMs });
        else if (info.isFile()) budget.truncated = true;
      }
      candidates.sort((a, b) => b.time - a.time);
      for (const { p } of candidates.slice(0, 100)) {
        if (signal.aborted) break;
        const info = await stat(p);
        if (info.size > budget.bytes) {
          budget.truncated = true;
          continue;
        }
        budget.bytes -= info.size;
        const raw = await readFile(p, "utf8");
        const summary = parseCrashReport(raw);
        if (reportTargetMatches(session.target, raw, summary)) await retain(raw, summary);
        if (reports.length >= 10) return reports;
      }
    }
  }
  return reports;
}

export async function captureDebugSegment(
  ctx: ToolContext,
  session: DebugSession,
  cap: DebugCapabilities,
  options: { lookback_seconds?: number; use_sudo?: boolean } = {},
): Promise<{ jobId: string }> {
  const segment: DebugSegment = {
    id: randomBytes(12).toString("hex"),
    backend: cap.logs && cap.log_backend ? cap.log_backend : cap.backend,
    capture_mode: cap.logs ? (cap.log_mode ?? "stream") : undefined,
    log_scope: cap.log_scope,
    installed_app: cap.installed_app,
    evidence_start:
      cap.logs && cap.log_mode === "snapshot"
        ? new Date(ctx.now().getTime() - (options.lookback_seconds ?? 120) * 1000).toISOString()
        : undefined,
    started_at: ctx.now().toISOString(),
    status: "starting",
  };
  let initialization: Promise<unknown> = Promise.resolve();
  const launch = await ctx.jobs.runWithDeadline(
    "app_debugging",
    `Capture ${session.target.platform} app evidence`,
    0,
    async (job) => {
      initialization = updateDebugSession(ctx, session.session_id, (s) => {
        if (s.segments.some((seg) => ["starting", "ready"].includes(seg.status)))
          throw new Error("Debug session invalid: capture is already running.");
        s.segments.push({ ...segment, job_id: job.id });
        s.gaps = cap.gaps;
        s.versions = cap.versions;
      });
      await initialization;
      job.setMeta("session_id", session.session_id);
      job.setMeta("target", session.target);
      const chunks: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
      const evidence = () =>
        [chunks.stdout.join(""), chunks.stderr.join("")]
          .filter(Boolean)
          .map((text) => redactDebugEvidence(text, limit === "output limit"))
          .join("\n");
      const reportBudget = { bytes: session.limits.bytes, truncated: false };
      let bytes = 0;
      let lines = 0;
      let limit: string | undefined;
      let ready = false;
      let disconnected = false;
      let records = 0;
      let transportBuffer = "";
      const inspectTransport = (chunk: string) => {
        transportBuffer += chunk;
        const complete = transportBuffer.split("\n");
        transportBuffer = complete.pop()!.slice(-512);
        for (const line of complete) {
          if (line.trim() === `[connected:${cap.device_udid}]`) ready = true;
          if (line.trim() === `[disconnected:${cap.device_udid}]`) disconnected = true;
          if (/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/.test(line)) records++;
        }
      };
      let readinessWrite: Promise<unknown> = Promise.resolve();
      let persistenceError: unknown;
      const controller = new AbortController();
      const abort = () => controller.abort();
      job.signal.addEventListener("abort", abort, { once: true });
      if (job.signal.aborted) abort();
      const timer = setTimeout(() => {
        limit ??= "duration";
        controller.abort();
      }, session.limits.seconds * 1000);
      const finish = async (changes: Partial<DebugSegment>) => {
        await readinessWrite;
        await updateDebugSession(ctx, session.session_id, (s) =>
          Object.assign(s.segments.find((x) => x.id === segment.id)!, changes, {
            ended_at: ctx.now().toISOString(),
          }),
        );
      };
      try {
        let failure: string | undefined;
        // Snapshot reports before live streaming so both operations share the same deadline.
        const reports = controller.signal.aborted
          ? []
          : await collectReports(ctx, session, cap, controller.signal, reportBudget, segment.id);
        bytes = session.limits.bytes - reportBudget.bytes;
        if (reportBudget.truncated || bytes >= session.limits.bytes) {
          limit = "output limit";
          controller.abort();
        }
        if (cap.logs && !controller.signal.aborted) {
          const runOptions: RunOptions = {
            signal: controller.signal,
            timeoutMs: (session.limits.seconds + 5) * 1000,
            retainOutput: false,
            onOutput(chunk, stream = "stdout") {
              if (controller.signal.aborted) return;
              const wasReady = ready;
              const remaining = session.limits.bytes - bytes;
              const encoded = Buffer.from(chunk);
              let accepted = encoded.subarray(0, remaining).toString("utf8");
              // A byte cut can split a UTF-8 character; never exceed the approved bound.
              while (Buffer.byteLength(accepted) > remaining) accepted = accepted.slice(0, -1);
              const parts = accepted.split("\n");
              if (parts.length - 1 > session.limits.lines - lines)
                accepted = parts.slice(0, session.limits.lines - lines).join("\n") + "\n";
              bytes += Buffer.byteLength(accepted);
              lines += accepted.split("\n").length - 1;
              chunks[stream].push(accepted);
              if (cap.log_backend === "libimobiledevice" && stream === "stdout") inspectTransport(accepted);
              if (
                cap.log_mode !== "snapshot" &&
                (!ready || !wasReady) &&
                (cap.log_backend === "libimobiledevice"
                  ? ready && !wasReady
                  : /Filtering the log data|Timestamp\s+Ty/.test(chunks[stream].slice(-2).join("")))
              ) {
                ready = true;
                job.progress("Capture ready; reproduce now, then record a marker.");
                readinessWrite = updateDebugSession(ctx, session.session_id, (s) => {
                  const seg = s.segments.find((x) => x.id === segment.id)!;
                  seg.status = "ready";
                  seg.ready_at = ctx.now().toISOString();
                  if (cap.log_backend === "libimobiledevice") seg.connected = true;
                }).catch((e) => {
                  persistenceError = e;
                  controller.abort();
                });
              }
              if (encoded.length >= remaining || lines >= session.limits.lines) {
                limit = "output limit";
                controller.abort();
              }
            },
          };
          let r: RunResult;
          if (cap.log_mode === "snapshot") {
            job.progress("Collecting stored app logs from the selected phone; no live stream is attached.");
            r = await collectDeviceLogs(
              ctx,
              cap,
              new Date(segment.evidence_start!),
              session.limits.bytes - bytes,
              runOptions,
              options.use_sudo,
            );
          } else {
            const command =
              cap.log_backend === "libimobiledevice"
                ? liveDeviceLogCommand(cap)
                : debugLogCommand(session.target);
            r = await ctx.runner.run(command.cmd, command.args, runOptions);
          }

          if (!ok(r) && !limit && !job.signal.aborted)
            failure = `Debug evidence unavailable: log backend exited (${r.code ?? r.signal ?? r.spawnError ?? "unknown"}).`;
          if (cap.log_backend === "libimobiledevice" && !limit && !job.signal.aborted)
            failure = disconnected
              ? "Debug evidence unavailable: selected device log stream disconnected; partial evidence retained."
              : "Debug evidence unavailable: live device log stream ended before the approved duration; partial evidence retained.";
          if (cap.log_backend === "libimobiledevice" && !ready && !job.signal.aborted)
            failure =
              "Debug evidence unavailable: selected device log stream never confirmed its connection.";
        }
        const raw = evidence();
        const artifact = await writeDebugArtifact(
          ctx,
          session.session_id,
          redactDebugEvidence(raw, limit === "output limit"),
        );
        if (persistenceError) throw persistenceError;
        await finish({
          status: job.signal.aborted ? "cancelled" : failure ? "failed" : "complete",
          reason:
            failure ??
            limit ??
            (cap.log_mode === "snapshot" && cap.logs
              ? "stored log snapshot complete"
              : cap.logs
                ? "backend exited"
                : "report collection complete"),
          truncated: limit === "output limit",
          bytes,
          lines,
          records: cap.log_backend === "libimobiledevice" ? records : undefined,
          artifact,
          excerpts: debugExcerpts(redactDebugEvidence(raw, limit === "output limit")),
          reports,
        });
        job.setMeta("artifact", artifact);
        return {
          summary:
            failure ??
            `Capture finished: ${cap.log_backend === "libimobiledevice" ? `${records} filtered log records (${cap.log_scope})` : `${lines} log lines`}, ${reports.length} matching report(s). Empty evidence does not rule out an app failure.`,
          isError: !!failure,
          data: { session_id: session.session_id, target: session.target, artifact, reports },
        };
      } catch (e) {
        bytes = Math.max(bytes, session.limits.bytes - reportBudget.bytes);
        const artifact = await writeDebugArtifact(
          ctx,
          session.session_id,
          redactDebugEvidence(evidence(), true),
        );
        await finish({
          status: job.signal.aborted ? "cancelled" : limit ? "complete" : "failed",
          reason: limit ?? redactDebugEvidence(String(e)),
          bytes,
          lines,
          artifact,
        });
        if (limit || job.signal.aborted)
          return {
            summary: "Bounded capture stopped; inspect status for partial evidence.",
            data: { session_id: session.session_id, target: session.target, artifact },
          };
        throw new Error(
          "Debug evidence unavailable: capture failed; inspect app_debugging status for partial evidence and limitations.",
        );
      } finally {
        clearTimeout(timer);
        job.signal.removeEventListener("abort", abort);
      }
    },
  );
  await initialization;
  return { jobId: launch.jobId };
}
