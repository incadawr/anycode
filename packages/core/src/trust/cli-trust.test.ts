/**
 * CLI workspace-trust gate (Taskana 4736, design 2.9): interactive t/o/N prompt
 * persists or not, non-interactive skip, denied is silent, the env override
 * trusts for this process only, and a failure is fail-closed. Injected streams
 * and a temp home — the real ~/.anycode is never touched.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCliProjectTrust } from "../cli/main.js";
import { NodeFileSystemAdapter } from "../adapters/node/index.js";
import { defaultTrustStorePath, parseTrustAnswer } from "./index.js";

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anycode-trust-home-"));
  workspace = mkdtempSync(join(tmpdir(), "anycode-trust-ws-"));
  mkdirSync(join(workspace, ".anycode"), { recursive: true });
  writeFileSync(
    join(workspace, ".anycode", "config.json"),
    JSON.stringify({ mcpServers: { lint: { command: "node", args: ["lint.js"] } } }),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function streams(answer?: string): { input: PassThrough; output: PassThrough; written: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  if (answer !== undefined) {
    input.end(`${answer}\n`);
  } else {
    input.end();
  }
  return { input, output, written: () => text };
}

function deps(over: {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  answer?: string;
  warnings?: string[];
}) {
  const s = streams(over.answer);
  return {
    fs: new NodeFileSystemAdapter(),
    cwd: workspace,
    home,
    env: over.env ?? {},
    interactive: over.interactive ?? false,
    io: { input: s.input, output: s.output },
    warn: (text: string) => {
      over.warnings?.push(text);
    },
    written: s.written,
  };
}

describe("parseTrustAnswer", () => {
  it("t/trust trusts, o/once is once, anything else (incl. empty) is No", () => {
    expect(parseTrustAnswer("t")).toBe("trust");
    expect(parseTrustAnswer(" TRUST ")).toBe("trust");
    expect(parseTrustAnswer("o")).toBe("once");
    expect(parseTrustAnswer("once")).toBe("once");
    expect(parseTrustAnswer("")).toBe("no");
    expect(parseTrustAnswer("n")).toBe("no");
    expect(parseTrustAnswer("yes please")).toBe("no");
  });

  // Taskana 4736 xfix m2: the universal confirmation used to fall into the
  // DENIED branch — persisted refusal from an intending-to-trust user.
  it("y/yes trusts and n/no denies (xfix m2)", () => {
    expect(parseTrustAnswer("y")).toBe("trust");
    expect(parseTrustAnswer("YES")).toBe("trust");
    expect(parseTrustAnswer(" Yes ")).toBe("trust");
    expect(parseTrustAnswer("no")).toBe("no");
    expect(parseTrustAnswer("N")).toBe("no");
  });
});

describe("resolveCliProjectTrust", () => {
  it("interactive 't' trusts and persists the decision to the injected home", async () => {
    const d = deps({ interactive: true, answer: "t" });
    expect(await resolveCliProjectTrust(d)).toBe(true);
    const store = JSON.parse(readFileSync(defaultTrustStorePath(home), "utf8"));
    expect(Object.values(store.folders)).toEqual([
      expect.objectContaining({ decision: "trusted" }),
    ]);
    expect(d.written()).toContain("[t]rust / [o]nce / [N]o");
    expect(d.written()).toContain("lint");
  });

  it("interactive 'o' trusts for this process only and persists nothing", async () => {
    expect(await resolveCliProjectTrust(deps({ interactive: true, answer: "o" }))).toBe(true);
    expect(existsSync(defaultTrustStorePath(home))).toBe(false);
  });

  it("interactive empty answer (default No) persists denial, and the next run is silent", async () => {
    expect(await resolveCliProjectTrust(deps({ interactive: true, answer: "" }))).toBe(false);
    const warnings: string[] = [];
    const again = deps({ interactive: true, answer: "t", warnings });
    expect(await resolveCliProjectTrust(again)).toBe(false);
    // denied is silent: no prompt was written and no warn line was emitted.
    expect(again.written()).toBe("");
    expect(warnings).toEqual([]);
  });

  it("non-interactive: skips with a boot warning naming the count and how to trust", async () => {
    const warnings: string[] = [];
    const d = deps({ interactive: false, warnings });
    expect(await resolveCliProjectTrust(d)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 project process declaration(s)");
    expect(warnings[0]).toContain("ANYCODE_TRUST_WORKSPACE=1");
    expect(d.written()).toBe("");
    expect(existsSync(defaultTrustStorePath(home))).toBe(false);
  });

  it("ANYCODE_TRUST_WORKSPACE=1 trusts this process only, without prompting or persisting", async () => {
    const warnings: string[] = [];
    const d = deps({ interactive: false, env: { ANYCODE_TRUST_WORKSPACE: "1" }, warnings });
    expect(await resolveCliProjectTrust(d)).toBe(true);
    expect(warnings).toEqual([]);
    expect(existsSync(defaultTrustStorePath(home))).toBe(false);
  });

  it("a folder with no project spawn declarations needs no prompt", async () => {
    rmSync(join(workspace, ".anycode"), { recursive: true, force: true });
    const d = deps({ interactive: true, answer: "n" });
    expect(await resolveCliProjectTrust(d)).toBe(true);
    expect(d.written()).toBe("");
  });

  it("a previously trusted folder stays trusted without prompting", async () => {
    mkdirSync(join(home, ".anycode"), { recursive: true });
    expect(await resolveCliProjectTrust(deps({ interactive: true, answer: "t" }))).toBe(true);
    const d = deps({ interactive: true, answer: "n" });
    expect(await resolveCliProjectTrust(d)).toBe(true);
    expect(d.written()).toBe("");
  });
});
