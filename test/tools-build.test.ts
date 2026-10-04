import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateWorkflow } from "../src/tools/ci";
import { exportOptions } from "../src/tools/xcode";
import { ascEnv, call, callConfirmed, connect, fakeAsc, makeCtx } from "./helpers";

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "xc-"));
  await mkdir(join(dir, "Example.xcworkspace"), { recursive: true });
  return dir;
}

describe("xcode tool", () => {
  it("archives with automatic signing via the API key after confirmation", async () => {
    const dir = await project();
    const env = await ascEnv(dir);
    const { ctx, runner } = await makeCtx({ env });
    runner.on("xcodebuild", ["archive"], { stdout: "Build settings…\n** ARCHIVE SUCCEEDED **\n" });
    const client = await connect(ctx);
    const { preview, result } = await callConfirmed(client, "xcode", {
      action: "archive",
      path: dir,
      scheme: "Example",
      target: "testflight-ios",
      team_id: "ABCDE12345",
    });
    expect(preview.text).toMatch(
      /-allowProvisioningUpdates -authenticationKeyPath .*AuthKey_TESTKEY123\.p8 -authenticationKeyID TESTKEY123/,
    );
    expect(preview.text).toMatch(/generic\/platform=iOS/);
    expect(result.text).toMatch(/Archived to .*build\/Example\.xcarchive/);
    const args = runner.callsTo("xcodebuild")[0];
    expect(args).toEqual(
      expect.arrayContaining(["-workspace", join(dir, "Example.xcworkspace"), "DEVELOPMENT_TEAM=ABCDE12345"]),
    );
  });

  it("manual archive checks the app target's own signing settings and never overrides them globally", async () => {
    const dir = await project();
    const settings = (extra: Record<string, string>) =>
      JSON.stringify([
        { target: "Pods-App", buildSettings: { PRODUCT_NAME: "Pods_App", CODE_SIGN_STYLE: "Automatic" } },
        {
          target: "App",
          buildSettings: {
            PRODUCT_BUNDLE_IDENTIFIER: "com.example.app",
            PRODUCT_TYPE: "com.apple.product-type.application",
            ...extra,
          },
        },
      ]);
    const manual = {
      action: "archive",
      path: dir,
      scheme: "App",
      target: "testflight-ios",
      signing_style: "manual",
      signing_certificate: "Apple Distribution",
      provisioning_profiles: { "com.example.app": "App Store Profile" },
    };

    const bare = await makeCtx();
    bare.runner.on("xcodebuild", ["-showBuildSettings"], {
      stdout: settings({ CODE_SIGN_STYLE: "Automatic" }),
    });
    const refused = await call(await connect(bare.ctx), "xcode", manual);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(
      /App \(com\.example\.app\): CODE_SIGN_STYLE = Manual; PROVISIONING_PROFILE_SPECIFIER = "App Store Profile"; CODE_SIGN_IDENTITY = "Apple Distribution"/,
    );
    expect(refused.text).toMatch(/does not support provisioning profiles/);
    expect(bare.runner.callsTo("xcodebuild").some((a) => a[0] === "archive")).toBe(false);

    const set = await makeCtx();
    set.runner
      .on("xcodebuild", ["-showBuildSettings"], {
        stdout: settings({
          CODE_SIGN_STYLE: "Manual",
          CODE_SIGN_IDENTITY: "Apple Distribution",
          PROVISIONING_PROFILE_SPECIFIER: "App Store Profile",
        }),
      })
      .on("xcodebuild", ["archive"], { stdout: "** ARCHIVE SUCCEEDED **\n" });
    const { preview } = await callConfirmed(await connect(set.ctx), "xcode", manual);
    expect(preview.text).not.toMatch(/PROVISIONING_PROFILE_SPECIFIER=|CODE_SIGN_IDENTITY=/);
    const archive = set.runner.callsTo("xcodebuild").find((a) => a[0] === "archive");
    expect(archive).toContain("CODE_SIGN_STYLE=Manual");
  });

  it("explains archive failures", async () => {
    const dir = await project();
    const { ctx, runner } = await makeCtx();
    runner.on("xcodebuild", ["archive"], {
      code: 65,
      stdout: `error: No profiles for 'com.example.app' were found: Xcode couldn't find any iOS App Store provisioning profiles matching 'com.example.app'.\n** ARCHIVE FAILED **`,
    });
    const { result } = await callConfirmed(await connect(ctx), "xcode", {
      action: "archive",
      path: dir,
      scheme: "Example",
      target: "ios-app-store",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No matching provisioning profile/);
  });

  it("builds ExportOptions for each method", () => {
    expect(
      exportOptions({
        method: "developer-id",
        destination: "export",
        signingStyle: "automatic",
        teamId: "T",
      }),
    ).toEqual({
      method: "developer-id",
      destination: "export",
      signingStyle: "automatic",
      teamID: "T",
    });
    expect(
      exportOptions({
        method: "app-store-connect",
        destination: "upload",
        signingStyle: "manual",
        provisioningProfiles: { "com.x": "P" },
        signingCertificate: "Apple Distribution",
      }),
    ).toMatchObject({
      provisioningProfiles: { "com.x": "P" },
      signingCertificate: "Apple Distribution",
      uploadSymbols: true,
      manageAppVersionAndBuildNumber: false,
    });
  });

  it("uses legacy export method names on Xcode < 15.3 and writes ExportOptions.plist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exp-"));
    const archive = join(dir, "Example.xcarchive");
    await mkdir(archive);
    const { ctx, runner } = await makeCtx();
    runner
      .on("xcode-select", ["-p"], { stdout: "/Applications/Xcode.app/Contents/Developer" })
      .on("xcodebuild", ["-version"], { stdout: "Xcode 15.2\nBuild version 15C500b" })
      .on("xcodebuild", ["-exportArchive"], { stdout: "** EXPORT SUCCEEDED **" });
    const { result } = await callConfirmed(await connect(ctx), "xcode", {
      action: "export",
      archive_path: archive,
      target: "ios-ad-hoc",
      allow_provisioning_updates: false,
    });
    expect(result.isError).toBe(false);
    const plist = await readFile(join(dir, "Example-ad-hoc", "ExportOptions.plist"), "utf8");
    expect(plist).toContain("<string>ad-hoc</string>");
  });
});

