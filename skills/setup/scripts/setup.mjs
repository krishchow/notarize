#!/usr/bin/env node
// notarize setup — check (and with `apply`, create) the App Store Connect credential state
// every other notarize skill assumes. Zero dependencies: Node >= 20 builtins only, no shell.
//
//   node setup.mjs [check] [--online] [--profile NAME] [--individual-key] [--pretty]
//   node setup.mjs plan  [--key-id ID] [--issuer-id UUID] [--team-id ID] [--p8 PATH] [--shell-rc PATH] [--profile NAME]
//   node setup.mjs apply <same arguments as plan>
//
// plan/apply may omit --key-id when exactly one AuthKey_<ID>.p8 is already installed in a search directory.
//
// Prints one JSON object on stdout (schema 1). Exit codes: 0 ready / applied, 1 not ready, 2 usage error.
// Never prints key material. Credential resolution mirrors ConfigStore.resolveAsc in src/core/config.ts.

import { execFileSync } from "node:child_process";
import { constants, createPrivateKey, sign } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const SCHEMA = 1;
const KEY_ID_RE = /^[A-Z0-9]{10}$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCK_START = "# >>> notarize setup >>>";
const BLOCK_END = "# <<< notarize setup <<<";
const ASC_BASE_URL = process.env.NOTARIZE_SETUP_ASC_BASE_URL || "https://api.appstoreconnect.apple.com";
const CREATE_KEY_FIX =
  "Create a Team key: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → + (role Admin or App Manager); download the .p8 (only once), then run `setup.mjs plan --key-id … --issuer-id … --p8 <path>`.";

class UsageError extends Error {}

// ------------------------------------------------------------------ args

function parseArgs(argv) {
  const opts = { command: "check", flags: {} };
  const valued = new Set(["key-id", "issuer-id", "team-id", "p8", "shell-rc", "profile"]);
  const bool = new Set(["online", "pretty", "individual-key", "help"]);
  let i = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    opts.command = argv[0];
    i = 1;
  }
  if (!["check", "plan", "apply"].includes(opts.command))
    throw new UsageError(`Unknown command "${opts.command}".`);
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`Unexpected argument "${a}".`);
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    if (bool.has(name)) opts.flags[name] = true;
    else if (valued.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "") throw new UsageError(`--${name} needs a value.`);
      opts.flags[name] = v;
    } else throw new UsageError(`Unknown option --${name}.`);
  }
  return opts;
}

// ------------------------------------------------------------------ environment

function makeEnv(env = process.env) {
  const home = env.HOME || homedir();
  const configDir =
    env.NOTARIZE_MCP_CONFIG_DIR || join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "notarize-mcp");
  return {
    env,
    home,
    configDir,
    configPath: join(configDir, "config.json"),
    defaultKeyDir: join(home, ".appstoreconnect", "private_keys"),
  };
}

function expandHome(p, home) {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function readConfig(ctx) {
  if (!existsSync(ctx.configPath)) return { exists: false, cfg: { profiles: {} } };
  try {
    const raw = JSON.parse(readFileSync(ctx.configPath, "utf8"));
    return { exists: true, cfg: { defaultProfile: raw.defaultProfile, profiles: raw.profiles ?? {} } };
  } catch (e) {
    return { exists: true, invalid: e.message, cfg: { profiles: {} } };
  }
}

/** Same search order as ConfigStore.p8SearchDirs(). */
function p8SearchDirs(ctx) {
  return [
    ctx.defaultKeyDir,
    join(ctx.home, "private_keys"),
    join(ctx.home, ".private_keys"),
    join(ctx.configDir, "keys"),
  ];
}

function discoverP8(ctx, keyId) {
  for (const dir of p8SearchDirs(ctx)) {
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const match = files.find((f) => (keyId ? f === `AuthKey_${keyId}.p8` : /^AuthKey_.+\.p8$/.test(f)));
    if (match) return join(dir, match);
  }
  return undefined;
}

/** Same as ConfigStore.listDiscoveredP8(): every AuthKey_<id>.p8 in the search dirs, one per Key ID. */
function listDiscoveredP8(ctx) {
  const out = [];
  for (const dir of p8SearchDirs(ctx)) {
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      const m = /^AuthKey_(.+)\.p8$/.exec(f);
      if (m && KEY_ID_RE.test(m[1]) && !out.some((k) => k.keyId === m[1]))
        out.push({ keyId: m[1], path: join(dir, f) });
    }
  }
  return out;
}

