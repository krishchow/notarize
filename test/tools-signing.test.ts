import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config";
import { SpawnRunner } from "../src/core/exec";
import { buildPlist } from "../src/core/plist";
import { dmgbuildSettings } from "../src/tools/package";
import { codesignArgs, entitlementsFromProfile } from "../src/tools/signing";
import { call, callConfirmed, connect, makeCtx } from "./helpers";

const fx = (name: string) => readFile(join(__dirname, "fixtures", name), "utf8");
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0]);

async function makeApp() {
  const app = join(await mkdtemp(join(tmpdir(), "sign-")), "Example.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(app, "Contents", "Frameworks"), { recursive: true });
  await writeFile(
    join(app, "Contents", "Info.plist"),
    buildPlist({ CFBundleExecutable: "Example", CFBundleIdentifier: "com.example.app" }),
  );
  await writeFile(join(app, "Contents", "MacOS", "Example"), MACHO);
  await writeFile(join(app, "Contents", "Frameworks", "libhelper.dylib"), MACHO);
  return app;
}

async function withApiKey(home: string) {
  const keyPath = join(home, "AuthKey_KEY1234567.p8");
  await writeFile(keyPath, "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n");
  return { ASC_KEY_ID: "KEY1234567", ASC_ISSUER_ID: "issuer-1", ASC_PRIVATE_KEY_PATH: keyPath };
}

describe("codesign argument building", () => {
  it("adds runtime/timestamp, per-item entitlements and preserve-metadata", () => {
    const s = {
      identity: "ABC",
      runtime: true,
      timestamp: true,
      entitlements: "/e/main.plist",
      defaultNestedEntitlements: "/e/inherit.plist",
      nestedEntitlements: { "Contents/Frameworks/X.framework/Versions/A": "/e/x.plist" },
      preserveNestedEntitlements: true,
      nested: true,
    };
    expect(codesignArgs({ path: "/A.app", kind: "app", relativePath: "." }, s, true)).toEqual([
      "--force",
      "--sign",
      "ABC",
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      "/e/main.plist",
      "/A.app",
    ]);
    expect(
      codesignArgs(
        {
          path: "/A.app/Contents/Frameworks/Helper.app",
          kind: "app",
          relativePath: "Contents/Frameworks/Helper.app",
        },
        s,
        false,
      ),
    ).toContain("/e/inherit.plist");
    expect(
      codesignArgs({ path: "/l.dylib", kind: "dylib", relativePath: "l.dylib" }, s, false),
    ).not.toContain("--entitlements");
    expect(
      codesignArgs(
        { path: "/l.dylib", kind: "dylib", relativePath: "l.dylib" },
        { ...s, identity: "-" },
        false,
      ),
    ).not.toContain("--timestamp");
  });

  it("derives entitlements from a profile, dropping get-task-allow for distribution", () => {
    const e = entitlementsFromProfile(
      {
        Entitlements: {
          "application-identifier": "NEWTEAM123.com.x",
          "com.apple.developer.team-identifier": "NEWTEAM123",
          "get-task-allow": false,
        },
      },
      {
        "application-identifier": "OLDTEAM123.com.x",
        "get-task-allow": true,
        "com.apple.security.application-groups": ["group.x"],
      },
      "ios-app-store",
    );
    expect(e).toEqual({
      "application-identifier": "NEWTEAM123.com.x",
      "com.apple.developer.team-identifier": "NEWTEAM123",
      "com.apple.security.application-groups": ["group.x"],
    });
  });
});

describe("sign tool", () => {
  it("previews inside-out codesign commands, then signs nested code before the bundle", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx();
    const devid = await fx("codesign-devid.txt");
    runner
      .on("security", ["find-identity"], { stdout: await fx("find-identity.txt") })
      .on("security", ["find-certificate"], { stdout: "" })
      .on("xattr", ["-cr"], {})
      .on("codesign", ["--force"], {})
      .on("codesign", ["-dvvv"], { stderr: devid })
      .on("codesign", ["--verify"], { stderr: "valid on disk" })
      .on("codesign", ["-d", "--entitlements"], { stdout: "" });
    const client = await connect(ctx);
    const { preview, result } = await callConfirmed(client, "sign", {
      path: app,
      identity: "auto",
      target: "mac-developer-id",
    });
    expect(preview.text).toMatch(
      /codesign --force --sign 1111111111111111111111111111111111111111 --timestamp --options runtime/,
    );
    const signCalls = runner.callsTo("codesign").filter((a) => a[0] === "--force");
    expect(signCalls.map((a) => a.at(-1))).toEqual([
      join(app, "Contents", "Frameworks", "libhelper.dylib"),
      app,
    ]);
    expect(result.text).toMatch(/Signed 2 item\(s\)/);
  });

  it("explains codesign failures", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx();
    runner
      .on("xattr", ["-cr"], {})
      .on("codesign", ["--force"], { code: 1, stderr: `${app}: errSecInternalComponent` });
    const client = await connect(ctx);
    const { result } = await callConfirmed(client, "sign", {
      path: app,
      identity: "Developer ID Application: X (ABCDE12345)",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Keychain refused access to the signing key/);
  });
});

