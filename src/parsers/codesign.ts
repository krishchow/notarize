/**
 * Parsers for `codesign -dvvv` (display), `codesign --verify` output and
 * `codesign -d --entitlements - --xml`.
 */

export interface CodeSignatureInfo {
  executable?: string;
  identifier?: string;
  format?: string;
  codeDirectoryVersion?: string;
  flags: string[];
  flagsHex?: string;
  hashType?: string;
  cdHash?: string;
  authorities: string[];
  teamIdentifier?: string;
  timestamp?: string;
  /** Secure (Apple TSA) timestamp present. */
  hasSecureTimestamp: boolean;
  signedTime?: string;
  isAdhoc: boolean;
  hardenedRuntime: boolean;
  runtimeVersion?: string;
  infoPlistEntries?: number;
  sealedResources?: string;
  isSigned: boolean;
  notarizationTicket?: "stapled" | "none";
  raw: string;
}

/** Parse `codesign -dvvv <path>` (output is on stderr). */
export function parseCodesignDisplay(text: string): CodeSignatureInfo {
  const info: CodeSignatureInfo = {
    flags: [],
    authorities: [],
    hasSecureTimestamp: false,
    isAdhoc: false,
    hardenedRuntime: false,
    isSigned: !/code object is not signed at all|is not signed at all/.test(text),
    raw: text,
  };
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "Executable":
        info.executable = value;
        break;
      case "Identifier":
        info.identifier = value;
        break;
      case "Format":
        info.format = value;
        break;
      case "CodeDirectory v": {
        // "CodeDirectory v=20500 size=… flags=0x10000(runtime) hashes=… location=embedded"
        const m = /^(\S+)/.exec(value);
        info.codeDirectoryVersion = m?.[1];
        const fm = /flags=(0x[0-9a-f]+)\(([^)]*)\)/i.exec(line);
        if (fm) {
          info.flagsHex = fm[1];
          info.flags = fm[2]
            ? fm[2]
                .split(",")
                .map((f) => f.trim())
                .filter(Boolean)
            : [];
        }
        const rv = /runtime=(\S+)/.exec(line);
        if (rv) info.runtimeVersion = rv[1];
        break;
      }
      case "Hash type":
        info.hashType = value;
        break;
      case "CandidateCDHash sha256":
      case "CDHash":
        info.cdHash ??= value;
        break;
      case "Authority":
        info.authorities.push(value);
        break;
      case "TeamIdentifier":
        info.teamIdentifier = value === "not set" ? undefined : value;
        break;
      case "Timestamp":
        info.timestamp = value;
        info.hasSecureTimestamp = true;
        break;
      case "Signed Time":
        info.signedTime = value;
        break;
      case "Signature":
        if (/adhoc/i.test(value)) info.isAdhoc = true;
        break;
      case "Info.plist entries":
        info.infoPlistEntries = Number.parseInt(value, 10);
        break;
      case "Sealed Resources version":
        info.sealedResources = value;
        break;
      case "Runtime Version":
        info.runtimeVersion = value;
        break;
      case "Notarization Ticket":
        info.notarizationTicket = /stapled/i.test(value) ? "stapled" : "none";
        break;
    }
  }
  if (info.flags.includes("adhoc")) info.isAdhoc = true;
  if (info.flags.includes("runtime")) info.hardenedRuntime = true;
  return info;
}

export type SignerKind =
  | "developer-id"
  | "apple-distribution"
  | "apple-development"
  | "mac-app-store"
  | "apple"
  | "adhoc"
  | "unsigned"
  | "unknown";

export function signerKind(info: CodeSignatureInfo): SignerKind {
  if (!info.isSigned) return "unsigned";
  if (info.isAdhoc) return "adhoc";
  const leaf = info.authorities[0] ?? "";
  if (leaf.startsWith("Developer ID Application")) return "developer-id";
  if (leaf.startsWith("Apple Distribution") || leaf.startsWith("iPhone Distribution"))
    return "apple-distribution";
  if (leaf.startsWith("3rd Party Mac Developer Application")) return "apple-distribution";
  if (/^(Apple Development|iPhone Developer|Mac Developer)/.test(leaf)) return "apple-development";
  if (leaf.startsWith("Apple Mac OS Application Signing")) return "mac-app-store";
  if (leaf.startsWith("Software Signing") || leaf.startsWith("Apple Code Signing")) return "apple";
  return "unknown";
}

export interface VerifyResult {
  valid: boolean;
  satisfiesDesignatedRequirement: boolean;
  messages: string[];
  /** Paths mentioned as problems (modified/added/missing files, unsigned subcomponents). */
  problemPaths: { kind: string; path: string }[];
}

/** Parse `codesign --verify --deep --strict --verbose=4` output + exit code. */
export function parseCodesignVerify(text: string, exitCode: number | null): VerifyResult {
  const problemPaths: { kind: string; path: string }[] = [];
  const messages = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of messages) {
    const m = /^(file added|file modified|file missing|In subcomponent|In architecture):\s*(.+)$/.exec(line);
    if (m) problemPaths.push({ kind: m[1], path: m[2] });
  }
  return {
    valid: exitCode === 0,
    satisfiesDesignatedRequirement: /satisfies its Designated Requirement/.test(text),
    messages,
    problemPaths,
  };
}

/** Split `codesign --verify` messages into errors/warnings for display. */
export function summarizeVerify(v: VerifyResult): string {
  if (v.valid) return "Signature verifies (strict, deep).";
  const interesting = v.messages.filter((m) => !/^--prepared:|^--validated:|^--satisfies/.test(m));
  return `Signature INVALID:\n${interesting.slice(0, 15).join("\n")}`;
}
