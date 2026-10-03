import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ToolError } from "../core/result";
import { pathExists, resolveUserPath } from "./shared";
import { defineTool, withConfirmation } from "./types";

const FRAMEWORKS = [
  "xcode",
  "electron",
  "tauri",
  "flutter",
  "react-native",
  "expo",
  "swiftpm",
  "prebuilt",
] as const;
type Framework = (typeof FRAMEWORKS)[number];
const CI_TARGETS = [
  "mac-developer-id",
  "testflight-ios",
  "ios-app-store",
  "mac-app-store",
  "testflight-mac",
] as const;
type CiTarget = (typeof CI_TARGETS)[number];

interface CiOptions {
  target: CiTarget;
  framework: Framework;
  scheme?: string;
  workspace?: string;
  appName: string;
  appPath?: string;
  runner: string;
}

const KEYCHAIN_SETUP = `      - name: Import signing certificate into a temporary keychain
        env:
          P12_BASE64: \${{ secrets.SIGNING_CERTIFICATE_P12_BASE64 }}
          P12_PASSWORD: \${{ secrets.SIGNING_CERTIFICATE_PASSWORD }}
        run: |
          KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"
          KEYCHAIN="$RUNNER_TEMP/signing.keychain-db"
          echo "$P12_BASE64" | base64 --decode > "$RUNNER_TEMP/cert.p12"
          security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
          security set-keychain-settings -lut 21600 "$KEYCHAIN"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
          security import "$RUNNER_TEMP/cert.p12" -P "$P12_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN"
          # Without this, codesign fails with errSecInternalComponent on CI
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
          security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
          rm "$RUNNER_TEMP/cert.p12"
          security find-identity -v -p codesigning "$KEYCHAIN"
`;

const API_KEY_SETUP = `      - name: Write App Store Connect API key
        env:
          ASC_PRIVATE_KEY: \${{ secrets.ASC_PRIVATE_KEY }}
          ASC_KEY_ID: \${{ secrets.ASC_KEY_ID }}
        run: |
          mkdir -p ~/.appstoreconnect/private_keys
          echo "$ASC_PRIVATE_KEY" > ~/.appstoreconnect/private_keys/AuthKey_\${ASC_KEY_ID}.p8
          echo "ASC_KEY_PATH=$HOME/.appstoreconnect/private_keys/AuthKey_\${ASC_KEY_ID}.p8" >> "$GITHUB_ENV"
`;

const CLEANUP = `      - name: Clean up keychain
        if: always()
        run: security delete-keychain "$RUNNER_TEMP/signing.keychain-db" || true
`;

function notarizeSteps(appPathExpr: string, appName: string): string {
  return `      - name: Notarize and staple
        env:
          ASC_KEY_ID: \${{ secrets.ASC_KEY_ID }}
          ASC_ISSUER_ID: \${{ secrets.ASC_ISSUER_ID }}
        run: |
          APP="${appPathExpr}"
          codesign --verify --deep --strict --verbose=2 "$APP"
          ditto -c -k --sequesterRsrc --keepParent "$APP" "$RUNNER_TEMP/${appName}-notarize.zip"
          # Notarization usually takes a few minutes; --wait blocks the CI job (not a human).
          xcrun notarytool submit "$RUNNER_TEMP/${appName}-notarize.zip" \\
            --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \\
            --wait --timeout 90m --output-format json | tee "$RUNNER_TEMP/notary.json"
          STATUS=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["status"])' "$RUNNER_TEMP/notary.json")
          ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$RUNNER_TEMP/notary.json")
          if [ "$STATUS" != "Accepted" ]; then
            xcrun notarytool log "$ID" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID"
            exit 1
          fi
          xcrun stapler staple "$APP"
          spctl --assess --type execute -vvv "$APP"
          ditto -c -k --sequesterRsrc --keepParent "$APP" "$RUNNER_TEMP/${appName}.zip"
      - uses: actions/upload-artifact@v4
        with:
          name: ${appName}-notarized
          path: \${{ runner.temp }}/${appName}.zip
`;
}

