/**
 * Redaction helpers. Anything that may end up in a log file, a preview, or a tool
 * result passes through here so private keys, passwords and tokens never leak.
 */

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|ENCRYPTED PRIVATE KEY)-----[\s\S]*?-----END [A-Z0-9 ]*-----/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const OPENSSL_PASS = /\bpass:[^\s"']+/g;
const APP_SPECIFIC_PASSWORD = /\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/g;

export const REDACTED = "***";

/** Redact well-known secret shapes plus any explicitly supplied secret values. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join(REDACTED);
  }
  return out
    .replace(PEM_BLOCK, "-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----")
    .replace(JWT, REDACTED)
    .replace(OPENSSL_PASS, `pass:${REDACTED}`)
    .replace(APP_SPECIFIC_PASSWORD, REDACTED);
}

const SECRET_FLAGS = new Set([
  "--password",
  "-P",
  "--passphrase",
  "--apiKeySecret",
  "--app-specific-password",
]);

/** Render argv as a copy/pasteable shell command with secrets masked. */
export function formatCommand(
  cmd: string,
  args: readonly string[],
  secrets: readonly (string | undefined)[] = [],
): string {
  const parts = [cmd];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const prev = i > 0 ? args[i - 1] : undefined;
    if (prev && SECRET_FLAGS.has(prev)) {
      parts.push(REDACTED);
      continue;
    }
    parts.push(shellQuote(redact(arg, secrets)));
  }
  return parts.join(" ");
}

export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_\-+=/.,:@%^]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Deep-redact string values in a JSON-like structure (for previews / structured results). */
export function redactDeep<T>(value: T, secrets: readonly (string | undefined)[] = []): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/password|passphrase|secret|privateKey$|private_key$/i.test(k) && typeof v === "string") {
        out[k] = REDACTED;
      } else {
        out[k] = redactDeep(v, secrets);
      }
    }
    return out as T;
  }
  return value;
}