describe("notarize_and_staple", () => {
  it("runs preflight → zip → submit → poll → staple → assess", async () => {
    const app = await makeApp();
    const { ctx, runner, home } = await makeCtx({ env: {} });
    (ctx as { config: ConfigStore }).config = new ConfigStore(
      home,
      await withApiKey(home),
      join(home, "cfg"),
    );
    const devid = await fx("codesign-devid.txt");
    runner
      .on("codesign", ["-dvvv"], { stderr: devid })
      .on("codesign", ["--verify"], { stderr: "valid on disk" })
      .on("codesign", ["-d", "--entitlements"], { stdout: "" })
      .on("ditto", ["-c", "-k"], (_c, a) => {
        void writeFile(a.at(-1)!, "zip");
        return {};
      })
      .on("xcrun", ["notarytool", "submit"], {
        stdout: '{"id":"sub-123","message":"Successfully uploaded file","path":"x.zip"}',
      })
      .on("xcrun", ["notarytool", "info"], { stdout: '{"id":"sub-123","status":"Accepted","message":"ok"}' })
      .on("xcrun", ["stapler", "staple"], { stdout: "The staple and validate action worked!" })
      .on("spctl", ["--assess"], { stderr: `${app}: accepted\nsource=Notarized Developer ID` });
    const client = await connect(ctx);
    const { preview, result } = await callConfirmed(client, "notarize_and_staple", { path: app });
    expect(preview.text).toMatch(/API key KEY1234567/);
    expect(result.text).toMatch(/Notarization ACCEPTED \(submission sub-123\)/);
    expect(result.text).toMatch(/Stapled ✓/);
    expect(result.text).toMatch(/Gatekeeper: accepted/);
    const submit = runner.callsTo("xcrun").find((a) => a[1] === "submit")!;
    expect(submit).toEqual(expect.arrayContaining(["--key-id", "KEY1234567", "--issuer", "issuer-1"]));
  });

  it("refuses obviously broken signatures before uploading", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx();
    runner
      .on("codesign", ["-dvvv"], { stderr: await fx("codesign-adhoc.txt") })
      .on("codesign", ["--verify"], { stderr: "valid on disk" })
      .on("codesign", ["-d", "--entitlements"], { stdout: "" });
    const r = await call(await connect(ctx), "notarize_and_staple", { path: app });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Preflight found problems/);
    expect(r.text).toMatch(/not Developer ID Application/);
    expect(runner.callsTo("xcrun")).toHaveLength(0);
  });
});

