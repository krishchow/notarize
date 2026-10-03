import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import {
  asDict,
  buildPlist,
  decodeProvisioningProfile,
  type PlistDict,
  type PlistValue,
  parsePlistDict,
} from "../core/plist";
import { ToolError } from "../core/result";
import {
  CAPABILITY_SHORTHANDS,
  ENTITLEMENT_PRESETS,
  ENTITLEMENTS,
  type EntitlementsDict,
  entitlementInfo,
  PROFILE_INJECTED_KEYS,
  RISKY_HARDENED_RUNTIME_EXCEPTIONS,
} from "../knowledge/entitlements";
import { TARGET_IDS, TARGETS, type TargetId } from "../knowledge/targets";
import { readBundleInfo } from "../parsers/project/detect";
import {
  type Finding,
  finding,
  formatFindings,
  isDirectory,
  pathExists,
  readSignedEntitlements,
  resolveUserPath,
} from "./shared";
import { defineTool, withConfirmation } from "./types";

export type EntitlementSource = "signature" | "file" | "profile";

/** Load entitlements from a signed binary/bundle, an .entitlements/.plist file, or a provisioning profile. */
export async function loadEntitlements(
  ctx: Parameters<typeof readSignedEntitlements>[0],
  path: string,
): Promise<{ source: EntitlementSource; entitlements: PlistDict; profile?: PlistDict }> {
  const ext = extname(path).toLowerCase();
  if (ext === ".mobileprovision" || ext === ".provisionprofile") {
    const profile = await decodeProvisioningProfile(ctx.runner, path, ctx.platform.isMac);
    return { source: "profile", entitlements: asDict(profile.Entitlements) ?? {}, profile };
  }
  if (ext === ".entitlements" || ext === ".plist" || ext === ".xcent") {
    return { source: "file", entitlements: parsePlistDict(new Uint8Array(await readFile(path))) };
  }
  if (!ctx.platform.isMac)
    throw new ToolError("Reading entitlements from a signed binary requires macOS (codesign).");
  return { source: "signature", entitlements: (await readSignedEntitlements(ctx, path)) ?? {} };
}

/** Wildcard-aware check that a requested entitlement value is granted by a profile value. */
export function valueAllowed(requested: PlistValue, granted: PlistValue | undefined): boolean {
  if (granted === undefined) return false;
  const strMatch = (r: string, g: string) =>
    g === "*" || r === g || (g.endsWith("*") && r.startsWith(g.slice(0, -1)));
  if (typeof requested === "string") {
    if (typeof granted === "string") return strMatch(requested, granted);
    if (Array.isArray(granted)) return granted.some((g) => typeof g === "string" && strMatch(requested, g));
    return false;
  }
  if (Array.isArray(requested)) {
    return requested.every((r) => valueAllowed(r, granted));
  }
  if (typeof requested === "boolean") {
    if (typeof granted === "boolean") return requested === false || granted === true;
    return false;
  }
  return JSON.stringify(requested) === JSON.stringify(granted);
}

export interface ValidationInput {
  entitlements: PlistDict;
  profileEntitlements?: PlistDict;
  target?: TargetId;
  infoPlist?: PlistDict;
  isHelper?: boolean;
}

