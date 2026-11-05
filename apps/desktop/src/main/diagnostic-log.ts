import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { types } from "node:util";
import { StringDecoder } from "node:string_decoder";

const MAX_FILE = 1024 * 1024;
const MAX_LINE = 4096;
const MAX_PENDING = 256;

export function redactDiagnostic(text: string): string {
  return text
    // Quoted JSON and unquoted headers both include the scheme and credentials.
    .replace(/(authorization["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/gi, "$1[redacted]")
    .replace(/\b(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/([?&])([^=&#\s]+)=([^&#\s"']*)/g, (match, separator: string, key: string) => {
      let normalized: string;
      try { normalized = decodeURIComponent(key.replace(/\+/g, " ")).toLowerCase(); } catch { return match; }
      return /^(?:key|api[_-]?key|access[_-]?token|token|secret|password)$/.test(normalized)
        ? `${separator}${key}=[redacted]` : match;
    })
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password|token)["']?\s*[=:]\s*["']?)[^\s&,'";}]+/gi, "$1[redacted]")
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xoxb|xoxp)-[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\b(?:ghp|gho|github_pat|xoxb|xoxp)_[a-z0-9_]{12,}\b/gi, "[redacted]");
}

function consoleArgument(arg: unknown): string {
  if (types.isNativeError(arg)) {
    // Error messages and stacks can contain source file snippets or other private data.
    const names = new Set(["Error", "SyntaxError", "TypeError", "RangeError", "ReferenceError", "URIError", "EvalError", "AggregateError"]);
    const name = names.has(arg.name) ? arg.name : "Error";
    const code: unknown = (arg as Error & { code?: unknown }).code;
    return `[${name}${typeof code === "string" && /^E[A-Z0-9_]{1,30}$/.test(code) ? ` ${code}` : ""}: details omitted]`;
  }
  return typeof arg === "string" ? arg : "[non-text argument omitted]";
}

/** Asynchronous, bounded best-effort diagnostics; callers never wait for disk. */
export function createDiagnosticLog(directory: string) {
  const path = join(directory, "anycode.log");
  let queue = Promise.resolve();
  let pending = 0;
  function write(source: string, line: string) {
    if (pending >= MAX_PENDING) return;
    const entry = `${new Date().toISOString()} [${source}] ${redactDiagnostic(line).slice(0, MAX_LINE)}\n`;
    pending++;
    queue = queue.then(async () => {
      await mkdir(directory, { recursive: true });
      let size = 0;
      try { size = (await stat(path)).size; } catch { /* new file */ }
      if (size + Buffer.byteLength(entry) > MAX_FILE) {
        try { await rename(path, `${path}.1`); } catch { return; }
      }
      await appendFile(path, entry, { mode: 0o600 });
    }).catch(() => {}).finally(() => { pending--; });
  }
  function stream(source: string) {
    const decoder = new StringDecoder("utf8");
    let partial = "";
    let overflow = false;
    const receive = (chunk: Buffer) => {
      for (const char of decoder.write(chunk)) {
        if (char === "\n") {
          write(source, partial + (overflow ? " [truncated]" : ""));
          partial = ""; overflow = false;
        } else if (partial.length < MAX_LINE * 2) partial += char;
        else overflow = true;
      }
    };
    return Object.assign(receive, { end: () => {
      partial += decoder.end();
      if (partial || overflow) write(source, partial + (overflow ? " [truncated]" : ""));
      partial = ""; overflow = false;
    } });
  }
  return { write, stream, flush: () => queue };
}

export function installConsoleLog(log: ReturnType<typeof createDiagnosticLog>, target: Console = console): void {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      try { log.write(`main ${level}`, args.map(consoleArgument).join(" ").replace(/[\r\n]+/g, " ")); } catch { /* diagnostics must not break the app */ }
      try { original(...args); } catch { /* console may be unavailable */ }
    };
  }
}
