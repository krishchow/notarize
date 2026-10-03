import { type ErrorMatch, matchKnownErrors } from "../knowledge/error-catalog";

export interface CrashSummary {
  process?: string;
  bundleId?: string;
  appVersion?: string;
  buildVersion?: string;
  osVersion?: string;
  timestamp?: string;
  exceptionType?: string;
  signal?: string;
  terminationNamespace?: string;
  terminationIndicator?: string;
  terminationDetails: string[];
  codeSigning?: { teamId?: string; flags?: number };
  isSigningRelated: boolean;
  explanations: ErrorMatch[];
}

/**
 * Parse an .ips crash report (macOS 12+: a one-line JSON header followed by a
 * JSON body) or a legacy .crash text report.
 */
export function parseCrashReport(text: string): CrashSummary {
  const nl = text.indexOf("\n");
  let header: Record<string, any> = {};
  let body: Record<string, any> = {};
  try {
    header = JSON.parse(nl === -1 ? text : text.slice(0, nl));
    if (nl !== -1) body = JSON.parse(text.slice(nl + 1));
  } catch {
    return parseLegacyCrash(text);
  }
  const term = body.termination ?? {};
  const details: string[] = [
    ...(Array.isArray(term.details) ? term.details : []),
    ...(Array.isArray(term.reasons) ? term.reasons : []),
    ...(Array.isArray(body.asi?.dyld) ? body.asi.dyld : []),
  ].map(String);
  const ns = term.namespace as string | undefined;
  const indicator = term.indicator as string | undefined;
  const joined = [ns, indicator, ...details, body.exception?.type, body.exception?.signal]
    .filter(Boolean)
    .join("\n");
  return {
    process: body.procName ?? header.name ?? header.app_name,
    bundleId: header.bundleID ?? body.bundleInfo?.CFBundleIdentifier,
    appVersion: header.app_version ?? body.bundleInfo?.CFBundleShortVersionString,
    buildVersion: header.build_version ?? body.bundleInfo?.CFBundleVersion,
    osVersion: header.os_version,
    timestamp: header.timestamp ?? body.captureTime,
    exceptionType: body.exception?.type,
    signal: body.exception?.signal,
    terminationNamespace: ns,
    terminationIndicator: indicator,
    terminationDetails: details,
    codeSigning:
      body.codeSigningTeamID || body.codeSigningFlags !== undefined
        ? { teamId: body.codeSigningTeamID || undefined, flags: body.codeSigningFlags }
        : undefined,
    isSigningRelated:
      /CODESIGNING|Code Signature Invalid|Library missing|not valid for use in process|DYLD/i.test(joined),
    explanations: matchKnownErrors(`Namespace ${ns ?? ""}\n${joined}`, ["runtime"]),
  };
}

function parseLegacyCrash(text: string): CrashSummary {
  const get = (re: RegExp) => re.exec(text)?.[1]?.trim();
  const termination = get(/^Termination Reason:\s*(.+)$/m);
  const details = [
    termination,
    get(/^Termination Details:\s*(.+)$/m),
    get(/^(Library not loaded:.+)$/m),
  ].filter(Boolean) as string[];
  return {
    process: get(/^Process:\s*([^[]+)/m),
    bundleId: get(/^Identifier:\s*(\S+)/m),
    appVersion: get(/^Version:\s*(\S+)/m),
    osVersion: get(/^OS Version:\s*(.+)$/m),
    timestamp: get(/^Date\/Time:\s*(.+)$/m),
    exceptionType: get(/^Exception Type:\s*(.+)$/m),
    terminationNamespace: termination ? /Namespace (\w+)/.exec(termination)?.[1] : undefined,
    terminationDetails: details,
    isSigningRelated: /CODESIGNING|Code Signature Invalid|Library not loaded|DYLD/i.test(text),
    explanations: matchKnownErrors(text, ["runtime"]),
  };
}
