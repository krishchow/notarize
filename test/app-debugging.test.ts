import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  debugExcerpts,
  debugRoot,
  loadDebugSession,
  redactDebugEvidence,
  reportTargetMatches,
} from "../src/core/debug-session";
import { debugLogCommand, debugTargetSchema } from "../src/core/debug-target";
import type { RunningProcess, RunOptions, RunResult } from "../src/core/exec";
import { FakeRunner } from "../src/core/fake-runner";
import { JobManager } from "../src/core/jobs";
import recordedDeviceFailure from "./fixtures/recorded/app-debugging/coredevice-mode-disabled.json";
import { call, callConfirmed, connect, makeCtx } from "./helpers";

const phoneId = "11111111-1111-4111-8111-111111111111";
const simId = "22222222-2222-4222-8222-222222222222";
const mac = { platform: "macos", bundle_id: "com.example.debug", process: "Example", runtime: "native" };
const phone = { platform: "ios", device_id: phoneId, bundle_id: "com.example.debug", process: "Example" };
const simulator = {
  platform: "ios-simulator",
  simulator_id: simId,
  bundle_id: "com.example.debug",
  process: "Example",
};
const clients: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function macRunner(runner = new FakeRunner()) {
  return runner
    .on("xcodebuild", ["-version"], { stdout: "Xcode 26.6\nBuild version 17F113" })
    .on("/usr/bin/log", ["help", "stream"], { stdout: "Usage: log stream" });
}
function deviceRunner(
  options: {
    locked?: boolean;
    paired?: boolean;
    developerMode?: boolean;
    reports?: string[];
    unknownSchema?: boolean;
    failSecondCopy?: boolean;
    unavailable?: boolean;
  } = {},
) {
  let copied = 0;
  return macRunner().on("xcrun", ["devicectl"], (_cmd, args) => {
    const path = args[args.indexOf("--json-output") + 1];
    let result: unknown;
    if (args.includes("list"))
      result = {
        devices: [
          {
            identifier: phoneId,
            connectionProperties: {
              pairingState: options.paired === false ? "unpaired" : "paired",
              tunnelState: options.unavailable ? "unavailable" : "disconnected",
            },
            deviceProperties: { osVersionNumber: "26.6" },
          },
        ],
      };
    else if (args.includes("lockState")) result = { passcodeRequired: !!options.locked };
    else if (options.developerMode === false)
      return {
        code: 1,
        stderr: recordedDeviceFailure.stderr,
      };
    else if (args.includes("apps")) result = { apps: [{ bundleIdentifier: "com.example.debug" }] };
    else if (args.includes("files"))
      result = options.unknownSchema
        ? {}
        : { files: (options.reports ?? []).map((name) => ({ name, size: Buffer.byteLength(crash()) })) };
    else if (args.includes("copy")) {
      if (options.failSecondCopy && copied++ > 0) return { code: 1, stderr: "Device disconnected" };
      writeFileSync(args[args.indexOf("--destination") + 1], crash());
      result = {};
    } else return { code: 1, stderr: "unexpected device command" };
    writeFileSync(path, JSON.stringify({ info: { outcome: "success", version: "518.33" }, result }));
    return { stdout: "device command completed" };
  });
}
function crash(bundle = "com.example.debug", extra: Record<string, unknown> = {}) {
  return (
    JSON.stringify({ bundleID: bundle, app_version: "1.2", build_version: "7", name: "Example" }) +
    "\n" +
    JSON.stringify({
      procName: "Example",
      termination: { namespace: "SIGNAL", details: ["password=hunter22"] },
      ...extra,
    })
  );
}
async function setup(runner = macRunner(), isMac = true) {
  const values = await makeCtx({ runner, isMac });
  const client = await connect(values.ctx);
  clients.push(client);
  return { ...values, client };
}
async function finished(ctx: Awaited<ReturnType<typeof makeCtx>>["ctx"], job: string) {
  const result = await ctx.jobs.wait(job, 2000);
  expect(result?.status).not.toBe("running");
  return result;
}

