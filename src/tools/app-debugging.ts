import { open } from "node:fs/promises";
import { z } from "zod";
import { cmdStep } from "../core/confirm";
import {
  captureDebugSegment,
  createDebugSession,
  debugExcerpts,
  debugRedactDeep,
  debugReportOrigin,
  debugRoot,
  loadDebugSession,
  redactDebugEvidence,
  reportTargetMatches,
  updateDebugSession,
  writeDebugArtifact,
} from "../core/debug-session";
import {
  type DebugTarget,
  debugCapabilityNextSteps,
  debugLogCommand,
  debugTargetSchema,
  probeDebugTarget,
} from "../core/debug-target";
import { liveDeviceLogCommand, setupDeviceLogs } from "../core/device-log-backend";
import { deviceLogCollectArgs, deviceLogPredicate } from "../core/device-logs";
import { ok, output } from "../core/exec";
import { parseCrashReport } from "../parsers/ips";
import { detachedOutput } from "./detached";
import { defineTool, withConfirmation } from "./types";

const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) throw new Error(`Debug session invalid: ${name} is required for this action.`);
  return value;
};

export const appDebuggingTool = defineTool({
  name: "app_debugging",
  title: "Collect target-aware app debugging evidence",
  description:
    "setup: inspect optional normal-user live device logging; install=true previews libimobiledevice installation through existing Homebrew. probe: check explicit macOS, iPhone/iPad or simulator capabilities without Apple credentials. start: preview bounded app-scoped logs/reports and persist a session. status: inspect readiness, artifacts and gaps. mark: preview a reproduction timestamp. cancel: preview stopping capture, retaining evidence. resume: preview a new segment after reprobe. import: preview local text evidence with provenance. relaunch: separately preview app launch/relaunch. Physical devices prefer installed libimobiledevice live logs; backend=apple uses stored-log snapshots requiring reproduction first and potentially administrator authorization. Console text import is a fallback. No resets, device registration, or automatic Developer Mode changes. Empty evidence is not proof of a healthy app.",
  mutating: true,
  input: {
    action: z.enum(["setup", "probe", "start", "status", "mark", "cancel", "resume", "import", "relaunch"]),
    install: z
      .boolean()
      .optional()
      .describe(
        "setup only: preview installation of optional libimobiledevice using existing Homebrew. Default false; never installs silently.",
      ),
    backend: z
      .enum(["auto", "apple", "libimobiledevice"])
      .optional()
      .describe(
        "Physical-device logs: auto prefers a supported installed live backend, otherwise Apple snapshots. No automatic installation. Default auto.",
      ),
    log_scope: z
      .enum(["app-related", "process"])
      .optional()
      .describe(
        "Live device logs: app-related matches messages mentioning the bundle ID, including system lifecycle records; process captures the known app process only. Default app-related.",
      ),
    target: debugTargetSchema
      .optional()
      .describe(
        "Explicit app/runtime target. Required for probe, start, relaunch and an import without session_id. Never infer an iPhone target from host logs.",
      ),
    session_id: z
      .string()
      .regex(/^debug_[a-f0-9]{24}$/)
      .optional()
      .describe("Durable debugging session returned by start/import."),
    collection: z
      .enum(["logs", "reports", "both"])
      .optional()
      .describe("start/resume: collection type, default both; unsupported components are disclosed."),
    seconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .describe("Capture duration limit, default 120 seconds."),
    max_bytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .optional()
      .describe("Evidence byte limit, default 10 MiB."),
    lookback_seconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe(
        "Physical-device log snapshots: collect stored logs from this recent window, default 120 seconds. Reproduce before starting; execution duration is bounded separately by seconds.",
      ),
    use_sudo: z
      .boolean()
      .optional()
      .describe(
        "Physical-device log snapshots only: opt in to sudo -n using administrator authorization already available to this MCP process. No password is accepted by MCP. Default false.",
      ),
    max_lines: z.number().int().min(1).max(100000).optional().describe("Log line limit, default 20000."),
    installation_channel: z
      .enum(["TestFlight", "App Store", "development", "other", "unknown"])
      .optional()
      .describe("Installation channel when established; default unknown."),
    version: z
      .string()
      .max(100)
      .optional()
      .describe("User-reported installed app version, never inferred from current source."),
    build: z.string().max(100).optional().describe("User-reported installed build number."),
    label: z.string().min(1).max(500).optional().describe("mark: description of the tap/failure."),
    timestamp: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("mark: reported event time; default time the marker is recorded."),
    path: z
      .string()
      .optional()
      .describe("import: absolute local UTF-8 .log/.txt/.ips/.crash file, at most 50 MiB."),
    origin: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "import: how and where evidence was obtained, including device/simulator identity. Stored as user-reported provenance.",
      ),
  },
  async handler(args, ctx, extra) {
    let target: DebugTarget | undefined = args.target;
    let sessionId = args.session_id;
    try {
      if (args.action === "setup") return await setupDeviceLogs(ctx, extra, args);
      if (args.install) throw new Error("Debug session invalid: install is only supported by action=setup.");
      const session = args.session_id ? await loadDebugSession(ctx, args.session_id) : undefined;
      if (args.action === "start" && session)
        throw new Error("Debug session invalid: use resume to continue a session.");
      if (session) {
        if (target && JSON.stringify(target) !== JSON.stringify(session.target))
          throw new Error("Debug target mismatch: supplied target differs from the session.");
        target = session.target;
      }
      if (args.action === "status") {
        const s = required(session, "session_id");
        return {
          summary: `Debug session ${s.session_id}: ${s.segments.at(-1)?.status ?? "imported evidence"}. Empty evidence does not rule out an app failure.`,
          data: { ...s, target: s.target },
        };
      }
      if (["mark", "cancel"].includes(args.action)) {
        const s = required(session, "session_id");
        if (args.action === "mark") required(args.label, "label");
        return await withConfirmation(
          ctx,
          extra,
          args,
          () => ({
            title: `${args.action} debugging session ${s.session_id}`,
            steps: [
              {
                description:
                  args.action === "mark"
                    ? `Persist reproduction marker: ${redactDebugEvidence(args.label!)}`
                    : "Stop this session's running capture and retain partial evidence.",
              },
            ],
            warnings: [],
          }),
          async () => {
            if (args.action === "mark") {
              const updated = await updateDebugSession(ctx, s.session_id, (current) => {
                if (current.markers.length >= 500)
                  throw new Error("Debug session invalid: marker limit reached.");
                const now = ctx.now().toISOString();
                current.markers.push({
                  timestamp: args.timestamp ?? now,
                  recorded_at: now,
                  label: redactDebugEvidence(args.label!),
                });
              });
              return {
                summary: "Reproduction marker recorded.",
                data: { session_id: s.session_id, target, markers: updated.markers },
              };
            }
            let cancelled = false;
            for (const segment of s.segments)
              if (segment.job_id && ["ready", "starting"].includes(segment.status))
                cancelled = ctx.jobs.cancel(segment.job_id) || cancelled;
            return {
              summary: cancelled
                ? "Cancellation requested; status will retain partial evidence when the backend exits."
                : "No active capture owned by this server.",
              data: { session_id: s.session_id, target, cancelled },
            };
          },
        );
      }
      target = required(target, "target");
      if (args.action === "import") {
        const path = required(args.path, "path");
        required(args.origin, "origin");
        if (!path.startsWith("/") || !/\.(log|txt|ips|crash)$/i.test(path))
          throw new Error(
            "Debug evidence unavailable: import requires an absolute .log/.txt/.ips/.crash path.",
          );
        return await withConfirmation(
          ctx,
          extra,
          args,
          () => ({
            title: `Import ${path} for ${target!.platform}`,
            steps: [
              {
                description: `Read at most 50 MiB, validate report identity, redact, and persist evidence under ${debugRoot(ctx)}.`,
              },
            ],
            warnings: [
              "Origin is user-reported. A device ID cannot generally be verified from exported text logs.",
            ],
          }),
          async () => {
            const handle = await open(path, "r");
            let raw: string;
            try {
              const info = await handle.stat();
              if (!info.isFile() || info.size > 50 * 1024 * 1024)
                throw new Error("Debug evidence unavailable: import must be a regular file at most 50 MiB.");
              const buffer = Buffer.alloc(Math.min(info.size + 1, 50 * 1024 * 1024 + 1));
              let used = 0;
              while (used < buffer.length) {
                const result = await handle.read(buffer, used, buffer.length - used, null);
                if (!result.bytesRead) break;
                used += result.bytesRead;
              }
              if (used > info.size)
                throw new Error(
                  "Debug evidence unavailable: import changed while reading; retry a stable file.",
                );
              raw = buffer.subarray(0, used).toString("utf8");
              if (raw.includes("\0"))
                throw new Error("Debug evidence unavailable: export logs as UTF-8 text first.");
            } finally {
              await handle.close();
            }
            const report = /\.(ips|crash)$/i.test(path) ? parseCrashReport(raw) : undefined;
            if (
              report &&
              (!reportTargetMatches(target!, raw, report) || (!report.bundleId && !report.process))
            )
              throw new Error(
                "Debug target mismatch: crash report app identity does not match the selected target.",
              );
            const ids = report ? debugReportOrigin(raw).simulatorIds : [];
            const s =
              session ??
              (await createDebugSession(
                ctx,
                {
                  target: target!,
                  backend: "manual-import",
                  logs: false,
                  reports: false,
                  relaunch: false,
                  versions: {},
                  gaps: [
                    "Imported evidence has user-reported device provenance unless the report contains matching simulator metadata.",
                  ],
                },
                { seconds: 120, bytes: 10 * 1024 * 1024, lines: 20000 },
                args.installation_channel ?? "unknown",
                args.version,
                args.build,
              ));
            const artifact = await writeDebugArtifact(ctx, s.session_id, raw, report ? "ips" : "log");
            await updateDebugSession(ctx, s.session_id, (current) =>
              current.imports.push({
                artifact,
                imported_at: ctx.now().toISOString(),
                origin: redactDebugEvidence(args.origin!),
                provenance: ids.length
                  ? "matching simulator metadata and app identity"
                  : "user-reported device; app identity verified only for crash reports",
                summary: report,
                excerpts: debugExcerpts(raw),
              }),
            );
            return {
              summary:
                "Evidence imported and redacted. Device provenance and installed-build verification remain explicit in the session.",
              data: { session_id: s.session_id, target, artifact },
            };
          },
        );
      }
      const cap = await probeDebugTarget(ctx, target, args.use_sudo ? "apple" : args.backend, args.log_scope);
      if (args.action === "probe")
        return {
          summary: `Capabilities for ${target.platform}: logs=${cap.logs}, reports=${cap.reports}, relaunch=${cap.relaunch}.`,
          data: debugRedactDeep({ ...cap }),
          next_steps: debugCapabilityNextSteps(cap),
        };
      if (args.action === "relaunch") {
        if (!cap.relaunch || !target.bundle_id)
          return {
            summary: "Debug evidence unavailable: relaunch is unsupported for this target.",
            data: debugRedactDeep({ ...cap }),
            next_steps: debugCapabilityNextSteps(cap),
            isError: true,
          };
        const command =
          target.platform === "macos"
            ? { cmd: "/usr/bin/open", argv: ["-b", target.bundle_id] }
            : target.platform === "ios"
              ? {
                  cmd: "xcrun",
                  argv: [
                    "devicectl",
                    "device",
                    "process",
                    "launch",
                    "--device",
                    target.device_id,
                    "--terminate-existing",
                    target.bundle_id,
                  ],
                }
              : {
                  cmd: "xcrun",
                  argv: [
                    "simctl",
                    "launch",
                    "--terminate-running-process",
                    target.simulator_id,
                    target.bundle_id,
                  ],
                };
        return await withConfirmation(
          ctx,
          extra,
          args,
          () => ({
            title: `Launch ${target!.bundle_id} on ${target!.platform}`,
            steps: [
              cmdStep(
                "Launch selected app (iOS/simulator terminates the running instance)",
                command.cmd,
                command.argv,
              ),
            ],
            warnings: [
              "This changes the reproduction state. Preserve passive evidence first. macOS open activates an already-running app.",
            ],
          }),
          async () => {
            const r = await ctx.runner.run(command.cmd, command.argv, { timeoutMs: 20000 });
            return {
              summary: ok(r)
                ? "App launch requested. Reproduce and verify against the selected runtime."
                : `Debug evidence unavailable: ${redactDebugEvidence(output(r))}`,
              data: { target, backend: cap.backend },
              isError: !ok(r),
            };
          },
        );
      }
      if (args.action === "resume") {
        const s = required(session, "session_id");
        if (s.segments.some((seg) => ["starting", "ready"].includes(seg.status)))
          throw new Error("Debug session invalid: capture is already running; use status/cancel first.");
        if (args.seconds !== undefined || args.max_bytes !== undefined || args.max_lines !== undefined)
          throw new Error(
            "Debug session invalid: resume reuses the session limits; start a new session to change them.",
          );
      } else if (args.action !== "start") throw new Error("Debug session invalid: unsupported action.");
      const collection = args.collection ?? "both";
      if (collection === "logs") cap.reports = false;
      if (collection === "reports") cap.logs = false;
      if (!cap.logs && !cap.reports)
        return {
          summary:
            "Debug evidence unavailable: requested collection has no supported backend for this target.",
          data: debugRedactDeep({ ...cap }),
          next_steps: debugCapabilityNextSteps(cap),
          isError: true,
        };
      const limits = session?.limits ?? {
        seconds: args.seconds ?? 120,
        bytes: args.max_bytes ?? 10 * 1024 * 1024,
        lines: args.max_lines ?? 20000,
      };
      const steps = [
        {
          description: `Persist private session/evidence files under ${debugRoot(ctx)}; duration <=${limits.seconds}s, evidence <=${limits.bytes} bytes and <=${limits.lines} log lines. Prune inactive sessions older than 30 days.`,
        },
      ];
      if (args.use_sudo && (target.platform !== "ios" || !cap.logs || args.backend === "libimobiledevice"))
        throw new Error(
          "Debug session invalid: use_sudo is only supported for physical-device log collection.",
        );
      if (cap.logs) {
        if (cap.log_mode === "snapshot") {
          const since = new Date(ctx.now().getTime() - (args.lookback_seconds ?? 120) * 1000);
          const collect = deviceLogCollectArgs(
            cap,
            "<private temporary directory>/app.logarchive",
            since,
            limits.bytes,
          );
          steps.push(
            cmdStep(
              "Collect stored app logs from this exact phone, then delete the temporary archive",
              args.use_sudo ? "/usr/bin/sudo" : "/usr/bin/log",
              args.use_sudo ? ["-n", "--", "/usr/bin/log", ...collect] : collect,
            ),
          );
          steps.push({
            description: `Export only matching entries (${deviceLogPredicate(cap)}), redact them, and retain bounded text. This snapshot covers the previous ${args.lookback_seconds ?? 120} seconds; reproduce first. Administrator authorization may be required.`,
          });
        } else {
          const cmd =
            cap.log_backend === "libimobiledevice" ? liveDeviceLogCommand(cap) : debugLogCommand(target);
          steps.push(
            cmdStep(
              cap.log_backend === "libimobiledevice"
                ? `Stream selected phone logs (${cap.log_scope}); transport headers are not app evidence`
                : "Capture app-scoped unified logs",
              cmd.cmd,
              cmd.args,
            ),
          );
        }
      }
      if (cap.reports)
        steps.push({
          description:
            target.platform === "ios"
              ? "Copy at most 10 matching individual systemCrashLogs reports from the selected phone; redact and verify app identity."
              : "Read recent host reports and retain only matching app identities.",
        });
      return await withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Capture ${target!.platform} evidence for ${target!.bundle_id ?? target!.process}`,
          steps,
          warnings: [
            ...debugCapabilityNextSteps(cap),
            cap.log_backend === "libimobiledevice"
              ? "App-related scope includes system messages referencing the bundle ID. Process scope captures only the known app process; transport connection is not evidence of app output."
              : "App filters use the bundle ID as subsystem plus the process when supplied. Add process for apps that use different subsystem names.",
          ],
        }),
        async () => {
          const s =
            session ??
            (await createDebugSession(
              ctx,
              cap,
              limits,
              args.installation_channel ?? "unknown",
              args.version,
              args.build,
            ));
          sessionId = s.session_id;
          const { jobId } = await captureDebugSegment(ctx, s, cap, {
            lookback_seconds: args.lookback_seconds,
            use_sudo: args.use_sudo,
          });
          const result = detachedOutput(ctx, jobId, "App evidence capture", [
            cap.log_mode === "snapshot" && cap.logs
              ? "Collecting a stored-log snapshot; reproduction must occur before this call. Inspect status for artifacts and collection failures."
              : "Check app_debugging status; reproduce only after the segment reports ready. Reports-only capture needs no reproduction wait.",
          ]);
          return {
            ...result,
            data: {
              ...result.data,
              session_id: s.session_id,
              target,
              backend: cap.logs && cap.log_backend ? cap.log_backend : cap.backend,
              log_mode: cap.logs ? cap.log_mode : undefined,
              gaps: cap.gaps,
            },
          };
        },
      );
    } catch (e) {
      return {
        summary: redactDebugEvidence(String(e)),
        data: { target: target ?? null, session_id: sessionId, capability_status: "unavailable" },
        next_steps: [
          "Use app_debugging action=probe with an explicit target, or inspect app_debugging action=status session_id after a capture failure.",
        ],
        isError: true,
      };
    }
  },
});