export function validateEntitlements(input: ValidationInput): Finding[] {
  const f: Finding[] = [];
  const ent = input.entitlements;
  const prof = input.profileEntitlements;
  const t = input.target ? TARGETS[input.target] : undefined;

  if (prof) {
    for (const [key, value] of Object.entries(ent)) {
      if (!valueAllowed(value, prof[key])) {
        if (
          prof[key] === undefined &&
          !entitlementInfo(key)?.requiresProfile &&
          !PROFILE_INJECTED_KEYS.has(key)
        )
          continue;
        f.push(
          finding(
            "error",
            `${key} = ${JSON.stringify(value)} is not granted by the provisioning profile (profile has ${prof[key] === undefined ? "nothing" : JSON.stringify(prof[key])}).`,
            entitlementInfo(key)?.ascCapability
              ? `Enable ${entitlementInfo(key)?.ascCapability} on the bundle ID (asc_bundle_ids enable_capability) and regenerate the profile (asc_profiles regenerate).`
              : "Remove the entitlement or use a profile that grants it.",
          ),
        );
      }
    }
  } else {
    const restricted = Object.keys(ent).filter(
      (k) => entitlementInfo(k)?.requiresProfile && !PROFILE_INJECTED_KEYS.has(k),
    );
    if (restricted.length)
      f.push(
        finding(
          "warning",
          `These entitlements must be granted by a provisioning profile: ${restricted.join(", ")}. Without one the app is killed at launch (macOS) or install fails (iOS).`,
          "Provide/compare against a profile (validate with profile=…) or embed one.",
        ),
      );
  }

  if (t) {
    for (const k of t.forbiddenEntitlements)
      if (ent[k] === true)
        f.push(finding("error", `${k} must not be present for ${t.id}.`, "Build Release / remove it."));
    if (t.sandbox === "required" && ent["com.apple.security.app-sandbox"] !== true)
      f.push(
        finding(
          "error",
          `App Sandbox is required for ${t.id}.`,
          "Add com.apple.security.app-sandbox = true (and inherit for helpers).",
        ),
      );
  }

  if (ent["com.apple.security.inherit"] === true) {
    const extra = Object.keys(ent).filter(
      (k) => !["com.apple.security.inherit", "com.apple.security.app-sandbox"].includes(k),
    );
    if (extra.length)
      f.push(
        finding(
          "error",
          `com.apple.security.inherit must only be combined with app-sandbox; also found ${extra.join(", ")}.`,
          "Strip helper entitlements down to app-sandbox + inherit.",
        ),
      );
  }
  for (const k of RISKY_HARDENED_RUNTIME_EXCEPTIONS) {
    if (ent[k] === true)
      f.push(finding("warning", `${k}: ${entitlementInfo(k)?.risk ?? "weakens hardened runtime"}`));
  }
  if (
    ent["com.apple.security.cs.allow-unsigned-executable-memory"] === true &&
    ent["com.apple.security.cs.allow-jit"] === true
  )
    f.push(
      finding(
        "info",
        "Both allow-jit and allow-unsigned-executable-memory are set; modern JS engines only need allow-jit.",
      ),
    );
  for (const k of Object.keys(ent).filter((k) => k.startsWith("com.apple.security.temporary-exception")))
    f.push(finding("warning", `${k} — App Review scrutinizes temporary exceptions.`));

  if (input.infoPlist) {
    for (const [key, value] of Object.entries(ent)) {
      const info = entitlementInfo(key);
      if (value === true && info?.usageDescriptionKey && !input.infoPlist[info.usageDescriptionKey])
        f.push(
          finding(
            "error",
            `${key} is enabled but Info.plist lacks ${info.usageDescriptionKey}; the permission request will crash or be denied.`,
            `Add ${info.usageDescriptionKey} with a user-facing explanation.`,
          ),
        );
    }
  }

  for (const key of Object.keys(ent)) {
    if (
      !entitlementInfo(key) &&
      !PROFILE_INJECTED_KEYS.has(key) &&
      !key.startsWith("com.apple.security.temporary-exception")
    )
      f.push(finding("info", `${key}: not in the built-in catalog (may be fine — check Apple's docs).`));
  }
  return f;
}

function annotate(ent: PlistDict) {
  return Object.entries(ent).map(([key, value]) => {
    const info = entitlementInfo(key);
    return {
      key,
      value,
      title: info?.title,
      kind: info?.kind,
      requiresProfile: info?.requiresProfile,
      description: info?.description,
      risk: info?.risk,
    };
  });
}

