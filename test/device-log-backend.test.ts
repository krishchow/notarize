import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { captureDebugSegment, createDebugSession, loadDebugSession } from "../src/core/debug-session";
import { type DebugCapabilities, probeDebugTarget } from "../src/core/debug-target";
import {
  deviceLogUsbAvailable,
  findDeviceLogTool,
  liveDeviceLogCommand,
} from "../src/core/device-log-backend";
import type { RunningProcess, RunOptions, RunResult } from "../src/core/exec";
import { FakeRunner } from "../src/core/fake-runner";
import { call, callConfirmed, connect, makeCtx } from "./helpers";

const executable = "/opt/homebrew/bin/idevicesyslog";
const udid = "00008120-0000000000000001";
const help = "--udid --process --match --exit --no-colors";
function installed(runner = new FakeRunner()) {
  return runner
    .on(executable, ["--version"], { stdout: "idevicesyslog 1.4.0" })
    .on(executable, ["--help"], { stdout: help });
}
const clients: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});
async function setup(runner = new FakeRunner()) {
  const values = await makeCtx({ runner });
  const client = await connect(values.ctx);
  clients.push(client);
  return { ...values, client };
}

describe("optional device logging setup", () => {
  it("detects an existing supported backend without installing or requiring a target", async () => {
    const { client, runner } = await setup(installed());
    const result = await call(client, "app_debugging", { action: "setup", install: true });
    expect(result.data.ready).toBe(true);
    expect(runner.calls.some((c) => c.args.includes("install"))).toBe(false);
  });
  it("rejects older versions and tools missing required filters", async () => {
    const old = await makeCtx({
      runner: new FakeRunner().on(executable, ["--version"], { stdout: "idevicesyslog 1.3.0" }),
    });
    expect(await findDeviceLogTool(old.ctx)).toBeUndefined();
    const incomplete = await makeCtx({
      runner: new FakeRunner()
        .on(executable, ["--version"], { stdout: "idevicesyslog 1.4.0" })
        .on(executable, ["--help"], { stdout: "--udid" }),
    });
    expect(await findDeviceLogTool(incomplete.ctx)).toBeUndefined();
  });
  it("previews installation, rejects a changed-argument token, then verifies the installed backend", async () => {
    let available = false;
    const runner = new FakeRunner()
      .on(executable, ["--version"], () => (available ? { stdout: "idevicesyslog 1.4.0" } : { code: 1 }))
      .on(executable, ["--help"], { stdout: help })
      .on("/opt/homebrew/bin/brew", ["--version"], { stdout: "Homebrew 5.0.0" })
      .on("/opt/homebrew/bin/brew", ["install", "libimobiledevice"], () => {
        available = true;
        return {};
      });
    const { client, ctx } = await setup(runner);
    const args = { action: "setup", install: true };
    const preview = await call(client, "app_debugging", args);
    expect(preview.data.status).toBe("preview");
    expect(available).toBe(false);
    const mismatch = await call(client, "app_debugging", {
      ...args,
      backend: "apple",
      confirm_token: preview.data.confirm_token,
    });
    expect(mismatch.isError).toBe(true);
    expect(available).toBe(false);
    const result = await call(client, "app_debugging", {
      ...args,
      confirm_token: preview.data.confirm_token,
    });
    const job = await ctx.jobs.wait(result.data.job_id, 2000);
    expect(job?.status).toBe("succeeded");
    expect(job?.meta.backend).toMatchObject({ executable });
    expect(runner.calls.filter((c) => c.args[0] === "install")).toHaveLength(1);
  });
  it("does not install Homebrew or ask for Apple credentials when Homebrew is missing", async () => {
    const { client, runner } = await setup();
    const result = await call(client, "app_debugging", { action: "setup", install: true });
    expect(result.isError).toBe(true);
    expect(result.data.homebrew_available).toBe(false);
    expect(runner.calls.every((c) => ["--version", "--help"].includes(c.args[0]))).toBe(true);
  });
  it.each([false, true])(
    "reports install failure or missing post-install executable (installer success=%s)",
    async (success) => {
      const runner = new FakeRunner()
        .on("/opt/homebrew/bin/brew", ["--version"], { stdout: "Homebrew 5.0.0" })
        .on("/opt/homebrew/bin/brew", ["install"], { code: success ? 0 : 1 });
      const { client, ctx } = await setup(runner);
      const { result } = await callConfirmed(client, "app_debugging", { action: "setup", install: true });
      if (result.data.job_id) expect((await ctx.jobs.wait(result.data.job_id, 2000))?.status).toBe("failed");
      else {
        expect(result.isError).toBe(true);
        expect(result.text).toContain("Debug evidence unavailable");
      }
    },
  );
});

