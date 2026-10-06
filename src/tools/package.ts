import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { cmdStep, type PlanStep } from "../core/confirm";
import { ok, output } from "../core/exec";
import { requireMacOS } from "../core/platform";
import { ToolError } from "../core/result";
import { formatMatches, matchKnownErrors } from "../knowledge/error-catalog";
import { TARGET_IDS, type TargetId } from "../knowledge/targets";
import { listIdentities, pathExists, pickIdentity, resolveUserPath, scratchDir } from "./shared";
import { defineTool, type ToolContext, withConfirmation } from "./types";

/** ditto zip that notarization accepts (preserves symlinks, resource forks sequestered). */
export function dittoZipArgs(src: string, out: string): string[] {
  return ["-c", "-k", "--sequesterRsrc", "--keepParent", src, out];
}

async function installerIdentity(
  ctx: ToolContext,
  identity: string | undefined,
  target: TargetId | undefined,
): Promise<string | undefined> {
  if (identity === "none") return undefined;
  if (identity && identity !== "auto") return identity;
  const ids = await listIdentities(ctx);
  const types =
    target === "mac-app-store" || target === "testflight-mac"
      ? ["mac-installer-distribution"]
      : ["developer-id-installer"];
  const pick = pickIdentity(ids, types);
  if (!pick)
    throw new ToolError(`No ${types[0]} identity found for signing the .pkg.`, {
      hint:
        types[0] === "developer-id-installer"
          ? "The Account Holder creates a 'Developer ID Installer' certificate in the developer portal (upload a CSR from keychain create_csr), then keychain import_certificate. Or pass identity='none' for an unsigned pkg (cannot be notarized)."
          : "Create a Mac Installer Distribution certificate: keychain create_csr → asc_certificates create certificate_type=MAC_INSTALLER_DISTRIBUTION.",
    });
  // productsign/productbuild want the certificate name (they don't accept SHA-1 on older macOS).
  return pick.name;
}

export interface DmgStyle {
  background?: string;
  windowSize?: { width: number; height: number };
  iconSize?: number;
  iconPositions?: Record<string, [number, number]>;
}

/**
 * appdmg-format JSON that `dmgbuild -s settings.json` reads. dmgbuild writes the window layout
 * into .DS_Store itself, so unlike create-dmg/appdmg it never scripts Finder (works on CI).
 */
export function dmgbuildSettings(app: string, volumeName: string, style: DmgStyle): Record<string, unknown> {
  const { width, height } = style.windowSize ?? { width: 640, height: 400 };
  const appName = basename(app);
  const pos = style.iconPositions ?? {};
  for (const name of Object.keys(pos))
    if (name !== appName && name !== "Applications")
      throw new ToolError(`icon_positions: unknown item "${name}".`, {
        hint: `The DMG holds "${appName}" and "Applications".`,
      });
  const y = Math.round(height * 0.45);
  return {
    title: volumeName,
    ...(style.background ? { background: style.background } : {}),
    "icon-size": style.iconSize ?? 128,
    window: { position: { x: 200, y: 120 }, size: { width, height } },
    format: "UDZO",
    contents: [
      {
        type: "file",
        path: app,
        x: pos[appName]?.[0] ?? Math.round(width * 0.25),
        y: pos[appName]?.[1] ?? y,
      },
      {
        type: "link",
        path: "/Applications",
        name: "Applications",
        x: pos.Applications?.[0] ?? Math.round(width * 0.75),
        y: pos.Applications?.[1] ?? y,
      },
    ],
  };
}

