import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlist } from "../src/core/plist";
import { validateEntitlements, valueAllowed } from "../src/tools/entitlements";
import { allTools } from "../src/tools/index";
import { call, callConfirmed, connect, makeCtx } from "./helpers";

const fx = (name: string) => readFile(join(__dirname, "fixtures", name), "utf8");
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0]);

async function makeApp(opts: { info?: Record<string, unknown>; framework?: boolean } = {}) {
  const app = join(await mkdtemp(join(tmpdir(), "app-")), "Example.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(app, "Contents", "Info.plist"),
    buildPlist({ CFBundleExecutable: "Example", CFBundleIdentifier: "com.example.app", ...opts.info }),
  );
  await writeFile(join(app, "Contents", "MacOS", "Example"), MACHO);
  if (opts.framework) {
    await mkdir(join(app, "Contents", "Frameworks"), { recursive: true });
    await writeFile(join(app, "Contents", "Frameworks", "libhelper.dylib"), MACHO);
  }
  return app;
}

describe("tool registry", () => {
  it("lists every tool with a schema; mutating tools accept confirm_token", async () => {
    const { ctx } = await makeCtx();
    const client = await connect(ctx);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(allTools.map((t) => t.name).sort());
    for (const t of tools) {
      const def = allTools.find((d) => d.name === t.name)!;
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(Object.hasOwn(t.inputSchema.properties ?? {}, "confirm_token")).toBe(!!def.mutating);
      expect(t.annotations?.readOnlyHint).toBe(!def.mutating);
    }
  });
});

describe("doctor", () => {
  it("works off-Mac and explains what is available", async () => {
    const { ctx } = await makeCtx({ isMac: false });
    const r = await call(await connect(ctx), "doctor", {});
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/only App Store Connect API and file inspection tools work here/);
    expect(r.text).toMatch(/No App Store Connect API key configured/);
  });

  it("reports Xcode, identities, orphan certs and duplicates on macOS", async () => {
    const { ctx, runner } = await makeCtx({ now: new Date("2026-10-01") });
    const pem = await fx("devid-app.pem");
    runner
      .on("sw_vers", [], { stdout: "15.5\n" })
      .on("xcode-select", ["-p"], { stdout: "/Applications/Xcode.app/Contents/Developer\n" })
      .on("xcodebuild", ["-version"], { stdout: "Xcode 16.4\nBuild version 16F6\n" })
      .on("xcrun", ["--find"], (_c, a) => ({ stdout: `/usr/bin/${a[1]}\n` }))
      .on("security", ["find-identity"], { stdout: await fx("find-identity.txt") })
      .on("security", ["find-certificate"], (_c, a) => ({
        stdout: a[3].startsWith("Developer ID Application") ? pem : "",
      }));
    const r = await call(await connect(ctx), "doctor", {});
    expect(r.text).toMatch(/Xcode 16\.4 is older than the App Store Connect minimum \(Xcode 26\.0/);
    expect(r.text).toMatch(
      /Invalid identity "Developer ID Application: Example Corp \(ABCDE12345\)" \(CSSMERR_TP_CERT_EXPIRED\)/,
    );
    // the fixture cert's SHA-1 does not match the fake identity hashes → reported as missing a private key
    expect(r.text).toMatch(/have no private key/);
  });
});

describe("signing_identities", () => {
  it("lists identities with type and team", async () => {
    const { ctx, runner } = await makeCtx();
    runner
      .on("security", ["find-identity"], { stdout: await fx("find-identity.txt") })
      .on("security", ["find-certificate"], { stdout: "" });
    const r = await call(await connect(ctx), "signing_identities", { include_reference: false });
    expect(r.data.identities).toHaveLength(4);
    expect(r.data.identities[0]).toMatchObject({
      type: "Developer ID Application",
      teamId: "ABCDE12345",
      valid: true,
    });
  });
});

