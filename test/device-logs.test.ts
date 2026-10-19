import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDebugSession } from "../src/core/debug-session";
import { FakeRunner } from "../src/core/fake-runner";
import { call, callConfirmed, connect, makeCtx } from "./helpers";

const id = "11111111-1111-4111-8111-111111111111";
const udid = "00008120-0000000000000001";
const target = { platform: "ios", device_id: id, bundle_id: "com.example.debug", process: "Example" };
const clients: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});
function runner(options: { permissionDenied?: boolean; oversize?: boolean } = {}) {
  const r = new FakeRunner()
    .on("xcodebuild", ["-version"], { stdout: "Xcode 26.6" })
    .on("sw_vers", [], { stdout: "26.5.1" })
    .on("/usr/bin/log", ["help", "collect"], {
      code: 64,
      stderr: "usage: log collect --device-udid --predicate --start --size --output",
    });
  r.on("xcrun", ["devicectl"], (_cmd, args) => {
    let result: unknown;
    if (args.includes("list"))
      result = {
        devices: [
          {
            identifier: id,
            hardwareProperties: { udid },
            connectionProperties: { pairingState: "paired", tunnelState: "disconnected" },
            deviceProperties: { developerModeStatus: "enabled" },
          },
        ],
      };
    else if (args.includes("lockState")) result = { passcodeRequired: false };
    else if (args.includes("apps"))
      result = {
        apps: [
          { bundleIdentifier: "com.other.app", name: "Other" },
          {
            bundleIdentifier: target.bundle_id,
            name: "Example",
            version: "1.2",
            bundleVersion: "7",
            url: "file:///private/app/Example.app/",
          },
        ],
      };
    else if (args.includes("processes"))
      result = {
        runningProcesses: [{ executable: "file:///private/app/Example.app/Example", processIdentifier: 42 }],
      };
    else result = { files: [] };
    writeFileSync(args[args.indexOf("--json-output") + 1], JSON.stringify({ result }));
    return {};
  });
  const collect = (_cmd: string, args: string[]) => {
    if (options.permissionDenied) return { code: 77, stderr: "log: Must be root to run this command" };
    const path = args[args.indexOf("--output") + 1];
    mkdirSync(path);
    writeFileSync(join(path, "tracev3"), options.oversize ? Buffer.alloc(4096) : "trace");
    return { stdout: "Archive collected" };
  };
  r.on("/usr/bin/log", ["collect"], collect);
  r.on("/usr/bin/log", ["show"], {
    stdout: "Timestamp Ty Process\n2026-10-18 Example error password=hunter22\n",
  });
  r.on("/usr/bin/sudo", (_cmd, args) => args.includes("collect"), collect);
  r.on("/usr/bin/sudo", (_cmd, args) => args.includes("show"), {
    stdout: "Timestamp Ty Process\nExample captured log\n",
  });
  r.on("/usr/bin/sudo", (_cmd, args) => args.includes("/usr/bin/du"), { stdout: "1\tarchive\n" });
  return r;
}
async function setup(r = runner()) {
  const state = await makeCtx({ runner: r });
  const client = await connect(state.ctx);
  clients.push(client);
  return { ...state, client };
}
async function capture(state: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) {
  const { result } = await callConfirmed(state.client, "app_debugging", {
    action: "start",
    target,
    collection: "logs",
    seconds: 5,
    lookback_seconds: 60,
    ...extra,
  });
  expect(result.isError).toBe(false);
  await state.ctx.jobs.wait(result.data.job_id, 2000);
  return loadDebugSession(state.ctx, result.data.session_id);
}