function describeFound(found) {
  return found.map((k) => `${basename(k.path)} in ${dirname(k.path)}`).join(", ");
}

/** Mirrors ConfigStore.resolveAsc(profileName) without throwing. */
function resolveCredentials(ctx, profileName) {
  const { cfg } = readConfig(ctx);
  const env = ctx.env;
  const name = profileName ?? env.ASC_PROFILE ?? cfg.defaultProfile;
  if (profileName && !cfg.profiles[profileName]) {
    return { error: `No credential profile named "${profileName}" in ${ctx.configPath}.`, source: "none" };
  }
  const profile = (name && cfg.profiles[name]) || {};
  const useEnv = !profileName;
  const keyId = (useEnv && env.ASC_KEY_ID) || profile.keyId;
  const issuerId = (useEnv && env.ASC_ISSUER_ID) || profile.issuerId;
  const inlineKey = useEnv ? env.ASC_PRIVATE_KEY : undefined;
  let privateKeyPath = (useEnv && env.ASC_PRIVATE_KEY_PATH) || profile.privateKeyPath;
  const source =
    useEnv && env.ASC_KEY_ID ? "environment" : name ? `profile "${name}" (${ctx.configPath})` : "none";
  let discovered = false;
  if (keyId && !inlineKey && !privateKeyPath) {
    privateKeyPath = discoverP8(ctx, keyId);
    discovered = Boolean(privateKeyPath);
  }
  return {
    keyId: keyId || undefined,
    issuerId: issuerId || undefined,
    privateKeyPath: inlineKey ? undefined : privateKeyPath,
    inlineKey: Boolean(inlineKey),
    discovered,
    source,
    profileName: name,
    profile,
  };
}

/** Loads a PEM (from a path or ASC_PRIVATE_KEY) and checks it is an EC P-256 private key. */
function loadKey(pemOrPath, ctx, { inline = false } = {}) {
  let pem;
  if (inline) {
    pem = pemOrPath.includes("BEGIN") ? pemOrPath : Buffer.from(pemOrPath, "base64").toString("utf8");
  } else {
    try {
      pem = readFileSync(expandHome(pemOrPath, ctx.home), "utf8");
    } catch (e) {
      return { error: `Cannot read ${pemOrPath}: ${e.code ?? e.message}` };
    }
  }
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    return {
      error: "Not a valid PEM private key (expected the AuthKey_<KEYID>.p8 file from App Store Connect).",
    };
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    return {
      error: `Key is ${key.asymmetricKeyType} ${key.asymmetricKeyDetails?.namedCurve ?? ""}, not EC P-256.`,
    };
  }
  return { key };
}

// ------------------------------------------------------------------ shell rc

function shellKind(ctx) {
  const sh = basename(ctx.env.SHELL || "zsh");
  return sh === "bash" || sh === "fish" ? sh : "zsh";
}

function rcCandidates(ctx) {
  const h = ctx.home;
  switch (shellKind(ctx)) {
    case "bash":
      return [join(h, ".bash_profile"), join(h, ".bashrc"), join(h, ".profile")];
    case "fish":
      return [join(h, ".config", "fish", "config.fish")];
    default:
      return [join(h, ".zshrc"), join(h, ".zshenv"), join(h, ".zprofile")];
  }
}

