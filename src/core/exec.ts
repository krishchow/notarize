import { spawn } from "node:child_process";
import { type LogWriter, NullLogWriter } from "./logs";
import { formatCommand, redact } from "./redact";

export interface RunOptions {
  cwd?: string;
  /** Extra environment variables (merged over process.env). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string | Uint8Array;
  /** If set, the full transcript is written to a log file with this name. */
  logName?: string;
  /** Values to mask anywhere in logs / formatted commands. */
  secrets?: string[];
  signal?: AbortSignal;
  /** Streamed output callback (stdout+stderr interleaved), used by jobs. */
  onOutput?: (chunk: string) => void;
  /** Return stdout as raw bytes as well (for binary plists, DER, etc.). */
  binary?: boolean;
}

export interface RunResult {
  command: string;
  args: string[];
  /** Exit code; null if the process could not be started or was killed. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes?: Uint8Array;
  durationMs: number;
  timedOut: boolean;
  /** Set when the binary could not be spawned (e.g. ENOENT). */
  spawnError?: string;
  logPath?: string;
}

export interface RunningProcess {
  result: Promise<RunResult>;
  kill(signal?: NodeJS.Signals): void;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  start(cmd: string, args: string[], opts?: RunOptions): RunningProcess;
}

export function ok(r: RunResult): boolean {
  return r.code === 0 && !r.spawnError && !r.timedOut;
}

/** Combined, trimmed output for display / error matching. */
export function output(r: RunResult): string {
  return [r.stdout, r.stderr]
    .filter((s) => s?.trim())
    .join("\n")
    .trim();
}

const MAX_CAPTURE = 32 * 1024 * 1024;

/** Real runner: always spawns with an argv array and never a shell. */
export class SpawnRunner implements CommandRunner {
  constructor(private readonly logs: LogWriter = new NullLogWriter()) {}

  run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return this.start(cmd, args, opts).result;
  }

  start(cmd: string, args: string[], opts: RunOptions = {}): RunningProcess {
    const started = Date.now();
    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderr = "";
    let timedOut = false;
    let killed = false;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const kill = (sig: NodeJS.Signals = "SIGTERM") => {
      if (killed) return;
      killed = true;
      try {
        child.kill(sig);
      } catch {
        /* already exited */
      }
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 5000).unref();
        }, opts.timeoutMs)
      : undefined;
    timer?.unref?.();

    const onAbort = () => kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d: Buffer) => {
      if (stdoutLen < MAX_CAPTURE) {
        stdoutChunks.push(d);
        stdoutLen += d.length;
      }
      opts.onOutput?.(d.toString("utf8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
      opts.onOutput?.(d.toString("utf8"));
    });

    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }

    const result = new Promise<RunResult>((resolve) => {
      let spawnError: string | undefined;
      child.on("error", (err: NodeJS.ErrnoException) => {
        spawnError = err.code === "ENOENT" ? `command not found: ${cmd}` : err.message;
      });
      child.on("close", async (code, signal) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const buf = Buffer.concat(stdoutChunks);
        const res: RunResult = {
          command: cmd,
          args,
          code: spawnError ? null : code,
          signal: signal ?? null,
          stdout: buf.toString("utf8"),
          stderr: spawnError ? `${stderr}${stderr ? "\n" : ""}${spawnError}` : stderr,
          stdoutBytes: opts.binary ? new Uint8Array(buf) : undefined,
          durationMs: Date.now() - started,
          timedOut,
          spawnError,
        };
        if (opts.logName) {
          res.logPath = await this.logs.write(opts.logName, transcript(res, opts.secrets));
        }
        resolve(res);
      });
    });

    return { result, kill };
  }
}

export function transcript(r: RunResult, secrets: string[] = []): string {
  return redact(
    [
      `$ ${formatCommand(r.command, r.args, secrets)}`,
      `# exit=${r.code} signal=${r.signal ?? ""} timedOut=${r.timedOut} durationMs=${r.durationMs}`,
      "## stdout",
      r.stdoutBytes ? "(binary output)" : r.stdout,
      "## stderr",
      r.stderr,
    ].join("\n"),
    secrets,
  );
}