describe("notary submit (rejected)", () => {
  it("fetches and explains the developer log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zip-"));
    const zip = join(dir, "Example.zip");
    await writeFile(zip, "zip");
    const { ctx, runner, home } = await makeCtx();
    (ctx as { config: ConfigStore }).config = new ConfigStore(
      home,
      { NOTARY_KEYCHAIN_PROFILE: "my-profile" },
      join(home, "cfg"),
    );
    runner
      .on("xcrun", ["notarytool", "submit"], {
        stdout: '{"id":"sub-9","message":"Successfully uploaded file"}',
      })
      .on("xcrun", ["notarytool", "info"], { stdout: '{"id":"sub-9","status":"Invalid"}' })
      .on("xcrun", ["notarytool", "log"], { stdout: await fx("notary-log-invalid.json") });
    const client = await connect(ctx);
    const { result } = await callConfirmed(client, "notary", { action: "submit", path: zip });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Notarization INVALID/);
    expect(result.text).toMatch(/hardened runtime enabled\. \(×2\)/);
    expect(result.text).toMatch(/--options runtime/);
    expect(runner.callsTo("xcrun")[0]).toEqual(expect.arrayContaining(["--keychain-profile", "my-profile"]));
  });
});

describe("package + keychain", () => {
  it("zips without confirmation when the output is new", async () => {
    const app = await makeApp();
    const { ctx, runner } = await makeCtx();
    runner.on("ditto", ["-c"], {});
    const r = await call(await connect(ctx), "package", { action: "zip", path: app });
    expect(r.text).toMatch(/Created .*Example\.zip/);
    expect(runner.callsTo("ditto")[0]).toEqual([
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      app,
      app.replace(/\.app$/, ".zip"),
    ]);
  });

  it("builds a styled DMG with dmgbuild (no Finder) from appdmg-format JSON", async () => {
    const app = await makeApp();
    const bg = join(app, "..", "bg.png");
    await writeFile(bg, "png");
    const { ctx, runner } = await makeCtx();
    let settings: Record<string, any> = {};
    runner.on("dmgbuild", ["--help"], {});
    runner.on("dmgbuild", ["-s"], (_c, a) => {
      settings = JSON.parse(readFileSync(a[1], "utf8"));
      return {};
    });
    const r = await call(await connect(ctx), "package", {
      action: "dmg",
      path: app,
      volume_name: "Example Installer",
      background: bg,
      window_size: { width: 600, height: 400 },
      icon_positions: { Applications: [450, 200] },
    });
    expect(r.text).toMatch(/Created .*Example\.dmg/);
    const argv = runner.callsTo("dmgbuild")[1];
    expect(argv.slice(2)).toEqual(["--", "Example Installer", app.replace(/\.app$/, ".dmg")]);
    expect(settings).toMatchObject({
      title: "Example Installer",
      background: bg,
      "icon-size": 128,
      window: { size: { width: 600, height: 400 } },
      contents: [
        { type: "file", path: app, x: 150, y: 180 },
        { type: "link", path: "/Applications", name: "Applications", x: 450, y: 200 },
      ],
    });
    expect(runner.callsTo("hdiutil")).toEqual([]);
  });

  it("explains how to install dmgbuild when a styled DMG is requested without it", async () => {
    const app = await makeApp();
    const { ctx } = await makeCtx();
    const r = await call(await connect(ctx), "package", { action: "dmg", path: app, icon_size: 96 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/pipx install dmgbuild/);
  });

  it("rejects icon positions for items the DMG doesn't contain", () => {
    expect(() =>
      dmgbuildSettings("/x/Example.app", "Ex", { iconPositions: { "Other.app": [1, 2] } }),
    ).toThrow(/unknown item "Other.app"/);
  });

  it("creates a real key + CSR with openssl (0600 key)", async () => {
    const { ctx } = await makeCtx({ runner: new SpawnRunner() as never, isMac: false });
    const client = await connect(ctx);
    const { result } = await callConfirmed(client, "keychain", {
      action: "create_csr",
      key_name: "test-key",
      common_name: "Example Corp",
      email: "dev@example.com",
    });
    expect(result.isError).toBe(false);
    expect(result.data.csrPem).toMatch(/BEGIN CERTIFICATE REQUEST/);
    const st = await stat(result.data.keyPath);
    expect(st.mode & 0o777).toBe(0o600);
  });
});