class StreamingRunner extends FakeRunner {
  capture?: RunOptions;
  private resolveCapture?: (result: RunResult) => void;
  override start(cmd: string, args: string[], opts: RunOptions = {}): RunningProcess {
    if (cmd !== "/usr/bin/log" || args[0] !== "stream") return super.start(cmd, args, opts);
    this.calls.push({ cmd, args, opts });
    this.capture = opts;
    const result = new Promise<RunResult>((resolve) => {
      this.resolveCapture = resolve;
    });
    const stop = () =>
      this.resolveCapture?.({
        command: cmd,
        args,
        code: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      });
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) stop();
    return { result, kill: stop };
  }
  emit(text: string, stream: "stdout" | "stderr" = "stdout") {
    this.capture?.onOutput?.(text, stream);
  }
}

describe("app debugging target isolation", () => {
  it("rejects contradictory selectors and missing app identity", () => {
    expect(debugTargetSchema.safeParse({ ...phone, simulator_id: simId }).success).toBe(false);
    expect(debugTargetSchema.safeParse({ platform: "macos" }).success).toBe(false);
    expect(() => debugLogCommand(phone as any)).toThrow(/physical-device/);
  });

  it("recognizes Apple's log help EX_USAGE status as supported tooling", async () => {
    const runner = new FakeRunner()
      .on("xcodebuild", ["-version"], { stdout: "Xcode 26.6" })
      .on("/usr/bin/log", ["help", "stream"], { code: 64, stderr: "usage: log stream [options]" });
    const { client } = await setup(runner);
    const result = await call(client, "app_debugging", { action: "probe", target: mac });
    expect(result.data.logs).toBe(true);
  });

  it("passes the discovered CoreDevice ID directly to the debugging tool", async () => {
    const { client } = await setup(deviceRunner());
    const discovery = await call(client, "devices", {});
    expect(discovery.data.connected[0].device_id).toBe(phoneId);
    expect(discovery.data.connected[0].connectionState).toBe("disconnected");
    const result = await call(client, "app_debugging", {
      action: "probe",
      target: { ...phone, device_id: discovery.data.connected[0].device_id },
    });
    expect(result.data.target.device_id).toBe(phoneId);
    expect(result.data.reports).toBe(true);
  });

  it("reports cached unavailable phones with connection guidance before attempting access", async () => {
    const { client, runner } = await setup(deviceRunner({ unavailable: true }));
    const result = await call(client, "app_debugging", { action: "probe", target: phone });
    expect(result.data.reports).toBe(false);
    expect(result.data.gaps.join(" ")).toMatch(/Connect, unlock, and Trust/);
    expect(runner.calls.some((call) => call.args.includes("lockState"))).toBe(false);
  });

  it("does not request Developer Mode when the attempted operations work", async () => {
    const { client } = await setup(deviceRunner());
    const result = await call(client, "app_debugging", { action: "probe", target: phone });
    expect(result.data.reports).toBe(true);
    expect(result.data.manual_actions).toBeUndefined();
  });

  it("reports physical-device Developer Mode gaps without host fallback or state changes", async () => {
    const { client, runner, ctx } = await setup(deviceRunner({ developerMode: false }));
    const r = await call(client, "app_debugging", { action: "probe", target: phone });
    expect(r.data).toMatchObject({ target: phone, logs: false, reports: false, relaunch: false });
    expect(r.data.gaps.join(" ")).toMatch(/Console/);
    expect(r.data.gaps.join(" ")).toMatch(/Developer Mode is disabled/);
    expect(r.data.developer_mode).toBe("disabled");
    expect(r.data.manual_actions).toHaveLength(1);
    expect(r.data.manual_actions[0].required_for).toEqual([
      "crash-report access",
      "app inspection / launch capability check",
    ]);
    expect(r.data.manual_actions[0].steps.join(" ")).toMatch(
      /Settings → Privacy & Security → Developer Mode/,
    );
    expect(r.data.manual_actions[0].steps.join(" ")).toMatch(/Restart/);
    expect(r.data.manual_actions[0].steps.join(" ")).toMatch(/Turn On/);
    expect(r.data.manual_actions[0].retry).toEqual({
      tool: "app_debugging",
      arguments: { action: "probe", target: phone },
    });
    expect(r.data.next_steps.join(" ")).toMatch(/Devices and Simulators/);
    expect(runner.calls.some((c) => c.cmd.includes("devmodectl") || c.args.includes("reboot"))).toBe(false);
    const start = await call(client, "app_debugging", { action: "start", target: phone });
    expect(start.isError).toBe(true);
    expect(start.text).toMatch(/unavailable/);
    expect(runner.callsTo("/usr/bin/log").filter((args) => args[0] !== "help")).toEqual([]);
    expect(existsSync(debugRoot(ctx))).toBe(false);
  });

  it.each([{ locked: true }, { paired: false }])("distinguishes inaccessible phones: %j", async (options) => {
    const { client } = await setup(deviceRunner(options));
    const r = await call(client, "app_debugging", { action: "probe", target: phone });
    expect(r.data.logs).toBe(false);
    expect(r.data.reports).toBe(false);
    expect(r.data.gaps.join(" ")).toMatch(/unlock|Trust/);
  });

  it("does not treat unsupported device JSON as a successful empty report listing", async () => {
    const { client } = await setup(deviceRunner({ unknownSchema: true }));
    const r = await call(client, "app_debugging", { action: "probe", target: phone });
    expect(r.data.reports).toBe(false);
    expect(r.data.gaps.join(" ")).toMatch(/unsupported.*schema/);
  });

  it("uses exactly the selected booted simulator, even with multiple devices", async () => {
    const runner = macRunner()
      .on("xcrun", ["simctl", "list"], {
        stdout: JSON.stringify({
          devices: {
            "iOS 26.5": [
              { udid: simId, state: "Booted", isAvailable: true },
              { udid: phoneId, state: "Booted", isAvailable: true },
            ],
          },
        }),
      })
      .on("xcrun", ["simctl", "spawn", simId, "log", "stream"], {
        stdout: "Filtering the log data\nTimestamp Ty\nExample error: no such column: rad_strokes\n",
      });
    const { client, ctx } = await setup(runner);
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: simulator,
      collection: "logs",
    });
    await finished(ctx, result.data.job_id);
    const s = await call(client, "app_debugging", { action: "status", session_id: result.data.session_id });
    expect(s.data.target).toEqual(simulator);
    expect(s.data.segments[0].excerpts).toMatch(/rad_strokes/);
    expect(runner.callsTo("/usr/bin/log").filter((args) => args[0] !== "help")).toEqual([]);
    expect(runner.callsTo("xcrun").some((a) => a.includes("spawn") && a.includes(phoneId))).toBe(false);
  });

  it("reports shut-down simulators and missing tooling truthfully", async () => {
    const runner = macRunner().on("xcrun", ["simctl", "list"], {
      stdout: JSON.stringify({ devices: { iOS: [{ udid: simId, state: "Shutdown" }] } }),
    });
    const { client } = await setup(runner);
    const r = await call(client, "app_debugging", { action: "probe", target: simulator });
    expect(r.data.logs).toBe(false);
    expect(r.data.gaps.join(" ")).toMatch(/shut down/);
    const missing = await setup(new FakeRunner());
    const m = await call(missing.client, "app_debugging", { action: "probe", target: simulator });
    expect(m.data.logs).toBe(false);
    expect(m.data.gaps.join(" ")).toMatch(/unavailable/);
  });
});

