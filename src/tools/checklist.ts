import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AscClient, AscResource } from "../asc/client";
import { compareVersions, xcodeInfo } from "../core/platform";
import { type PlistDict, parsePlistDict } from "../core/plist";
import { CERTIFICATE_TYPES, certType } from "../knowledge/certificate-types";
import { entitlementInfo } from "../knowledge/entitlements";
import { currentSdkRequirement } from "../knowledge/sdk-requirements";
import { TARGET_IDS, TARGETS, type TargetId } from "../knowledge/targets";
import { type DetectedComponent, detectProject, readBundleInfo } from "../parsers/project/detect";
import { listInstalledProfiles } from "./provisioning";
import {
  type EnrichedIdentity,
  intermediateStatus,
  isDirectory,
  listIdentities,
  pickIdentity,
  resolveUserPath,
} from "./shared";
import { defineTool, profileArg, type ToolContext } from "./types";

export type ItemStatus = "ok" | "missing" | "warn" | "unknown" | "manual";

export interface ChecklistItem {
  id: string;
  title: string;
  status: ItemStatus;
  detail: string;
  fix?: string;
}

const ICON: Record<ItemStatus, string> = { ok: "✓", missing: "✗", warn: "⚠", unknown: "?", manual: "☐" };

async function readEntitlementsFiles(component: DetectedComponent | undefined): Promise<PlistDict> {
  if (!component) return {};
  const base = dirname(component.path);
  const files: string[] = [];
  const s = component.signing as Record<string, any>;
  for (const f of (s.entitlementsFiles as string[] | undefined) ?? []) if (!f.includes("$(")) files.push(f);
  if (s.mac?.entitlements) files.push(s.mac.entitlements);
  if (s.macOS?.entitlements) files.push(s.macOS.entitlements);
  const out: PlistDict = {};
  for (const f of files) {
    for (const candidate of [isAbsolute(f) ? f : join(base, f), join(base, "..", f)]) {
      try {
        Object.assign(out, parsePlistDict(new Uint8Array(await readFile(candidate))));
        break;
      } catch {
        /* try next */
      }
    }
  }
  return out;
}

function pickComponent(components: DetectedComponent[], target: TargetId): DetectedComponent | undefined {
  const platform = TARGETS[target].platform;
  return (
    components.find((c) => c.platforms.includes(platform) && c.bundleIds.length) ??
    components.find((c) => c.platforms.includes(platform)) ??
    components[0]
  );
}

