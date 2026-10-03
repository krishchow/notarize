import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { cmdStep, type PlanStep } from "../core/confirm";
import { ok, output } from "../core/exec";
import { requireMacOS } from "../core/platform";
import { ToolError } from "../core/result";
import { APPLE_INTERMEDIATES } from "../knowledge/certificate-types";
import { derToPem, describeCertificate } from "../parsers/x509";
import { pathExists, resolveUserPath, scratchDir } from "./shared";
import { defineTool, type ToolContext, withConfirmation } from "./types";

export function loginKeychain(home: string): string {
  return join(home, "Library", "Keychains", "login.keychain-db");
}

/** Apps allowed to use imported private keys without a prompt. */
const TRUSTED_APPS = [
  "/usr/bin/codesign",
  "/usr/bin/productsign",
  "/usr/bin/productbuild",
  "/usr/bin/pkgbuild",
  "/usr/bin/security",
];

/** Legacy-compatible PKCS#12 encryption: macOS `security import` rejects OpenSSL 3 defaults. */
const P12_COMPAT = ["-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1"];

function readSecretEnv(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const v = process.env[name];
  if (!v) throw new ToolError(`Environment variable ${name} is not set in the MCP server's environment.`);
  return v;
}

/** Normalise a certificate file (DER .cer or PEM) to PEM text. */
export async function certToPem(path: string): Promise<string> {
  const buf = await readFile(path);
  const text = buf.toString("latin1");
  return text.includes("-----BEGIN CERTIFICATE-----") ? text : derToPem(new Uint8Array(buf));
}

/** Build a temporary .p12 from key + cert and import it into a keychain. */
export async function importKeyAndCert(
  ctx: ToolContext,
  keyPath: string,
  certPem: string,
  keychain: string,
): Promise<{ identity?: string; logPath?: string }> {
  const dir = await scratchDir("p12");
  const certPath = join(dir, "cert.pem");
  const p12 = join(dir, "identity.p12");
  const pass = randomBytes(18).toString("base64url");
  await writeFile(certPath, certPem, { mode: 0o600 });
  try {
    const exp = await ctx.runner.run(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-inkey",
        keyPath,
        "-in",
        certPath,
        "-out",
        p12,
        "-passout",
        "env:NOTARIZE_P12_PASS",
        ...P12_COMPAT,
      ],
      { env: { NOTARIZE_P12_PASS: pass }, timeoutMs: 30000, secrets: [pass] },
    );
    if (!ok(exp)) throw new ToolError(`openssl pkcs12 failed: ${output(exp)}`);
    const imp = await ctx.runner.run(
      "security",
      ["import", p12, "-k", keychain, "-f", "pkcs12", "-P", pass, ...TRUSTED_APPS.flatMap((a) => ["-T", a])],
      { timeoutMs: 60000, secrets: [pass], logName: "security-import" },
    );
    if (!ok(imp) && !/already exists/i.test(output(imp)))
      throw new ToolError(`security import failed: ${output(imp)}`);
    let identity: string | undefined;
    try {
      identity = describeCertificate(certPem).commonName;
    } catch {
      /* ignore */
    }
    return { identity, logPath: imp.logPath };
  } finally {
    await unlink(p12).catch(() => {});
    await unlink(certPath).catch(() => {});
  }
}