function defaultRcFile(ctx, flag) {
  if (flag) return resolve(expandHome(flag, ctx.home));
  const kind = shellKind(ctx);
  if (kind === "bash") return join(ctx.home, process.platform === "darwin" ? ".bash_profile" : ".bashrc");
  return rcCandidates(ctx)[0];
}

function findPersistedShell(ctx) {
  const re = /^\s*(?:export\s+ASC_KEY_ID=|set\s+-gx\s+ASC_KEY_ID\s)/m;
  for (const f of rcCandidates(ctx)) {
    try {
      if (re.test(readFileSync(f, "utf8"))) return f;
    } catch {
      /* missing file */
    }
  }
  return undefined;
}

/** ASC_* exports written outside the managed block (by hand), with $HOME / ~ expanded. */
function unmanagedExports(content, ctx) {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  const outside =
    start !== -1 && end > start ? content.slice(0, start) + content.slice(end + BLOCK_END.length) : content;
  const re = /^\s*(?:export\s+(ASC_[A-Z_]+)=|set\s+-gx\s+(ASC_[A-Z_]+)\s+)(.*?)\s*$/gm;
  const found = {};
  for (const m of outside.matchAll(re)) {
    const v = m[3].replace(/^(["'])(.*)\1$/, "$2");
    found[m[1] ?? m[2]] = v.replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/)/, ctx.home);
  }
  return found;
}

function shellQuote(value, ctx) {
  // Values are validated IDs or paths; render paths under $HOME portably.
  const v = value.startsWith(`${ctx.home}/`) ? `$HOME/${value.slice(ctx.home.length + 1)}` : value;
  return `"${v.replace(/(["\\`])/g, "\\$1").replace(/\$(?!HOME\/)/g, "\\$")}"`;
}