describe("upload_build", () => {
  it("uses --upload-package with app metadata and returns a processing next step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "up-"));
    const env = await ascEnv(dir);
    const ipa = join(dir, "Example.ipa");
    await writeFile(ipa, "zip");
    const asc = fakeAsc({
      "GET /v1/apps": {
        body: { data: [{ type: "apps", id: "6400000000", attributes: { bundleId: "com.example.app" } }] },
      },
    });
    const { ctx, runner } = await makeCtx({ env, fetch: asc.fetch });
    runner
      .on("unzip", ["-Z1"], { stdout: "Payload/\nPayload/Example.app/Info.plist\n" })
      .on("unzip", ["-p"], {
        stdout:
          '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string><key>CFBundleShortVersionString</key><string>1.2</string><key>CFBundleVersion</key><string>42</string></dict></plist>',
      })
      .on("xcrun", ["altool", "--help"], { stdout: "--upload-package <file>  --p8-file-path <path>" })
      .on("xcrun", ["altool", "--upload-package"], { stdout: '{"success-message":"No errors uploading"}' });
    const { preview, result } = await callConfirmed(await connect(ctx), "upload_build", { path: ipa });
    expect(preview.text).toMatch(/--upload-package .*--type ios --apiKey TESTKEY123/);
    expect(preview.text).toMatch(
      /--apple-id 6400000000 --bundle-id com\.example\.app --bundle-short-version-string 1\.2 --bundle-version 42/,
    );
    expect(result.text).toMatch(/Uploaded Example\.ipa/);
    expect(result.text).toMatch(/asc_builds action=wait_processing app=com\.example\.app build_number=42/);
  });
});