export async function buildChecklist(
  ctx: ToolContext,
  opts: { path?: string; target: TargetId; bundleId?: string; profile?: string },
): Promise<{ items: ChecklistItem[]; bundleId?: string; component?: DetectedComponent }> {
  const t = TARGETS[opts.target];
  const items: ChecklistItem[] = [];
  const add = (i: ChecklistItem) => items.push(i);
  const isStore = t.ascAppRecord;

  // ---- project
  let component: DetectedComponent | undefined;
  let artifactEntitlements: PlistDict = {};
  let infoPlist: PlistDict | undefined;
  if (opts.path) {
    try {
      const path = await resolveUserPath(ctx, opts.path);
      const report = await detectProject(path);
      component = pickComponent(report.components, opts.target);
      if (component) {
        add({
          id: "project",
          title: "Project detected",
          status: "ok",
          detail: `${component.kind}${component.name ? ` "${component.name}"` : ""} (${component.platforms.join(", ") || "?"})`,
        });
        for (const f of component.findings.filter((x) => /false|not set|not YES|No appId/.test(x)))
          add({ id: "project-config", title: "Project signing config", status: "warn", detail: f });
        artifactEntitlements = await readEntitlementsFiles(component);
        if ((await isDirectory(path)) && extname(path) === ".app") infoPlist = await readBundleInfo(path);
      } else
        add({
          id: "project",
          title: "Project detected",
          status: "unknown",
          detail: "No recognizable project at path.",
          fix: "detect_project to investigate",
        });
    } catch (e) {
      add({ id: "project", title: "Project detected", status: "unknown", detail: (e as Error).message });
    }
  }
  const bundleId =
    opts.bundleId ?? component?.bundleIds.find((b) => !/Tests?$|\$\(/.test(b)) ?? component?.bundleIds[0];
  if (!bundleId && (isStore || t.profile?.required === "always"))
    add({
      id: "bundle-id",
      title: "Bundle identifier",
      status: "missing",
      detail: "No bundle ID known.",
      fix: "Pass bundle_id or set PRODUCT_BUNDLE_IDENTIFIER / appId / identifier in the project.",
    });

  // ---- tools
  if (ctx.platform.isMac) {
    const xc = await xcodeInfo(ctx.runner);
    const req = currentSdkRequirement(ctx.now());
    if (isStore || t.platform === "iOS") {
      if (!xc.xcodeVersion)
        add({
          id: "xcode",
          title: "Xcode",
          status: "missing",
          detail: "Full Xcode is required for archives and App Store uploads.",
          fix: "Install Xcode from the Mac App Store and select it with xcode-select.",
        });
      else if (req && compareVersions(xc.xcodeVersion, req.minXcode) < 0)
        add({
          id: "xcode",
          title: "Xcode",
          status: "missing",
          detail: `Xcode ${xc.xcodeVersion} < required ${req.minXcode} for App Store uploads (since ${req.effective}).`,
          fix: "Update Xcode.",
        });
      else add({ id: "xcode", title: "Xcode", status: "ok", detail: `Xcode ${xc.xcodeVersion}` });
    } else
      add({
        id: "xcode",
        title: "Developer tools",
        status: xc.developerDir ? "ok" : "missing",
        detail: xc.developerDir
          ? `${xc.xcodeVersion ? `Xcode ${xc.xcodeVersion}` : "Command Line Tools"} at ${xc.developerDir}`
          : "No developer tools.",
        fix: xc.developerDir ? undefined : "xcode-select --install (or install Xcode)",
      });
  } else
    add({
      id: "xcode",
      title: "Developer tools",
      status: "unknown",
      detail: `Running on ${ctx.platform.os}; local checks need macOS.`,
    });

  // ---- API key
  let client: AscClient | undefined;
  try {
    client = await ctx.asc(opts.profile);
    await client.list("apps", {}, 1);
    add({
      id: "api-key",
      title: "App Store Connect API key",
      status: "ok",
      detail: `Key ${client.keyId} authenticated (this also confirms an active developer membership).`,
    });
  } catch (e) {
    client = undefined;
    add({
      id: "api-key",
      title: "App Store Connect API key",
      status: "missing",
      detail: (e as Error).message,
      fix: "Requires a paid Apple Developer Program membership (developer.apple.com/programs/enroll). Then App Store Connect → Users and Access → Integrations → Team Keys → Generate (Admin or App Manager), download the .p8 and run asc_auth action=configure.",
    });
  }

  // ---- notarization credentials
  if (opts.target === "mac-developer-id") {
    const kp = await ctx.config.notaryProfile(undefined, opts.profile).catch(() => undefined);
    add(
      kp
        ? {
            id: "notary",
            title: "Notarization credentials",
            status: "ok",
            detail: `notarytool keychain profile "${kp}"`,
          }
        : client
          ? {
              id: "notary",
              title: "Notarization credentials",
              status: "ok",
              detail: "Will use the API key directly.",
              fix: "Optional: notary action=store_credentials",
            }
          : {
              id: "notary",
              title: "Notarization credentials",
              status: "missing",
              detail: "No API key or notarytool profile.",
              fix: "asc_auth action=configure, then notary action=store_credentials",
            },
    );
  }

  // ---- certificates
  let identities: EnrichedIdentity[] = [];
  let portalCerts: AscResource[] = [];
  if (ctx.platform.isMac) {
    try {
      identities = await listIdentities(ctx);
    } catch {
      /* reported below */
    }
  }
  if (client) {
    try {
      portalCerts = (await client.list("certificates", {}, 200)).data;
    } catch {
      /* ignore */
    }
  }
  const teamId = component?.teamIds[0];
  for (const role of t.certificates) {
    const pick = pickIdentity(identities, role.alternatives, teamId);
    const typeNames = role.alternatives.map((a) => certType(a).portalName).join(" / ");
    if (pick) {
      add({
        id: `cert-${role.alternatives[0]}`,
        title: `Certificate: ${typeNames}`,
        status: "ok",
        detail: `"${pick.name}"${pick.certificate ? `, expires ${pick.certificate.validTo.slice(0, 10)}` : ""}`,
      });
      continue;
    }
    const ascTypes = role.alternatives.flatMap((a) => certType(a).ascTypes);
    const inPortal = portalCerts.filter((c) => ascTypes.includes(String(c.attributes?.certificateType)));
    const isDevId = role.alternatives[0].startsWith("developer-id");
    const status: ItemStatus = role.when ? "warn" : ctx.platform.isMac ? "missing" : "unknown";
    add({
      id: `cert-${role.alternatives[0]}`,
      title: `Certificate: ${typeNames}${role.when ? ` (${role.when})` : ""}`,
      status,
      detail: inPortal.length
        ? `${inPortal.length} exist in the portal but none is usable in this keychain (the private key lives on the Mac that created it).`
        : "None in this keychain.",
      fix: inPortal.length
        ? "Import the .p12 from the Mac/person that created it (keychain import_p12), or create a new one (keychain create_csr → asc_certificates create)."
        : isDevId
          ? "Account Holder: keychain create_csr, then developer.apple.com → Certificates → + → " +
            typeNames +
            " → upload CSR → keychain import_certificate."
          : `keychain create_csr → asc_certificates action=create certificate_type=${ascTypes[0]} key_name=<name> (or let Xcode create it: xcode archive with allow_provisioning_updates).`,
    });
  }
  if (ctx.platform.isMac && identities.length) {
    try {
      const inter = await intermediateStatus(ctx);
      const missing = inter.filter((i) => !i.found && !i.name.includes("G1"));
      if (missing.length)
        add({
          id: "intermediates",
          title: "Apple intermediate certificates",
          status: "warn",
          detail: `Not found: ${missing.map((m) => m.name).join(", ")}`,
          fix: "keychain action=install_intermediates (only needed if codesign reports chain errors)",
        });
    } catch {
      /* ignore */
    }
  }

  // ---- entitlements in the project
  const restricted = Object.keys(artifactEntitlements).filter((k) => entitlementInfo(k)?.requiresProfile);
  if (opts.target === "mac-app-store" || opts.target === "testflight-mac") {
    const sandboxed =
      artifactEntitlements["com.apple.security.app-sandbox"] === true ||
      (component?.signing as Record<string, unknown> | undefined)?.mas !== undefined;
    add(
      sandboxed
        ? { id: "sandbox", title: "App Sandbox", status: "ok", detail: "Sandbox entitlement present." }
        : {
            id: "sandbox",
            title: "App Sandbox",
            status: component ? "missing" : "unknown",
            detail: "Mac App Store apps must be sandboxed.",
            fix: "entitlements action=generate preset=sandbox-basic (Electron: electron-mas + electron-mas-inherit)",
          },
    );
  }
  if (artifactEntitlements["com.apple.security.get-task-allow"] === true && opts.target !== "mac-development")
    add({
      id: "get-task-allow",
      title: "Debug entitlement",
      status: "missing",
      detail: "get-task-allow is in the entitlements file.",
      fix: "Remove it; build the Release configuration.",
    });

  // ---- portal: bundle ID + capabilities
  const profileNeeded = t.profile && (t.profile.required === "always" || restricted.length > 0);
  let bundleRes: AscResource | undefined;
  if (bundleId && client && (isStore || profileNeeded)) {
    try {
      const res = await client.list("bundleIds", { "filter[identifier]": bundleId }, 20);
      bundleRes = res.data.find((b) => b.attributes?.identifier === bundleId);
      add(
        bundleRes
          ? {
              id: "bundle-id",
              title: `Bundle ID ${bundleId} registered`,
              status: "ok",
              detail: `${bundleRes.attributes?.platform} (id ${bundleRes.id})`,
            }
          : {
              id: "bundle-id",
              title: `Bundle ID ${bundleId} registered`,
              status: "missing",
              detail: "Not registered in the developer portal.",
              fix: `asc_bundle_ids action=create bundle_id=${bundleId} name=<name> platform=${t.platform === "iOS" ? "IOS" : "MAC_OS"}`,
            },
      );
      if (bundleRes && restricted.length) {
        const caps = (await client.list(`bundleIds/${bundleRes.id}/bundleIdCapabilities`, {}, 100)).data.map(
          (c) => String(c.attributes?.capabilityType),
        );
        const needed = [
          ...new Set(
            restricted.map((k) => entitlementInfo(k)?.ascCapability).filter((x): x is string => !!x),
          ),
        ];
        const missingCaps = needed.filter((c) => !caps.includes(c));
        add(
          missingCaps.length
            ? {
                id: "capabilities",
                title: "Capabilities on the App ID",
                status: "missing",
                detail: `Entitlements need ${missingCaps.join(", ")}.`,
                fix: missingCaps
                  .map(
                    (c) =>
                      `asc_bundle_ids action=enable_capability bundle_id=${bundleId} capability_type=${c}`,
                  )
                  .join("; "),
              }
            : {
                id: "capabilities",
                title: "Capabilities on the App ID",
                status: "ok",
                detail: needed.length ? needed.join(", ") : "No capability-backed entitlements.",
              },
        );
      }
    } catch (e) {
      add({
        id: "bundle-id",
        title: `Bundle ID ${bundleId}`,
        status: "unknown",
        detail: (e as Error).message,
      });
    }
  }

  // ---- provisioning profile
  if (t.profile && bundleId) {
    if (!profileNeeded) {
      add({
        id: "profile",
        title: `Provisioning profile (${t.profile.ascType})`,
        status: "ok",
        detail: "Not needed: no restricted entitlements detected.",
      });
    } else {
      let local: Awaited<ReturnType<typeof listInstalledProfiles>> = [];
      if (ctx.platform.isMac) local = await listInstalledProfiles(ctx).catch(() => []);
      const kindMatch = (k: string) => k.startsWith(t.profile!.ascType);
      const matching = local.filter(
        (p) =>
          (p.bundleId === bundleId ||
            p.bundleId === "*" ||
            (p.bundleId?.endsWith("*") && bundleId.startsWith(p.bundleId.slice(0, -1)))) &&
          !p.expired &&
          kindMatch(p.kind),
      );
      if (matching.length)
        add({
          id: "profile",
          title: `Provisioning profile (${t.profile.ascType})`,
          status: "ok",
          detail: `Installed: "${matching[0].name}", expires ${matching[0].expires?.slice(0, 10)}`,
        });
      else {
        let portal: AscResource[] = [];
        if (client && bundleRes)
          portal = (
            await client
              .list(`bundleIds/${bundleRes.id}/profiles`, {}, 50)
              .catch(() => ({ data: [] as AscResource[] }))
          ).data.filter(
            (p) =>
              p.attributes?.profileType === t.profile!.ascType && p.attributes?.profileState === "ACTIVE",
          );
        add({
          id: "profile",
          title: `Provisioning profile (${t.profile.ascType})`,
          status: "missing",
          detail: portal.length
            ? `Active in the portal ("${portal[0].attributes?.name}") but not installed here.`
            : "None installed or in the portal.",
          fix: portal.length
            ? `asc_profiles action=download_install profile_id=${portal[0].id}`
            : `asc_profiles action=create profile_type=${t.profile.ascType} bundle_id=${bundleId} (or Xcode automatic signing: xcode archive allow_provisioning_updates=true)`,
        });
      }
    }
  }

  // ---- App Store Connect app record + build numbers
  if (isStore && bundleId) {
    if (!client)
      add({
        id: "app-record",
        title: "App Store Connect app record",
        status: "unknown",
        detail: "Needs a working API key to check.",
      });
    else {
      try {
        const apps = await client.list("apps", { "filter[bundleId]": bundleId }, 5);
        const app = apps.data.find((a) => a.attributes?.bundleId === bundleId);
        if (!app)
          add({
            id: "app-record",
            title: "App Store Connect app record",
            status: "missing",
            detail: `No app record for ${bundleId}.`,
            fix: `asc_apps action=create_instructions bundle_id=${bundleId} (manual, ~2 minutes in the web UI)`,
          });
        else {
          add({
            id: "app-record",
            title: "App Store Connect app record",
            status: "ok",
            detail: `"${app.attributes?.name}" (app id ${app.id})`,
          });
          const builds = await client
            .list(
              "builds",
              { "filter[app]": app.id, sort: "-uploadedDate", "fields[builds]": "version,processingState" },
              1,
            )
            .catch(() => undefined);
          const latest = builds?.data[0]?.attributes?.version as string | undefined;
          const projectBuild = (
            (component?.signing as Record<string, unknown> | undefined)?.buildNumber as string[] | undefined
          )?.find((b) => !b.includes("$("));
          if (latest)
            add({
              id: "build-number",
              title: "Build number",
              status: projectBuild && compareVersions(projectBuild, latest) <= 0 ? "missing" : "ok",
              detail: `Latest uploaded build: ${latest}${projectBuild ? `; project: ${projectBuild}` : ""}`,
              fix:
                projectBuild && compareVersions(projectBuild, latest) <= 0
                  ? `Bump CFBundleVersion / CURRENT_PROJECT_VERSION above ${latest}`
                  : undefined,
            });
        }
      } catch (e) {
        add({
          id: "app-record",
          title: "App Store Connect app record",
          status: "unknown",
          detail: (e as Error).message,
        });
      }
    }
  }

  // ---- Info.plist level checks (when a built .app is given)
  if (infoPlist) {
    if (isStore && infoPlist.ITSAppUsesNonExemptEncryption === undefined)
      add({
        id: "export-compliance",
        title: "Export compliance key",
        status: "warn",
        detail: "ITSAppUsesNonExemptEncryption not set — every build will wait for a compliance answer.",
        fix: "Add ITSAppUsesNonExemptEncryption=NO if you only use HTTPS / OS crypto.",
      });
    if (
      (opts.target === "mac-app-store" || opts.target === "testflight-mac") &&
      !infoPlist.LSApplicationCategoryType
    )
      add({
        id: "category",
        title: "App category",
        status: "missing",
        detail: "LSApplicationCategoryType is required for the Mac App Store.",
        fix: "Set INFOPLIST_KEY_LSApplicationCategoryType (e.g. public.app-category.productivity).",
      });
  }

  for (const h of t.humanSteps) add({ id: "human", title: "Manual step", status: "manual", detail: h });
  return { items, bundleId, component };
}

export const distributionChecklistTool = defineTool({
  name: "distribution_checklist",
  title: "What is missing to ship this app to a target?",
  description:
    "The zero-context entry point. For a project/artifact path and a target (mac-developer-id, mac-app-store, testflight-mac, ios-app-store, testflight-ios, ios-ad-hoc, ios-development, mac-development, enterprise) it checks: developer tools / Xcode version, App Store Connect API key (and therefore membership), notarization credentials, required certificates in the keychain (and in the portal), Apple intermediates, sandbox / debug entitlements, bundle ID registration + capabilities, provisioning profiles (local and portal), the App Store Connect app record and build numbers, export compliance and category keys, plus the human-only steps. Each item has a status and the exact tool call or manual step that fixes it, in order. Read-only.",
  input: {
    target: z.enum(TARGET_IDS),
    path: z.string().optional().describe("Project directory or built artifact."),
    bundle_id: z.string().optional().describe("Override the detected bundle identifier."),
    profile: profileArg,
  },
  async handler(args, ctx) {
    const t = TARGETS[args.target];
    const { items, bundleId } = await buildChecklist(ctx, {
      path: args.path,
      target: args.target,
      bundleId: args.bundle_id,
      profile: args.profile,
    });
    const blocking = items.filter((i) => i.status === "missing");
    const lines = [
      `${t.title}`,
      t.summary,
      "",
      ...items.map(
        (i) =>
          `${ICON[i.status]} ${i.title}: ${i.detail}${i.fix && i.status !== "ok" ? `\n    → ${i.fix}` : ""}`,
      ),
      "",
      blocking.length
        ? `${blocking.length} blocking item(s). Fix them in order, then re-run this checklist.`
        : "Nothing blocking. Proceed with the steps below.",
      "",
      "Steps for this target:",
      ...t.steps.map((s, i) => `${i + 1}. ${s}`),
    ];
    return {
      summary: lines.join("\n"),
      data: {
        target: args.target,
        bundleId,
        items,
        steps: t.steps,
        ready: blocking.length === 0,
        certificateTypes: CERTIFICATE_TYPES.filter((c) =>
          t.certificates.some((r) => r.alternatives.includes(c.id)),
        ).map((c) => ({ type: c.portalName, createdBy: c.createdBy })),
      },
      next_steps: blocking.length ? blocking.slice(0, 3).map((b) => b.fix ?? b.title) : t.steps.slice(0, 2),
    };
  },
});
