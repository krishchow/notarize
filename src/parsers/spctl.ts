export interface SpctlAssessment {
  path?: string;
  accepted: boolean;
  /** e.g. "Notarized Developer ID", "Unnotarized Developer ID", "no usable signature", "Apple System" */
  source?: string;
  origin?: string;
  /** Extra reason text after "rejected (…)". */
  reason?: string;
  notarized: boolean;
  raw: string;
}

/** Parse `spctl --assess -vvv` output (stderr). */
export function parseSpctl(text: string, exitCode: number | null): SpctlAssessment {
  const first = text.split("\n").find((l) => /: (accepted|rejected)/.test(l)) ?? "";
  const m = /^(.*): (accepted|rejected)(?:\s*\((.*)\))?/.exec(first.trim());
  const source = /^source=(.*)$/m.exec(text)?.[1]?.trim();
  const origin = /^origin=(.*)$/m.exec(text)?.[1]?.trim();
  const accepted = m ? m[2] === "accepted" : exitCode === 0;
  return {
    path: m?.[1],
    accepted,
    source,
    origin,
    reason: m?.[3],
    notarized: !!source && /^Notarized/i.test(source),
    raw: text.trim(),
  };
}

export interface SyspolicyCheckResult {
  passed: boolean;
  issues: string[];
  raw: string;
}

/** Parse `syspolicy_check distribution|notary-submission <app>` (macOS 14+). */
export function parseSyspolicyCheck(text: string, exitCode: number | null): SyspolicyCheckResult {
  const lines = text.split("\n").map((l) => l.trimEnd());
  const issues: string[] = [];
  let capture = false;
  for (const line of lines) {
    if (/^(Error|Warning|Issue|Notary|Codesign|Gatekeeper|XProtect)/i.test(line.trim()) && /:/.test(line)) {
      capture = true;
    }
    if (capture && line.trim()) issues.push(line.trim());
  }
  const passed = exitCode === 0 && !/fail|error/i.test(text.replace(/0 errors?/gi, ""));
  return { passed: passed || /App passed all pre-distribution checks/i.test(text), issues, raw: text.trim() };
}