describe("testflight + app_store", () => {
  it("adds existing testers to a group after a 409", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-"));
    const asc = fakeAsc({
      "POST /v1/betaTesters": {
        status: 409,
        body: {
          errors: [
            { status: "409", code: "ENTITY_ERROR", title: "conflict", detail: "Tester already exists" },
          ],
        },
      },
      "GET /v1/betaTesters": { body: { data: [{ type: "betaTesters", id: "T1" }] } },
      "POST /v1/betaGroups/G1/relationships/betaTesters": { status: 204 },
    });
    const { ctx } = await makeCtx({ env: await ascEnv(dir), fetch: asc.fetch, isMac: false });
    const { result } = await callConfirmed(await connect(ctx), "testflight", {
      action: "add_testers",
      group_id: "G1",
      testers: [{ email: "a@b.c" }],
    });
    expect(result.text).toMatch(/a@b\.c: existing tester added to group/);
    expect(asc.requests.at(-1)!.body).toEqual({ data: [{ type: "betaTesters", id: "T1" }] });
  });

  it("submits a version for review via reviewSubmissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "as-"));
    const asc = fakeAsc({
      "GET /v1/apps": {
        body: { data: [{ type: "apps", id: "A1", attributes: { bundleId: "com.example.app" } }] },
      },
      "GET /v1/appStoreVersions/V1": {
        body: {
          data: {
            type: "appStoreVersions",
            id: "V1",
            attributes: { versionString: "1.2" },
            relationships: { build: { data: { type: "builds", id: "B1" } } },
          },
        },
      },
      "POST /v1/reviewSubmissions": { status: 201, body: { data: { type: "reviewSubmissions", id: "R1" } } },
      "POST /v1/reviewSubmissionItems": {
        status: 201,
        body: { data: { type: "reviewSubmissionItems", id: "I1" } },
      },
      "PATCH /v1/reviewSubmissions/R1": {
        body: { data: { type: "reviewSubmissions", id: "R1", attributes: { state: "WAITING_FOR_REVIEW" } } },
      },
    });
    const { ctx } = await makeCtx({ env: await ascEnv(dir), fetch: asc.fetch, isMac: false });
    const { result } = await callConfirmed(await connect(ctx), "app_store", {
      action: "submit_for_review",
      app: "com.example.app",
      version_id: "V1",
    });
    expect(result.text).toMatch(/Submitted for review \(submission R1, state WAITING_FOR_REVIEW\)/);
    const writes = asc.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    expect(writes).toEqual([
      "POST /v1/reviewSubmissions",
      "POST /v1/reviewSubmissionItems",
      "PATCH /v1/reviewSubmissions/R1",
    ]);
    expect(asc.requests.find((r) => r.path === "/v1/reviewSubmissions")!.body.data.attributes).toEqual({
      platform: "IOS",
    });
  });
});

describe("ci_config", () => {
  it("generates an Xcode Developer ID workflow with keychain setup, notarization and cleanup", () => {
    const { yaml, secrets } = generateWorkflow({
      target: "mac-developer-id",
      framework: "xcode",
      appName: "Example",
      runner: "macos-15",
    });
    expect(yaml).toContain("security set-key-partition-list -S apple-tool:,apple:,codesign:");
    expect(yaml).toContain('-destination "generic/platform=macOS"');
    expect(yaml).toContain("<string>developer-id</string>");
    expect(yaml).toContain("xcrun notarytool submit");
    expect(yaml).toContain("xcrun stapler staple");
    expect(yaml).toContain("security delete-keychain");
    expect(secrets.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "ASC_KEY_ID",
        "ASC_ISSUER_ID",
        "ASC_PRIVATE_KEY",
        "SIGNING_CERTIFICATE_P12_BASE64",
        "TEAM_ID",
      ]),
    );
  });

  it("generates Electron and Expo variants with their own env conventions", () => {
    const el = generateWorkflow({
      target: "mac-developer-id",
      framework: "electron",
      appName: "El",
      runner: "macos-15",
    });
    expect(el.yaml).toContain("CSC_LINK");
    expect(el.yaml).toContain('export APPLE_API_KEY="$ASC_KEY_PATH"');
    const ex = generateWorkflow({
      target: "testflight-ios",
      framework: "expo",
      appName: "Ex",
      runner: "macos-15",
    });
    expect(ex.yaml).toContain("eas build --platform ios");
    expect(ex.secrets.map((s) => s.name)).toEqual(["EXPO_TOKEN"]);
  });

  it("writes the workflow file without confirmation when new", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ci-"));
    const { ctx } = await makeCtx({ isMac: false });
    const out = join(dir, ".github", "workflows", "release.yml");
    const r = await call(await connect(ctx), "ci_config", {
      target: "testflight-ios",
      framework: "flutter",
      app_name: "Runner",
      output_path: out,
    });
    expect(r.text).toMatch(/Wrote/);
    expect(await readFile(out, "utf8")).toContain("flutter build ios --release --no-codesign");
  });
});