describe("confirmed bounded evidence", () => {
  it("does not write before confirmation, and binds authorization to target/limits/action", async () => {
    const { client, ctx, runner } = await setup();
    const args = { action: "start", target: mac, collection: "logs" };
    const preview = await call(client, "app_debugging", args);
    expect(preview.data.status).toBe("preview");
    expect(existsSync(debugRoot(ctx))).toBe(false);
    for (const changed of [
      { target: { ...mac, process: "Other" } },
      { max_bytes: 1024 },
      { action: "relaunch" },
    ]) {
      const result = await call(client, "app_debugging", {
        ...args,
        ...changed,
        confirm_token: preview.data.confirm_token,
      });
      expect(result.isError).toBe(true);
      expect(result.data.status).toBe("preview");
    }
    expect(existsSync(debugRoot(ctx))).toBe(false);
    expect(runner.callsTo("/usr/bin/open")).toEqual([]);
  });

  it("captures split secrets, private permissions, excerpts, markers and cancellation", async () => {
    const runner = macRunner(new StreamingRunner()) as StreamingRunner;
    const { client, ctx } = await setup(runner);
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: mac,
      collection: "logs",
      installation_channel: "TestFlight",
      version: "1.2",
      build: "7",
    });
    expect(result.data.monitor.command).toContain("watch-job");
    runner.emit("Filtering the log data\n");
    runner.emit("error password=hunt");
    runner.emit("er22\n");
    runner.emit("-----BEGIN PRIVATE KEY-----\nveryprivate\n");
    runner.emit("-----END PRIVATE KEY-----\n");
    const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ4eHh4eHh4In0.c2lnbmF0dXJlc2lnbmF0dXJl";
    runner.emit(jwt.slice(0, 25));
    runner.emit("stderr noise\n", "stderr");
    runner.emit(jwt.slice(25) + "\n");
    await callConfirmed(client, "app_debugging", {
      action: "mark",
      session_id: result.data.session_id,
      label: "Explore tapped",
      timestamp: "2026-10-18T17:00:00Z",
    });
    const ready = await call(client, "app_debugging", {
      action: "status",
      session_id: result.data.session_id,
    });
    expect(ready.data.segments[0].status).toBe("ready");
    await callConfirmed(client, "app_debugging", { action: "cancel", session_id: result.data.session_id });
    await finished(ctx, result.data.job_id);
    const s = await loadDebugSession(ctx, result.data.session_id);
    expect(s.segments[0].status).toBe("cancelled");
    expect(s.markers[0].label).toBe("Explore tapped");
    expect(s.build).toEqual({ version: "1.2", number: "7", source: "user-reported" });
    const artifact = s.segments[0].artifact!;
    const text = await readFile(artifact, "utf8");
    expect(text).not.toMatch(/hunter22|veryprivate/);
    expect(text).not.toContain(jwt);
    expect((await stat(artifact)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(artifact))).mode & 0o777).toBe(0o700);
    expect(runner.capture?.logName).toBeUndefined();
    expect(runner.capture?.retainOutput).toBe(false);
  });

  it.each([{ max_lines: 2 }, { max_bytes: 1024 }])("stops at output bounds: %j", async (limits) => {
    const runner = macRunner(new StreamingRunner()) as StreamingRunner;
    const { client, ctx } = await setup(runner);
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: mac,
      collection: "logs",
      ...limits,
    });
    runner.emit("Filtering the log data\nfirst\n" + "x".repeat(2000) + "secret=password\n");
    await finished(ctx, result.data.job_id);
    const s = await loadDebugSession(ctx, result.data.session_id);
    expect(s.segments[0].truncated).toBe(true);
    expect(s.segments[0].bytes).toBeLessThanOrEqual(limits.max_bytes ?? 10 * 1024 * 1024);
    expect(s.segments[0].lines).toBeLessThanOrEqual(limits.max_lines ?? 20000);
  });

  it("ends on its duration limit without treating the expected stop as failure", async () => {
    const runner = macRunner(new StreamingRunner()) as StreamingRunner;
    const { client, ctx } = await setup(runner);
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: mac,
      collection: "logs",
      seconds: 1,
    });
    runner.emit("Filtering the log data\n");
    await finished(ctx, result.data.job_id);
    const s = await loadDebugSession(ctx, result.data.session_id);
    expect(s.segments[0]).toMatchObject({ status: "complete", reason: "duration" });
  });

  it("separates backend failures from successful empty captures", async () => {
    const { client, ctx } = await setup(
      macRunner().on("/usr/bin/log", ["stream"], { code: 1, stderr: "Operation not permitted" }),
    );
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: mac,
      collection: "logs",
    });
    await finished(ctx, result.data.job_id);
    const s = await loadDebugSession(ctx, result.data.session_id);
    expect(s.segments[0].status).toBe("failed");
    expect(s.segments[0].ready_at).toBeUndefined();
    expect(s.segments[0].reason).toMatch(/unavailable/);
  });

  it("copies only matching phone reports and labels their reported build identity", async () => {
    const { client, ctx, runner } = await setup(
      deviceRunner({ reports: ["Example.ips", "../Other.ips", "Other.log"] }),
    );
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: phone,
      collection: "reports",
    });
    await finished(ctx, result.data.job_id);
    const s = await loadDebugSession(ctx, result.data.session_id);
    expect(s.segments[0].reports).toHaveLength(1);
    expect(s.segments[0].reports![0].summary).toMatchObject({ appVersion: "1.2", buildVersion: "7" });
    expect(JSON.stringify(s)).not.toContain("hunter22");
    const copies = runner.callsTo("xcrun").filter((a) => a.includes("copy"));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain(phoneId);
  });

  it("snapshots matching Mac reports before streaming and excludes simulator reports", async () => {
    const { client, ctx, home } = await setup(
      macRunner().on("/usr/bin/log", ["stream"], { stdout: "Filtering the log data\n" }),
    );
    const reportsDir = join(home, "Library/Logs/DiagnosticReports");
    await mkdir(reportsDir, { recursive: true });
    await writeFile(join(reportsDir, "Example-native.ips"), crash());
    await writeFile(
      join(reportsDir, "Example-simulator.ips"),
      crash("com.example.debug", { is_simulated: 1 }),
    );
    const { result } = await callConfirmed(client, "app_debugging", { action: "start", target: mac });
    await finished(ctx, result.data.job_id);
    const session = await loadDebugSession(ctx, result.data.session_id);
    expect(session.segments[0].reports).toHaveLength(1);
    expect(session.segments[0].ready_at).toBeDefined();
    expect(session.segments[0].bytes).toBeGreaterThan(Buffer.byteLength(crash()));
  });

  it("retains completed report references when a later phone transfer disconnects", async () => {
    const { client, ctx } = await setup(
      deviceRunner({ reports: ["Example-one.ips", "Example-two.ips"], failSecondCopy: true }),
    );
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: phone,
      collection: "reports",
    });
    await finished(ctx, result.data.job_id);
    const session = await loadDebugSession(ctx, result.data.session_id);
    expect(session.segments[0].status).toBe("failed");
    expect(session.segments[0].reports).toHaveLength(1);
    expect(existsSync(session.segments[0].reports![0].artifact)).toBe(true);
  });

  it("resumes into a linked new segment and rejects mismatched selectors or changed limits", async () => {
    const { client, ctx } = await setup(
      macRunner().on("/usr/bin/log", ["stream"], { stdout: "Filtering the log data\n" }),
    );
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: mac,
      collection: "logs",
    });
    await finished(ctx, result.data.job_id);
    const id = result.data.session_id;
    const mismatch = await call(client, "app_debugging", { action: "resume", session_id: id, target: phone });
    expect(mismatch.isError).toBe(true);
    const changed = await call(client, "app_debugging", { action: "resume", session_id: id, max_lines: 1 });
    expect(changed.isError).toBe(true);
    const { result: resumed } = await callConfirmed(client, "app_debugging", {
      action: "resume",
      session_id: id,
      collection: "logs",
    });
    await finished(ctx, resumed.data.job_id);
    expect((await loadDebugSession(ctx, id)).segments).toHaveLength(2);
  });

  it("marks active captures interrupted after server loss without mutating status reads", async () => {
    const runner = macRunner(new StreamingRunner()) as StreamingRunner;
    const { client, ctx } = await setup(runner);
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "start",
      target: mac,
      collection: "logs",
    });
    const before = await readFile(join(debugRoot(ctx), result.data.session_id, "session.json"), "utf8");
    const other = { ...ctx, jobs: new JobManager(ctx.jobs.stateDir) };
    const lost = await loadDebugSession(other, result.data.session_id);
    expect(lost.segments[0].status).toBe("interrupted");
    expect(await readFile(join(debugRoot(ctx), result.data.session_id, "session.json"), "utf8")).toBe(before);
    ctx.jobs.cancel(result.data.job_id);
    await finished(ctx, result.data.job_id);
  });
});

