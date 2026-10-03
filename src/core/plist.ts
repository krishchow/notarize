import { readFile } from "node:fs/promises";
import { build, type PlistValue, parse } from "plist";
import type { CommandRunner } from "./exec";
import { ok } from "./exec";
import { ToolError } from "./result";

export type { PlistValue };
export type PlistDict = { [key: string]: PlistValue };

/** Parse XML, binary (bplist00) or OpenStep plists. */
export function parsePlist(data: string | Uint8Array): PlistValue {
  try {
    return parse(data);
  } catch (e) {
    throw new ToolError(`Could not parse property list: ${(e as Error).message}`);
  }
}

export function parsePlistDict(data: string | Uint8Array): PlistDict {
  const v = parsePlist(data);
  if (!v || typeof v !== "object" || Array.isArray(v) || v instanceof Date || v instanceof Uint8Array) {
    throw new ToolError("Property list root is not a dictionary.");
  }
  return v as PlistDict;
}

export async function readPlistFile(path: string): Promise<PlistDict> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (e) {
    throw new ToolError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  return parsePlistDict(new Uint8Array(buf));
}

export function buildPlist(value: PlistValue): string {
  return build(value, { pretty: true, indent: "\t" });
}

/**
 * Decode a CMS-signed provisioning profile (.mobileprovision / .provisionprofile)
 * into its inner plist. Uses `security cms -D` on macOS, `openssl cms` elsewhere,
 * and falls back to scanning the DER for the embedded XML plist.
 */
export async function decodeProvisioningProfile(
  runner: CommandRunner,
  path: string,
  isMac: boolean,
): Promise<PlistDict> {
  if (isMac) {
    const r = await runner.run("security", ["cms", "-D", "-i", path], { timeoutMs: 15000 });
    if (ok(r) && r.stdout.includes("<plist")) return parsePlistDict(r.stdout);
  } else {
    const r = await runner.run("openssl", ["cms", "-verify", "-noverify", "-inform", "DER", "-in", path], {
      timeoutMs: 15000,
    });
    if (ok(r) && r.stdout.includes("<plist")) return parsePlistDict(r.stdout);
  }
  const buf = await readFile(path).catch((e) => {
    throw new ToolError(`Cannot read ${path}: ${(e as Error).message}`);
  });
  return extractEmbeddedPlist(new Uint8Array(buf));
}

/** CMS SignedData stores the plist as an uncompressed OCTET STRING, so a byte scan works. */
export function extractEmbeddedPlist(der: Uint8Array): PlistDict {
  const text = Buffer.from(der).toString("latin1");
  const start = text.indexOf("<?xml");
  const end = text.indexOf("</plist>");
  if (start === -1 || end === -1) throw new ToolError("No embedded plist found in provisioning profile.");
  const xml = Buffer.from(text.slice(start, end + "</plist>".length), "latin1").toString("utf8");
  return parsePlistDict(xml);
}

export function asString(v: PlistValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asDict(v: PlistValue | undefined): PlistDict | undefined {
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array)
    ? (v as PlistDict)
    : undefined;
}

export function asArray(v: PlistValue | undefined): PlistValue[] {
  return Array.isArray(v) ? v : [];
}
