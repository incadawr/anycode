import { constants, lstatSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { BuiltinPolicyReason } from "./builtin-policy.js";

const LIMIT = 1024 * 1024;
class Refusal extends Error {
  constructor(readonly reason: BuiltinPolicyReason) { super(reason); }
}
const refuse = (reason: BuiltinPolicyReason): never => { throw new Refusal(reason); };

/** Validate the complete JSON grammar before JSON.parse can erase duplicate keys.
 * Keys are compared after escape decoding, at every object depth.
 */
function strictJson(text: string): Record<string, unknown> {
  let at = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(text[at] ?? "!")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') return JSON.parse(text.slice(start, at)) as string;
      if (char === "\\") at++;
    }
    return refuse("invalid-config");
  };
  const value = (depth: number): void => {
    whitespace();
    const char = text[at];
    if (char === "{" || char === "[") {
      if (depth >= 64) refuse("too-deep");
      at++; whitespace();
      const end = char === "{" ? "}" : "]";
      const keys = new Set<string>();
      if (text[at] === end) { at++; return; }
      while (true) {
        whitespace();
        if (char === "{") {
          if (text[at] !== '"') refuse("invalid-config");
          const key = string();
          if (keys.has(key)) refuse("invalid-config");
          keys.add(key); whitespace();
          if (text[at++] !== ":") refuse("invalid-config");
        }
        value(depth + 1); whitespace();
        if (text[at] === end) { at++; return; }
        if (text[at++] !== ",") refuse("invalid-config");
      }
    }
    if (char === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!token) refuse("invalid-config");
    at += token![0].length;
  };
  value(0); whitespace();
  if (at !== text.length) refuse("invalid-config");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) refuse("invalid-config");
  return parsed as Record<string, unknown>;
}
function readConfig(path: string): string[] {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return refuse("io-error");
  }
  if (!stat.isFile()) refuse("unsafe-file");
  if (stat.size > LIMIT) refuse("too-large");
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) refuse("unsupported");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino) refuse("unsafe-file");
    if (opened.size > LIMIT) refuse("too-large");
    const bytes = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > LIMIT) refuse("too-large");
    const config = strictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!Object.hasOwn(config, "skills")) return [];
    const skills = config.skills;
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) refuse("invalid-config");
    if (!Object.hasOwn(skills as object, "disabled")) return [];
    const disabled = (skills as Record<string, unknown>).disabled;
    if (!Array.isArray(disabled) || disabled.some(id => typeof id !== "string")) refuse("invalid-config");
    return disabled as string[];
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse(error instanceof SyntaxError || error instanceof TypeError ? "invalid-config" : "io-error");
  } finally { if (fd !== undefined) closeSync(fd); }
}
try {
  const { paths, ids } = workerData as { paths: string[]; ids: string[] };
  const disabled = new Set(paths.flatMap(readConfig));
  parentPort?.postMessage({ disabled: ids.filter(id => disabled.has(id)) });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Refusal ? error.reason : "io-error" });
}