function renderBlock(ctx, rcFile, vars) {
  const fish = rcFile.endsWith(".fish");
  const lines = [
    BLOCK_START,
    "# App Store Connect API key for notarize-mcp, xcodebuild and altool. Managed by the notarize setup skill.",
  ];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue;
    lines.push(fish ? `set -gx ${k} ${shellQuote(v, ctx)}` : `export ${k}=${shellQuote(v, ctx)}`);
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

function withBlock(content, block) {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start !== -1 && end > start) {
    return content.slice(0, start) + block + content.slice(end + BLOCK_END.length);
  }
  const sep = content === "" || content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${sep}${block}\n`;
}

// ------------------------------------------------------------------ checks

function check(id, status, message, fix) {
  return fix ? { id, status, message, fix } : { id, status, message };
}

function fileMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    }).trim();
  } catch {
    return undefined;
  }
}

async function runChecks(ctx, flags) {
  const checks = [];
  const r = resolveCredentials(ctx, flags.profile);
  const individual = Boolean(flags["individual-key"]);
  // With no Key ID configured, report keys already on disk instead of telling the user to create one.
  const found = !r.error && !r.keyId && !r.inlineKey ? listDiscoveredP8(ctx) : [];

  checks.push(
    process.platform === "darwin"
      ? check("platform", "ok", "macOS")
      : check(
          "platform",
          "warn",
          `Running on ${process.platform}: only App Store Connect API features work here.`,
          "Run on a Mac for signing and notarization.",
        ),
  );
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 20
      ? check("node_version", "ok", `Node ${process.versions.node}`)
      : check(
          "node_version",
          "fail",
          `Node ${process.versions.node} is too old.`,
          "Install Node 20 or newer.",
        ),
  );

  const cfg = readConfig(ctx);
  if (cfg.invalid) {
    checks.push(
      check(
        "config_file",
        "fail",
        `${ctx.configPath} is not valid JSON (${cfg.invalid}).`,
        "Fix or remove the file; setup will not overwrite it.",
      ),
    );
  }

  if (r.error) {
    checks.push(check("asc_key_id", "fail", r.error, "Pick an existing profile or omit --profile."));
  } else if (!r.keyId && found.length === 1) {
    checks.push(
      check(
        "asc_key_id",
        "fail",
        `No App Store Connect API Key ID configured, but ${describeFound(found)} is already installed (Key ID ${found[0].keyId}).`,
        `Confirm ${found[0].keyId} is the key to use, then run \`setup.mjs plan --key-id ${found[0].keyId} --issuer-id … --team-id …\`; no --p8 is needed.`,
      ),
    );
  } else if (!r.keyId && found.length > 1) {
    checks.push(
      check(
        "asc_key_id",
        "fail",
        `No App Store Connect API Key ID configured; several keys are installed: ${describeFound(found)}.`,
        `Ask which key to use, then run \`setup.mjs plan --key-id <one of ${found.map((k) => k.keyId).join(", ")}> --issuer-id … --team-id …\`; no --p8 is needed.`,
      ),
    );
  } else if (!r.keyId) {
    checks.push(check("asc_key_id", "fail", "No App Store Connect API Key ID configured.", CREATE_KEY_FIX));
  } else if (!KEY_ID_RE.test(r.keyId)) {
    checks.push(
      check(
        "asc_key_id",
        "fail",
        `Key ID "${r.keyId}" is not 10 upper-case letters/digits (from ${r.source}).`,
        "Copy the Key ID column from App Store Connect → Integrations → App Store Connect API.",
      ),
    );
  } else {
    checks.push(check("asc_key_id", "ok", `Key ID ${r.keyId} (from ${r.source})`));
  }

  if (r.issuerId && !UUID_RE.test(r.issuerId)) {
    checks.push(
      check(
        "asc_issuer_id",
        "fail",
        `Issuer ID "${r.issuerId}" is not a UUID.`,
        "Copy the Issuer ID shown above the Team Keys table.",
      ),
    );
  } else if (r.issuerId) {
    checks.push(check("asc_issuer_id", "ok", `Issuer ID ${r.issuerId}`));
  } else if (individual) {
    checks.push(check("asc_issuer_id", "ok", "No Issuer ID (individual key)."));
  } else {
    checks.push(
      check(
        "asc_issuer_id",
        "fail",
        "No Issuer ID configured. Team keys need it.",
        "Copy the Issuer ID shown above the Team Keys table (App Store Connect → Integrations → App Store Connect API). For an individual key pass --individual-key.",
      ),
    );
  }

  let key;
  if (r.inlineKey) {
    checks.push(check("p8_path", "ok", "Private key provided inline via ASC_PRIVATE_KEY (CI)."));
    const loaded = loadKey(ctx.env.ASC_PRIVATE_KEY, ctx, { inline: true });
    if (loaded.error) checks.push(check("p8_readable", "fail", `ASC_PRIVATE_KEY: ${loaded.error}`));
    else {
      key = loaded.key;
      checks.push(check("p8_readable", "ok", "ASC_PRIVATE_KEY is an EC P-256 private key."));
    }
  } else if (!r.keyId && found.length) {
    checks.push(
      check("p8_path", "warn", `Found ${describeFound(found)}; not used until its Key ID is configured.`),
    );
  } else if (!r.keyId) {
    checks.push(
      check(
        "p8_path",
        "fail",
        `No Key ID, and no AuthKey_*.p8 in ${p8SearchDirs(ctx).join(", ")}.`,
        CREATE_KEY_FIX,
      ),
    );
  } else if (!r.privateKeyPath) {
    checks.push(
      check(
        "p8_path",
        "fail",
        `No AuthKey_${r.keyId}.p8 found (searched ${p8SearchDirs(ctx).join(", ")}).`,
        `Run \`setup.mjs plan --p8 <path to downloaded AuthKey_${r.keyId}.p8>\` to install it into ${ctx.defaultKeyDir}.`,
      ),
    );
  } else {
    const path = expandHome(r.privateKeyPath, ctx.home);
    checks.push(check("p8_path", "ok", `${path}${r.discovered ? " (found in a default directory)" : ""}`));
    const loaded = loadKey(path, ctx);
    if (loaded.error) checks.push(check("p8_readable", "fail", loaded.error, CREATE_KEY_FIX));
    else {
      key = loaded.key;
      checks.push(check("p8_readable", "ok", "EC P-256 private key."));
    }
    const mode = fileMode(path);
    if (mode !== undefined) {
      checks.push(
        mode & 0o077
          ? check(
              "p8_mode",
              "warn",
              `Mode ${mode.toString(8)} lets other users read the key.`,
              `chmod 600 "${path}" (or run \`setup.mjs apply\`).`,
            )
          : check("p8_mode", "ok", `Mode ${mode.toString(8)}`),
      );
    }
    const expected = `AuthKey_${r.keyId}.p8`;
    if (basename(path) !== expected) {
      checks.push(
        check(
          "p8_filename",
          "warn",
          `File is named ${basename(path)}, not ${expected}; xcodebuild/altool find keys by that name.`,
          `Run \`setup.mjs apply --p8 "${path}"\` to install a copy as ${join(ctx.defaultKeyDir, expected)}.`,
        ),
      );
    }
  }

  const teamId = r.profile?.teamId;
  checks.push(
    !teamId
      ? check(
          "team_id",
          "warn",
          "No Team ID saved; archives and checklists will ask for it.",
          "Find it at developer.apple.com → Account → Membership details, then run `setup.mjs apply --team-id <ID>`.",
        )
      : TEAM_ID_RE.test(teamId)
        ? check("team_id", "ok", `Team ID ${teamId}`)
        : check("team_id", "warn", `Team ID "${teamId}" is not 10 upper-case letters/digits.`),
  );

  const rc = findPersistedShell(ctx);
  checks.push(
    rc
      ? check("persisted_shell", "ok", `ASC_KEY_ID is exported in ${rc}.`)
      : check(
          "persisted_shell",
          "warn",
          `ASC_* variables are not exported in ${rcCandidates(ctx)[0]}; new shells, xcodebuild and altool won't see them.`,
          "Run `setup.mjs plan` then `setup.mjs apply`.",
        ),
  );

  const saved = r.profileName ? cfg.cfg.profiles[r.profileName] : undefined;
  if (!saved?.keyId) {
    checks.push(
      check(
        "persisted_profile",
        "warn",
        `No notarize-mcp profile in ${ctx.configPath}; the running MCP server only sees env vars it started with.`,
        "Run `setup.mjs plan` then `setup.mjs apply` (no restart needed afterwards).",
      ),
    );
  } else if (r.keyId && saved.keyId !== r.keyId) {
    checks.push(
      check(
        "persisted_profile",
        "warn",
        `Profile "${r.profileName}" holds key ${saved.keyId} but the environment uses ${r.keyId}.`,
        "Run `setup.mjs apply` to update the profile.",
      ),
    );
  } else {
    checks.push(check("persisted_profile", "ok", `Profile "${r.profileName}" in ${ctx.configPath}`));
  }

  if (process.platform === "darwin") {
    const devDir = tryRun("xcode-select", ["-p"]);
    const notary = devDir ? tryRun("xcrun", ["notarytool", "--version"]) : undefined;
    checks.push(
      devDir && notary
        ? check("xcode_tools", "ok", `${devDir}; notarytool ${notary}`)
        : check(
            "xcode_tools",
            "warn",
            devDir ? "notarytool not available." : "No developer tools selected.",
            "Install Xcode, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. The notarize doctor tool gives details.",
          ),
    );
  }

  if (flags.online) {
    if (!key || !r.keyId || (!r.issuerId && !individual)) {
      checks.push(check("asc_online", "fail", "Skipped: fix the failing credential checks first."));
    } else {
      checks.push(await onlineCheck(r.keyId, r.issuerId, key));
    }
  }

  return { checks, resolved: { ...r, ...(found.length ? { discoveredKeys: found } : {}) } };
}