function buildSteps(o: CiOptions): string {
  const ws = o.workspace ?? `${o.appName}.xcworkspace`;
  const scheme = o.scheme ?? o.appName;
  const archiveFlags = `-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"`;
  const ascEnv = `        env:
          ASC_KEY_ID: \${{ secrets.ASC_KEY_ID }}
          ASC_ISSUER_ID: \${{ secrets.ASC_ISSUER_ID }}
`;
  const isMac = o.target.startsWith("mac") || o.target === "testflight-mac";
  const platform = isMac ? "macOS" : "iOS";
  const method = o.target === "mac-developer-id" ? "developer-id" : "app-store-connect";
  const exportPlist = `cat > "$RUNNER_TEMP/ExportOptions.plist" <<'PLIST'
          <?xml version="1.0" encoding="UTF-8"?>
          <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
          <plist version="1.0"><dict>
            <key>method</key><string>${method}</string>
            <key>destination</key><string>${o.target === "mac-developer-id" ? "export" : "upload"}</string>
            <key>signingStyle</key><string>automatic</string>
            <key>teamID</key><string>\${{ secrets.TEAM_ID }}</string>
          </dict></plist>
          PLIST`;
  const xcodeArchive = (container: string) => `      - name: Archive and export
${ascEnv}        run: |
          xcodebuild archive ${container} -scheme "${scheme}" -configuration Release \\
            -destination "generic/platform=${platform}" -archivePath "$RUNNER_TEMP/${o.appName}.xcarchive" ${archiveFlags}
          ${exportPlist}
          xcodebuild -exportArchive -archivePath "$RUNNER_TEMP/${o.appName}.xcarchive" -exportPath "$RUNNER_TEMP/export" \\
            -exportOptionsPlist "$RUNNER_TEMP/ExportOptions.plist" ${archiveFlags}
`;
  switch (o.framework) {
    case "xcode":
      return xcodeArchive(`-workspace "${ws}"`);
    case "react-native":
      return `      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: cd ios && pod install
${xcodeArchive(`-workspace "ios/${o.appName}.xcworkspace"`)}`;
    case "flutter":
      return `      - uses: subosito/flutter-action@v2
        with: { channel: stable }
      - run: flutter pub get
      - run: flutter build ${isMac ? "macos" : "ios"} --release --no-codesign
${xcodeArchive(`-workspace "${isMac ? "macos" : "ios"}/Runner.xcworkspace"`).replace(`-scheme "${scheme}"`, '-scheme "Runner"')}`;
    case "electron":
      return `      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Build, sign and notarize with electron-builder
        env:
          CSC_LINK: \${{ secrets.SIGNING_CERTIFICATE_P12_BASE64 }}
          CSC_KEY_PASSWORD: \${{ secrets.SIGNING_CERTIFICATE_PASSWORD }}
          APPLE_API_KEY_ID: \${{ secrets.ASC_KEY_ID }}
          APPLE_API_ISSUER: \${{ secrets.ASC_ISSUER_ID }}
        run: |
          export APPLE_API_KEY="$ASC_KEY_PATH"   # electron-builder expects the .p8 PATH here
          npx electron-builder --mac --publish never
`;
    case "tauri":
      return `      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: "aarch64-apple-darwin,x86_64-apple-darwin" }
      - run: npm ci
      - name: Build, sign and notarize with Tauri
        env:
          APPLE_CERTIFICATE: \${{ secrets.SIGNING_CERTIFICATE_P12_BASE64 }}
          APPLE_CERTIFICATE_PASSWORD: \${{ secrets.SIGNING_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: \${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_API_ISSUER: \${{ secrets.ASC_ISSUER_ID }}
          APPLE_API_KEY: \${{ secrets.ASC_KEY_ID }}       # Tauri: the key ID
        run: |
          export APPLE_API_KEY_PATH="$ASC_KEY_PATH"
          npm run tauri build -- --target universal-apple-darwin
`;
    case "expo":
      return `      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: \${{ secrets.EXPO_TOKEN }}
      - run: eas build --platform ios --profile production --non-interactive --auto-submit
`;
    case "swiftpm":
      return `      - name: Build universal binary and sign
        run: |
          swift build -c release --arch arm64 --arch x86_64
          BIN=".build/apple/Products/Release/${o.appName}"
          codesign --force --sign "Developer ID Application" --options runtime --timestamp "$BIN"
          mkdir -p "$RUNNER_TEMP/dist" && cp "$BIN" "$RUNNER_TEMP/dist/"
`;
    case "prebuilt":
      return "";
  }
}