describe("evidence imports and fallback", () => {
  it("imports a spinner log without Apple credentials and preserves user-reported origin", async () => {
    const { client, ctx, home, runner } = await setup(new FakeRunner(), false);
    const path = join(home, "spinner.txt");
    await writeFile(path, "Example SQL error: no such column: rad_strokes\naccess_token=my-private-token\n");
    const args = {
      action: "import",
      target: phone,
      path,
      origin: "Console export from selected iPhone; source reproduction is separate",
    };
    const preview = await call(client, "app_debugging", args);
    expect(existsSync(debugRoot(ctx))).toBe(false);
    const result = await call(client, "app_debugging", {
      ...args,
      confirm_token: preview.data.confirm_token,
    });
    expect(result.isError).toBe(false);
    const s = await loadDebugSession(ctx, result.data.session_id);
    expect(s.imports[0].provenance).toMatch(/user-reported/);
    expect(await readFile(s.imports[0].artifact, "utf8")).not.toContain("my-private-token");
    expect(runner.calls).toEqual([]);
    expect(s.build.source).toBe("unknown");
  });

  it("rejects reports from another app and conflicting simulator provenance before creating artifacts", async () => {
    const { client, ctx, home } = await setup();
    const path = join(home, "crash.ips");
    for (const raw of [crash("com.other.app"), crash("com.example.debug", { simulatorUDID: phoneId })]) {
      await writeFile(path, raw);
      const { result } = await callConfirmed(client, "app_debugging", {
        action: "import",
        target: simulator,
        path,
        origin: "Simulator export",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/mismatch/);
      expect(existsSync(debugRoot(ctx))).toBe(false);
    }
  });

  it("imports matching simulator metadata without attributing a shared directory", async () => {
    const { client, ctx, home } = await setup();
    const path = join(home, "crash.ips");
    await writeFile(path, crash("com.example.debug", { simulatorUDID: simId }));
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "import",
      target: simulator,
      path,
      origin: "explicit simulator export",
    });
    const s = await loadDebugSession(ctx, result.data.session_id);
    expect(s.imports[0].provenance).toMatch(/matching simulator metadata/);
    expect(s.imports[0].summary?.bundleId).toBe("com.example.debug");
  });

  it("does not allow archive directories as text imports", async () => {
    const { client, home } = await setup();
    const path = join(home, "archive.log");
    await mkdir(path);
    const { result } = await callConfirmed(client, "app_debugging", {
      action: "import",
      target: phone,
      path,
      origin: "Console archive",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/regular file/);
  });

  it("launches only after a separate confirmation and never attaches a console", async () => {
    const { client, runner } = await setup(macRunner().on("/usr/bin/open", ["-b", "com.example.debug"], {}));
    const args = { action: "relaunch", target: mac };
    const preview = await call(client, "app_debugging", args);
    expect(runner.callsTo("/usr/bin/open")).toEqual([]);
    const result = await call(client, "app_debugging", {
      ...args,
      confirm_token: preview.data.confirm_token,
    });
    expect(result.isError).toBe(false);
    expect(runner.callsTo("/usr/bin/open")).toEqual([["-b", "com.example.debug"]]);
    expect(runner.calls.some((c) => c.args.includes("--console"))).toBe(false);
  });

  it("does not attribute a simulator report in a host directory to a native Mac or physical phone", () => {
    const raw = crash("com.example.debug", { isSimulated: true });
    const summary = {
      process: "Example",
      bundleId: "com.example.debug",
      terminationDetails: [],
      isSigningRelated: false,
      explanations: [],
    };
    expect(reportTargetMatches(mac as any, raw, summary)).toBe(false);
    expect(reportTargetMatches(phone as any, raw, summary)).toBe(false);
    expect(reportTargetMatches(simulator as any, raw, summary)).toBe(true);
  });

  it("redacts truncated secret lines and produces bounded excerpts", () => {
    expect(redactDebugEvidence("ok\npassword=part", true)).toBe("ok\n");
    expect(redactDebugEvidence("-----BEGIN PRIVATE KEY-----\npartial")).not.toContain("partial");
    expect(debugExcerpts("x".repeat(10000)).length).toBeLessThanOrEqual(4000);
  });
});