describe("Apple device log snapshots", () => {
  it("advertises the installed snapshot backend and exact installed app", async () => {
    const { client } = await setup();
    const result = await call(client, "app_debugging", { action: "probe", target });
    expect(result.data).toMatchObject({
      logs: true,
      log_mode: "snapshot",
      log_backend: "apple-log-collect",
      device_udid: udid,
      installed_app: { bundle_id: target.bundle_id, version: "1.2", build: "7" },
    });
    expect(result.data.gaps.join(" ")).toMatch(/Reproduce first/);
  });

  it("resolves the running main process for a bundle-only target", async () => {
    const { client } = await setup();
    const result = await call(client, "app_debugging", {
      action: "probe",
      target: { platform: "ios", device_id: id, bundle_id: target.bundle_id },
    });
    expect(result.data.resolved_process).toBe("Example");
  });

  it("previews explicit device, predicate, bounds, and sudo consent before any capture", async () => {
    const { client, runner: r } = await setup();
    const args = { action: "start", target, collection: "logs", lookback_seconds: 60 };
    const preview = await call(client, "app_debugging", args);
    expect(preview.data.status).toBe("preview");
    expect(preview.text).toContain("--device-udid " + udid);
    expect(preview.text).toContain("--predicate");
    expect(preview.text).toContain("--size");
    expect(r.calls.some((c) => c.args[0] === "collect")).toBe(false);
    const changed = await call(client, "app_debugging", {
      ...args,
      use_sudo: true,
      confirm_token: preview.data.confirm_token,
    });
    expect(changed.data.status).toBe("preview");
    expect(changed.isError).toBe(true);
  });

  it("collects and exports through MCP, retains redacted evidence and removes the raw archive", async () => {
    const state = await setup();
    const session = await capture(state);
    const segment = session.segments[0];
    expect(segment).toMatchObject({
      backend: "apple-log-collect",
      capture_mode: "snapshot",
      status: "complete",
      reason: "stored log snapshot complete",
      installed_app: { version: "1.2", build: "7" },
    });
    expect(segment.ready_at).toBeUndefined();
    const text = await readFile(segment.artifact!, "utf8");
    expect(text).toContain("Example error");
    expect(text).not.toContain("hunter22");
    const collect = state.runner.calls.find((c) => c.args[0] === "collect")!;
    expect(collect.args).toContain(udid);
    expect(collect.args).not.toContain(id);
    const archive = collect.args[collect.args.indexOf("--output") + 1];
    expect(existsSync(archive)).toBe(false);
    const show = state.runner.calls.find((c) => c.args[0] === "show")!;
    expect(show.args).toContain(archive);
    expect(show.args).toContain("--predicate");
    expect(state.runner.calls.some((c) => c.cmd.includes("osascript"))).toBe(false);
  });

  it("returns an actionable admin failure rather than a successful empty capture", async () => {
    const state = await setup(runner({ permissionDenied: true }));
    const session = await capture(state);
    expect(session.segments[0].status).toBe("failed");
    expect(session.segments[0].reason).toMatch(/administrator authorization/);
    expect(session.segments[0].reason).toMatch(/never requests your password/);
    expect(state.runner.calls.some((c) => c.cmd === "/usr/bin/sudo")).toBe(false);
  });

  it("runs privileged collection and export only with explicit use_sudo", async () => {
    const state = await setup();
    const session = await capture(state, { use_sudo: true });
    expect(session.segments[0].status).toBe("complete");
    const privileged = state.runner.calls.filter((c) => c.cmd === "/usr/bin/sudo");
    expect(privileged.some((c) => c.args.includes("collect"))).toBe(true);
    expect(privileged.some((c) => c.args.includes("show"))).toBe(true);
    expect(privileged.every((c) => c.args[0] === "-n")).toBe(true);
  });

  it("rejects and removes archives exceeding the approved size", async () => {
    const state = await setup(runner({ oversize: true }));
    const session = await capture(state, { max_bytes: 1024 });
    expect(session.segments[0].status).toBe("failed");
    expect(session.segments[0].reason).toMatch(/exceeds the approved byte limit/);
    const collect = state.runner.calls.find((c) => c.args[0] === "collect")!;
    expect(existsSync(collect.args[collect.args.indexOf("--output") + 1])).toBe(false);
    expect(state.runner.calls.some((c) => c.args[0] === "show")).toBe(false);
  });
});