// ------------------------------------------------------------------ online

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function makeJwt(keyId, issuerId, key, nowSec = Math.floor(Date.now() / 1000)) {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { ...(issuerId ? { iss: issuerId } : { sub: "user" }), iat: nowSec, exp: nowSec + 600 };
  payload.aud = "appstoreconnect-v1";
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64url(sig)}`;
}

async function onlineCheck(keyId, issuerId, key) {
  let res;
  let body = "";
  try {
    res = await fetch(`${ASC_BASE_URL}/v1/apps?limit=1`, {
      headers: { authorization: `Bearer ${makeJwt(keyId, issuerId, key)}` },
      signal: AbortSignal.timeout(20000),
    });
    body = await res.text();
  } catch (e) {
    return check(
      "asc_online",
      "fail",
      `Could not reach App Store Connect: ${e.cause?.code ?? e.message}`,
      "Check network access to api.appstoreconnect.apple.com.",
    );
  }
  if (res.ok) return check("asc_online", "ok", "Authenticated GET /v1/apps succeeded.");
  if (res.status === 401) {
    return check(
      "asc_online",
      "fail",
      "401 Unauthorized: Key ID, Issuer ID and .p8 don't match, or the key was revoked.",
      "Re-check the Key ID and Issuer ID in App Store Connect; generate a new key if it was revoked.",
    );
  }
  if (res.status === 403) {
    return /agreement/i.test(body)
      ? check(
          "asc_online",
          "fail",
          "403: an updated agreement must be accepted.",
          "The Account Holder accepts it at developer.apple.com/account and App Store Connect → Business.",
        )
      : check(
          "asc_online",
          "fail",
          "403 Forbidden: the key's role can't list apps.",
          "Use a key with the Admin or App Manager role.",
        );
  }
  return check("asc_online", "fail", `App Store Connect returned HTTP ${res.status}.`);
}

// ------------------------------------------------------------------ plan / apply

function planActions(ctx, flags) {
  const r = resolveCredentials(ctx, flags.profile);
  let keyId = flags["key-id"] ?? r.keyId;
  const issuerId = flags["issuer-id"] ?? r.issuerId;
  let inferred;
  if (!keyId && !flags.p8) {
    const found = listDiscoveredP8(ctx);
    if (found.length === 1) {
      inferred = found[0];
      keyId = inferred.keyId;
    } else if (found.length > 1) {
      throw new UsageError(
        `No Key ID: several keys are installed (${describeFound(found)}); pass --key-id to pick one.`,
      );
    }
  }
  if (!keyId)
    throw new UsageError("No Key ID: pass --key-id (the 10-character Key ID from App Store Connect).");
  if (!KEY_ID_RE.test(keyId))
    throw new UsageError(`--key-id "${keyId}" is not 10 upper-case letters/digits.`);
  if (issuerId && !UUID_RE.test(issuerId)) throw new UsageError(`--issuer-id "${issuerId}" is not a UUID.`);
  const teamId = flags["team-id"];
  if (teamId && !TEAM_ID_RE.test(teamId))
    throw new UsageError(`--team-id "${teamId}" is not 10 upper-case letters/digits.`);
  if (!issuerId && !flags["individual-key"]) {
    throw new UsageError("No Issuer ID: pass --issuer-id (or --individual-key for an individual API key).");
  }

  const cfg = readConfig(ctx);
  if (cfg.invalid) throw new UsageError(`${ctx.configPath} is not valid JSON; refusing to overwrite it.`);

  const target = join(ctx.defaultKeyDir, `AuthKey_${keyId}.p8`);
  const sourceRaw =
    flags.p8 ??
    (r.keyId === keyId ? r.privateKeyPath : undefined) ??
    inferred?.path ??
    (existsSync(target) ? target : undefined);
  if (!sourceRaw) {
    throw new UsageError(`No .p8 for ${keyId}: pass --p8 <path to the downloaded AuthKey_${keyId}.p8>.`);
  }
  const source = resolve(expandHome(sourceRaw, ctx.home));
  const loaded = loadKey(source, ctx);
  if (loaded.error) throw new UsageError(`--p8: ${loaded.error}`);

  const actions = [];
  const notes = [];
  if (source !== target) {
    if (existsSync(target)) {
      if (!readFileSync(target).equals(readFileSync(source))) {
        throw new UsageError(`${target} already exists with different contents; refusing to overwrite it.`);
      }
    } else {
      actions.push({ kind: "copy_p8", path: target, from: source, detail: `Copy ${source} → ${target}` });
    }
  }
  const mode = fileMode(target);
  if (actions.length || (mode !== undefined && mode !== 0o600)) {
    actions.push({ kind: "chmod", path: target, detail: `chmod 600 ${target} (directory 700)` });
  }

  const rcFile = defaultRcFile(ctx, flags["shell-rc"]);
  const block = renderBlock(ctx, rcFile, {
    ASC_KEY_ID: keyId,
    ASC_ISSUER_ID: issuerId,
    ASC_PRIVATE_KEY_PATH: target,
  });
  const current = existsSync(rcFile) ? readFileSync(rcFile, "utf8") : "";
  const next = withBlock(current, block);
  // Exports the user wrote by hand: leave the file alone when they already match, and say so when they don't.
  const wanted = { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId, ASC_PRIVATE_KEY_PATH: target };
  const manual = unmanagedExports(current, ctx);
  const manualKeys = Object.keys(manual).filter((k) => k in wanted);
  const manualMatches =
    !current.includes(BLOCK_START) &&
    Object.entries(wanted).every(([k, v]) => (v === undefined ? !(k in manual) : manual[k] === v));
  if (manualMatches) {
    notes.push(
      `${rcFile} already exports matching ASC_* variables (outside a notarize block); leaving it unchanged.`,
    );
  } else if (next !== current) {
    if (manualKeys.length)
      notes.push(
        `${rcFile} also sets ${manualKeys.join(", ")} outside the notarize block with different values; the block is appended after them and wins. Remove the old lines to avoid confusion.`,
      );
    actions.push({
      kind: "write_shell_rc",
      path: rcFile,
      detail: `${current.includes(BLOCK_START) ? "Update" : "Add"} the notarize setup block in ${rcFile}:\n${block}`,
      content: next,
    });
  }

  const name = flags.profile ?? r.profileName ?? "default";
  const existing = cfg.cfg.profiles[name] ?? {};
  const profile = { ...existing, keyId, privateKeyPath: target };
  if (issuerId) profile.issuerId = issuerId;
  else delete profile.issuerId;
  if (teamId) profile.teamId = teamId;
  const nextCfg = {
    ...cfg.cfg,
    defaultProfile: cfg.cfg.defaultProfile ?? name,
    profiles: { ...cfg.cfg.profiles, [name]: profile },
  };
  if (JSON.stringify(nextCfg) !== JSON.stringify(cfg.cfg)) {
    actions.push({
      kind: "write_profile",
      path: ctx.configPath,
      detail: `Save profile "${name}" (keyId ${keyId}, issuerId ${issuerId ?? "none"}${profile.teamId ? `, teamId ${profile.teamId}` : ""}, privateKeyPath ${target}) to ${ctx.configPath} (mode 600, path only)`,
      content: `${JSON.stringify(nextCfg, null, 2)}\n`,
    });
  }
  return { actions, notes, keyId, inferred, profileName: name };
}

function execute(action) {
  switch (action.kind) {
    case "copy_p8":
      mkdirSync(dirname(action.path), { recursive: true, mode: 0o700 });
      copyFileSync(action.from, action.path, constants.COPYFILE_EXCL);
      break;
    case "chmod":
      chmodSync(dirname(action.path), 0o700);
      chmodSync(action.path, 0o600);
      break;
    case "write_shell_rc":
      mkdirSync(dirname(action.path), { recursive: true });
      writeFileSync(action.path, action.content);
      break;
    case "write_profile":
      mkdirSync(dirname(action.path), { recursive: true, mode: 0o700 });
      writeFileSync(action.path, action.content, { mode: 0o600 });
      chmodSync(action.path, 0o600);
      break;
  }
}

const publicAction = ({ content: _content, ...a }) => a;

// ------------------------------------------------------------------ output

function nextSteps(command, ready, checks) {
  if (command === "plan")
    return ["Show these actions to the user; after they agree run the same command with `apply`."];
  if (ready) {
    const steps = [];
    if (!checks.some((c) => c.id === "asc_online"))
      steps.push("setup.mjs check --online (validates the key with Apple)");
    steps.push(
      "Credentials are ready: continue with the apple-distribution skill (doctor, detect_project …).",
    );
    return steps;
  }
  return [...new Set(checks.filter((c) => c.status === "fail" && c.fix).map((c) => c.fix))];
}

function render(result, pretty) {
  if (!pretty) return JSON.stringify(result, null, 2);
  const icon = { ok: "✓", warn: "!", fail: "✗" };
  const lines = [result.error ? `error: ${result.error}` : `ready: ${result.ready}`];
  for (const c of result.checks ?? [])
    lines.push(`${icon[c.status]} ${c.id}: ${c.message}${c.fix ? `\n    fix: ${c.fix}` : ""}`);
  for (const a of result.actions ?? []) lines.push(`${a.done ? "done" : "plan"} ${a.kind}: ${a.detail}`);
  for (const s of result.next_steps ?? []) lines.push(`→ ${s}`);
  return lines.join("\n");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(`${render({ schema: SCHEMA, ready: false, error: e.message }, false)}\n`);
    return 2;
  }
  const pretty = Boolean(opts.flags.pretty);
  if (opts.flags.help) {
    process.stdout.write(
      "usage: setup.mjs [check|plan|apply] [--key-id ID] [--issuer-id UUID] [--team-id ID] [--p8 PATH] [--shell-rc PATH] [--profile NAME] [--individual-key] [--online] [--pretty]\n",
    );
    return 0;
  }
  const ctx = makeEnv();
  try {
    let actions;
    const notes = [];
    if (opts.command !== "check") {
      const planned = planActions(ctx, opts.flags);
      actions = planned.actions;
      if (planned.inferred)
        notes.push(
          `Key ID ${planned.keyId} was taken from ${planned.inferred.path} (the only AuthKey_*.p8 found); confirm it is the right key.`,
        );
      notes.push(...planned.notes);
      if (opts.command === "apply") {
        for (const a of actions) {
          execute(a);
          a.done = true;
        }
        // Re-check against what was just written, not the env this process inherited.
        opts.flags.profile = planned.profileName;
      } else {
        // plan: report the current state; --profile names the profile to write, which may not exist yet.
        opts.flags.profile = undefined;
      }
    }
    const { checks, resolved } = await runChecks(ctx, opts.flags);
    const ready = checks.every((c) => c.status !== "fail");
    const result = {
      schema: SCHEMA,
      command: opts.command,
      ready,
      resolved: {
        keyId: resolved.keyId,
        issuerId: resolved.issuerId,
        privateKeyPath: resolved.privateKeyPath,
        source: resolved.source,
        profile: resolved.profileName,
        configPath: ctx.configPath,
        ...(resolved.discoveredKeys ? { discoveredKeys: resolved.discoveredKeys } : {}),
      },
      checks,
      ...(actions ? { actions: actions.map(publicAction) } : {}),
      next_steps: [...notes, ...nextSteps(opts.command, ready, checks)],
    };
    process.stdout.write(`${render(result, pretty)}\n`);
    return opts.command === "plan" || ready ? 0 : 1;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stdout.write(
      `${render({ schema: SCHEMA, command: opts.command, ready: false, error: e.message }, pretty)}\n`,
    );
    return 2;
  }
}

process.exitCode = await main();
