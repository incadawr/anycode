import { describe, expect, it } from "vitest";
import { createDiagnosticsAnonymizer } from "./diagnostics-anonymize.js";

const SALT = "test-salt";

/** Realistic values the card forbids from ever appearing in a bundle. */
const FORBIDDEN = {
  openaiKey: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  anthropicKey: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  githubToken: "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  githubPat: "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
  slackToken: "xox" + "b-123456789012-abcdefghijklmnop",
  awsKey: "AKIAIOSFODNN7EXAMPLE",
  googleKey: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  bearer: "Bearer abcdef1234567890abcdef",
  envValue: "hunter2-do-not-leak",
  userPath: "/Users/alice/secret-project/src/prompt.ts",
  homePath: "/home/bob/.config/secrets.json",
  tempPath: "/tmp/anycode-debug/session.jsonl",
  // A root outside the well-known list must be scrubbed just the same.
  oddRootPath: "/data/models/qwen-private.json",
  relativePath: "./profiles/work-private.json",
  parentRelativePath: "../elsewhere/private-secrets.json",
  // Path shapes whose only separator from the preceding word is a colon.
  colonAttachedPath: "/data/colon-root/private-model.json",
  colonRelativePath: "../colon-root/private-notes.json",
  windowsPath: "C:\\Users\\carol\\AppData\\Roaming\\anycode\\config.json",
  host: "build-agent-7.internal.corp",
  url: "https://api.secret-provider.example.com/v1/chat?token=abc",
  localhost: "localhost:43121",
  ip: "10.4.5.6",
  email: "alice@example.com",
  sessionId: "sess_9f8e7d6c5b4a3210",
  uuid: "8f14e45f-ceea-467f-a1d2-9a1b2c3d4e5f",
  longHex: "0123456789abcdef0123456789abcdef0123456789abcdef",
  bareToken: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  unusualHost: "builder.box.internalcluster.zz",
};

function assertNothingForbidden(output: string): void {
  for (const [name, value] of Object.entries(FORBIDDEN)) {
    expect(output, `${name} leaked: ${value}`).not.toContain(value);
  }
}

describe("diagnostics anonymiser (GitHub #18)", () => {
  it("scrubs credentials, paths, URLs, hosts, e-mails and raw ids from text", () => {
    const anon = createDiagnosticsAnonymizer({ salt: SALT });
    const text = [
      `key=${FORBIDDEN.openaiKey}`,
      `Authorization: Bearer ${FORBIDDEN.bearer.replace("Bearer ", "")}`,
      `stored at ${FORBIDDEN.userPath} and ${FORBIDDEN.windowsPath}`,
      `also ${FORBIDDEN.homePath} and ${FORBIDDEN.tempPath}`,
      `odd root ${FORBIDDEN.oddRootPath} and ${FORBIDDEN.relativePath} and ${FORBIDDEN.parentRelativePath}`,
      // A path is a path even when a colon, not a space, precedes it.
      `cwd:${FORBIDDEN.colonAttachedPath} open:${FORBIDDEN.colonRelativePath}`,
      `call ${FORBIDDEN.url} via ${FORBIDDEN.host} / ${FORBIDDEN.localhost} / ${FORBIDDEN.ip}`,
      `mail ${FORBIDDEN.email}, session ${FORBIDDEN.sessionId}, uuid ${FORBIDDEN.uuid}`,
      `hex ${FORBIDDEN.longHex}`,
      `bare ${FORBIDDEN.bareToken} at ${FORBIDDEN.unusualHost}`,
      `GITHUB_TOKEN=${FORBIDDEN.envValue}`,
    ].join("\n");

    const scrubbed = anon.text(text);
    assertNothingForbidden(scrubbed);
    // Colon-attached paths lose the WHOLE path, not just the part an
    // independent host/file rule happens to catch.
    expect(scrubbed).not.toContain("/data/colon-root");
    expect(scrubbed).not.toContain("../colon-root");
    expect(scrubbed).toContain("<secret>");
    expect(scrubbed).toContain("<path>");
    expect(scrubbed).toContain("<host>");
    expect(scrubbed).toContain("<email>");
    expect(scrubbed).toContain("<ip>");
    expect(scrubbed).toContain("<value>");
    expect(scrubbed).toContain("GITHUB_TOKEN=");
  });

  it("hashes ids deterministically with the per-export salt, and never returns the raw id", () => {
    const a = createDiagnosticsAnonymizer({ salt: SALT });
    const b = createDiagnosticsAnonymizer({ salt: "another-salt" });
    const first = a.id(FORBIDDEN.sessionId);
    expect(first).toMatch(/^id_[0-9a-f]{12}$/);
    expect(first).toBe(a.id(FORBIDDEN.sessionId));
    expect(b.id(FORBIDDEN.sessionId)).not.toBe(first);
    expect(first).not.toContain("sess_");
  });

  it("generates a fresh random salt per anonymiser by default", () => {
    expect(createDiagnosticsAnonymizer().salt).not.toBe(createDiagnosticsAnonymizer().salt);
  });

  it("drops unpredicted keys and unknown string shapes recursively", () => {
    const anon = createDiagnosticsAnonymizer({ salt: SALT });
    const projected = anon.value({
      safe: "hello",
      "bad key!": "dropped",
      ["__proto__"]: "dropped",
      nested: { path: FORBIDDEN.userPath, prompt: FORBIDDEN.openaiKey },
      list: [FORBIDDEN.email, 2, true, null],
      fn: () => 1,
      big: Number.POSITIVE_INFINITY,
    }) as Record<string, unknown>;

    expect(Object.keys(projected).sort()).toEqual(["big", "list", "nested", "safe"]);
    expect(projected.big).toBeNull();
    assertNothingForbidden(JSON.stringify(projected));
  });

  it("is bounded: huge input is cut before scrubbing, never carried whole", () => {
    const anon = createDiagnosticsAnonymizer({ salt: SALT });
    const scrubbed = anon.text(`${"a".repeat(10_000)}${FORBIDDEN.openaiKey}`);
    expect(scrubbed.length).toBeLessThanOrEqual(4_096);
  });

  it("reports where each replacement landed, so a truncated copy counts only what it kept", () => {
    const anon = createDiagnosticsAnonymizer({ salt: SALT });
    const prefix = "lorem ipsum ".repeat(20);
    const scrubbed = anon.textWithRedactions(`${FORBIDDEN.userPath} ${prefix} ${FORBIDDEN.email}`);

    expect(scrubbed.text).toContain("<path>");
    expect(scrubbed.text).toContain("<email>");
    expect(scrubbed.redactions).toHaveLength(2);
    const [path, email] = scrubbed.redactions;
    expect(scrubbed.text.slice(path!.start).startsWith("<path>")).toBe(true);
    expect(scrubbed.text.slice(email!.start).startsWith("<email>")).toBe(true);
    // One replacement is inside a 128-char saved prefix, the other is not.
    expect(path!.start).toBeLessThan(128);
    expect(email!.start).toBeGreaterThanOrEqual(128);
    expect(new Set(scrubbed.redactions.map((event) => event.id)).size).toBe(2);
  });

  it("counts every replacement without reporting what was replaced", () => {
    const anon = createDiagnosticsAnonymizer({ salt: SALT });
    anon.text(FORBIDDEN.userPath);
    expect(anon.redactionCount()).toBeGreaterThan(0);
  });
});
