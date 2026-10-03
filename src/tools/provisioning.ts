import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { asArray, asDict, decodeProvisioningProfile, type PlistDict } from "../core/plist";
import { ToolError } from "../core/result";
import { describeCertificate } from "../parsers/x509";
import {
  type Finding,
  finding,
  formatFindings,
  isDirectory,
  listIdentities,
  pathExists,
  profileKind,
  resolveUserPath,
} from "./shared";
import { defineTool, type ToolContext, withConfirmation } from "./types";

export function profileDirs(home: string): string[] {
  return [
    join(home, "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
    join(home, "Library", "MobileDevice", "Provisioning Profiles"),
  ];
}

export interface ProfileSummary {
  path?: string;
  name?: string;
  uuid?: string;
  appIdName?: string;
  applicationIdentifier?: string;
  bundleId?: string;
  teamId?: string;
  teamName?: string;
  platforms: string[];
  kind: string;
  created?: string;
  expires?: string;
  expired: boolean;
  daysUntilExpiry?: number;
  deviceCount: number;
  provisionsAllDevices: boolean;
  certificates: {
    commonName?: string;
    sha1: string;
    expires: string;
    expired: boolean;
    inKeychain?: boolean;
  }[];
  entitlements: PlistDict;
}

export function summarizeProfile(pl: PlistDict, now: Date, path?: string): ProfileSummary {
  const ent = asDict(pl.Entitlements) ?? {};
  const appId = (ent["application-identifier"] ?? ent["com.apple.application-identifier"]) as
    | string
    | undefined;
  const teamId = asArray(pl.TeamIdentifier)[0] as string | undefined;
  const exp = pl.ExpirationDate instanceof Date ? pl.ExpirationDate : undefined;
  const certs = asArray(pl.DeveloperCertificates)
    .filter((c): c is Uint8Array => c instanceof Uint8Array)
    .map((der) => {
      try {
        const d = describeCertificate(der, now);
        return { commonName: d.commonName, sha1: d.sha1, expires: d.validTo, expired: d.expired };
      } catch {
        return { sha1: "?", expires: "?", expired: false };
      }
    });
  return {
    path,
    name: pl.Name as string | undefined,
    uuid: pl.UUID as string | undefined,
    appIdName: pl.AppIDName as string | undefined,
    applicationIdentifier: appId,
    bundleId: appId && teamId && appId.startsWith(`${teamId}.`) ? appId.slice(teamId.length + 1) : appId,
    teamId,
    teamName: pl.TeamName as string | undefined,
    platforms: asArray(pl.Platform).map(String),
    kind: profileKind(pl),
    created: pl.CreationDate instanceof Date ? pl.CreationDate.toISOString() : undefined,
    expires: exp?.toISOString(),
    expired: exp ? exp.getTime() < now.getTime() : false,
    daysUntilExpiry: exp ? Math.floor((exp.getTime() - now.getTime()) / 86_400_000) : undefined,
    deviceCount: asArray(pl.ProvisionedDevices).length,
    provisionsAllDevices: pl.ProvisionsAllDevices === true,
    certificates: certs,
    entitlements: ent,
  };
}

export async function listInstalledProfiles(ctx: ToolContext): Promise<ProfileSummary[]> {
  const out: ProfileSummary[] = [];
  const seen = new Set<string>();
  for (const dir of profileDirs(ctx.platform.homeDir)) {
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files.filter((x) => /\.(mobileprovision|provisionprofile)$/.test(x))) {
      try {
        const s = summarizeProfile(
          await decodeProvisioningProfile(ctx.runner, join(dir, f), ctx.platform.isMac),
          ctx.now(),
          join(dir, f),
        );
        if (s.uuid && seen.has(s.uuid)) continue;
        if (s.uuid) seen.add(s.uuid);
        out.push(s);
      } catch {
        /* unreadable profile */
      }
    }
  }
  return out;
}

/** Install profile bytes into Xcode's profile directories (Xcode 16+ and legacy). */
export async function installProfileBytes(
  ctx: ToolContext,
  bytes: Uint8Array,
  uuid: string,
  isMac: boolean,
): Promise<string[]> {
  const ext = isMac ? "provisionprofile" : "mobileprovision";
  const written: string[] = [];
  for (const dir of profileDirs(ctx.platform.homeDir)) {
    await mkdir(dir, { recursive: true });
    const p = join(dir, `${uuid}.${ext}`);
    await writeFile(p, bytes);
    written.push(p);
  }
  return written;
}

function profileText(s: ProfileSummary): string {
  return [
    `${s.name ?? "(unnamed)"} — ${s.kind}`,
    `  App ID: ${s.applicationIdentifier ?? "?"}  Team: ${s.teamId ?? "?"}${s.teamName ? ` (${s.teamName})` : ""}`,
    `  UUID: ${s.uuid ?? "?"}  Platforms: ${s.platforms.join(", ") || "?"}`,
    `  Expires: ${s.expires?.slice(0, 10) ?? "?"}${s.expired ? " (EXPIRED)" : ""}  Devices: ${s.provisionsAllDevices ? "all" : s.deviceCount}`,
    `  Certificates: ${s.certificates.map((c) => `${c.commonName ?? "?"}${c.inKeychain === false ? " [not in keychain]" : c.inKeychain ? " [in keychain]" : ""}`).join("; ")}`,
  ].join("\n");
}

