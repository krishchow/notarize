import { randomBytes } from "node:crypto";

/**
 * Long-running operations (xcodebuild archive, notarization waits, uploads,
 * build processing) run in the foreground up to a deadline. If they are still
 * going, the tool returns a job id and the work continues in the background;
 * the `jobs` tool reports status / output and can cancel it.
 */

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface JobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Append output (kept as a bounded ring of lines). */
  log(chunk: string): void;
  /** Update the progress message reported by `jobs status`. */
  progress(message: string): void;
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
  lines: string[];
}

const MAX_LINES = 2000;

export class JobManager {
  private readonly jobs = new Map<
    string,
    JobRecord & { controller: AbortController; promise: Promise<unknown> }
  >();

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
      lines: [],
      controller,
      promise: Promise.resolve(),
    };
    let partial = "";
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
        rec.progress = message;
      },
    };
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
        if (partial) rec.lines.push(partial);
        rec.endedAt = new Date().toISOString();
      }
    })();
    rec.promise = promise.catch(() => undefined);
    this.jobs.set(id, rec);
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