export const keychainTool = defineTool({
  name: "keychain",
  title: "Create CSRs and manage signing identities in the keychain",
  description:
    "action=create_csr (confirm): generate an RSA-2048 private key (stored 0600 in ~/.config/notarize-mcp/keys) and a Certificate Signing Request to upload to Apple (asc_certificates create, or the developer portal for Developer ID). action=import_certificate (confirm): pair a downloaded .cer with that private key and import the identity into the login keychain, pre-authorizing codesign/productsign. action=import_p12 (confirm): import an existing .p12 (password via password_env). action=install_intermediates (confirm): download and import Apple's WWDR G3 and Developer ID G2 intermediate certificates (fixes 'unable to build chain' / errSecInternalComponent). action=export_p12 (confirm): export a key generated here + its certificate as a .p12 (+ base64) for CI secrets.",
  mutating: true,
  input: {
    action: z.enum(["create_csr", "import_certificate", "import_p12", "install_intermediates", "export_p12"]),
    key_name: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional()
      .describe("Name for the generated key/CSR (create_csr/import_certificate/export_p12)."),
    common_name: z
      .string()
      .optional()
      .describe("create_csr: your name or company (Apple replaces it with your team name)."),
    email: z.string().optional().describe("create_csr: your Apple Developer account email."),
    country: z.string().length(2).optional().describe("create_csr: 2-letter country code (default US)."),
    certificate_path: z
      .string()
      .optional()
      .describe("import_certificate/export_p12: .cer (DER) or .pem certificate from Apple."),
    p12_path: z.string().optional().describe("import_p12: the .p12 file."),
    password_env: z
      .string()
      .optional()
      .describe(
        "Name of an environment variable (in the MCP server's env) holding the .p12 password — keeps secrets out of the conversation.",
      ),
    keychain: z.string().optional().describe("Target keychain (default login keychain)."),
    output_path: z.string().optional().describe("export_p12: where to write the .p12."),
  },
  async handler(args, ctx, extra) {
    const keysDir = ctx.config.keysDir;
    const keychain = args.keychain
      ? await resolveUserPath(ctx, args.keychain, false)
      : loginKeychain(ctx.platform.homeDir);

    if (args.action === "create_csr") {
      const name = args.key_name ?? `signing-${ctx.now().toISOString().slice(0, 10)}`;
      const keyPath = join(keysDir, `${name}.key`);
      const csrPath = join(keysDir, `${name}.csr`);
      if (await pathExists(keyPath))
        throw new ToolError(`A key named ${name} already exists at ${keyPath}. Choose another key_name.`);
      const subjParts = [
        args.email && `emailAddress=${args.email}`,
        `CN=${args.common_name ?? "Apple Developer"}`,
        `C=${args.country ?? "US"}`,
      ].filter(Boolean);
      const subj = `/${subjParts.map((p) => (p as string).replace(/\//g, "\\/")).join("/")}`;
      const cmd = [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        csrPath,
        "-subj",
        subj,
      ];
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: "Create a private key and Certificate Signing Request",
          steps: [
            cmdStep("Generate RSA-2048 key + CSR", "openssl", cmd),
            { description: `Restrict ${keyPath} to mode 0600` },
          ],
          notes: [
            "The private key never leaves this Mac. Back it up (export_p12) once the certificate is issued — Apple cannot re-issue it.",
          ],
        }),
        async () => {
          await mkdir(keysDir, { recursive: true, mode: 0o700 });
          const r = await ctx.runner.run("openssl", cmd, { timeoutMs: 60000 });
          if (!ok(r)) throw new ToolError(`openssl req failed: ${output(r)}`);
          await chmod(keyPath, 0o600).catch(() => {});
          const csr = await readFile(csrPath, "utf8");
          return {
            summary: `Created key ${keyPath} and CSR ${csrPath}.`,
            data: { keyName: name, keyPath, csrPath, csrPem: csr },
            next_steps: [
              `asc_certificates action=create certificate_type=<DISTRIBUTION|DEVELOPMENT|MAC_INSTALLER_DISTRIBUTION|DEVELOPER_ID_APPLICATION_G2> csr_path=${csrPath} key_name=${name}`,
              "Developer ID certificates usually require the Account Holder in the web portal: developer.apple.com/account/resources/certificates/add → upload this .csr → download the .cer → keychain action=import_certificate",
            ],
          };
        },
      );
    }

    if (args.action === "import_certificate") {
      requireMacOS(ctx.platform, "Keychain import");
      if (!args.certificate_path || !args.key_name)
        throw new ToolError("certificate_path and key_name are required.");
      const certPath = await resolveUserPath(ctx, args.certificate_path);
      const keyPath = join(keysDir, `${args.key_name}.key`);
      if (!(await pathExists(keyPath)))
        throw new ToolError(
          `No key ${keyPath}. It must be the key used to create the CSR for this certificate.`,
        );
      const pem = await certToPem(certPath);
      const cert = describeCertificate(pem, ctx.now());
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Import "${cert.commonName}" into ${basename(keychain)}`,
          steps: [
            {
              description: `Bundle ${basename(keyPath)} + ${basename(certPath)} into a temporary .p12 (openssl)`,
            },
            { description: `security import → ${keychain}, trusting ${TRUSTED_APPS.join(", ")}` },
            { description: "Delete the temporary .p12" },
          ],
          notes: [
            `Certificate: ${cert.commonName} (team ${cert.teamId ?? "?"}), expires ${cert.validTo.slice(0, 10)}`,
          ],
        }),
        async () => {
          const res = await importKeyAndCert(ctx, keyPath, pem, keychain);
          return {
            summary: `Imported identity "${res.identity ?? cert.commonName}" into ${keychain}.`,
            data: { identity: res.identity, sha1: cert.sha1, keychain },
            next_steps: [
              "signing_identities to confirm it is valid",
              "keychain action=export_p12 to back it up / use in CI",
            ],
          };
        },
      );
    }

    if (args.action === "import_p12") {
      requireMacOS(ctx.platform, "Keychain import");
      if (!args.p12_path) throw new ToolError("p12_path is required.");
      const p12 = await resolveUserPath(ctx, args.p12_path);
      const password = readSecretEnv(args.password_env) ?? "";
      const cmd = [
        "import",
        p12,
        "-k",
        keychain,
        "-f",
        "pkcs12",
        "-P",
        password,
        ...TRUSTED_APPS.flatMap((a) => ["-T", a]),
      ];
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Import ${basename(p12)} into ${basename(keychain)}`,
          steps: [cmdStep("security import", "security", cmd, [password])],
        }),
        async () => {
          const r = await ctx.runner.run("security", cmd, { timeoutMs: 60000, secrets: [password] });
          if (!ok(r) && !/already exists/i.test(output(r)))
            throw new ToolError(`security import failed: ${output(r)}`);
          return {
            summary: `Imported ${basename(p12)}.`,
            data: { keychain },
            next_steps: ["signing_identities"],
          };
        },
      );
    }

    if (args.action === "install_intermediates") {
      requireMacOS(ctx.platform, "Keychain import");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: "Install Apple intermediate certificates",
          steps: APPLE_INTERMEDIATES.map((i) => ({
            description: `Download ${i.url} and import into ${basename(keychain)}`,
          })),
        }),
        async () => {
          const dir = await scratchDir("intermediates");
          const results = [];
          for (const im of APPLE_INTERMEDIATES) {
            const res = await ctx.fetch(im.url);
            if (!res.ok) {
              results.push({ name: im.name, ok: false, error: `HTTP ${res.status}` });
              continue;
            }
            const file = join(dir, basename(im.url));
            await writeFile(file, new Uint8Array(await res.arrayBuffer()));
            const r = await ctx.runner.run("security", ["import", file, "-k", keychain], {
              timeoutMs: 30000,
            });
            results.push({
              name: im.name,
              ok: ok(r) || /already exists/i.test(output(r)),
              detail: output(r).slice(0, 200),
            });
          }
          return {
            summary: results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}`).join("\n"),
            data: { results },
          };
        },
      );
    }

    // export_p12
    if (!args.key_name || !args.certificate_path || !args.output_path)
      throw new ToolError("key_name, certificate_path and output_path are required.");
    const keyPath = join(keysDir, `${args.key_name}.key`);
    if (!(await pathExists(keyPath))) throw new ToolError(`No key ${keyPath}.`);
    const certPath = await resolveUserPath(ctx, args.certificate_path);
    const out = await resolveUserPath(ctx, args.output_path, false);
    const steps: PlanStep[] = [
      { description: `openssl pkcs12 -export ${basename(keyPath)} + ${basename(certPath)} → ${out}` },
      { description: `Write base64 copy to ${out}.base64 (for CI secrets)` },
    ];
    if (!args.password_env)
      steps.push({ description: `Generate a random password and save it to ${out}.password (0600)` });
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Export ${args.key_name} as .p12`,
        steps,
        warnings: [
          "The .p12 contains your private key — store it as a CI secret and delete local copies you don't need.",
        ],
      }),
      async () => {
        const password = readSecretEnv(args.password_env) ?? randomBytes(18).toString("base64url");
        const pemPath = join(await scratchDir("export"), "cert.pem");
        await writeFile(pemPath, await certToPem(certPath), { mode: 0o600 });
        const r = await ctx.runner.run(
          "openssl",
          [
            "pkcs12",
            "-export",
            "-inkey",
            keyPath,
            "-in",
            pemPath,
            "-out",
            out,
            "-passout",
            "env:NOTARIZE_P12_PASS",
            ...P12_COMPAT,
          ],
          { env: { NOTARIZE_P12_PASS: password }, timeoutMs: 30000, secrets: [password] },
        );
        await unlink(pemPath).catch(() => {});
        if (!ok(r)) throw new ToolError(`openssl pkcs12 failed: ${output(r)}`);
        await chmod(out, 0o600).catch(() => {});
        await writeFile(`${out}.base64`, (await readFile(out)).toString("base64"), { mode: 0o600 });
        if (!args.password_env) await writeFile(`${out}.password`, password, { mode: 0o600 });
        return {
          summary: `Exported ${out} (+ ${out}.base64${args.password_env ? "" : `, password in ${out}.password`}).`,
          data: {
            p12: out,
            base64: `${out}.base64`,
            passwordFile: args.password_env ? undefined : `${out}.password`,
          },
          next_steps: ["ci_config to generate a workflow that imports it from secrets"],
        };
      },
    );
  },
});