export const packageTool = defineTool({
  name: "package",
  title: "Package an app as .zip, .dmg or .pkg (optionally signed)",
  description:
    "action=zip: `ditto -c -k --sequesterRsrc --keepParent` (the zip format notarization accepts; plain `zip` breaks framework symlinks). action=dmg: compressed UDZO disk image with an /Applications shortcut, optionally codesigned with Developer ID (recommended before notarizing). With background / window_size / icon_size / icon_positions it builds a styled DMG with `dmgbuild` (pipx install dmgbuild), which writes the window layout directly instead of scripting Finder, so it needs no Automation permission and works headless/on CI. action=pkg: productbuild installer that installs into /Applications, signed with Developer ID Installer (direct distribution) or Mac Installer Distribution (Mac App Store upload, target=mac-app-store). action=sign_pkg: productsign an existing pkg. Writing a new file runs directly; overwriting or signing needs confirmation.",
  mutating: true,
  input: {
    action: z.enum(["zip", "dmg", "pkg", "sign_pkg"]),
    path: z.string().describe("The .app (or .pkg for sign_pkg)."),
    output_path: z.string().optional().describe("Output file (default next to the input)."),
    target: z.enum(TARGET_IDS).optional().describe("pkg: mac-developer-id (default) or mac-app-store."),
    identity: z
      .string()
      .optional()
      .describe(
        "dmg: Developer ID Application identity to sign the DMG ('auto' or omit to skip). pkg/sign_pkg: installer identity name, 'auto' (default) or 'none'.",
      ),
    volume_name: z.string().optional().describe("dmg: volume name (default app name)."),
    background: z
      .string()
      .optional()
      .describe("dmg (styled): background image (.png; a name@2x.png next to it is used on Retina)."),
    window_size: z
      .object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(150).max(4000) })
      .optional()
      .describe("dmg (styled): Finder window size in points; match the background image (default 640x400)."),
    icon_size: z
      .number()
      .int()
      .min(16)
      .max(512)
      .optional()
      .describe("dmg (styled): icon size (default 128)."),
    icon_positions: z
      .record(z.string(), z.tuple([z.number(), z.number()]))
      .optional()
      .describe(
        'dmg (styled): icon centres in window points, keyed by "<App>.app" and "Applications", e.g. {"MyApp.app":[160,180],"Applications":[480,180]}. Default: side by side.',
      ),
    install_location: z.string().optional().describe("pkg: default /Applications."),
  },
  async handler(args, ctx, extra) {
    requireMacOS(ctx.platform, "Packaging");
    const src = await resolveUserPath(ctx, args.path);
    const name = basename(src, extname(src));
    const defaultOut = {
      zip: join(dirname(src), `${name}.zip`),
      dmg: join(dirname(src), `${name}.dmg`),
      pkg: join(dirname(src), `${name}.pkg`),
      sign_pkg: join(dirname(src), `${name}-signed.pkg`),
    }[args.action];
    const out = args.output_path ? await resolveUserPath(ctx, args.output_path, false) : defaultOut;
    const exists = await pathExists(out);

    const steps: PlanStep[] = [];
    let run: () => Promise<{ ok: boolean; detail: string }>;
    let signing = false;

    if (args.action === "zip") {
      const cmd = dittoZipArgs(src, out);
      steps.push(cmdStep("Create zip", "ditto", cmd));
      run = async () => {
        const r = await ctx.runner.run("ditto", cmd, { timeoutMs: 1800000 });
        return { ok: ok(r), detail: output(r) };
      };
    } else if (
      args.action === "dmg" &&
      (args.background || args.window_size || args.icon_size || args.icon_positions)
    ) {
      const vol = args.volume_name ?? name;
      const background = args.background ? await resolveUserPath(ctx, args.background) : undefined;
      const settingsJson = dmgbuildSettings(src, vol, {
        background,
        windowSize: args.window_size,
        iconSize: args.icon_size,
        iconPositions: args.icon_positions as Record<string, [number, number]> | undefined,
      });
      const probe = await ctx.runner.run("dmgbuild", ["--help"], { timeoutMs: 30000 });
      if (probe.spawnError)
        throw new ToolError(
          "A styled DMG needs dmgbuild, which isn't installed (or isn't on the server's PATH).",
          {
            hint: "Install it with `pipx install dmgbuild` (or `pip3 install --user dmgbuild`), then restart the MCP server so it sees the new PATH. Or drop the style options for a plain DMG.",
          },
        );
      const settings = join(await scratchDir("dmg"), "dmgbuild-settings.json");
      const create = ["-s", settings, "--", vol, out];
      const identity =
        args.identity && args.identity !== "none"
          ? args.identity === "auto"
            ? await autoDevId(ctx)
            : args.identity
          : undefined;
      const sign = identity ? ["--force", "--sign", identity, "--timestamp", out] : undefined;
      signing = !!sign;
      steps.push(
        { description: `Write the dmgbuild layout to ${settings}` },
        cmdStep("Build the styled disk image (writes .DS_Store directly; no Finder)", "dmgbuild", create),
        ...(sign ? [cmdStep("Sign the DMG with Developer ID", "codesign", sign)] : []),
      );
      run = async () => {
        await writeFile(settings, JSON.stringify(settingsJson, null, 2));
        await rm(out, { force: true });
        const r = await ctx.runner.run("dmgbuild", create, { timeoutMs: 1800000, logName: "dmgbuild" });
        await rm(dirname(settings), { recursive: true, force: true }).catch(() => {});
        if (!ok(r)) return { ok: false, detail: output(r) };
        if (sign) {
          const s = await ctx.runner.run("codesign", sign, { timeoutMs: 300000 });
          if (!ok(s)) return { ok: false, detail: output(s) };
        }
        return { ok: true, detail: "" };
      };
    } else if (args.action === "dmg") {
      const staging = join(await scratchDir("dmg"), args.volume_name ?? name);
      const vol = args.volume_name ?? name;
      const create = ["create", "-volname", vol, "-srcfolder", staging, "-ov", "-format", "UDZO", out];
      const identity =
        args.identity && args.identity !== "none"
          ? args.identity === "auto"
            ? await autoDevId(ctx)
            : args.identity
          : undefined;
      const sign = identity ? ["--force", "--sign", identity, "--timestamp", out] : undefined;
      signing = !!sign;
      steps.push(
        { description: `Stage ${basename(src)} + /Applications symlink in ${staging}` },
        cmdStep("Create compressed disk image", "hdiutil", create),
        ...(sign ? [cmdStep("Sign the DMG with Developer ID", "codesign", sign)] : []),
      );
      run = async () => {
        await mkdir(staging, { recursive: true });
        const cp = await ctx.runner.run("ditto", [src, join(staging, basename(src))], { timeoutMs: 1800000 });
        if (!ok(cp)) return { ok: false, detail: output(cp) };
        await symlink("/Applications", join(staging, "Applications")).catch(() => {});
        const r = await ctx.runner.run("hdiutil", create, { timeoutMs: 1800000, logName: "hdiutil" });
        await rm(dirname(staging), { recursive: true, force: true }).catch(() => {});
        if (!ok(r)) return { ok: false, detail: output(r) };
        if (sign) {
          const s = await ctx.runner.run("codesign", sign, { timeoutMs: 300000 });
          if (!ok(s)) return { ok: false, detail: output(s) };
        }
        return { ok: true, detail: "" };
      };
    } else if (args.action === "pkg") {
      const identity = await installerIdentity(ctx, args.identity ?? "auto", args.target);
      const isMas = args.target === "mac-app-store" || args.target === "testflight-mac";
      const cmd = ["--component", src, args.install_location ?? "/Applications"];
      if (identity) cmd.push("--sign", identity);
      if (identity && !isMas) cmd.push("--timestamp");
      cmd.push(out);
      signing = !!identity;
      steps.push(
        cmdStep(`Build ${identity ? "signed " : "UNSIGNED "}installer package`, "productbuild", cmd),
      );
      run = async () => {
        const r = await ctx.runner.run("productbuild", cmd, { timeoutMs: 1800000, logName: "productbuild" });
        return { ok: ok(r), detail: output(r) };
      };
    } else {
      const identity = await installerIdentity(ctx, args.identity ?? "auto", args.target);
      if (!identity) throw new ToolError("sign_pkg needs an installer identity.");
      const cmd = ["--sign", identity, "--timestamp", src, out];
      signing = true;
      steps.push(cmdStep("Sign the package", "productsign", cmd));
      run = async () => {
        const r = await ctx.runner.run("productsign", cmd, { timeoutMs: 600000 });
        return { ok: ok(r), detail: output(r) };
      };
    }

    const execute = async () => {
      if (exists && args.action !== "dmg") await rm(out, { force: true, recursive: true });
      const r = await run();
      if (!r.ok) {
        const known = matchKnownErrors(r.detail);
        return {
          summary: `${args.action} FAILED:\n${r.detail.slice(0, 1500)}${known.length ? `\n\n${formatMatches(known)}` : ""}`,
          data: { output: r.detail },
          isError: true,
        };
      }
      return {
        summary: `Created ${out}.`,
        data: { output: out },
        next_steps:
          args.action === "zip"
            ? ["notary action=submit path=<zip> (or notarize_and_staple on the .app, which zips for you)"]
            : args.action === "pkg" && (args.target === "mac-app-store" || args.target === "testflight-mac")
              ? ["upload_build path=<pkg>"]
              : ["notarize_and_staple path=<this file>"],
      };
    };

    if (!exists && !signing) return execute();
    return withConfirmation(
      ctx,
      extra,
      args,
      () => ({
        title: `${args.action} ${basename(src)} → ${out}`,
        steps,
        warnings: exists ? [`${out} already exists and will be replaced.`] : [],
      }),
      execute,
    );
  },
});

async function autoDevId(ctx: ToolContext): Promise<string> {
  const pick = pickIdentity(await listIdentities(ctx), ["developer-id-application"]);
  if (!pick) throw new ToolError("No Developer ID Application identity to sign the DMG.");
  return pick.sha1;
}
