import { jobMonitor } from "../core/monitor";
import type { ToolOutput } from "../core/result";
import type { ToolContext } from "./types";

/**
 * Result for work that is still running in a background job. Includes a
 * ready-made Monitor command so agents can be notified on completion instead
 * of blocking or polling.
 */
export function detachedOutput(
  ctx: ToolContext,
  jobId: string,
  what: string,
  extraLines: string[] = [],
): ToolOutput {
  const job = ctx.jobs.get(jobId);
  const submissionId = job?.meta.submissionId as string | undefined;
  const monitor = jobMonitor({
    jobId,
    description: what,
    stateDir: ctx.jobs.stateDir,
    submissionId,
  });
  return {
    summary: [
      `${what} is still running in background job ${jobId}${submissionId ? ` (Apple submission ${submissionId})` : ""}.`,
      job?.progress ? `Current step: ${job.progress}` : undefined,
      ...extraLines,
      "",
      "Do not block or re-submit. Watch it instead:",
      `• Claude Code: start the Monitor tool with command \`${monitor.command}\`, description "${what}", timeout_ms 1800000 (re-arm if it expires). Keep working; you'll be notified on completion.`,
      `• Otherwise: jobs action=status job_id=${jobId} wait_seconds=600 (repeat until finished).`,
      submissionId
        ? `• If this server restarts, the job is lost but Apple keeps processing: \`${monitor.fallback_command}\` or notary action=status submission_id=${submissionId}.`
        : undefined,
    ]
      .filter((l) => l !== undefined)
      .join("\n"),
    data: { status: "running", job_id: jobId, submission_id: submissionId, monitor },
    next_steps: [
      `Monitor: ${monitor.command}`,
      `When it reports completion: jobs action=status job_id=${jobId}`,
    ],
  };
}