class LiveRunner extends FakeRunner {
  capture?: RunOptions;
  end?: () => void;
  override start(cmd: string, args: string[], opts: RunOptions = {}): RunningProcess {
    if (cmd !== executable || !args.includes("--udid")) return super.start(cmd, args, opts);
    this.calls.push({ cmd, args, opts });
    this.capture = opts;
    let resolve!: (r: RunResult) => void;
    const result = new Promise<RunResult>((done) => {
      resolve = done;
    });
    const end = () =>
      resolve({
        command: cmd,
        args,
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      });
    this.end = end;
    opts.signal?.addEventListener("abort", end, { once: true });
    return { result, kill: end };
  }
  emit(text: string) {
    this.capture?.onOutput?.(text, "stdout");
  }
}
const cap: DebugCapabilities = {
  target: {
    platform: "ios",
    device_id: "11111111-1111-4111-8111-111111111111",
    bundle_id: "com.example.debug",
    process: "Example",
  },
  backend: "devicectl",
  logs: true,
  reports: false,
  relaunch: false,
  log_backend: "libimobiledevice",
  log_mode: "stream",
  log_scope: "app-related",
  log_executable: executable,
  device_udid: udid,
  versions: {},
  gaps: [],
};
async function live() {
  const runner = new LiveRunner();
  const { ctx } = await makeCtx({ runner });
  const session = await createDebugSession(ctx, cap, { seconds: 10, bytes: 4096, lines: 100 }, "TestFlight");
  const { jobId } = await captureDebugSegment(ctx, session, cap);
  await expect.poll(() => !!runner.capture).toBe(true);
  return { runner, ctx, session, jobId };
}
describe("bounded normal-user device streams", () => {
  it("selects live logging only for the requested USB phone, and respects explicit Apple selection", async () => {
    const runner = installed()
      .on("/opt/homebrew/bin/idevice_id", ["-l"], { stdout: `${udid}\n` })
      .on("xcrun", ["devicectl"], (_cmd, args) => {
        const result = args.includes("list")
          ? {
              devices: [
                {
                  identifier: cap.target.platform === "ios" ? cap.target.device_id : "",
                  connectionProperties: { pairingState: "paired" },
                  hardwareProperties: { udid },
                },
              ],
            }
          : args.includes("lockState")
            ? { passcodeRequired: false }
            : args.includes("files")
              ? { files: [] }
              : { apps: [] };
        writeFileSync(args[args.indexOf("--json-output") + 1], JSON.stringify({ result }));
        return {};
      });
    const { ctx } = await makeCtx({ runner });
    expect(await probeDebugTarget(ctx, cap.target)).toMatchObject({
      logs: true,
      log_backend: "libimobiledevice",
      log_scope: "app-related",
    });
    expect(await probeDebugTarget(ctx, cap.target, "libimobiledevice", "process")).toMatchObject({
      logs: true,
      log_scope: "process",
    });
    const before = runner.callsTo(executable).length;
    expect((await probeDebugTarget(ctx, cap.target, "apple")).log_backend).not.toBe("libimobiledevice");
    expect(runner.callsTo(executable)).toHaveLength(before);
    runner.on("/usr/local/bin/idevice_id", ["-l"], { stdout: "other-phone" });
    const missing = await makeCtx({
      runner: new FakeRunner().on("/opt/homebrew/bin/idevice_id", ["-l"], { stdout: "other-phone" }),
    });
    expect(await deviceLogUsbAvailable(missing.ctx, { executable, version: "1.4.0" }, udid)).toBe(false);
  });
  it("checks the selected USB UDID independently of Apple's wireless device discovery", async () => {
    const { ctx } = await makeCtx({
      runner: new FakeRunner().on("/opt/homebrew/bin/idevice_id", ["-l"], { stdout: `${udid}\n` }),
    });
    const tool = { executable, version: "idevicesyslog 1.4.0" };
    expect(await deviceLogUsbAvailable(ctx, tool, udid)).toBe(true);
    expect(await deviceLogUsbAvailable(ctx, tool, "another-phone")).toBe(false);
  });
  it("binds the exact UDID and filter, and keeps system and app-process scopes distinct", () => {
    expect(liveDeviceLogCommand(cap).args).toEqual([
      "--udid",
      udid,
      "--no-colors",
      "--exit",
      "--match",
      "com.example.debug",
    ]);
    expect(liveDeviceLogCommand({ ...cap, log_scope: "process" }).args.slice(-2)).toEqual([
      "--process",
      "Example",
    ]);
    expect(() => liveDeviceLogCommand({ ...cap, device_udid: undefined })).toThrow("selected UDID");
  });
  it("requires an exact connection banner, accepts split banners, and preserves redacted partial logs on disconnect", async () => {
    const { ctx, runner, session, jobId } = await live();
    runner.emit("[disconnected:another-phone]\n[connected:another-phone]\n");
    expect((await loadDebugSession(ctx, session.session_id)).segments[0].status).toBe("starting");
    runner.emit(`[connected:${udid.slice(0, 8)}`);
    runner.emit(`${udid.slice(8)}]\n`);
    await expect
      .poll(async () => (await loadDebugSession(ctx, session.session_id)).segments[0].status)
      .toBe("ready");
    runner.emit("Oct 18 12:00:00 SpringBoard[1]: com.example.debug password=hunt");
    runner.emit("er22\n");
    runner.emit(`[disconnected:${udid}]\n`);
    runner.end!();
    await ctx.jobs.wait(jobId, 2000);
    const segment = (await loadDebugSession(ctx, session.session_id)).segments[0];
    expect(segment.status).toBe("failed");
    expect(segment.reason).toContain("disconnected");
    expect(segment.records).toBe(1);
    const text = await readFile(segment.artifact!, "utf8");
    expect(text).toContain("SpringBoard");
    expect(text).not.toContain("hunter22");
    expect(runner.calls.every((c) => !c.cmd.includes("sudo"))).toBe(true);
  });
  it("does not count a connection banner as evidence and treats a premature clean exit as failure", async () => {
    const { ctx, runner, session, jobId } = await live();
    runner.emit(`[connected:${udid}]\n`);
    runner.end!();
    await ctx.jobs.wait(jobId, 2000);
    const segment = (await loadDebugSession(ctx, session.session_id)).segments[0];
    expect(segment.status).toBe("failed");
    expect(segment.records).toBe(0);
  });
  it("cancels and retains partial evidence", async () => {
    const { ctx, runner, session, jobId } = await live();
    runner.emit(`[connected:${udid}]\n`);
    ctx.jobs.cancel(jobId);
    await ctx.jobs.wait(jobId, 2000);
    expect((await loadDebugSession(ctx, session.session_id)).segments[0].status).toBe("cancelled");
  });
});
