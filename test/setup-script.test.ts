import { execFile } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/core/config";

const SCRIPT = join(__dirname, "..", "skills", "setup", "scripts", "setup.mjs");
const KEY_ID = "ABCDE12345";
const ISSUER = "69a6de70-1234-47e3-a053-5b8c7c11a4d1";

interface Check {
  id: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}
interface Result {
  schema: number;
  ready: boolean;
  error?: string;
  resolved?: {
    keyId?: string;
    issuerId?: string;
    privateKeyPath?: string;
    source: string;
    notaryKeychainProfile?: string;
    discoveredKeys?: { keyId: string; path: string }[];
  };
  checks?: Check[];
  actions?: { kind: string; path: string; done?: boolean }[];
  next_steps?: string[];
}

function ecPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), "setup-home-"));
  const configDir = join(home, "cfg");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    SHELL: "/bin/zsh",
    NOTARIZE_MCP_CONFIG_DIR: configDir,
  };
  return { home, configDir, env };
}

function writeKey(path: string, pem = ecPem(), mode = 0o600): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, pem);
  chmodSync(path, mode);
  return path;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; json: Result }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env }, (err, stdout) => {
      const code = err ? Number((err as { code?: number }).code ?? 1) : 0;
      resolve({ code, out: stdout, json: JSON.parse(stdout) as Result });
    });
  });
}

const byId = (r: Result, id: string) => r.checks?.find((c) => c.id === id);