export function generateWorkflow(o: CiOptions): { yaml: string; secrets: { name: string; how: string }[] } {
  const usesKeychain = o.framework !== "expo" && o.framework !== "electron" && o.framework !== "tauri";
  const appPathExpr =
    o.appPath ??
    (o.framework === "xcode" || o.framework === "react-native" || o.framework === "flutter"
      ? `$RUNNER_TEMP/export/${o.framework === "flutter" ? "Runner" : o.appName}.app`
      : `dist/mac/${o.appName}.app`);
  const needsNotarizeStep =
    o.target === "mac-developer-id" && ["xcode", "react-native", "flutter", "prebuilt"].includes(o.framework);
  const name = {
    "mac-developer-id": "macOS Developer ID release",
    "testflight-ios": "iOS TestFlight",
    "ios-app-store": "iOS App Store build",
    "mac-app-store": "Mac App Store build",
    "testflight-mac": "Mac TestFlight",
  }[o.target];
  const yaml = `# Generated by notarize-mcp (ci_config). Review before committing.
name: ${name}

on:
  workflow_dispatch:
  push:
    tags: ["v*"]

jobs:
  release:
    runs-on: ${o.runner}
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
${usesKeychain ? KEYCHAIN_SETUP : ""}${o.framework === "expo" ? "" : API_KEY_SETUP}${buildSteps(o)}${needsNotarizeStep ? notarizeSteps(appPathExpr, o.appName) : ""}${
  o.framework === "swiftpm" && o.target === "mac-developer-id"
    ? `      - name: Notarize
        env:
          ASC_KEY_ID: \${{ secrets.ASC_KEY_ID }}
          ASC_ISSUER_ID: \${{ secrets.ASC_ISSUER_ID }}
        run: |
          ditto -c -k --keepParent "$RUNNER_TEMP/dist" "$RUNNER_TEMP/${o.appName}.zip"
          xcrun notarytool submit "$RUNNER_TEMP/${o.appName}.zip" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait --timeout 90m
      - uses: actions/upload-artifact@v4
        with: { name: ${o.appName}, path: "\${{ runner.temp }}/${o.appName}.zip" }
`
    : ""
}${usesKeychain ? CLEANUP : ""}`;
  const secrets = [
    ...(o.framework !== "expo"
      ? [
          {
            name: "ASC_KEY_ID",
            how: "App Store Connect → Users and Access → Integrations → Team Keys (Key ID column)",
          },
          { name: "ASC_ISSUER_ID", how: "Same page, 'Issuer ID' above the table" },
          { name: "ASC_PRIVATE_KEY", how: "Full contents of AuthKey_<KEYID>.p8" },
        ]
      : []),
    ...(o.framework !== "expo"
      ? [
          {
            name: "SIGNING_CERTIFICATE_P12_BASE64",
            how: "keychain action=export_p12 → contents of <file>.p12.base64 (Developer ID Application for direct distribution, Apple Distribution for the stores)",
          },
          {
            name: "SIGNING_CERTIFICATE_PASSWORD",
            how: "The .p12 password (from <file>.p12.password or password_env)",
          },
        ]
      : []),
    ...(o.framework === "xcode" || o.framework === "flutter" || o.framework === "react-native"
      ? [{ name: "TEAM_ID", how: "developer.apple.com → Membership details" }]
      : []),
    ...(o.framework === "tauri"
      ? [
          {
            name: "APPLE_SIGNING_IDENTITY",
            how: "e.g. 'Developer ID Application: Your Name (TEAMID)' (signing_identities)",
          },
        ]
      : []),
    ...(o.framework === "expo"
      ? [
          {
            name: "EXPO_TOKEN",
            how: "expo.dev → Account settings → Access tokens; configure ASC API key in eas.json / eas credentials",
          },
        ]
      : []),
  ];
  return { yaml, secrets };
}

export const ciConfigTool = defineTool({
  name: "ci_config",
  title: "Generate a CI workflow for signing + notarization / upload",
  description:
    "Generates a GitHub Actions workflow for a target (mac-developer-id, testflight-ios, ios-app-store, mac-app-store, testflight-mac) and framework (xcode, electron, tauri, flutter, react-native, expo, swiftpm, prebuilt): temporary keychain + set-key-partition-list (avoids errSecInternalComponent), API key from secrets, archive/export with automatic signing via the API key (or the framework's own signing), notarytool --wait + staple, artifact upload, and keychain cleanup. Returns the YAML and the list of repository secrets to create. Writing to output_path needs confirmation only when overwriting.",
  mutating: true,
  input: {
    target: z.enum(CI_TARGETS),
    framework: z.enum(FRAMEWORKS),
    app_name: z.string().describe("Product / scheme name (used for paths)."),
    scheme: z.string().optional(),
    workspace: z.string().optional().describe("Relative .xcworkspace path (xcode)."),
    app_path: z.string().optional().describe("Built .app path expression (prebuilt / custom layouts)."),
    runner: z.string().optional().describe("GitHub runner label (default macos-15)."),
    output_path: z.string().optional().describe("e.g. .github/workflows/release.yml"),
  },
  async handler(args, ctx, extra) {
    if (args.framework === "expo" && args.target.startsWith("mac"))
      throw new ToolError("Expo targets iOS; use testflight-ios or ios-app-store.");
    const { yaml, secrets } = generateWorkflow({
      target: args.target,
      framework: args.framework,
      scheme: args.scheme,
      workspace: args.workspace,
      appName: args.app_name,
      appPath: args.app_path,
      runner: args.runner ?? "macos-15",
    });
    const summary = `Workflow (${args.framework} → ${args.target}):\n\n${yaml}\nRepository secrets to create:\n${secrets.map((s) => `• ${s.name}: ${s.how}`).join("\n")}`;
    const result = { summary, data: { yaml, secrets } };
    if (!args.output_path) return result;
    const out = await resolveUserPath(ctx, args.output_path, false);
    const write = async () => {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, yaml);
      return { ...result, summary: `Wrote ${out}.\n\n${summary}`, data: { ...result.data, written: out } };
    };
    if (!(await pathExists(out))) return write();
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Overwrite ${out}`,
        steps: [{ description: `Replace ${out} with the generated workflow` }],
      }),
      write,
    );
  },
});
