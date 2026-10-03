import { open, readdir, readFile, readlink, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { parsePlistDict } from "../core/plist";

/** Mach-O / fat magic numbers (both endians). */
const MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const FAT_MAGICS = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

/** True if the file starts with a Mach-O or universal-binary header. */
export async function isMachO(path: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    if (bytesRead < 8) return false;
    const magic = buf.readUInt32BE(0);
    if (MAGICS.has(magic)) return true;
    if (FAT_MAGICS.has(magic)) {
      // Java class files share 0xCAFEBABE; fat headers have a small arch count.
      const nArch = magic === 0xcafebabe || magic === 0xcafebabf ? buf.readUInt32BE(4) : buf.readUInt32LE(4);
      return nArch > 0 && nArch < 20;
    }
    return false;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

export type CodeKind =
  | "app"
  | "framework"
  | "appex"
  | "xpc"
  | "bundle"
  | "plugin"
  | "kext"
  | "systemextension"
  | "dylib"
  | "executable"
  | "node-module"
  | "other-macho";

export interface NestedCode {
  /** Absolute path of the item to pass to codesign. */
  path: string;
  relativePath: string;
  kind: CodeKind;
  /** Nesting depth (number of enclosing code bundles). Higher = sign earlier. */
  depth: number;
}

const BUNDLE_EXTS: Record<string, CodeKind> = {
  ".app": "app",
  ".framework": "framework",
  ".appex": "appex",
  ".xpc": "xpc",
  ".bundle": "bundle",
  ".plugin": "plugin",
  ".kext": "kext",
  ".systemextension": "systemextension",
  ".qlgenerator": "plugin",
  ".mdimporter": "plugin",
  ".saver": "plugin",
};

/**
 * Discover all signable code inside a bundle and return it in signing order
 * (deepest first, the outer bundle last). Symlinks are not followed, and code
 * inside a nested bundle's main executable slot is covered by that bundle.
 */
export async function discoverNestedCode(root: string): Promise<NestedCode[]> {
  const results: NestedCode[] = [];
  const rootKind = BUNDLE_EXTS[extname(root).toLowerCase()];

  async function walk(dir: string, depth: number, bundleRoot: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        const kind = BUNDLE_EXTS[extname(e.name).toLowerCase()];
        if (kind) {
          // For frameworks sign the versioned bundle (Versions/A) when present.
          const target = kind === "framework" ? await frameworkSignTarget(full) : full;
          await walk(full, depth + 1, full);
          results.push({ path: target, relativePath: relative(root, target) || ".", kind, depth: depth + 1 });
        } else if (e.name !== "_CodeSignature" && e.name !== "Headers" && e.name !== "Modules") {
          await walk(full, depth, bundleRoot);
        }
        continue;
      }
      if (!e.isFile()) continue;
      if (await isMainExecutable(full, bundleRoot)) continue;
      const lower = e.name.toLowerCase();
      if (lower.endsWith(".dylib") || lower.endsWith(".so")) {
        if (await isMachO(full))
          results.push({ path: full, relativePath: relative(root, full), kind: "dylib", depth: depth + 1 });
      } else if (lower.endsWith(".node")) {
        if (await isMachO(full))
          results.push({
            path: full,
            relativePath: relative(root, full),
            kind: "node-module",
            depth: depth + 1,
          });
      } else if (await isExecutableCandidate(full)) {
        if (await isMachO(full))
          results.push({
            path: full,
            relativePath: relative(root, full),
            kind: "executable",
            depth: depth + 1,
          });
      }
    }
  }

  await walk(root, 0, root);
  results.sort((a, b) => b.depth - a.depth);
  if (rootKind) results.push({ path: root, relativePath: ".", kind: rootKind, depth: 0 });
  else if (await isMachO(root))
    results.push({ path: root, relativePath: basename(root), kind: "executable", depth: 0 });
  return results;
}

async function frameworkSignTarget(fw: string): Promise<string> {
  try {
    const current = await readlink(join(fw, "Versions", "Current"));
    const versioned = join(fw, "Versions", current);
    await stat(versioned);
    return versioned;
  } catch {
    return fw;
  }
}

/** The bundle's own main executable is signed as part of the bundle itself. */
async function isMainExecutable(file: string, bundleRoot: string): Promise<boolean> {
  const name = basename(bundleRoot).replace(/\.[^.]+$/, "");
  const candidates = [
    join(bundleRoot, "Contents", "MacOS", name),
    join(bundleRoot, name),
    join(bundleRoot, "Versions", "A", name),
  ];
  if (candidates.includes(file)) return true;
  // Bundles whose executable name differs from the folder name: CFBundleExecutable.
  const rel = relative(bundleRoot, file);
  if (/^Contents\/MacOS\/[^/]+$/.test(rel) || /^Versions\/[^/]+\/[^/]+$/.test(rel)) {
    const exe = await readBundleExecutable(bundleRoot);
    if (exe && basename(file) === exe) return true;
  }
  return false;
}

async function readBundleExecutable(bundleRoot: string): Promise<string | undefined> {
  for (const p of [
    join(bundleRoot, "Contents", "Info.plist"),
    join(bundleRoot, "Info.plist"),
    join(bundleRoot, "Resources", "Info.plist"),
    join(bundleRoot, "Versions", "Current", "Resources", "Info.plist"),
  ]) {
    try {
      const v = parsePlistDict(new Uint8Array(await readFile(p)));
      if (typeof v?.CFBundleExecutable === "string") return v.CFBundleExecutable;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function isExecutableCandidate(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    // Executable bit, or no extension (helpers / CLI tools in Resources).
    return (s.mode & 0o111) !== 0 || extname(path) === "";
  } catch {
    return false;
  }
}
