import { X509Certificate } from "node:crypto";
import { type CertificateTypeInfo, classifyCertificateName } from "../knowledge/certificate-types";

export interface CertificateDetails {
  commonName?: string;
  organizationalUnit?: string;
  organization?: string;
  country?: string;
  userId?: string;
  issuerCommonName?: string;
  issuerOrganizationalUnit?: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
  expired: boolean;
  notYetValid: boolean;
  daysUntilExpiry: number;
  sha1: string;
  sha256: string;
  type?: { id: string; portalName: string };
  /** Team ID for Apple-issued developer certificates (subject OU). */
  teamId?: string;
}

export function parseDistinguishedName(dn: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of dn.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function describeCertificate(input: string | Uint8Array, now = new Date()): CertificateDetails {
  const cert = new X509Certificate(typeof input === "string" ? input : Buffer.from(input));
  const subject = parseDistinguishedName(cert.subject);
  const issuer = parseDistinguishedName(cert.issuer);
  const validTo = new Date(cert.validTo);
  const validFrom = new Date(cert.validFrom);
  const cn = subject.CN;
  const type: CertificateTypeInfo | undefined = cn ? classifyCertificateName(cn) : undefined;
  return {
    commonName: cn,
    organizationalUnit: subject.OU,
    organization: subject.O,
    country: subject.C,
    userId: subject.UID,
    issuerCommonName: issuer.CN,
    issuerOrganizationalUnit: issuer.OU,
    serialNumber: cert.serialNumber,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    expired: validTo.getTime() < now.getTime(),
    notYetValid: validFrom.getTime() > now.getTime(),
    daysUntilExpiry: Math.floor((validTo.getTime() - now.getTime()) / 86_400_000),
    sha1: cert.fingerprint.replace(/:/g, "").toUpperCase(),
    sha256: cert.fingerprint256.replace(/:/g, "").toUpperCase(),
    type: type ? { id: type.id, portalName: type.portalName } : undefined,
    teamId: subject.OU && /^[A-Z0-9]{10}$/.test(subject.OU) ? subject.OU : undefined,
  };
}

/** Split a blob containing multiple PEM certificates. */
export function splitPemCertificates(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

export function derToPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}