export const entitlementsTool = defineTool({
  name: "entitlements",
  title: "Read, validate, explain or generate entitlements",
  description:
    "action=read: entitlements of a signed app/binary, an .entitlements/.plist file, or a provisioning profile, annotated with what each key does. action=validate: check them against a provisioning profile (wildcards supported), a distribution target (sandbox required, get-task-allow forbidden…), Info.plist usage descriptions, risky hardened-runtime exceptions and helper inherit rules. action=explain: describe keys (or the whole catalog). action=generate: build an .entitlements plist from a preset (electron, electron-mas, electron-mas-inherit, tauri, sandbox-basic, developer-id-minimal) plus capability shorthands; writing to output_path requires confirmation.",
  mutating: true,
  input: {
    action: z.enum(["read", "validate", "explain", "generate"]),
    path: z
      .string()
      .optional()
      .describe("read/validate: app bundle, binary, .entitlements/.plist file, or profile."),
    profile: z
      .string()
      .optional()
      .describe(
        "validate: provisioning profile to validate against (default: the bundle's embedded profile).",
      ),
    target: z.enum(TARGET_IDS).optional().describe("validate/generate: distribution target."),
    keys: z
      .array(z.string())
      .optional()
      .describe("explain: entitlement keys to describe (omit for the full catalog)."),
    preset: z
      .string()
      .optional()
      .describe(`generate: one of ${ENTITLEMENT_PRESETS.map((p) => p.id).join(", ")}`),
    capabilities: z
      .array(z.string())
      .optional()
      .describe(`generate: shorthands — ${Object.keys(CAPABILITY_SHORTHANDS).join(", ")}`),
    extra: z.record(z.string(), z.any()).optional().describe("generate: additional raw key/value pairs."),
    output_path: z.string().optional().describe("generate: write the plist here (requires confirmation)."),
  },
  async handler(args, ctx, extra) {
    if (args.action === "explain") {
      const items = args.keys?.length
        ? args.keys.map((k) => entitlementInfo(k) ?? { key: k, title: "(not in catalog)" })
        : ENTITLEMENTS;
      return {
        summary: items
          .map((i) => `• ${i.key} — ${"description" in i ? `${i.title}: ${i.description}` : i.title}`)
          .join("\n"),
        data: { entitlements: items, presets: args.keys?.length ? undefined : ENTITLEMENT_PRESETS },
      };
    }

    if (args.action === "generate") {
      const ent: EntitlementsDict = {};
      const notes: string[] = [];
      if (args.preset) {
        const p = ENTITLEMENT_PRESETS.find((x) => x.id === args.preset);
        if (!p)
          throw new ToolError(`Unknown preset ${args.preset}.`, {
            hint: `Choose one of ${ENTITLEMENT_PRESETS.map((x) => x.id).join(", ")}`,
          });
        Object.assign(ent, p.entitlements);
        notes.push(...p.notes);
      }
      if (args.target === "mac-app-store" || args.target === "testflight-mac")
        ent["com.apple.security.app-sandbox"] = true;
      for (const c of args.capabilities ?? []) {
        const v = CAPABILITY_SHORTHANDS[c];
        if (!v)
          throw new ToolError(`Unknown capability shorthand "${c}".`, {
            hint: Object.keys(CAPABILITY_SHORTHANDS).join(", "),
          });
        Object.assign(ent, v);
      }
      Object.assign(ent, args.extra ?? {});
      const xml = buildPlist(ent as PlistValue);
      const findings = validateEntitlements({ entitlements: ent as PlistDict, target: args.target });
      const usage = Object.keys(ent)
        .map((k) => entitlementInfo(k)?.usageDescriptionKey)
        .filter(Boolean);
      if (usage.length) notes.push(`Add Info.plist usage descriptions: ${[...new Set(usage)].join(", ")}`);
      const result = {
        summary: `Generated entitlements (${Object.keys(ent).length} keys):\n${xml}${notes.length ? `\nNotes:\n- ${notes.join("\n- ")}` : ""}${findings.length ? `\n\n${formatFindings(findings)}` : ""}`,
        data: { entitlements: ent, plist: xml, notes, findings },
      };
      if (!args.output_path) return result;
      const out = await resolveUserPath(ctx, args.output_path, false);
      const overwriting = await pathExists(out);
      return withConfirmation(
        ctx,
        extra,
        args,
        () => ({
          title: `Write entitlements plist to ${out}`,
          steps: [
            {
              description: `${overwriting ? "Overwrite" : "Create"} ${out} with ${Object.keys(ent).length} keys`,
            },
          ],
          warnings: overwriting ? ["The existing file will be replaced."] : [],
          notes: [xml],
        }),
        async () => {
          await writeFile(out, xml);
          return {
            ...result,
            summary: `Wrote ${out}.\n${result.summary}`,
            data: { ...result.data, written: out },
          };
        },
      );
    }

    if (!args.path) throw new ToolError("path is required for read/validate.");
    const path = await resolveUserPath(ctx, args.path);
    const loaded = await loadEntitlements(ctx, path);

    if (args.action === "read") {
      const ann = annotate(loaded.entitlements);
      return {
        summary: `Entitlements from ${loaded.source} (${path}):\n${ann.length ? ann.map((a) => `• ${a.key} = ${JSON.stringify(a.value)}${a.title ? ` — ${a.title}` : ""}${a.risk ? ` ⚠ ${a.risk}` : ""}`).join("\n") : "(none)"}`,
        data: { source: loaded.source, path, entitlements: loaded.entitlements, annotated: ann },
      };
    }

    // validate
    let profileEnt: PlistDict | undefined;
    let profileSource: string | undefined;
    if (args.profile) {
      const pp = await resolveUserPath(ctx, args.profile);
      const prof = await decodeProvisioningProfile(ctx.runner, pp, ctx.platform.isMac);
      profileEnt = asDict(prof.Entitlements);
      profileSource = pp;
    } else if (await isDirectory(path)) {
      for (const rel of ["Contents/embedded.provisionprofile", "embedded.mobileprovision"]) {
        if (await pathExists(join(path, rel))) {
          const prof = await decodeProvisioningProfile(ctx.runner, join(path, rel), ctx.platform.isMac);
          profileEnt = asDict(prof.Entitlements);
          profileSource = `${rel} (embedded)`;
        }
      }
    }
    const infoPlist = (await isDirectory(path)) ? await readBundleInfo(path) : undefined;
    const findings = validateEntitlements({
      entitlements: loaded.entitlements,
      profileEntitlements: profileEnt,
      target: args.target,
      infoPlist,
    });
    const errors = findings.filter((x) => x.severity === "error").length;
    return {
      summary: `Validated ${Object.keys(loaded.entitlements).length} entitlement(s) from ${loaded.source}${profileSource ? ` against ${profileSource}` : ""}${args.target ? ` for ${args.target}` : ""}: ${errors ? `${errors} error(s)` : "no errors"}.\n${formatFindings(findings) || "All good."}`,
      data: { entitlements: loaded.entitlements, profileEntitlements: profileEnt, profileSource, findings },
    };
  },
});
