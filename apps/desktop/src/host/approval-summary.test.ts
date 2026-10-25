import { describe, expect, it } from "vitest";
import { describeApproval } from "./approval-summary.js";

describe("describeApproval (Taskana 4763)", () => {
  it("T5 Bash: multi-line command collapsed, long command truncated, secrets scrubbed", () => {
    expect(describeApproval("Bash", { command: "echo a\necho b" })).toBe("echo a ; echo b");
    const long = describeApproval("Bash", { command: "ls " + "a-b ".repeat(100) });
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
    const header = describeApproval("Bash", { command: 'curl -H "Authorization: Bearer abc123def456ghi789" https://example.com' });
    expect(header).not.toContain("abc123def456ghi789");
    expect(header).toContain("[redacted]");
    const env = describeApproval("Bash", { command: "API_KEY=sk-abcdefghijklmnopqrstuvwxyz make" });
    expect(env).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(env).toContain("make");
    const flag = describeApproval("Bash", { command: "deploy --password hunter2" });
    expect(flag).not.toContain("hunter2");
    expect(describeApproval("CodexExec", { command: "npm test" })).toBe("npm test");
  });

  it("T6 file tools show only the path, never body text", () => {
    const big = "A".repeat(1024 * 1024);
    expect(describeApproval("Write", { file_path: "/w/a.txt", content: big })).toBe("/w/a.txt");
    expect(describeApproval("Edit", { file_path: "/w/b.ts", old_string: "token=SECRETVALUE", new_string: big })).toBe("/w/b.ts");
    expect(describeApproval("MultiEdit", { file_path: "/w/c.ts", edits: [{ old_string: "x", new_string: big }] })).toBe("/w/c.ts");
    expect(describeApproval("NotebookEdit", { notebook_path: "/w/n.ipynb", new_source: big })).toBe("/w/n.ipynb");
    const patch = describeApproval("CodexApplyPatch", { paths: ["a.ts", "b.ts", "c.ts", "d.ts"], diff: big });
    expect(patch).toBe("patch touching 4 file(s): a.ts, b.ts, c.ts");
    expect(patch).not.toContain("AAAA");
    expect(describeApproval("Edit", { file_path: "/w/d.ts", old_string: "password=hunter2hunter2hunter2" })).not.toContain("hunter2");
  });

  it("T7 URL, browser and unknown tools never leak query, text or values", () => {
    expect(describeApproval("WebFetch", { url: "https://u:p@example.com/a?token=x#f" })).toBe("https://example.com/a");
    expect(describeApproval("BrowserOpen", { url: "not a url" })).toBe("(invalid url)");
    expect(describeApproval("BrowserType", { ref: "e1", text: "my-secret-password", submit: true })).toBe("on page");
    expect(describeApproval("BrowserEval", { expression: "document.cookie" })).toBe("run JavaScript in the page");
    const unknown = describeApproval("mcp__x__tool", { alpha: "SECRET_VALUE_1", beta: 2, gamma: null, d: 1, e: 1, f: 1 });
    expect(unknown).toBe("mcp__x__tool with 6 argument(s): alpha, beta, gamma, d, e, +1 more");
    expect(unknown).not.toContain("SECRET_VALUE_1");
    for (const input of [null, [1, 2], "string", 7, undefined]) {
      expect(() => describeApproval("Unknown", input)).not.toThrow();
    }
    const circular: Record<string, unknown> = { a: 1 }; circular.self = circular;
    expect(() => describeApproval("Unknown", circular)).not.toThrow();
    expect(describeApproval("Unknown", circular)).toBe("Unknown with 2 argument(s): a, self");
  });

  it("output is always one line and at most 200 characters (deterministic property check)", () => {
    let seed = 42;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    const alphabet = "ab \n\t\u0001Bearer=--token/_-0123456789";
    const randomText = (n: number) => Array.from({ length: n }, () => alphabet[next() % alphabet.length]).join("");
    const tools = ["Bash", "CodexExec", "Write", "CodexApplyPatch", "WebFetch", "BrowserType", "Other"];
    for (let i = 0; i < 50; i++) {
      const tool = tools[i % tools.length]!;
      const input = { command: randomText(next() % 900), file_path: randomText(next() % 900), url: `https://h/${randomText(next() % 500)}`, paths: [randomText(300), randomText(300), randomText(300), randomText(300)], [randomText(30)]: randomText(40) };
      const text = describeApproval(tool, input);
      expect(text).not.toMatch(/[\r\n]/);
      expect(text.length).toBeLessThanOrEqual(200);
    }
  });
});
