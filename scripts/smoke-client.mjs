// Drives the built MCP server (dist/notarize-mcp.js) over stdio and checks real macOS behaviour.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [app, work] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/notarize-mcp.js"],
  env: { ...process.env },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
async function step(name, args, check) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? "").join("\n");
  const ok = check(text, r.structuredContent ?? {}, r);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(args).slice(0, 80)}`);
  if (!ok) {
    failures++;
    console.log(text.slice(0, 3000));
  }
  return r;
}

const { tools } = await client.listTools();
console.log(`${tools.length} tools registered`);

await step("doctor", {}, (t) => /doctor: macOS/.test(t));
await step("detect_project", { path: app }, (_t, d) => d.components?.[0]?.kind === "app-bundle");
await step("inspect_code_signature", { path: app }, (t) =>
  /Signed: yes \(adhoc\)|linker-signed|Signed: NO/.test(t),
);
await step(
  "sign",
  { path: app, identity: "-", hardened_runtime: true },
  (t, _d, r) => !r.isError && /Signed 2 item/.test(t),
);
await step(
  "inspect_code_signature",
  { path: app, target: "mac-developer-id" },
  (t) =>
    /Signed: yes \(adhoc\)/.test(t) &&
    /Hardened runtime: yes/.test(t) &&
    /not Developer ID Application/.test(t) &&
    !/Nested dylib: unsigned/.test(t),
);
await step(
  "inspect_binary",
  { path: app },
  (_t, d) => d.binaries?.length === 2 && d.binaries.every((b) => b.archs.includes("arm64")),
);
await step("entitlements", { action: "read", path: app }, (t) => /Entitlements from signature/.test(t));
await step("gatekeeper", { action: "assess", path: app }, (t) => /REJECTED/.test(t));
await step("privacy", { action: "audit", path: app }, (_t, d) => d.platform === "macOS");
await step("package", { action: "zip", path: app, output_path: join(work, "Hello.zip") }, (t) =>
  /Created/.test(t),
);
await step("package", { action: "dmg", path: app, output_path: join(work, "Hello.dmg") }, (t) =>
  /Created/.test(t),
);
await step("gatekeeper", { action: "simulate_download", path: join(work, "Hello.zip") }, (t) =>
  /WILL see a Gatekeeper block/.test(t),
);
const copy = join(work, "Copy.app");
execFileSync("ditto", [app, copy]);
await step("quarantine", { action: "set", path: copy }, (t) => /Done/.test(t));
await step("quarantine", { action: "get", path: copy }, (t) => /is quarantined/.test(t));
await step("system_logs", { preset: "gatekeeper", last: "2m", max_lines: 20 }, (_t, _d, r) => !r.isError);
await step("signing_identities", { include_reference: false }, (_t, _d, r) => !r.isError);
await step("provisioning_profiles", { action: "list_installed" }, (_t, _d, r) => !r.isError);

// watch-job CLI against a synthetic finished job
const state = join(work, "jobs");
execFileSync("mkdir", ["-p", state]);
writeFileSync(
  join(state, "job_smoke.json"),
  JSON.stringify({
    id: "job_smoke",
    name: "notarize",
    description: "d",
    status: "succeeded",
    summary: "ok",
    startedAt: "",
    updatedAt: new Date().toISOString(),
    pid: 1,
    meta: {},
  }),
);
const out = execFileSync(process.execPath, [
  "dist/notarize-mcp.js",
  "watch-job",
  "job_smoke",
  "--state-dir",
  state,
]).toString();
console.log(`${/SUCCEEDED/.test(out) ? "PASS" : "FAIL"} watch-job CLI`);
if (!/SUCCEEDED/.test(out)) failures++;

await client.close();
if (failures) {
  console.error(`${failures} smoke step(s) failed`);
  process.exit(1);
}
