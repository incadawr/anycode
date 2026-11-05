import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { types } from "node:util";
import { StringDecoder } from "node:string_decoder";

const MAX_FILE = 1024 * 1024;
const MAX_LINE = 4096;
const MAX_PENDING = 256;

const sensitiveNames = new Set(["key", "apikey", "accesstoken", "token", "secret", "password", "authorization"]);
const isNameChar = (c: string) => /[a-z0-9_%+\-]/i.test(c);
const isValueEnd = (c: string) => c === "&" || c === "#" || c === "," || c === ";" || c === "}" || c === "\r" || c === "\n";

/** Scan each character at most a constant number of times, including malformed URLs. */
export function redactDiagnostic(input: string): string {
  const text = input.slice(0, MAX_LINE * 2);
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (!isNameChar(text[i]!)) { result += text[i++]; continue; }
    const start = i;
    while (i < text.length && isNameChar(text[i]!)) i++;
    const word = text.slice(start, i);
    let name = word.toLowerCase();
    if (word.includes("%") || word.includes("+")) {
      try { name = decodeURIComponent(word.replace(/\+/g, " ")).toLowerCase(); } catch { /* retain the literal */ }
    }
    if ((name === "http" || name === "https") && text.slice(i, i + 3) === "://") {
      let end = i + 3;
      let at = -1;
      while (end < text.length && !"/?#\t\r\n \"'".includes(text[end]!)) {
        if (text[end] === "@") at = end;
        end++;
      }
      result += text.slice(start, i + 3) + (at >= 0 ? `[redacted]@${text.slice(at + 1, end)}` : text.slice(i + 3, end));
      i = end;
      continue;
    }
    const suffix = name.slice(Math.max(name.lastIndexOf("-"), name.lastIndexOf("_")) + 1);
    const sensitive = sensitiveNames.has(suffix);
    const authorization = suffix === "authorization";
    let next = i;
    if (text[next] === '"' || text[next] === "'") next++;
    while (text[next] === " " || text[next] === "\t") next++;
    if (sensitive && (text[next] === ":" || text[next] === "=")) {
      next++;
      while (text[next] === " " || text[next] === "\t") next++;
      result += text.slice(start, next) + "[redacted]";
      const quote = text[next] === '"' || text[next] === "'" ? text[next++] : "";
      if (quote) {
        while (next < text.length && text[next] !== quote) {
          if (text[next] === "\\" && next + 1 < text.length) next++;
          next++;
        }
        if (next < text.length) next++;
      } else {
        while (next < text.length && !isValueEnd(text[next]!) && (authorization || !/\s/.test(text[next]!))) next++;
      }
      i = next;
    } else if (name === "bearer") {
      let value = i;
      while (text[value] === " " || text[value] === "\t") value++;
      if (value > i && value < text.length) {
        result += word + text.slice(i, value) + "[redacted]";
        while (value < text.length && !isValueEnd(text[value]!) && !/\s/.test(text[value]!) && text[value] !== '"' && text[value] !== "'") value++;
        i = value;
      } else result += word;
    } else if (/^AIza[A-Za-z0-9_-]{20,}$/.test(word) || /^(?:sk|pk|ghp|gho|github_pat|xoxb|xoxp)[_-][a-z0-9_-]{12,}$/i.test(word)) {
      result += "[redacted]";
    } else result += word;
  }
  return result;
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

/** Keep only explicitly understood host messages; dynamic output is suppressed. */
export function safeHostLine(line: string): string | undefined {
  if (line.startsWith("[host] started. workspace=")) return "[host] started";
  if (line.startsWith("[host] initialized. workspace=")) return "[host] initialized";
  if (line === "[host] UI port wired." || line === "[host] terminal port wired.") return line;
  if (/^\[host\] failed to load hook config; no command hooks registered: (?:Error|SyntaxError|TypeError|RangeError)(?: E[A-Z0-9_]{1,30})?$/.test(line)) return line;
  const error = /^(?:Uncaught\s+)?(Error|SyntaxError|TypeError|RangeError|ReferenceError|URIError|EvalError|AggregateError)(?:\s*\[(ERR_[A-Z0-9_]{1,60})\])?(?::|\s|$)/.exec(line);
  if (error) return `[host] ${error[1]}${error[2] ? ` [${error[2]}]` : ""} (details suppressed)`;
  if (line.startsWith("FATAL ERROR:")) return "[host] FATAL ERROR (details suppressed)";
  if (/^\(node:[0-9]+\) (?:Warning|[A-Za-z]+Warning):/.test(line)) return "[host] Node warning (details suppressed)";
  return undefined;
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
    let suppressed = 0;
    const flushSuppressed = () => {
      if (suppressed) write(source, `[${suppressed} host output lines suppressed]`);
      suppressed = 0;
    };
    const emitLine = () => {
      const safe = overflow ? undefined : safeHostLine(partial);
      if (safe === undefined) suppressed++;
      else { flushSuppressed(); write(source, safe); }
      partial = ""; overflow = false;
    };
    const receive = (chunk: Buffer) => {
      for (const char of decoder.write(chunk)) {
        if (char === "\n") {
          emitLine();
        } else if (partial.length < MAX_LINE * 2) partial += char;
        else overflow = true;
      }
    };
    return Object.assign(receive, { end: () => {
      partial += decoder.end();
      if (partial || overflow) emitLine();
      flushSuppressed();
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
