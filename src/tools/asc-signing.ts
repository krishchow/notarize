import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AscResource } from "../asc/client";
import { rel, relMany } from "../asc/client";
import { expandHome } from "../core/config";
import { requireMacOS } from "../core/platform";
import { ToolError } from "../core/result";
import { ASC_CERTIFICATE_TYPES, classifyAscCertificateType } from "../knowledge/certificate-types";
import { certTypesForProfile, PROFILE_TYPES, profileNeedsDevices } from "../knowledge/targets";
import { derToPem } from "../parsers/x509";
import { clientFromKey, PLATFORMS, resolveBundleIdResource, slimResource, table } from "./asc-common";
import { importKeyAndCert, loginKeychain } from "./keychain";
import { installProfileBytes } from "./provisioning";
import { pathExists, resolveUserPath } from "./shared";
import { defineTool, profileArg, withConfirmation } from "./types";

// ------------------------------------------------------------------ asc_auth

export const ascAuthTool = defineTool({
  name: "asc_auth",
  title: "App Store Connect API key setup and validation",
  description:
    "action=status: show which API key is configured (env vars or saved profile) without network calls, plus .p8 files found in ~/.appstoreconnect/private_keys. action=test: make an authenticated call and report success, rate limit, and role/agreement problems. action=configure (confirm): validate a key (key_id, issuer_id, private_key_path) and save it as a named profile in ~/.config/notarize-mcp/config.json (0600; only the .p8 PATH is stored). One Team API key (Admin or App Manager role) powers portal automation, notarization and uploads. Creating the key itself is manual: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate (the .p8 downloads only once).",
  mutating: true,
  input: {
    action: z.enum(["status", "test", "configure"]),
    profile: profileArg,
    profile_name: z.string().optional().describe("configure: profile name to save (default 'default')."),
    key_id: z.string().optional().describe("configure: Key ID (10 characters)."),
    issuer_id: z
      .string()
      .optional()
      .describe("configure: Issuer ID (UUID shown above the keys table). Omit for an individual key."),
    private_key_path: z.string().optional().describe("configure: path to AuthKey_<KEYID>.p8."),
    team_id: z
      .string()
      .optional()
      .describe("configure: your 10-character Team ID (developer.apple.com → Membership)."),
    make_default: z.boolean().optional().describe("configure: make this the default profile (default true)."),
  },
  async handler(args, ctx, extra) {
    if (args.action === "status") {
      const cfg = await ctx.config.load();
      const discovered = await ctx.config.listDiscoveredP8();
      let active: Record<string, unknown> | undefined;
      try {
        const c = await ctx.config.resolveAsc(args.profile);
        active = {
          keyId: c.keyId,
          issuerId: c.issuerId ?? "(individual key)",
          source: c.source,
          privateKeyPath: c.privateKeyPath,
          teamId: c.teamId,
        };
      } catch (e) {
        active = { error: (e as Error).message };
      }
      return {
        summary: `Active credentials: ${active.error ? `none — ${active.error}` : `${active.keyId} via ${active.source}`}\nSaved profiles: ${Object.keys(cfg.profiles).join(", ") || "(none)"}${cfg.defaultProfile ? ` (default: ${cfg.defaultProfile})` : ""}\nDiscovered .p8 keys: ${discovered.map((d) => d.path).join(", ") || "(none)"}`,
        data: {
          active,
          profiles: cfg.profiles,
          defaultProfile: cfg.defaultProfile,
          configPath: ctx.config.path,
          discoveredKeys: discovered,
        },
        next_steps: active.error
          ? ["asc_auth action=configure key_id=… issuer_id=… private_key_path=…"]
          : ["asc_auth action=test"],
      };
    }

    if (args.action === "test") {
      const client = await ctx.asc(args.profile);
      const res = await client.list("apps", { "fields[apps]": "name,bundleId" }, 5);
      return {
        summary: `App Store Connect API key ${client.keyId} works. ${res.total ?? res.data.length} app record(s) visible${res.data.length ? `: ${res.data.map((a) => a.attributes?.name).join(", ")}` : ""}.${client.lastRateLimit ? ` Rate limit remaining this hour: ${client.lastRateLimit.remaining}/${client.lastRateLimit.limit}.` : ""}`,
        data: { ok: true, apps: res.data.map(slimResource), rateLimit: client.lastRateLimit },
        next_steps: ["distribution_checklist path=<project> target=<target>"],
      };
    }

    // configure
    if (!args.key_id || !args.private_key_path)
      throw new ToolError("key_id and private_key_path are required (issuer_id too for Team keys).");
    const keyPath = expandHome(args.private_key_path, ctx.platform.homeDir);
    if (!(await pathExists(keyPath))) throw new ToolError(`Private key not found at ${keyPath}.`);
    const name = args.profile_name ?? "default";
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Save App Store Connect API key ${args.key_id} as profile "${name}"`,
        steps: [
          { description: "Validate the key with an authenticated GET /v1/apps" },
          {
            description: `Write profile "${name}" to ${ctx.config.path} (mode 0600; stores the key path, not the key)`,
          },
        ],
      }),
      async () => {
        const pem = await readFile(keyPath, "utf8");
        const client = clientFromKey(ctx, args.key_id!, args.issuer_id, pem);
        await client.list("apps", {}, 1);
        await ctx.config.saveProfile(
          name,
          { keyId: args.key_id, issuerId: args.issuer_id, privateKeyPath: keyPath, teamId: args.team_id },
          args.make_default ?? true,
        );
        return {
          summary: `Validated and saved API key ${args.key_id} as profile "${name}".`,
          data: { profile: name, configPath: ctx.config.path },
          next_steps: [
            "notary action=store_credentials (optional, for notarytool)",
            "distribution_checklist",
          ],
        };
      },
    );
  },
});

// ------------------------------------------------------------------ bundle IDs

export const ascBundleIdsTool = defineTool({
  name: "asc_bundle_ids",
  title: "Register bundle IDs (App IDs) and manage capabilities",
  description:
    "App IDs identify your app to Apple's services. action=list (filter by identifier/platform) / get / capabilities (enabled capabilities). action=create (confirm): register an explicit bundle ID (IOS, MAC_OS or UNIVERSAL). action=enable_capability / disable_capability (confirm): e.g. PUSH_NOTIFICATIONS, ICLOUD, APP_GROUPS, ASSOCIATED_DOMAINS, APPLE_ID_AUTH (Sign in with Apple), IN_APP_PURCHASE, NETWORK_EXTENSIONS — provisioning profiles must be regenerated afterwards. action=delete (confirm, destructive).",
  mutating: true,
  input: {
    action: z.enum([
      "list",
      "get",
      "create",
      "delete",
      "capabilities",
      "enable_capability",
      "disable_capability",
    ]),
    bundle_id: z.string().optional().describe("Bundle identifier (com.example.app) or ASC resource id."),
    name: z.string().optional().describe("create: display name (letters, numbers, spaces)."),
    platform: z.enum(PLATFORMS).optional().describe("create/list: IOS, MAC_OS or UNIVERSAL."),
    capability_type: z
      .string()
      .optional()
      .describe("enable/disable_capability: capabilityType, e.g. PUSH_NOTIFICATIONS."),
    capability_id: z
      .string()
      .optional()
      .describe("disable_capability: bundleIdCapability id (from capabilities)."),
    settings: z
      .array(z.record(z.string(), z.any()))
      .optional()
      .describe("enable_capability: capability settings array (e.g. iCloud version)."),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const client = await ctx.asc(args.profile);
    if (args.action === "list") {
      const res = await client.list(
        "bundleIds",
        { "filter[identifier]": args.bundle_id, "filter[platform]": args.platform },
        200,
      );
      const rows = res.data.map(slimResource);
      return {
        summary: rows.length ? table(rows, ["identifier", "name", "platform", "id"]) : "No bundle IDs found.",
        data: { bundleIds: rows, total: res.total },
      };
    }
    if (args.action === "create") {
      if (!args.bundle_id || !args.name || !args.platform)
        throw new ToolError("bundle_id, name and platform are required.");
      if (!/^[A-Za-z0-9.-]+$/.test(args.bundle_id) || args.bundle_id.includes("*"))
        throw new ToolError(
          "Use an explicit reverse-DNS identifier (letters, digits, '-', '.'), e.g. com.yourcompany.yourapp.",
        );
      const body = {
        data: {
          type: "bundleIds",
          attributes: { identifier: args.bundle_id, name: args.name, platform: args.platform },
        },
      };
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Register bundle ID ${args.bundle_id} (${args.platform})`,
          steps: [{ description: `POST /v1/bundleIds ${JSON.stringify(body.data.attributes)}` }],
          notes: ["Bundle IDs are unique across all Apple developers and cannot be renamed later."],
        }),
        async () => {
          const r = await client.post("bundleIds", body);
          return {
            summary: `Registered ${args.bundle_id} (id ${r.data.id}).`,
            data: { bundleId: slimResource(r.data) },
            next_steps: [
              "asc_bundle_ids action=enable_capability (if you use iCloud, push, app groups…)",
              "asc_profiles action=create",
            ],
          };
        },
      );
    }
    if (!args.bundle_id && !args.capability_id) throw new ToolError("bundle_id is required.");
    const b = args.bundle_id ? await resolveBundleIdResource(client, args.bundle_id) : undefined;
    if (args.action === "get")
      return {
        summary: `${b!.attributes?.identifier} — ${b!.attributes?.name} (${b!.attributes?.platform}, team prefix ${b!.attributes?.seedId})`,
        data: { bundleId: slimResource(b!) },
      };
    if (args.action === "capabilities") {
      const caps = await client.list(`bundleIds/${b!.id}/bundleIdCapabilities`, {}, 100);
      const rows = caps.data.map((c) => ({
        id: c.id,
        capabilityType: c.attributes?.capabilityType,
        settings: c.attributes?.settings,
      }));
      return {
        summary: rows.length ? table(rows, ["capabilityType", "id"]) : "No capabilities enabled.",
        data: { capabilities: rows },
      };
    }
    if (args.action === "enable_capability") {
      if (!args.capability_type) throw new ToolError("capability_type is required.");
      const body = {
        data: {
          type: "bundleIdCapabilities",
          attributes: {
            capabilityType: args.capability_type,
            ...(args.settings ? { settings: args.settings } : {}),
          },
          relationships: { bundleId: rel("bundleIds", b!.id) },
        },
      };
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Enable ${args.capability_type} on ${b!.attributes?.identifier}`,
          steps: [{ description: "POST /v1/bundleIdCapabilities" }],
          notes: [
            "Existing provisioning profiles become invalid for this capability — regenerate them (asc_profiles regenerate).",
          ],
        }),
        async () => {
          const r = await client.post("bundleIdCapabilities", body);
          return {
            summary: `Enabled ${args.capability_type} (id ${r.data.id}).`,
            data: { capability: slimResource(r.data) },
            next_steps: ["asc_profiles action=regenerate for affected profiles"],
          };
        },
      );
    }
    if (args.action === "disable_capability") {
      if (!args.capability_id) throw new ToolError("capability_id is required (see action=capabilities).");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Disable capability ${args.capability_id}`,
          steps: [{ description: `DELETE /v1/bundleIdCapabilities/${args.capability_id}` }],
          destructive: true,
          warnings: ["Apps relying on this capability lose it after their profiles are regenerated."],
        }),
        async () => {
          await client.delete(`bundleIdCapabilities/${args.capability_id}`);
          return { summary: "Capability disabled.", data: { ok: true } };
        },
      );
    }
    // delete
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Delete bundle ID ${b!.attributes?.identifier}`,
        steps: [{ description: `DELETE /v1/bundleIds/${b!.id}` }],
        destructive: true,
        warnings: [
          "Bundle IDs used by an App Store app cannot be deleted; deleting may make the identifier unavailable for reuse.",
        ],
      }),
      async () => {
        await client.delete(`bundleIds/${b!.id}`);
        return { summary: `Deleted ${b!.attributes?.identifier}.`, data: { ok: true } };
      },
    );
  },
});

// ------------------------------------------------------------------ certificates

export const ascCertificatesTool = defineTool({
  name: "asc_certificates",
  title: "Signing certificates in the Apple Developer portal",
  description:
    "action=list (filter by certificate_type) / get. action=create (confirm): submit a CSR (from keychain create_csr: pass key_name, or csr_path) for certificate_type DISTRIBUTION (Apple Distribution), DEVELOPMENT (Apple Development), MAC_INSTALLER_DISTRIBUTION, DEVELOPER_ID_APPLICATION_G2… and, if key_name is given, install the issued certificate + private key into the login keychain. Developer ID types usually require the Account Holder via the web portal — on refusal you get exact manual steps. action=download_install (confirm): fetch an existing certificate and pair it with a local key. action=revoke (confirm, destructive).",
  mutating: true,
  input: {
    action: z.enum(["list", "get", "create", "download_install", "revoke"]),
    certificate_type: z.enum(ASC_CERTIFICATE_TYPES).optional(),
    certificate_id: z.string().optional(),
    key_name: z
      .string()
      .optional()
      .describe(
        "Key created by keychain create_csr (its .csr is used for create; its .key is paired on install).",
      ),
    csr_path: z.string().optional().describe("create: explicit CSR path."),
    install: z
      .boolean()
      .optional()
      .describe("create: install into the keychain afterwards (default true when key_name is given)."),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const client = await ctx.asc(args.profile);
    if (args.action === "list") {
      const res = await client.list(
        "certificates",
        {
          "filter[certificateType]": args.certificate_type,
          "fields[certificates]": "name,certificateType,displayName,serialNumber,platform,expirationDate",
        },
        200,
      );
      const rows = res.data.map((c) => ({
        ...slimResource(c),
        kind: classifyAscCertificateType(String(c.attributes?.certificateType))?.portalName,
      }));
      return {
        summary: rows.length
          ? table(rows, ["certificateType", "displayName", "expirationDate", "id"])
          : "No certificates.",
        data: { certificates: rows },
      };
    }
    if (args.action === "get") {
      if (!args.certificate_id) throw new ToolError("certificate_id is required.");
      const c = (await client.get<AscResource>(`certificates/${args.certificate_id}`)).data;
      return {
        summary: `${c.attributes?.certificateType} ${c.attributes?.displayName} expires ${c.attributes?.expirationDate}`,
        data: { certificate: slimResource(c) },
      };
    }
    const keysDir = ctx.config.keysDir;
    if (args.action === "create") {
      if (!args.certificate_type) throw new ToolError("certificate_type is required.");
      const csrPath = args.csr_path
        ? await resolveUserPath(ctx, args.csr_path)
        : args.key_name
          ? join(keysDir, `${args.key_name}.csr`)
          : undefined;
      if (!csrPath || !(await pathExists(csrPath)))
        throw new ToolError("Provide key_name (from keychain create_csr) or csr_path.");
      const install = args.install ?? !!args.key_name;
      const isDevId = args.certificate_type.startsWith("DEVELOPER_ID");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Request a ${args.certificate_type} certificate`,
          steps: [
            { description: `POST /v1/certificates with ${csrPath}` },
            ...(install
              ? [
                  {
                    description: `Save the .cer to ${keysDir} and import it with ${args.key_name}.key into the login keychain`,
                  },
                ]
              : []),
          ],
          warnings: isDevId
            ? [
                "Developer ID certificates are usually restricted to the Account Holder; if the API refuses, follow the manual steps returned.",
              ]
            : [],
          notes: ["Per-team limits apply (e.g. 3 Apple Distribution, 5 Developer ID)."],
        }),
        async () => {
          const csr = await readFile(csrPath, "utf8");
          let created: AscResource;
          try {
            created = (
              await client.post("certificates", {
                data: {
                  type: "certificates",
                  attributes: { certificateType: args.certificate_type, csrContent: csr },
                },
              })
            ).data;
          } catch (e) {
            if (isDevId && (e as { status?: number }).status === 403) {
              throw new ToolError("Apple refused to create a Developer ID certificate with this API key.", {
                hint: `The Account Holder must create it: developer.apple.com/account/resources/certificates/add → Developer ID Application → upload ${csrPath} → download the .cer → keychain action=import_certificate key_name=${args.key_name ?? "<key>"} certificate_path=<downloaded .cer>`,
              });
            }
            throw e;
          }
          const lines = [
            `Created certificate ${created.attributes?.displayName ?? ""} (${created.id}), expires ${created.attributes?.expirationDate}.`,
          ];
          const data: Record<string, unknown> = { certificate: slimResource(created) };
          const content = created.attributes?.certificateContent as string | undefined;
          if (content) {
            await mkdir(keysDir, { recursive: true, mode: 0o700 });
            const cerPath = join(keysDir, `${args.key_name ?? created.id}.cer`);
            await writeFile(cerPath, Buffer.from(content, "base64"));
            data.cerPath = cerPath;
            lines.push(`Saved ${cerPath}.`);
            if (install && args.key_name) {
              requireMacOS(ctx.platform, "Keychain import");
              const res = await importKeyAndCert(
                ctx,
                join(keysDir, `${args.key_name}.key`),
                derToPem(Buffer.from(content, "base64")),
                loginKeychain(ctx.platform.homeDir),
              );
              lines.push(`Installed identity "${res.identity}" into the login keychain.`);
              data.installed = res.identity;
            }
          }
          return {
            summary: lines.join("\n"),
            data,
            next_steps: [
              "signing_identities to confirm",
              "keychain action=export_p12 to back up the identity",
            ],
          };
        },
      );
    }
    if (!args.certificate_id) throw new ToolError("certificate_id is required.");
    if (args.action === "download_install") {
      if (!args.key_name)
        throw new ToolError("key_name is required: the private key that created this certificate's CSR.");
      const keyPath = join(keysDir, `${args.key_name}.key`);
      if (!(await pathExists(keyPath)))
        throw new ToolError(
          `No private key ${keyPath}. A certificate is useless without the key that created its CSR — create a new certificate instead.`,
        );
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Download certificate ${args.certificate_id} and install it with ${args.key_name}.key`,
          steps: [
            { description: `GET /v1/certificates/${args.certificate_id}` },
            { description: "Import into the login keychain" },
          ],
        }),
        async () => {
          requireMacOS(ctx.platform, "Keychain import");
          const c = (await client.get<AscResource>(`certificates/${args.certificate_id}`)).data;
          const pem = derToPem(Buffer.from(String(c.attributes?.certificateContent), "base64"));
          const res = await importKeyAndCert(ctx, keyPath, pem, loginKeychain(ctx.platform.homeDir));
          return { summary: `Installed "${res.identity}".`, data: { identity: res.identity } };
        },
      );
    }
    // revoke
    const c = (await client.get<AscResource>(`certificates/${args.certificate_id}`)).data;
    const isDevId = String(c.attributes?.certificateType).startsWith("DEVELOPER_ID");
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `REVOKE ${c.attributes?.certificateType} certificate "${c.attributes?.displayName}" (${c.id})`,
        steps: [{ description: `DELETE /v1/certificates/${c.id}` }],
        destructive: true,
        warnings: [
          "Revocation cannot be undone.",
          ...(isDevId
            ? [
                "Revoking a Developer ID certificate makes Gatekeeper block NEW launches of software already shipped with it. Only revoke if the private key was compromised.",
              ]
            : [
                "Provisioning profiles that include this certificate become invalid; builds signed with it can no longer be installed/uploaded.",
              ]),
        ],
      }),
      async () => {
        await client.delete(`certificates/${c.id}`);
        return { summary: `Revoked certificate ${c.id}.`, data: { ok: true } };
      },
    );
  },
});

// ------------------------------------------------------------------ devices

export const ascDevicesTool = defineTool({
  name: "asc_devices",
  title: "Registered test devices",
  description:
    "Devices (UDIDs) are needed for development and Ad Hoc profiles (limit: 100 per device family per membership year — disabling does not free a slot until renewal). action=list (filter platform/status). action=register (confirm): add a device (get UDIDs from the devices tool). action=disable (confirm).",
  mutating: true,
  input: {
    action: z.enum(["list", "register", "disable"]),
    name: z.string().optional(),
    udid: z.string().optional(),
    platform: z.enum(["IOS", "MAC_OS"]).optional(),
    device_id: z.string().optional().describe("disable: ASC device resource id."),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const client = await ctx.asc(args.profile);
    if (args.action === "list") {
      const res = await client.list(
        "devices",
        { "filter[platform]": args.platform, "filter[udid]": args.udid },
        200,
      );
      const rows = res.data.map(slimResource);
      return {
        summary: rows.length
          ? table(rows, ["name", "platform", "deviceClass", "status", "udid", "id"])
          : "No devices registered.",
        data: { devices: rows },
      };
    }
    if (args.action === "register") {
      if (!args.name || !args.udid || !args.platform)
        throw new ToolError("name, udid and platform are required.");
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Register ${args.platform} device "${args.name}" (${args.udid})`,
          destructive: true,
          steps: [{ description: "POST /v1/devices" }],
          notes: ["Uses one of your yearly device slots. Regenerate development/Ad Hoc profiles afterwards."],
        }),
        async () => {
          const r = await client.post("devices", {
            data: {
              type: "devices",
              attributes: { name: args.name, udid: args.udid, platform: args.platform },
            },
          });
          return {
            summary: `Registered ${args.name} (id ${r.data.id}).`,
            data: { device: slimResource(r.data) },
            next_steps: ["asc_profiles action=regenerate for development / Ad Hoc profiles"],
          };
        },
      );
    }
    if (!args.device_id) throw new ToolError("device_id is required.");
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Disable device ${args.device_id}`,
        destructive: true,
        steps: [{ description: `PATCH /v1/devices/${args.device_id} status=DISABLED` }],
        warnings: ["Disabling does not free the slot until your membership renews."],
      }),
      async () => {
        await client.patch(`devices/${args.device_id}`, {
          data: { type: "devices", id: args.device_id, attributes: { status: "DISABLED" } },
        });
        return { summary: "Device disabled.", data: { ok: true } };
      },
    );
  },
});

// ------------------------------------------------------------------ profiles

export const ascProfilesTool = defineTool({
  name: "asc_profiles",
  title: "Provisioning profiles in the Apple Developer portal",
  description:
    "action=list (filter profile_type, bundle_id) / get. action=create (confirm): profile_type (IOS_APP_STORE, IOS_APP_ADHOC, IOS_APP_DEVELOPMENT, MAC_APP_STORE, MAC_APP_DIRECT = Developer ID, MAC_APP_DEVELOPMENT, …) for a bundle ID; certificates default to all valid certificates of the matching type and devices to all enabled devices of the platform (for development/ad hoc). Installs it for Xcode by default. action=download_install (confirm). action=regenerate (confirm): delete + recreate with the same name/type/bundle ID and current certificates/devices — needed after adding devices or capabilities. action=delete (confirm).",
  mutating: true,
  input: {
    action: z.enum(["list", "get", "create", "download_install", "regenerate", "delete"]),
    profile_id: z.string().optional(),
    profile_type: z.enum(PROFILE_TYPES).optional(),
    bundle_id: z.string().optional().describe("Bundle identifier or ASC bundleId resource id."),
    name: z.string().optional().describe("create: profile name (default '<bundle id> <type>')."),
    certificate_ids: z
      .array(z.string())
      .optional()
      .describe("create: certificate ids (default: all valid of the right type)."),
    device_ids: z
      .array(z.string())
      .optional()
      .describe("create: device ids (default: all enabled for the platform, dev/ad hoc only)."),
    install: z.boolean().optional().describe("create/regenerate: install for Xcode (default true on macOS)."),
    profile: profileArg,
  },
  async handler(args, ctx, extra) {
    const client = await ctx.asc(args.profile);
    const install = (args.install ?? true) && ctx.platform.isMac;

    if (args.action === "list") {
      const path = args.bundle_id
        ? `bundleIds/${(await resolveBundleIdResource(client, args.bundle_id)).id}/profiles`
        : "profiles";
      const res = await client.list(
        path,
        {
          "filter[profileType]": args.bundle_id ? undefined : args.profile_type,
          "fields[profiles]": "name,platform,profileType,profileState,uuid,createdDate,expirationDate",
        },
        200,
      );
      const rows = res.data
        .map(slimResource)
        .filter((r) => !args.profile_type || r.profileType === args.profile_type);
      return {
        summary: rows.length
          ? table(rows, ["name", "profileType", "profileState", "expirationDate", "id"])
          : "No profiles.",
        data: { profiles: rows },
      };
    }

    const createProfile = async (name: string, type: string, bundle: AscResource) => {
      const certTypes = certTypesForProfile(type);
      const certIds =
        args.certificate_ids ??
        (await client.list("certificates", { "filter[certificateType]": certTypes.join(",") }, 200)).data
          .filter(
            (c) =>
              !c.attributes?.expirationDate ||
              Date.parse(String(c.attributes.expirationDate)) > ctx.now().getTime(),
          )
          .map((c) => c.id);
      if (!certIds.length)
        throw new ToolError(
          `No valid ${certTypes.join("/")} certificates in the team for a ${type} profile.`,
          { hint: "Create one first: keychain create_csr → asc_certificates create." },
        );
      let deviceIds: string[] | undefined;
      if (profileNeedsDevices(type)) {
        const platform = type.startsWith("MAC") ? "MAC_OS" : "IOS";
        deviceIds =
          args.device_ids ??
          (
            await client.list("devices", { "filter[platform]": platform, "filter[status]": "ENABLED" }, 200)
          ).data.map((d) => d.id);
        if (!deviceIds.length)
          throw new ToolError(`A ${type} profile needs at least one registered ${platform} device.`, {
            hint: "devices → asc_devices action=register",
          });
      }
      const body = {
        data: {
          type: "profiles",
          attributes: { name, profileType: type },
          relationships: {
            bundleId: rel("bundleIds", bundle.id),
            certificates: relMany("certificates", certIds),
            ...(deviceIds ? { devices: relMany("devices", deviceIds) } : {}),
          },
        },
      };
      const created = (await client.post("profiles", body)).data;
      let installed: string[] | undefined;
      if (install && created.attributes?.profileContent) {
        installed = await installProfileBytes(
          ctx,
          Buffer.from(String(created.attributes.profileContent), "base64"),
          String(created.attributes.uuid),
          type.startsWith("MAC"),
        );
      }
      return { created, installed, certIds, deviceIds };
    };

    if (args.action === "create") {
      if (!args.profile_type || !args.bundle_id)
        throw new ToolError("profile_type and bundle_id are required.");
      const bundle = await resolveBundleIdResource(client, args.bundle_id);
      const name = args.name ?? `${bundle.attributes?.identifier} ${args.profile_type}`;
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Create ${args.profile_type} profile "${name}" for ${bundle.attributes?.identifier}`,
          steps: [
            {
              description: `Certificates: ${args.certificate_ids?.join(", ") ?? `all valid ${certTypesForProfile(args.profile_type!).join("/")}`}`,
            },
            ...(profileNeedsDevices(args.profile_type!)
              ? [
                  {
                    description: `Devices: ${args.device_ids?.join(", ") ?? "all enabled devices for the platform"}`,
                  },
                ]
              : []),
            { description: "POST /v1/profiles" },
            ...(install ? [{ description: "Install into Xcode's Provisioning Profiles folders" }] : []),
          ],
        }),
        async () => {
          const r = await createProfile(name, args.profile_type!, bundle);
          return {
            summary: `Created profile "${name}" (${r.created.id}, UUID ${r.created.attributes?.uuid}), expires ${r.created.attributes?.expirationDate}.${r.installed ? `\nInstalled: ${r.installed.join(", ")}` : ""}`,
            data: { profile: slimResource(r.created), installed: r.installed },
          };
        },
      );
    }

    if (!args.profile_id) throw new ToolError("profile_id is required.");
    const existing = (await client.get<AscResource>(`profiles/${args.profile_id}`, { include: "bundleId" }))
      .data;
    if (args.action === "get")
      return {
        summary: `${existing.attributes?.name} — ${existing.attributes?.profileType} ${existing.attributes?.profileState}, expires ${existing.attributes?.expirationDate}`,
        data: { profile: slimResource(existing) },
      };

    if (args.action === "download_install") {
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Install profile "${existing.attributes?.name}"`,
          steps: [{ description: "Write profile into Xcode's Provisioning Profiles folders" }],
        }),
        async () => {
          const content = existing.attributes?.profileContent as string | undefined;
          if (!content)
            throw new ToolError("Profile has no downloadable content (it may be invalid — regenerate it).");
          const installed = await installProfileBytes(
            ctx,
            Buffer.from(content, "base64"),
            String(existing.attributes?.uuid),
            String(existing.attributes?.platform) === "MAC_OS",
          );
          return { summary: `Installed to ${installed.join(", ")}`, data: { installed } };
        },
      );
    }

    if (args.action === "delete") {
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Delete profile "${existing.attributes?.name}"`,
          steps: [{ description: `DELETE /v1/profiles/${existing.id}` }],
          destructive: true,
        }),
        async () => {
          await client.delete(`profiles/${existing.id}`);
          return { summary: "Profile deleted.", data: { ok: true } };
        },
      );
    }

    // regenerate
    const bundleRel = existing.relationships?.bundleId?.data as { id: string } | undefined;
    if (!bundleRel) throw new ToolError("Could not determine the profile's bundle ID.");
    const bundle = (await client.get<AscResource>(`bundleIds/${bundleRel.id}`)).data;
    const type = String(existing.attributes?.profileType);
    const name = String(existing.attributes?.name);
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Regenerate profile "${name}" (${type})`,
        destructive: true,
        steps: [
          { description: `DELETE /v1/profiles/${existing.id}` },
          {
            description: `POST /v1/profiles with the same name/type for ${bundle.attributes?.identifier}, current certificates${profileNeedsDevices(type) ? " and devices" : ""}`,
          },
          ...(install ? [{ description: "Install the new profile for Xcode" }] : []),
        ],
        warnings: ["Builds must be re-signed/re-exported with the new profile."],
      }),
      async () => {
        await client.delete(`profiles/${existing.id}`);
        const r = await createProfile(name, type, bundle);
        return {
          summary: `Regenerated "${name}" → ${r.created.id} (UUID ${r.created.attributes?.uuid}).`,
          data: { profile: slimResource(r.created), installed: r.installed },
        };
      },
    );
  },
});
