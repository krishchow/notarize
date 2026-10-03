import { classifyCertificateName, teamIdFromCertName } from "../knowledge/certificate-types";

export interface KeychainIdentity {
  sha1: string;
  name: string;
  valid: boolean;
  /** e.g. CSSMERR_TP_CERT_EXPIRED, CSSMERR_TP_NOT_TRUSTED, CSSMERR_TP_CERT_REVOKED */
  invalidReason?: string;
  type?: string;
  typeName?: string;
  teamId?: string;
}

/**
 * Parse `security find-identity -p codesigning` (without -v) which lists all
 * matching identities with failure reasons, followed by the valid subset.
 */
export function parseFindIdentity(text: string): KeychainIdentity[] {
  const byHash = new Map<string, KeychainIdentity>();
  const lineRe = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"(?:\s+\((\S+)\))?\s*$/;
  let section: "matching" | "valid" | "unknown" = "unknown";
  for (const line of text.split("\n")) {
    if (/Matching identities/i.test(line)) section = "matching";
    else if (/Valid identities only/i.test(line)) section = "valid";
    const m = lineRe.exec(line);
    if (!m) continue;
    const [, sha1, name, reason] = m;
    const existing = byHash.get(sha1);
    const type = classifyCertificateName(name);
    const rec: KeychainIdentity = existing ?? {
      sha1,
      name,
      valid: !reason,
      invalidReason: reason,
      type: type?.id,
      typeName: type?.portalName,
      teamId: teamIdFromCertName(name),
    };
    if (reason) {
      rec.valid = false;
      rec.invalidReason = reason;
    } else if (section === "valid") {
      rec.valid = true;
    }
    byHash.set(sha1, rec);
  }
  return [...byHash.values()];
}

/** Parse `security find-certificate -a -Z [-c name]` → SHA-1 + label pairs. */
export function parseFindCertificateZ(text: string): { sha1: string; label?: string }[] {
  const out: { sha1: string; label?: string }[] = [];
  let current: { sha1: string; label?: string } | undefined;
  for (const line of text.split("\n")) {
    const h = /^SHA-1 hash:\s*([0-9A-F]{40})/.exec(line);
    if (h) {
      current = { sha1: h[1] };
      out.push(current);
      continue;
    }
    const l = /"labl"<blob>="(.*)"/.exec(line);
    if (l && current && !current.label) current.label = l[1];
  }
  return out;
}

/** Find identities that share a common name (codesign would report "ambiguous"). */
export function duplicateNames(ids: KeychainIdentity[]): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id.name, (counts.get(id.name) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
}

/** Parse `security list-keychains -d user` output. */
export function parseKeychainList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}