export const provisioningProfilesTool = defineTool({
  name: "provisioning_profiles",
  title: "List, inspect, install or embed provisioning profiles",
  description:
    "action=list_installed: profiles installed for Xcode (both ~/Library/Developer/Xcode/UserData/Provisioning Profiles and the legacy MobileDevice folder) with expiry and type, optionally filtered by bundle_id. action=inspect: decode a .mobileprovision/.provisionprofile (app ID, team, type, devices, entitlements, embedded certificates and whether their private keys are in this keychain). action=install (confirm): copy a profile into Xcode's folders. action=embed (confirm): copy a profile into an app bundle (Contents/embedded.provisionprofile or embedded.mobileprovision) — re-sign afterwards.",
  mutating: true,
  input: {
    action: z.enum(["list_installed", "inspect", "install", "embed"]),
    path: z.string().optional().describe("inspect/install/embed: the profile file."),
    bundle_id: z
      .string()
      .optional()
      .describe("list_installed: filter by bundle ID (wildcard profiles also match)."),
    app_path: z.string().optional().describe("embed: the .app bundle to embed into."),
  },
  async handler(args, ctx, extra) {
    if (args.action === "list_installed") {
      let list = await listInstalledProfiles(ctx);
      if (args.bundle_id) {
        list = list.filter((p) => {
          const id = p.bundleId ?? "";
          return (
            id === args.bundle_id ||
            id === "*" ||
            (id.endsWith("*") && args.bundle_id!.startsWith(id.slice(0, -1)))
          );
        });
      }
      list.sort((a, b) => (b.expires ?? "").localeCompare(a.expires ?? ""));
      return {
        summary: list.length
          ? `${list.length} installed profile(s):\n${list.map(profileText).join("\n")}`
          : "No matching provisioning profiles installed.",
        data: { profiles: list.map((p) => ({ ...p, entitlements: Object.keys(p.entitlements) })) },
        next_steps: list.length ? [] : ["asc_profiles action=list / create / download_install"],
      };
    }

    if (!args.path) throw new ToolError("path (profile file) is required.");
    const path = await resolveUserPath(ctx, args.path);
    const pl = await decodeProvisioningProfile(ctx.runner, path, ctx.platform.isMac);
    const summary = summarizeProfile(pl, ctx.now(), path);
    const isMac =
      summary.platforms.some((p) => p === "OSX" || p === "macOS") || extname(path) === ".provisionprofile";

    if (args.action === "inspect") {
      const findings: Finding[] = [];
      if (ctx.platform.isMac) {
        try {
          const ids = await listIdentities(ctx);
          const have = new Set(ids.map((i) => i.sha1));
          for (const c of summary.certificates) c.inKeychain = have.has(c.sha1);
          if (!summary.certificates.some((c) => c.inKeychain))
            findings.push(
              finding(
                "error",
                "None of the profile's certificates has a private key in this keychain — signing with this profile will fail.",
                "Import the matching .p12, or regenerate the profile with a certificate you own (asc_profiles regenerate).",
              ),
            );
        } catch {
          /* keychain unavailable */
        }
      }
      if (summary.expired)
        findings.push(finding("error", "Profile has expired.", "asc_profiles action=regenerate"));
      else if ((summary.daysUntilExpiry ?? 999) < 30)
        findings.push(finding("warning", `Profile expires in ${summary.daysUntilExpiry} days.`));
      if (summary.certificates.every((c) => c.expired))
        findings.push(finding("error", "All certificates in the profile are expired."));
      return {
        summary: `${profileText(summary)}\n  Entitlements: ${Object.keys(summary.entitlements).join(", ")}${findings.length ? `\n\n${formatFindings(findings)}` : ""}`,
        data: { profile: summary, findings },
      };
    }

    if (args.action === "install") {
      if (!summary.uuid) throw new ToolError("Profile has no UUID.");
      const dests = profileDirs(ctx.platform.homeDir).map((d) =>
        join(d, `${summary.uuid}.${isMac ? "provisionprofile" : "mobileprovision"}`),
      );
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Install profile "${summary.name}" (${summary.kind})`,
          steps: dests.map((d) => ({ description: `Copy ${basename(path)} → ${d}` })),
        }),
        async () => {
          const { readFile } = await import("node:fs/promises");
          const written = await installProfileBytes(
            ctx,
            new Uint8Array(await readFile(path)),
            summary.uuid!,
            isMac,
          );
          return {
            summary: `Installed "${summary.name}" to:\n${written.join("\n")}`,
            data: { installed: written, profile: { ...summary, entitlements: undefined } },
          };
        },
      );
    }

    // embed
    if (!args.app_path) throw new ToolError("app_path is required for embed.");
    const app = await resolveUserPath(ctx, args.app_path);
    if (!(await isDirectory(app))) throw new ToolError(`${app} is not a bundle directory.`);
    const isMacBundle = await pathExists(join(app, "Contents"));
    const dest = isMacBundle
      ? join(app, "Contents", "embedded.provisionprofile")
      : join(app, "embedded.mobileprovision");
    const replacing = await pathExists(dest);
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `Embed "${summary.name}" into ${basename(app)}`,
        steps: [{ description: `${replacing ? "Replace" : "Create"} ${dest}` }],
        warnings: [
          "This invalidates the bundle's current signature — re-sign the bundle afterwards (sign tool).",
        ],
      }),
      async () => {
        await copyFile(path, dest);
        return {
          summary: `Embedded profile at ${dest}. Re-sign the bundle now.`,
          data: { embedded: dest },
          next_steps: ["sign path=<app> (with entitlements matching the profile)"],
        };
      },
    );
  },
});
