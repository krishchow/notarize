import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Long-running operations (xcodebuild archive, notarization waits, uploads,
 * build processing) run in the foreground up to a deadline. If they are still
 * going, the tool returns a job id and the work continues in the background;
 * the `jobs` tool reports status / output and can cancel it.
 *
 * Every job is also mirrored to `<stateDir>/<id>.json` (status, progress,
 * metadata such as the notarization submission id, a heartbeat, and the final
 * summary) so that `notarize-mcp watch-job <id>` — e.g. inside a Claude Code
 * Monitor — can follow it from outside the MCP server process.
 */

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface JobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Append output (kept as a bounded ring of lines). */
  log(chunk: string): void;
  /** Update the progress message reported by `jobs status` / watch-job. */
  progress(message: string): void;
  /** Attach durable metadata (e.g. submissionId) visible to watchers. */
  setMeta(key: string, value: unknown): void;
}

export interface JobRecord {
  id: string;
  name: string;
  description: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  progress?: string;
  error?: string;
  result?: unknown;
  meta: Record<string, unknown>;
  lines: string[];
}

/** What is written to disk for external watchers. */
export interface JobStateFile {
  id: string;
  name: string;
  description: string;
  status: JobStatus;
  /** True when the job completed but its result is a failure (e.g. notarization Invalid). */
  resultIsError?: boolean;
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  pid: number;
  progress?: string;
  error?: string;
  summary?: string;
  meta: Record<string, unknown>;
}

const MAX_LINES = 2000;
export const HEARTBEAT_MS = 30_000;

export class JobManager {
  private readonly jobs = new Map<
    string,
    JobRecord & { controller: AbortController; promise: Promise<unknown> }
  >();

  constructor(readonly stateDir?: string) {}

  statePath(id: string): string | undefined {
    return this.stateDir ? join(this.stateDir, `${id}.json`) : undefined;
  }

  private persist(rec: JobRecord): void {
    const path = this.statePath(rec.id);
    if (!path) return;
    const result = rec.result as { summary?: string; isError?: boolean } | undefined;
    const state: JobStateFile = {
      id: rec.id,
      name: rec.name,
      description: rec.description,
      status: rec.status,
      resultIsError: result?.isError ? true : undefined,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      progress: rec.progress,
      error: rec.error,
      summary: typeof result?.summary === "string" ? result.summary.slice(0, 4000) : undefined,
      meta: rec.meta,
    };
    try {
      mkdirSync(this.stateDir!, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      /* state mirroring is best-effort */
    }
  }

  start<T>(
    name: string,
    description: string,
    task: (job: JobHandle) => Promise<T>,
  ): { id: string; promise: Promise<T> } {
    const id = `job_${randomBytes(4).toString("hex")}`;
    const controller = new AbortController();
    const rec: JobRecord & { controller: AbortController; promise: Promise<unknown> } = {
      id,
      name,
      description,
      status: "running",
      startedAt: new Date().toISOString(),
      meta: {},
      lines: [],
      controller,
      promise: Promise.resolve(),
    };
    let partial = "";
    const persist = () => this.persist(rec);
    const handle: JobHandle = {
      id,
      signal: controller.signal,
      log(chunk: string) {
        const parts = (partial + chunk).split("\n");
        partial = parts.pop() ?? "";
        rec.lines.push(...parts);
        if (rec.lines.length > MAX_LINES) rec.lines.splice(0, rec.lines.length - MAX_LINES);
      },
      progress(message: string) {
        if (rec.progress === message) return;
        rec.progress = message;
        persist();
      },
      setMeta(key: string, value: unknown) {
        rec.meta[key] = value;
        persist();
      },
    };
    this.jobs.set(id, rec);
    persist();
    const heartbeat = this.stateDir ? setInterval(persist, HEARTBEAT_MS) : undefined;
    heartbeat?.unref();
    const promise = (async () => {
      try {
        const result = await task(handle);
        rec.status = controller.signal.aborted ? "cancelled" : "succeeded";
        rec.result = result;
        return result;
      } catch (e) {
        rec.status = controller.signal.aborted ? "cancelled" : "failed";
        rec.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (partial) rec.lines.push(partial);
        rec.endedAt = new Date().toISOString();
        persist();
      }
    })();
    rec.promise = promise.catch(() => undefined);
    return { id, promise };
  }

  /**
   * Run `task` as a job and wait up to `maxWaitMs`. Returns the value if it
   * finished in time, otherwise the job id so the caller can poll later.
   */
  async runWithDeadline<T>(
    name: string,
    description: string,
    maxWaitMs: number,
    task: (job: JobHandle) => Promise<T>,
  ): Promise<{ done: true; value: T; jobId: string } | { done: false; jobId: string }> {
    const { id, promise } = this.start(name, description, task);
    // Settle-wrapped so a rejection after the deadline is never unhandled.
    const settled = promise.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, maxWaitMs));
    });
    try {
      const winner = await Promise.race([settled, deadline]);
      if (winner === "timeout") return { done: false, jobId: id };
      if (!winner.ok) throw winner.e;
      return { done: true, value: winner.v, jobId: id };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** State files from earlier/other server processes (not in this process's memory). */
  persisted(opts: { maxAgeDays?: number; now?: number } = {}): PersistedJob[] {
    return readPersistedJobs(this.stateDir, { ...opts, exclude: new Set(this.jobs.keys()) });
  }

  get(id: string): JobRecord | undefined {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    const { controller: _c, promise: _p, ...rest } = j;
    return rest;
  }

  list(): JobRecord[] {
    return [...this.jobs.keys()].map((id) => this.get(id)!).reverse();
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (j?.status !== "running") return false;
    j.controller.abort();
    return true;
  }

  async wait(id: string, maxWaitMs: number): Promise<JobRecord | undefined> {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      j.promise,
      new Promise((r) => {
        timer = setTimeout(r, maxWaitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return this.get(id);
  }
}

export type PersistedJob = JobStateFile & {
  /** "running" jobs whose owning process died or stopped heart-beating. */
  lost: boolean;
  /** Owned by another live server process (cannot be cancelled from here). */
  foreign: boolean;
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Classify a state file written by any server process. */
export function classifyJobState(s: JobStateFile, now = Date.now(), selfPid = process.pid): PersistedJob {
  const running = s.status === "running";
  const stale = now - Date.parse(s.updatedAt) > HEARTBEAT_MS * 4;
  const dead = s.pid !== selfPid && !pidAlive(s.pid);
  return { ...s, lost: running && (dead || stale), foreign: s.pid !== selfPid && !dead };
}

/**
 * Jobs persisted by previous (or other) server processes, newest first.
 * Prunes state files older than `maxAgeDays`.
 */
export function readPersistedJobs(
  stateDir: string | undefined,
  opts: { exclude?: Set<string>; maxAgeDays?: number; now?: number } = {},
): PersistedJob[] {
  if (!stateDir) return [];
  const now = opts.now ?? Date.now();
  const maxAge = (opts.maxAgeDays ?? 30) * 86_400_000;
  let files: string[];
  try {
    files = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PersistedJob[] = [];
  for (const f of files) {
    const path = join(stateDir, f);
    const s = readJobState(path);
    if (!s) continue;
    if (now - Date.parse(s.updatedAt) > maxAge) {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (opts.exclude?.has(s.id)) continue;
    out.push(classifyJobState(s, now));
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Read a persisted job state file (used by the watch-job CLI). */
export function readJobState(path: string): JobStateFile | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JobStateFile;
  } catch {
    return undefined;
  }
}
