import type { CommandRunner, RunningProcess, RunOptions, RunResult } from "./exec";

export interface FakeResponse {
  code?: number;
  stdout?: string;
  stderr?: string;
  stdoutBytes?: Uint8Array;
  spawnError?: string;
  /** Simulate the runner killing the process at its timeout. */
  timedOut?: boolean;
}

export type FakeMatcher = (cmd: string, args: string[]) => boolean;

interface Rule {
  match: FakeMatcher;
  respond: FakeResponse | ((cmd: string, args: string[], opts: RunOptions) => FakeResponse);
  times?: number;
}

/**
 * Scriptable runner for tests. Rules are checked in insertion order; the first
 * matching rule answers. Unmatched commands fail with a spawn error so tests
 * notice unexpected calls.
 */
export class FakeRunner implements CommandRunner {
  readonly calls: { cmd: string; args: string[]; opts: RunOptions }[] = [];
  private readonly rules: Rule[] = [];

  /** Match when `cmd` equals and argv starts with `prefix` (or contains all of `includes`). */
  on(
    cmd: string,
    argsPrefixOrMatcher: string[] | FakeMatcher,
    respond: Rule["respond"],
    opts: { times?: number } = {},
  ): this {
    const match: FakeMatcher =
      typeof argsPrefixOrMatcher === "function"
        ? argsPrefixOrMatcher
        : (c, a) => c === cmd && argsPrefixOrMatcher.every((p, i) => a[i] === p);
    const wrapped: FakeMatcher =
      typeof argsPrefixOrMatcher === "function" ? (c, a) => c === cmd && match(c, a) : match;
    this.rules.push({ match: wrapped, respond, times: opts.times });
    return this;
  }

  /** Match when `cmd` equals and argv contains every element of `includes`. */
  onIncludes(cmd: string, includes: string[], respond: Rule["respond"]): this {
    return this.on(cmd, (_c, a) => includes.every((x) => a.includes(x)), respond);
  }

  run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return this.start(cmd, args, opts).result;
  }

  start(cmd: string, args: string[], opts: RunOptions = {}): RunningProcess {
    this.calls.push({ cmd, args, opts });
    const rule = this.rules.find((r) => (r.times === undefined || r.times > 0) && r.match(cmd, args));
    let res: FakeResponse;
    if (!rule) {
      res = { spawnError: `FakeRunner: no rule for ${cmd} ${args.join(" ")}` };
    } else {
      if (rule.times !== undefined) rule.times--;
      res = typeof rule.respond === "function" ? rule.respond(cmd, args, opts) : rule.respond;
    }
    if (res.stdout) opts.onOutput?.(res.stdout);
    const result: RunResult = {
      command: cmd,
      args,
      code: res.spawnError || res.timedOut ? null : (res.code ?? 0),
      signal: res.timedOut ? "SIGTERM" : null,
      stdout: res.stdout ?? "",
      stderr: res.spawnError ? `${res.stderr ?? ""}${res.spawnError}` : (res.stderr ?? ""),
      stdoutBytes: res.stdoutBytes,
      durationMs: 1,
      timedOut: !!res.timedOut,
      spawnError: res.spawnError,
    };
    return { result: Promise.resolve(result), kill: () => {} };
  }

  callsTo(cmd: string): string[][] {
    return this.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  }
}
