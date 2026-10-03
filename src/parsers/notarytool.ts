import { type ErrorMatch, matchKnownErrors } from "../knowledge/error-catalog";

export type NotaryStatus = "In Progress" | "Accepted" | "Invalid" | "Rejected" | string;

export interface NotarySubmission {
  id?: string;
  status?: NotaryStatus;
  message?: string;
  name?: string;
  createdDate?: string;
  path?: string;
}

/** Parse any `notarytool … --output-format json` result. */
export function parseNotaryJson(text: string): NotarySubmission & { history?: NotarySubmission[] } {
  const json = extractJson(text);
  if (!json || typeof json !== "object") return { message: text.trim().slice(0, 500) };
  const j = json as Record<string, any>;
  return {
    id: j.id,
    status: j.status,
    message: j.message,
    name: j.name,
    createdDate: j.createdDate,
    path: j.path,
    history: Array.isArray(j.history)
      ? j.history.map((h: Record<string, any>) => ({
          id: h.id,
          status: h.status,
          name: h.name,
          createdDate: h.createdDate,
        }))
      : undefined,
  };
}

export interface NotaryIssue {
  severity: string;
  path?: string;
  message: string;
  docUrl?: string;
  architecture?: string;
  explanation?: ErrorMatch;
}

export interface NotaryLog {
  jobId?: string;
  status?: string;
  statusSummary?: string;
  statusCode?: number;
  archiveFilename?: string;
  uploadDate?: string;
  sha256?: string;
  ticketIssued: boolean;
  issues: NotaryIssue[];
}

/** Parse the developer log JSON from `notarytool log <id>`. */
export function parseNotaryLog(text: string): NotaryLog {
  const j = (extractJson(text) ?? {}) as Record<string, any>;
  const issues: NotaryIssue[] = (Array.isArray(j.issues) ? j.issues : []).map((i: Record<string, any>) => ({
    severity: i.severity ?? "error",
    path: i.path,
    message: i.message ?? "",
    docUrl: i.docUrl,
    architecture: i.architecture,
    explanation: matchKnownErrors(String(i.message ?? ""), ["notarization", "codesign"])[0],
  }));
  return {
    jobId: j.jobId,
    status: j.status,
    statusSummary: j.statusSummary,
    statusCode: j.statusCode,
    archiveFilename: j.archiveFilename,
    uploadDate: j.uploadDate,
    sha256: j.sha256,
    ticketIssued: Array.isArray(j.ticketContents) && j.ticketContents.length > 0,
    issues,
  };
}

/** Group issues by message so 200 identical "not signed" lines become one entry. */
export function groupIssues(
  issues: NotaryIssue[],
): { message: string; count: number; paths: string[]; explanation?: ErrorMatch; docUrl?: string }[] {
  const groups = new Map<
    string,
    { message: string; count: number; paths: string[]; explanation?: ErrorMatch; docUrl?: string }
  >();
  for (const i of issues) {
    const g = groups.get(i.message) ?? {
      message: i.message,
      count: 0,
      paths: [],
      explanation: i.explanation,
      docUrl: i.docUrl,
    };
    g.count++;
    if (i.path && g.paths.length < 10 && !g.paths.includes(i.path)) g.paths.push(i.path);
    groups.set(i.message, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** notarytool sometimes prints progress lines before the JSON object. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
