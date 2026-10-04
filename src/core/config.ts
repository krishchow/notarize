import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ToolError } from "./result";

/**
 * Credential + preference storage.
 *
 * Only *paths* to private keys are persisted, never key material. The file is
 * created with 0600 permissions.
 */

export interface CredentialProfile {
  /** App Store Connect API key ID (10 chars, e.g. 2X9R4HXF34). */
  keyId?: string;
  /** Issuer ID (UUID). Omit for individual API keys. */
  issuerId?: string;
  /** Path to the AuthKey_<KEYID>.p8 file. */
  privateKeyPath?: string;
  /** Apple Developer Team ID (10 chars). */
  teamId?: string;
  /** Name of a `notarytool store-credentials` keychain profile. */
  notaryKeychainProfile?: string;
}

export interface ConfigFile {
  defaultProfile?: string;
  profiles: Record<string, CredentialProfile>;
}

export interface ResolvedAscCredentials {
  keyId: string;
  issuerId?: string;
  privateKeyPem: string;
  privateKeyPath?: string;
  teamId?: string;
  source: string;
  profileName?: string;
}

export function defaultConfigDir(home: string): string {
  if (process.env.NOTARIZE_MCP_CONFIG_DIR) return process.env.NOTARIZE_MCP_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "notarize-mcp");
}

export class ConfigStore {
  readonly path: string;
  readonly dir: string;

  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    dir?: string,
  ) {
    this.dir = dir ?? defaultConfigDir(home);
    this.path = join(this.dir, "config.json");
  }

  get keysDir(): string {
    return join(this.dir, "keys");
  }

  async load(): Promise<ConfigFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<ConfigFile>;
      return { defaultProfile: raw.defaultProfile, profiles: raw.profiles ?? {} };
    } catch {
      return { profiles: {} };
    }
  }

  async save(cfg: ConfigFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600).catch(() => {});
  }

  async saveProfile(name: string, profile: CredentialProfile, makeDefault = false): Promise<ConfigFile> {
    const cfg = await this.load();
    cfg.profiles[name] = { ...cfg.profiles[name], ...stripUndefined(profile) };
    if (makeDefault || !cfg.defaultProfile) cfg.defaultProfile = name;
    await this.save(cfg);
    return cfg;
  }

  /** Profile chosen explicitly, via ASC_PROFILE, or the configured default. */
  async getProfile(name?: string): Promise<{ name?: string; profile: CredentialProfile }> {
    const cfg = await this.load();
    const chosen = name ?? this.env.ASC_PROFILE ?? cfg.defaultProfile;
    if (name && !cfg.profiles[name]) {
      throw new ToolError(`No credential profile named "${name}" in ${this.path}.`, {
        hint: `Known profiles: ${Object.keys(cfg.profiles).join(", ") || "(none)"}. Create one with asc_auth action=configure.`,
      });
    }
    return { name: chosen, profile: (chosen && cfg.profiles[chosen]) || {} };
  }

  /** Env vars override profile fields; explicit profile arg wins over env. */
  async resolveAsc(profileName?: string): Promise<ResolvedAscCredentials> {
    const { name, profile } = await this.getProfile(profileName);
    const env = this.env;
    const useEnv = !profileName;
    const keyId = (useEnv && env.ASC_KEY_ID) || profile.keyId;
    const issuerId = (useEnv && env.ASC_ISSUER_ID) || profile.issuerId;
    const inlineKey = useEnv ? env.ASC_PRIVATE_KEY : undefined;
    let privateKeyPath = (useEnv && env.ASC_PRIVATE_KEY_PATH) || profile.privateKeyPath;
    const source =
      useEnv && env.ASC_KEY_ID ? "environment" : name ? `profile "${name}" (${this.path})` : "none";

    if (!keyId) {
      const installed = await this.listDiscoveredP8();
      if (installed.length)
        throw new ToolError("No App Store Connect API key configured.", {
          hint: `Found ${installed.map((k) => `${k.path} (Key ID ${k.keyId})`).join(", ")} but no Key ID is configured. Confirm which key to use with the user, then call asc_auth action=configure with that key_id and its Issuer ID, or set ASC_KEY_ID / ASC_ISSUER_ID.`,
          data: { discoveredKeys: installed },
          next_steps: ["asc_auth action=configure key_id=<one of the found Key IDs> issuer_id=<Issuer ID>"],
        });
      throw new ToolError("No App Store Connect API key configured.", {
        hint: "Create a Team API key in App Store Connect → Users and Access → Integrations → App Store Connect API (role Admin or App Manager), download the .p8 once, then call asc_auth action=configure, or set ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY_PATH.",
        next_steps: ["asc_auth action=status to see what is configured", "asc_auth action=configure"],
      });
    }
    if (!inlineKey && !privateKeyPath) {
      privateKeyPath = await this.discoverP8(keyId);
    }
    let privateKeyPem: string;
    if (inlineKey) {
      privateKeyPem = inlineKey.includes("BEGIN")
        ? inlineKey
        : Buffer.from(inlineKey, "base64").toString("utf8");
    } else if (privateKeyPath) {
      try {
        privateKeyPem = await readFile(expandHome(privateKeyPath, this.home), "utf8");
      } catch (e) {
        throw new ToolError(
          `Cannot read App Store Connect private key at ${privateKeyPath}: ${(e as Error).message}`,
        );
      }
    } else {
      throw new ToolError(`No private key (.p8) found for API key ${keyId}.`, {
        hint: `Set privateKeyPath in the profile, ASC_PRIVATE_KEY_PATH, or place AuthKey_${keyId}.p8 in ~/.appstoreconnect/private_keys/.`,
      });
    }
    return {
      keyId,
      issuerId: issuerId || undefined,
      privateKeyPem,
      privateKeyPath,
      teamId: profile.teamId,
      source,
      profileName: name,
    };
  }

  /** altool / xcodebuild conventional locations for AuthKey_<id>.p8. */
  p8SearchDirs(): string[] {
    return [
      join(this.home, ".appstoreconnect", "private_keys"),
      join(this.home, "private_keys"),
      join(this.home, ".private_keys"),
      this.keysDir,
    ];
  }

  async discoverP8(keyId?: string): Promise<string | undefined> {
    for (const dir of this.p8SearchDirs()) {
      try {
        const files = await readdir(dir);
        const match = files.find((f) => (keyId ? f === `AuthKey_${keyId}.p8` : /^AuthKey_.+\.p8$/.test(f)));
        if (match) return join(dir, match);
      } catch {
        /* missing dir */
      }
    }
    return undefined;
  }

  async listDiscoveredP8(): Promise<{ keyId: string; path: string }[]> {
    const out: { keyId: string; path: string }[] = [];
    for (const dir of this.p8SearchDirs()) {
      try {
        for (const f of await readdir(dir)) {
          const m = /^AuthKey_(.+)\.p8$/.exec(f);
          if (m) out.push({ keyId: m[1], path: join(dir, f) });
        }
      } catch {
        /* missing dir */
      }
    }
    return out;
  }

  async notaryProfile(explicit?: string, profileName?: string): Promise<string | undefined> {
    if (explicit) return explicit;
    if (this.env.NOTARY_KEYCHAIN_PROFILE) return this.env.NOTARY_KEYCHAIN_PROFILE;
    const { profile } = await this.getProfile(profileName);
    return profile.notaryKeychainProfile;
  }
}

export function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}
