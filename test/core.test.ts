import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config";
import { ConfirmManager, canonicalJson, parseAutoConfirm, policyAllows } from "../src/core/confirm";
import { SpawnRunner } from "../src/core/exec";
import { FakeRunner } from "../src/core/fake-runner";
import { JobManager } from "../src/core/jobs";
import { tail } from "../src/core/logs";
import { compareVersions } from "../src/core/platform";
import { buildPlist, extractEmbeddedPlist, parsePlistDict } from "../src/core/plist";
import { formatCommand, redact, redactDeep } from "../src/core/redact";

describe("confirm tokens", () => {
  it("previews without a token, executes with a matching token", () => {
    const cm = new ConfirmManager({ autoConfirm: false });
    const args = { path: "/tmp/App.app", identity: "Developer ID Application: X (ABCDE12345)" };
    expect(cm.check("sign", args).status).toBe("preview");
    const token = cm.issue("sign", args);
    expect(cm.check("sign", { ...args, confirm_token: token }).status).toBe("execute");
  });

  it("rejects tokens when args change, the tool differs, or the token expired", () => {
    let now = 1_000_000;
    const cm = new ConfirmManager({ autoConfirm: false, ttlMs: 1000, now: () => now });
    const args = { path: "/a" };
    const token = cm.issue("sign", args);
    expect(cm.check("sign", { path: "/b", confirm_token: token }).status).toBe("invalid");
    expect(cm.check("notary", { path: "/a", confirm_token: token }).status).toBe("invalid");
    expect(cm.check("sign", { path: "/a", confirm_token: "garbage" }).status).toBe("invalid");
    now += 2000;
    const res = cm.check("sign", { path: "/a", confirm_token: token });
    expect(res.status).toBe("invalid");
    expect(res.status === "invalid" && res.reason).toMatch(/expired/);
  });

  it("is insensitive to key order and undefined values", () => {
    const cm = new ConfirmManager({ autoConfirm: false });
    const token = cm.issue("t", { a: 1, b: { y: 2, x: 1 }, c: undefined });
    expect(cm.check("t", { b: { x: 1, y: 2 }, a: 1, confirm_token: token }).status).toBe("execute");
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it("parses the NOTARIZE_MCP_AUTO_CONFIRM policy", () => {
    expect(parseAutoConfirm(undefined)).toEqual({ mode: "off" });
    expect(parseAutoConfirm("0")).toEqual({ mode: "off" });
    expect(parseAutoConfirm("1")).toEqual({ mode: "safe" });
    expect(parseAutoConfirm("safe")).toEqual({ mode: "safe" });
    expect(parseAutoConfirm("ALL")).toEqual({ mode: "all" });
    expect(parseAutoConfirm("sign, notary:submit ,")).toEqual({
      mode: "list",
      entries: ["sign", "notary:submit"],
    });
  });

  it("safe never auto-runs destructive actions; lists are explicit opt-ins", () => {
    const safe = parseAutoConfirm("safe");
    expect(policyAllows(safe, "package", "zip", false)).toBe(true);
    expect(policyAllows(safe, "asc_certificates", "revoke", true)).toBe(false);
    const list = parseAutoConfirm("sign,notary:submit,asc_certificates:revoke");
    expect(policyAllows(list, "sign", undefined, false)).toBe(true);
    expect(policyAllows(list, "notary", "submit", false)).toBe(true);
    expect(policyAllows(list, "notary", "store_credentials", false)).toBe(false);
    expect(policyAllows(list, "asc_certificates", "revoke", true)).toBe(true);
    expect(policyAllows({ mode: "all" }, "x", undefined, true)).toBe(true);
    const cm = new ConfirmManager({ policy: safe });
    expect(cm.autoAllows("package", { action: "zip" }, false)).toBe(true);
    expect(cm.check("package", { action: "zip" }).status).toBe("preview");
  });
});

describe("redaction", () => {
  it("masks PEM keys, JWTs, openssl pass: args and explicit secrets", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----";
    const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ4eHh4eHh4In0.c2lnbmF0dXJlc2lnbmF0dXJl";
    const out = redact(`${pem} token=${jwt} -passout pass:hunter22 pw=s3cr3tvalue`, ["s3cr3tvalue"]);
    expect(out).not.toContain("MIGTAgEAMBMGByqGSM49");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("s3cr3tvalue");
  });

  it("formats commands with masked password flags and shell quoting", () => {
    expect(formatCommand("security", ["import", "a b.p12", "-P", "pw123"])).toBe(
      "security import 'a b.p12' -P ***",
    );
  });

  it("redacts secret-looking keys in objects", () => {
    expect(redactDeep({ password: "x", nested: { p12Passphrase: "y", ok: "z" } })).toEqual({
      password: "***",
      nested: { p12Passphrase: "***", ok: "z" },
    });
  });
});

describe("jobs", () => {
  it("returns the value when done before the deadline", async () => {
    const jm = new JobManager();
    const r = await jm.runWithDeadline("t", "d", 1000, async (job) => {
      job.log("hello\nworld\n");
      return 42;
    });
    expect(r).toMatchObject({ done: true, value: 42 });
    expect(jm.get(r.jobId)?.lines).toEqual(["hello", "world"]);
    expect(jm.get(r.jobId)?.status).toBe("succeeded");
  });

  it("detaches when the deadline passes and can be cancelled", async () => {
    const jm = new JobManager();
    const r = await jm.runWithDeadline(
      "slow",
      "d",
      20,
      (job) =>
        new Promise((resolve, reject) => {
          job.signal.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => resolve("late"), 5000).unref();
        }),
    );
    expect(r.done).toBe(false);
    expect(jm.get(r.jobId)?.status).toBe("running");
    expect(jm.cancel(r.jobId)).toBe(true);
    const rec = await jm.wait(r.jobId, 1000);
    expect(rec?.status).toBe("cancelled");
  });

  it("propagates failures that happen before the deadline", async () => {
    const jm = new JobManager();
    await expect(
      jm.runWithDeadline("f", "d", 1000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("config store", () => {
  it("saves profiles with 0600 perms and resolves credentials (env overrides profile)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notarize-cfg-"));
    const keyPath = join(dir, "AuthKey_ABC123DEFG.p8");
    await writeFile(keyPath, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
    const store = new ConfigStore(dir, {}, join(dir, "cfg"));
    await store.saveProfile("main", { keyId: "ABC123DEFG", issuerId: "iss-1", privateKeyPath: keyPath });
    const st = await stat(store.path);
    expect(st.mode & 0o777).toBe(0o600);
    const creds = await store.resolveAsc();
    expect(creds).toMatchObject({ keyId: "ABC123DEFG", issuerId: "iss-1", profileName: "main" });
    expect(creds.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(await readFile(store.path, "utf8")).not.toContain("BEGIN PRIVATE KEY");

    const envStore = new ConfigStore(
      dir,
      { ASC_KEY_ID: "ENVKEY0001", ASC_ISSUER_ID: "env-iss", ASC_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----x" },
      join(dir, "cfg"),
    );
    expect(await envStore.resolveAsc()).toMatchObject({ keyId: "ENVKEY0001", source: "environment" });
  });

  it("discovers AuthKey_*.p8 in ~/.appstoreconnect/private_keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "notarize-home-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".appstoreconnect", "private_keys"), { recursive: true });
    await writeFile(join(home, ".appstoreconnect", "private_keys", "AuthKey_ZZZ999.p8"), "k");
    const store = new ConfigStore(home, { ASC_KEY_ID: "ZZZ999", ASC_ISSUER_ID: "i" }, join(home, "cfg"));
    expect((await store.resolveAsc()).privateKeyPath).toContain("AuthKey_ZZZ999.p8");
    expect(await store.listDiscoveredP8()).toEqual([
      { keyId: "ZZZ999", path: join(home, ".appstoreconnect", "private_keys", "AuthKey_ZZZ999.p8") },
    ]);
  });

  it("explains missing credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "notarize-empty-"));
    const store = new ConfigStore(home, {}, join(home, "cfg"));
    await expect(store.resolveAsc()).rejects.toThrow(/No App Store Connect API key/);
  });
});

describe("plist", () => {
  it("round-trips XML plists and extracts plists embedded in CMS blobs", () => {
    const xml = buildPlist({ "com.apple.security.app-sandbox": true, groups: ["A.b"] });
    expect(parsePlistDict(xml)).toEqual({ "com.apple.security.app-sandbox": true, groups: ["A.b"] });
    const der = Buffer.concat([
      Buffer.from([0x30, 0x82, 0x01, 0x00]),
      Buffer.from(xml),
      Buffer.from([0, 1, 2]),
    ]);
    expect(extractEmbeddedPlist(new Uint8Array(der))).toEqual({
      "com.apple.security.app-sandbox": true,
      groups: ["A.b"],
    });
  });
});

describe("misc", () => {
  it("compares versions", () => {
    expect(compareVersions("16.0", "15.4")).toBe(1);
    expect(compareVersions("26.0", "26")).toBe(0);
    expect(compareVersions("10.9", "10.15")).toBe(-1);
  });

  it("tails output", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const t = tail(text, 3);
    expect(t).toContain("line 99");
    expect(t).toContain("97 earlier lines omitted");
  });

  it("FakeRunner answers scripted commands and flags unknown ones", async () => {
    const fr = new FakeRunner().on("codesign", ["-dvvv"], { stdout: "ok" });
    expect((await fr.run("codesign", ["-dvvv", "x"])).stdout).toBe("ok");
    expect((await fr.run("spctl", [])).spawnError).toMatch(/no rule/);
  });

  it("SpawnRunner runs real processes without a shell and reports missing commands", async () => {
    const r = new SpawnRunner();
    const res = await r.run(process.execPath, ["-e", "process.stdout.write('$HOME')"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("$HOME");
    const missing = await r.run("definitely-not-a-command-xyz", []);
    expect(missing.spawnError).toMatch(/command not found/);
    const timed = await r.run(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 100 });
    expect(timed.timedOut).toBe(true);
  });
});