async function snapshot(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

describe("setup.mjs", () => {
  it("reports not ready with stable check ids when nothing is configured", async () => {
    const { env } = await sandbox();
    const { code, json } = await run([], env);
    expect(code).toBe(1);
    expect(json.schema).toBe(1);
    expect(json.ready).toBe(false);
    expect(byId(json, "asc_key_id")?.status).toBe("fail");
    expect(byId(json, "asc_issuer_id")?.status).toBe("fail");
    expect(byId(json, "persisted_shell")?.status).toBe("warn");
    expect(json.next_steps?.length).toBeGreaterThan(0);
  });

  it("reports an installed key when no Key ID is configured, without using it", async () => {
    const { home, env } = await sandbox();
    const keyPath = writeKey(join(home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`));
    const { code, json } = await run([], env);
    expect(code).toBe(1);
    expect(json.resolved?.keyId).toBeUndefined();
    expect(json.resolved?.discoveredKeys).toEqual([{ keyId: KEY_ID, path: keyPath }]);
    expect(byId(json, "asc_key_id")).toMatchObject({ status: "fail" });
    expect(byId(json, "asc_key_id")?.message).toContain(KEY_ID);
    expect(byId(json, "asc_key_id")?.fix).toContain(`--key-id ${KEY_ID}`);
    expect(byId(json, "p8_path")?.status).toBe("warn");
    expect(json.next_steps?.join("\n")).not.toMatch(/Create a Team key/);
  });

  it("lists every installed key when there are several, and only says to create one when there are none", async () => {
    const { home, env } = await sandbox();
    writeKey(join(home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`));
    writeKey(join(home, "private_keys", "AuthKey_ZZZZZ99999.p8"));
    writeKey(join(home, "private_keys", "AuthKey_not-a-key-id.p8"));
    const several = await run([], env);
    expect(several.json.resolved?.discoveredKeys?.map((k) => k.keyId)).toEqual([KEY_ID, "ZZZZZ99999"]);
    expect(byId(several.json, "asc_key_id")?.fix).toMatch(/Ask which key/);

    const empty = await sandbox();
    const none = await run([], empty.env);
    expect(none.json.resolved?.discoveredKeys).toBeUndefined();
    expect(byId(none.json, "p8_path")?.status).toBe("fail");
    expect(byId(none.json, "p8_path")?.fix).toMatch(/Create a Team key/);
  });

  it("plan infers --key-id from the only installed key; refuses to guess between several", async () => {
    const { home, env } = await sandbox();
    const installed = writeKey(join(home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`));
    const plan = await run(["plan", "--issuer-id", ISSUER], env);
    expect(plan.code).toBe(0);
    // Already in place with mode 600: nothing to copy or chmod.
    expect(plan.json.actions?.map((a) => a.kind)).toEqual(["write_shell_rc", "write_profile"]);
    expect(plan.json.next_steps?.[0]).toContain(`Key ID ${KEY_ID} was taken from ${installed}`);

    const apply = await run(["apply", "--issuer-id", ISSUER], env);
    expect(apply.json.ready).toBe(true);
    expect(apply.json.resolved).toMatchObject({ keyId: KEY_ID, privateKeyPath: installed });

    const other = await sandbox();
    writeKey(join(other.home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`));
    writeKey(join(other.home, "private_keys", "AuthKey_ZZZZZ99999.p8"));
    const ambiguous = await run(["plan", "--issuer-id", ISSUER], other.env);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.json.error).toMatch(/several keys are installed/);
  });

  it("is ready with env vars and a key in the default directory; warns on a world-readable key", async () => {
    const { home, env } = await sandbox();
    const keyPath = writeKey(join(home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`));
    Object.assign(env, { ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER });
    const ok = await run(["check"], env);
    expect(ok.code).toBe(0);
    expect(ok.json.ready).toBe(true);
    expect(ok.json.resolved).toMatchObject({ keyId: KEY_ID, privateKeyPath: keyPath, source: "environment" });
    expect(byId(ok.json, "p8_readable")?.status).toBe("ok");
    expect(byId(ok.json, "p8_mode")?.status).toBe("ok");

    chmodSync(keyPath, 0o644);
    const loose = await run([], env);
    expect(loose.json.ready).toBe(true);
    expect(byId(loose.json, "p8_mode")?.status).toBe("warn");
  });

  it("rejects a key that isn't EC P-256 and never prints key material", async () => {
    const { home, env } = await sandbox();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const keyPath = writeKey(join(home, "AuthKey_X.p8"), rsa);
    Object.assign(env, { ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER, ASC_PRIVATE_KEY_PATH: keyPath });
    const { code, out, json } = await run(["--online"], env);
    expect(code).toBe(1);
    expect(byId(json, "p8_readable")?.status).toBe("fail");
    expect(byId(json, "p8_filename")?.status).toBe("warn");
    expect(byId(json, "asc_online")?.status).toBe("fail");
    expect(out).not.toContain("BEGIN");
  });

  it("resolves credentials exactly like ConfigStore.resolveAsc", async () => {
    const fixtures: { name: string; setup: (s: Awaited<ReturnType<typeof sandbox>>) => void }[] = [
      {
        name: "env + explicit path",
        setup: ({ home, env }) =>
          Object.assign(env, {
            ASC_KEY_ID: KEY_ID,
            ASC_ISSUER_ID: ISSUER,
            ASC_PRIVATE_KEY_PATH: writeKey(join(home, "keys", "k.p8")),
          }),
      },
      {
        name: "env + discovered in ~/private_keys",
        setup: ({ home, env }) => {
          writeKey(join(home, "private_keys", `AuthKey_${KEY_ID}.p8`));
          Object.assign(env, { ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER });
        },
      },
      {
        name: "default profile only",
        setup: ({ home, configDir }) => {
          const p = writeKey(join(home, "a.p8"));
          mkdirSync(configDir, { recursive: true });
          writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
              defaultProfile: "main",
              profiles: { main: { keyId: KEY_ID, issuerId: ISSUER, privateKeyPath: p } },
            }),
          );
        },
      },
      {
        name: "ASC_PROFILE picks a profile; key discovered in configDir/keys",
        setup: ({ configDir, env }) => {
          writeKey(join(configDir, "keys", "AuthKey_ZZZZZ99999.p8"));
          writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({
              defaultProfile: "main",
              profiles: {
                main: { keyId: KEY_ID, issuerId: ISSUER },
                ci: { keyId: "ZZZZZ99999", issuerId: ISSUER },
              },
            }),
          );
          env.ASC_PROFILE = "ci";
        },
      },
    ];
    for (const f of fixtures) {
      const s = await sandbox();
      f.setup(s);
      const { json } = await run([], s.env);
      const expected = await new ConfigStore(s.home, s.env, s.configDir).resolveAsc();
      expect(json.resolved, f.name).toMatchObject({
        keyId: expected.keyId,
        issuerId: expected.issuerId,
        privateKeyPath: expected.privateKeyPath,
        source: expected.source,
      });
      expect(json.ready, f.name).toBe(true);
    }
  });

  it("plan changes nothing; apply installs the key, shell block and profile, and is idempotent", async () => {
    const { home, configDir, env } = await sandbox();
    const download = writeKey(join(home, "Downloads", `AuthKey_${KEY_ID}.p8`), ecPem(), 0o644);
    writeFileSync(join(home, ".zshrc"), "export PATH=/opt/bin:$PATH\n");
    const args = ["--key-id", KEY_ID, "--issuer-id", ISSUER, "--team-id", "TEAM123456", "--p8", download];

    const before = await snapshot(home);
    const plan = await run(["plan", ...args], env);
    expect(plan.code).toBe(0);
    expect(plan.json.actions?.map((a) => a.kind)).toEqual([
      "copy_p8",
      "chmod",
      "write_shell_rc",
      "write_profile",
    ]);
    expect(await snapshot(home)).toEqual(before);

    const apply = await run(["apply", ...args], env);
    expect(apply.code).toBe(0);
    expect(apply.json.ready).toBe(true);
    expect(apply.json.actions?.every((a) => a.done)).toBe(true);
    expect(byId(apply.json, "team_id")?.status).toBe("ok");

    const installed = join(home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`);
    expect(statSync(installed).mode & 0o777).toBe(0o600);
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(download, "utf8"));
    const rc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(rc).toBe(
      [
        "export PATH=/opt/bin:$PATH",
        "",
        "# >>> notarize setup >>>",
        "# App Store Connect API key for notarize-mcp, xcodebuild and altool. Managed by the notarize setup skill.",
        `export ASC_KEY_ID="${KEY_ID}"`,
        `export ASC_ISSUER_ID="${ISSUER}"`,
        `export ASC_PRIVATE_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"`,
        "# <<< notarize setup <<<",
        "",
      ].join("\n"),
    );
    const cfgPath = join(configDir, "config.json");
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toEqual({
      defaultProfile: "default",
      profiles: {
        default: { keyId: KEY_ID, issuerId: ISSUER, privateKeyPath: installed, teamId: "TEAM123456" },
      },
    });
    // The MCP server's own resolver sees the new profile without any env vars.
    const creds = await new ConfigStore(home, { HOME: home }, configDir).resolveAsc();
    expect(creds).toMatchObject({
      keyId: KEY_ID,
      issuerId: ISSUER,
      privateKeyPath: installed,
      teamId: "TEAM123456",
    });

    const again = await run(["apply", ...args], env);
    expect(again.json.actions).toEqual([]);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(rc);

    // A changed issuer replaces the block in place rather than appending a second one.
    const other = "11111111-2222-4333-8444-555555555555";
    await run(["apply", "--key-id", KEY_ID, "--issuer-id", other], env);
    const rc2 = readFileSync(join(home, ".zshrc"), "utf8");
    expect(rc2.match(/>>> notarize setup/g)).toHaveLength(1);
    expect(rc2).toContain(other);
  });

  it("leaves hand-written matching exports alone and flags ones that differ", async () => {
    const { home, configDir, env } = await sandbox();
    writeKey(join(home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`));
    const rcPath = join(home, ".zshrc");
    const handWritten = [
      "export PATH=/opt/bin:$PATH",
      `export ASC_KEY_ID="${KEY_ID}"`,
      `export ASC_ISSUER_ID=${ISSUER}`,
      `export ASC_PRIVATE_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"`,
      "",
    ].join("\n");
    writeFileSync(rcPath, handWritten);
    const args = ["--key-id", KEY_ID, "--issuer-id", ISSUER];

    const apply = await run(["apply", ...args], env);
    expect(apply.json.actions?.map((a) => a.kind)).toEqual(["write_profile"]);
    expect(apply.json.next_steps?.[0]).toMatch(/already exports matching ASC_\* variables/);
    expect(readFileSync(rcPath, "utf8")).toBe(handWritten);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).profiles.default.keyId).toBe(
      KEY_ID,
    );

    const other = "11111111-2222-4333-8444-555555555555";
    const plan = await run(["plan", "--key-id", KEY_ID, "--issuer-id", other], env);
    expect(plan.json.actions?.map((a) => a.kind)).toContain("write_shell_rc");
    expect(plan.json.next_steps?.[0]).toMatch(
      /also sets ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH outside/,
    );
  });

  it("refuses bad input with exit 2 and never overwrites a different installed key", async () => {
    const { home, env } = await sandbox();
    expect((await run(["plan", "--key-id", "short", "--issuer-id", ISSUER], env)).code).toBe(2);
    expect((await run(["frobnicate"], env)).code).toBe(2);
    writeKey(join(home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`));
    const other = writeKey(join(home, "other.p8"));
    const r = await run(["apply", "--key-id", KEY_ID, "--issuer-id", ISSUER, "--p8", other], env);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatch(/refusing to overwrite/);
  });

  it("reports the notarytool keychain profile like ConfigStore.notaryProfile and validates it --online", async () => {
    const s = await sandbox();
    mkdirSync(s.configDir, { recursive: true });
    writeFileSync(
      join(s.configDir, "config.json"),
      JSON.stringify({ defaultProfile: "main", profiles: { main: { notaryKeychainProfile: "app-notary" } } }),
    );
    const offline = await run([], s.env);
    const expected = await new ConfigStore(s.home, s.env, s.configDir).notaryProfile();
    expect(offline.json.resolved?.notaryKeychainProfile).toBe(expected);
    expect(byId(offline.json, "notary_profile")?.message).toMatch(/app-notary.*--online/);

    s.env.NOTARY_KEYCHAIN_PROFILE = "from-env";
    const fromEnv = await run([], s.env);
    expect(fromEnv.json.resolved?.notaryKeychainProfile).toBe(
      await new ConfigStore(s.home, s.env, s.configDir).notaryProfile(),
    );
    delete s.env.NOTARY_KEYCHAIN_PROFILE;

    // A fake xcrun on PATH: logs its argv, fails when FAKE_XCRUN_FAIL is set.
    const bin = join(s.home, "bin");
    const log = join(s.home, "xcrun.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "xcrun"),
      `#!/bin/sh\necho "$@" >> "${log}"\nif [ -n "$FAKE_XCRUN_FAIL" ]; then echo "Error: No Keychain password item found for profile" >&2; exit 69; fi\necho '{"history":[]}'\n`,
    );
    chmodSync(join(bin, "xcrun"), 0o755);
    s.env.PATH = `${bin}:${process.env.PATH}`;
    const good = await run(["--online"], s.env);
    expect(byId(good.json, "notary_profile")).toMatchObject({ status: "ok" });
    expect(readFileSync(log, "utf8")).toContain("notarytool history --keychain-profile app-notary");

    s.env.FAKE_XCRUN_FAIL = "1";
    const bad = await run(["--online"], s.env);
    expect(byId(bad.json, "notary_profile")).toMatchObject({ status: "warn" });
    expect(byId(bad.json, "notary_profile")?.message).toMatch(/No Keychain password item/);
    expect(byId(bad.json, "notary_profile")?.fix).toMatch(/store_credentials profile_name=app-notary/);
  });

  it("--online signs an ES256 JWT and maps HTTP status codes", async () => {
    const { home, env } = await sandbox();
    const pem = ecPem();
    writeKey(join(home, ".appstoreconnect", "private_keys", `AuthKey_${KEY_ID}.p8`), pem);
    let status = 200;
    let auth = "";
    const server = createServer((req, res) => {
      auth = req.headers.authorization ?? "";
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 403 ? '{"errors":[{"detail":"A required agreement is missing"}]}' : '{"data":[]}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    Object.assign(env, {
      ASC_KEY_ID: KEY_ID,
      ASC_ISSUER_ID: ISSUER,
      NOTARIZE_SETUP_ASC_BASE_URL: `http://127.0.0.1:${port}`,
    });
    try {
      const ok = await run(["--online"], env);
      expect(byId(ok.json, "asc_online")?.status).toBe("ok");
      const [h, p, sig] = auth.replace(/^Bearer /, "").split(".");
      expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
        alg: "ES256",
        kid: KEY_ID,
        typ: "JWT",
      });
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      expect(claims).toMatchObject({ iss: ISSUER, aud: "appstoreconnect-v1" });
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(1200);
      const valid = verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" },
        Buffer.from(sig, "base64url"),
      );
      expect(valid).toBe(true);

      status = 401;
      expect(byId((await run(["--online"], env)).json, "asc_online")?.message).toMatch(/401/);
      status = 403;
      const forbidden = await run(["--online"], env);
      expect(forbidden.code).toBe(1);
      expect(byId(forbidden.json, "asc_online")?.message).toMatch(/agreement/);
    } finally {
      server.close();
    }
  });
});
