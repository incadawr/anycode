import { types } from "node:util";

/** Never put parser error messages or source snippets in host output. */
export function logHookConfigFailure(error: unknown, log: (line: string) => void = console.error): void {
  let name = "Error";
  let code = "";
  if (types.isNativeError(error)) {
    if (["Error", "SyntaxError", "TypeError", "RangeError"].includes(error.name)) name = error.name;
    const value: unknown = (error as Error & { code?: unknown }).code;
    if (typeof value === "string" && /^E[A-Z0-9_]{1,30}$/.test(value)) code = ` ${value}`;
  }
  log(`[host] failed to load hook config; no command hooks registered: ${name}${code}`);
}
