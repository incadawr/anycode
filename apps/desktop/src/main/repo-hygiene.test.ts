import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root = apps/desktop/src/main -> up four levels.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// The owner's account name (public repo hygiene: never commit it as a home
// path). Assembled from parts so this guard does not itself carry the literal.
// Establishing commits: 42f8c0f1 (scrub), 59b738a1 (regression this guard closes).
const OWNER = ["inca", "dawr"].join("");
const FORBIDDEN = [`/Users/${OWNER}`, `/home/${OWNER}`, `\\Users\\${OWNER}`];

function gitFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

describe("repo hygiene — owner home path (Taskana 4163)", () => {
  it("no tracked file contains the owner's home-path literal", () => {
    // Sanity: repoRoot must really be the repo root (guards against path drift).
    expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
    const files = gitFiles();
    expect(files).toContain("apps/desktop/src/main/repo-hygiene.test.ts");
    const offenders: string[] = [];
    for (const file of files) {
      const abs = join(repoRoot, file);
      if (!existsSync(abs)) continue; // deleted in the worktree, not yet staged
      const bytes = readFileSync(abs);
      if (bytes.includes(0)) continue; // binary
      const text = bytes.toString("utf-8");
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) offenders.push(`${file}: contains ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("known-scrubbed fixtures keep their placeholder forms", () => {
    // Cheap canary that the 42f8c0f1 scrub stays in place.
    const readme = readFileSync(join(repoRoot, "apps/desktop/src/main/codex-rollout-fixtures/README.md"), "utf-8");
    expect(readme).toContain("/Users/<name>/");
    const mcp = readFileSync(join(repoRoot, "apps/desktop/src/renderer/src/components/McpServersPane.test.ts"), "utf-8");
    expect(mcp).toContain("/Users/<user>");
  });
});

// Taskana 4163: captured rollout fixtures must not carry real infrastructure
// IPs. Every IPv4-looking token — bare or as a CIDR base — is limited to
// RFC 5737 documentation ranges, 10.0.0.0/8 and 127.0.0.0/8 (no CIDR
// exemption: a real host written as "a.b.c.d/32" must still fail).
// Deliberately narrow: codex-rollout-fixtures/ only (.jsonl and README.md).
describe("repo hygiene — codex rollout fixtures carry no real IPv4 (Taskana 4163)", () => {
  const fixturesDir = join(repoRoot, "apps/desktop/src/main/codex-rollout-fixtures");

  const IPv4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

  function isAllowedIPv4(o: number[]): boolean {
    return (
      (o[0] === 192 && o[1] === 0 && o[2] === 2) || // 192.0.2.0/24   (RFC 5737)
      (o[0] === 198 && o[1] === 51 && o[2] === 100) || // 198.51.100.0/24 (RFC 5737)
      (o[0] === 203 && o[1] === 0 && o[2] === 113) || // 203.0.113.0/24 (RFC 5737)
      o[0] === 10 || // 10.0.0.0/8
      o[0] === 127 // 127.0.0.0/8
    );
  }

  it("every IPv4 in codex-rollout-fixtures is RFC 5737, 10/8 or 127/8", () => {
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".jsonl") || f === "README.md");
    expect(files.length).toBeGreaterThan(0); // sanity: the directory was found
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(fixturesDir, file), "utf-8");
      for (const match of text.matchAll(IPv4_RE)) {
        const octets = match.slice(1).map(Number);
        if (octets.some((n) => n > 255)) continue; // e.g. a version string caught by the shape
        if (!isAllowedIPv4(octets)) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