describe("inspect_code_signature", () => {
  it("flags get-task-allow, unsigned nested code and missing ticket for Developer ID", async () => {
    const app = await makeApp({ framework: true });
    const { ctx, runner } = await makeCtx();
    const devid = await fx("codesign-devid.txt");
    runner
      .on("codesign", (_c, a) => a[0] === "-dvvv" && a[1] === app, {
        stderr: devid.replace("Notarization Ticket=stapled\n", ""),
      })
      .on("codesign", (_c, a) => a[0] === "-dvvv", {
        code: 1,
        stderr: "libhelper.dylib: code object is not signed at all",
      })
      .on("codesign", ["--verify"], {
        stderr: `${app}: valid on disk\n${app}: satisfies its Designated Requirement`,
      })
      .on("codesign", ["-d", "--entitlements"], {
        stdout: buildPlist({
          "com.apple.security.get-task-allow": true,
          "com.apple.security.cs.disable-library-validation": true,
        }),
      });
    const r = await call(await connect(ctx), "inspect_code_signature", {
      path: app,
      target: "mac-developer-id",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Signed: yes \(developer-id\)/);
    expect(r.text).toMatch(/get-task-allow entitlement present/);
    expect(r.text).toMatch(/Nested dylib: unsigned/);
    expect(r.text).toMatch(/disable-library-validation/);
    expect(r.text).toMatch(/No stapled notarization ticket/);
  });

  it("refuses to run off-Mac with a clear message", async () => {
    const { ctx } = await makeCtx({ isMac: false });
    const r = await call(await connect(ctx), "inspect_code_signature", { path: "/tmp" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/requires macOS/);
  });
});

describe("entitlements", () => {
  it("matches wildcard profile values", () => {
    expect(valueAllowed("ABCDE12345.com.example.app", "ABCDE12345.*")).toBe(true);
    expect(valueAllowed(["ABCDE12345.group"], ["ABCDE12345.*"])).toBe(true);
    expect(valueAllowed("OTHER.com.x", "ABCDE12345.*")).toBe(false);
    expect(valueAllowed(true, false)).toBe(false);
    expect(valueAllowed(false, true)).toBe(true);
  });

  it("validates against profile, target and Info.plist", () => {
    const f = validateEntitlements({
      entitlements: {
        "com.apple.developer.icloud-services": ["CloudKit"],
        "com.apple.security.device.camera": true,
        "com.apple.security.get-task-allow": true,
      },
      profileEntitlements: { "com.apple.application-identifier": "ABCDE12345.*" },
      target: "mac-app-store",
      infoPlist: {},
    });
    const msgs = f.map((x) => x.message).join("\n");
    expect(msgs).toMatch(/icloud-services .* not granted/);
    expect(msgs).toMatch(/get-task-allow must not be present/);
    expect(msgs).toMatch(/App Sandbox is required/);
    expect(msgs).toMatch(/NSCameraUsageDescription/);
  });

  it("reads an .entitlements file and generates presets (write requires confirmation)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ent-"));
    const file = join(dir, "App.entitlements");
    await writeFile(file, buildPlist({ "com.apple.security.cs.allow-jit": true }));
    const { ctx } = await makeCtx();
    const client = await connect(ctx);
    const read = await call(client, "entitlements", { action: "read", path: file });
    expect(read.text).toMatch(/allow-jit = true — Allow JIT/);

    const out = join(dir, "gen.entitlements");
    const args = { action: "generate", preset: "electron-mas", capabilities: ["camera"], output_path: out };
    const { preview, result } = await callConfirmed(client, "entitlements", args);
    expect(preview.text).toMatch(/PREVIEW/);
    expect(result.text).toMatch(/Wrote/);
    const written = await readFile(out, "utf8");
    expect(written).toContain("com.apple.security.app-sandbox");
    expect(written).toContain("com.apple.security.device.camera");
    expect(result.text).toMatch(/NSCameraUsageDescription/);
  });

  it("rejects a confirm token when arguments change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ent-"));
    const { ctx } = await makeCtx();
    const client = await connect(ctx);
    const preview = await call(client, "entitlements", {
      action: "generate",
      preset: "tauri",
      output_path: join(dir, "a.plist"),
    });
    const r = await call(client, "entitlements", {
      action: "generate",
      preset: "electron",
      output_path: join(dir, "a.plist"),
      confirm_token: preview.data.confirm_token,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/does not match these arguments/);
  });
});

describe("gatekeeper + quarantine", () => {
  it("explains an unnotarized rejection", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx();
    runner.on("spctl", ["--assess", "--type", "execute"], {
      code: 3,
      stderr: `${app}: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: Example Corp (ABCDE12345)`,
    });
    const r = await call(await connect(ctx), "gatekeeper", { action: "assess", path: app });
    expect(r.text).toMatch(/REJECTED/);
    expect(r.text).toMatch(/Signed but not notarized/);
  });

  it("quarantine set runs xattr only after confirmation", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx();
    runner.on("xattr", ["-w"], { stdout: "" });
    const client = await connect(ctx);
    const preview = await call(client, "quarantine", { action: "set", path: app });
    expect(runner.callsTo("xattr")).toHaveLength(0);
    const res = await call(client, "quarantine", {
      action: "set",
      path: app,
      confirm_token: preview.data.confirm_token,
    });
    expect(res.text).toMatch(/Done/);
    const [args] = runner.callsTo("xattr");
    expect(args.slice(0, 3)).toEqual(["-w", "-r", "com.apple.quarantine"]);
    expect(args[3]).toMatch(/^0083;[0-9a-f]+;Safari;[0-9A-F-]{36}$/);
  });
});

describe("system_logs + privacy", () => {
  it("parses sandbox violations from log show", async () => {
    const { ctx, runner } = await makeCtx();
    runner.on("log", ["show"], { stdout: await fx("sandbox-log.txt") });
    const r = await call(await connect(ctx), "system_logs", {
      preset: "sandbox",
      process: "Example",
      last: "5m",
    });
    expect(r.data.violations[0]).toMatchObject({ operation: "network-outbound", count: 2 });
    expect(r.text).toMatch(/com\.apple\.security\.network\.client/);
    const args = runner.callsTo("log")[0];
    expect(args[args.indexOf("--predicate") + 1]).toMatch(/process == "Example"/);
  });

  it("audits usage descriptions vs entitlements and frameworks", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx();
    runner
      .on("otool", ["-L"], { stdout: await fx("otool-libs.txt") })
      .on("codesign", ["-d", "--entitlements"], {
        stdout: buildPlist({ "com.apple.security.device.camera": true }),
      });
    const r = await call(await connect(ctx), "privacy", { action: "audit", path: app });
    expect(r.text).toMatch(
      /Camera: entitlement com\.apple\.security\.device\.camera present but no NSCameraUsageDescription/,
    );
    expect(r.text).toMatch(/Location: links CoreLocation/);
  });
});
