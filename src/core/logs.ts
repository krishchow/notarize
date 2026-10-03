import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where full command transcripts are written so tool results can stay short. */
export function defaultLogDir(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (process.env.NOTARIZE_MCP_LOG_DIR) return process.env.NOTARIZE_MCP_LOG_DIR;
  if (platform === "darwin") return join(home, "Library", "Logs", "notarize-mcp");
  return join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "notarize-mcp", "logs");
}

export interface LogWriter {
  write(name: string, content: string): Promise<string | undefined>;
}

export class FileLogWriter implements LogWriter {
  constructor(private readonly dir: string = defaultLogDir()) {}

  async write(name: string, content: string): Promise<string | undefined> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60);
      const path = join(this.dir, `${stamp}-${safe}.log`);
      await writeFile(path, content, { mode: 0o600 });
      return path;
    } catch {
      return undefined;
    }
  }
}

export class NullLogWriter implements LogWriter {
  async write(): Promise<string | undefined> {
    return undefined;
  }
}

/** Last `maxLines` lines (and at most `maxChars` chars) of a blob of output. */
export function tail(text: string, maxLines = 40, maxChars = 4000): string {
  const lines = text.trimEnd().split("\n");
  let out = lines.slice(-maxLines).join("\n");
  if (out.length > maxChars) out = `…${out.slice(-maxChars)}`;
  return lines.length > maxLines ? `…(${lines.length - maxLines} earlier lines omitted)\n${out}` : out;
}

/** Where background job state files live (watched by `notarize-mcp watch-job`). */
export function defaultJobsDir(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (process.env.NOTARIZE_MCP_STATE_DIR) return process.env.NOTARIZE_MCP_STATE_DIR;
  return join(defaultLogDir(platform, home), "jobs");
}
