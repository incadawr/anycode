/**
 * Unit tests for `scripts/check-codex-manifest-scheduled.mjs` — the
 * between-releases watch. No network, no GitHub: `parseArgs`/`orchestrate`
 * are called directly, and the `gh` helper is a recording fake, so the issue
 * flow (create vs comment, dedup, skip-on-network-failure) is pinned without
 * a live `gh` — the workflow itself is never run against GitHub from tests.
 */
import { describe, expect, it } from "vitest";

const { parseArgs, orchestrate } = await import("../scripts/check-codex-manifest-scheduled.mjs");

/** Records every argv it receives; replies are keyed by first two subcommands. */
function makeFakeGh(replies = {}) {
  const calls = [];
  const fake = (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    if (key in replies) {
      const reply = replies[key];
      if (typeof reply === "function") return reply(args);
      return reply;
      }
    return "";
  };
  fake.calls = calls;
  return fake;
}

describe("parseArgs", () => {
  it("no flags → dry-run is the default with the first watched repo", () => {
    expect(parseArgs([])).toEqual({ ok: true, args: { dryRun: true, repo: "incadawr/anycode" } });
  });

  it("--repo x/y stays dry-run by default", () => {
    expect(parseArgs(["--repo", "x/y"])).toEqual({ ok: true, args: { dryRun: true, repo: "x/y" } });
  });

  it("--dry-run and --repo together are accepted", () => {
    expect(parseArgs(["--dry-run", "--repo", "incadawr/anycode"])).toEqual({
      ok: true,
      args: { dryRun: true, repo: "incadawr/anycode" },
    });
  });

  it("an unknown flag is exit 2 with usage", () => {
    const result = parseArgs(["--verbose"]);
    expect(result.ok).toBe(false);
    expect(result.exit).toBe(2);
    expect(result.message).toContain("unknown flag");
  });

  it("--repo without a value is exit 2", () => {
    const result = parseArgs(["--repo"]);
    expect(result.ok).toBe(false);
    expect(result.exit).toBe(2);
  });

  it("a repo outside the watched list is exit 2 (repo is not watched)", () => {
    // parseArgs itself never rejects a repo — orchestrate enforces the watch
    // list only when it would act on it. Pin both halves:
    expect(parseArgs(["--repo", "x/y"])).toEqual({ ok: true, args: { dryRun: true, repo: "x/y" } });
    expect(orchestrate({ versions: ["0.164.0"], dryRun: false, repo: "x/y", gh: makeFakeGh() })).toMatchObject({
      exit: 2,
      message: expect.stringContaining("repo is not watched"),
    });
  });

  it("a watched repo is accepted for the non-dry-run path", () => {
    expect(parseArgs(["--dry-run", "--repo", "incadawr/anycode"])).toEqual({
      ok: true,
      args: { dryRun: true, repo: "incadawr/anycode" },
    });
  });
});

describe("orchestrate — dry run (default)", () => {
  it("stale range → exit 0 and gh is never called", () => {
    const ghFake = makeFakeGh();
    const result = orchestrate({ versions: ["0.164.0"], dryRun: true, gh: ghFake });
    expect(result.exit).toBe(0);
    expect(result.runResult.exit).toBe(1);
    expect(ghFake.calls).toHaveLength(0);
  });
});

describe("orchestrate — live mode (issue flow)", () => {
  it("stale range with no open issue → create, labeled codex-manifest-watch, title says stale", () => {
    const ghFake = makeFakeGh({
      "issue list": "[]",
      "issue create": "https://github.com/incadawr/anycode/issues/42\n",
    });
    const result = orchestrate({ versions: ["0.164.0"], dryRun: false, gh: ghFake });
    expect(result.exit).toBe(1);

    const create = ghFake.calls.find((c) => c[0] === "issue" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create).toContain("--label");
    expect(create).toContain("codex-manifest-watch");
    const title = create[create.indexOf("--title") + 1];
    expect(title).toContain("stale");
    const body = create[create.indexOf("--body") + 1];
    expect(body).toContain("STALE — 0.164.0 is outside the declared range");
  });

  it("label is created on demand before the issue flow", () => {
    const ghFake = makeFakeGh({
      "issue list": "[]",
      "issue create": "https://github.com/incadawr/anycode/issues/42\n",
    });
    orchestrate({ versions: ["0.164.0"], dryRun: false, gh: ghFake });
    expect(ghFake.calls[0].slice(0, 2)).toEqual(["label", "create"]);
    expect(ghFake.calls[0]).toContain("codex-manifest-watch");
  });

  it("an existing open issue gets a comment, never a second issue", () => {
    const ghFake = makeFakeGh({
      "issue list": JSON.stringify([{ number: 7 }]),
    });
    const result = orchestrate({ versions: ["0.164.0"], dryRun: false, gh: ghFake });
    expect(result.exit).toBe(1);

    const comment = ghFake.calls.find((c) => c[0] === "issue" && c[1] === "comment");
    expect(comment).toBeDefined();
    expect(comment).toContain(String(7));
    expect(ghFake.calls.find((c) => c[0] === "issue" && c[1] === "create")).toBeUndefined();
  });

  it("exit 2 (no network) → SKIP: exit 0 and gh never called", () => {
    const ghFake = makeFakeGh();
    const result = orchestrate({ versions: null, dryRun: false, gh: ghFake });
    expect(result.exit).toBe(0);
    expect(result.skip).toContain("SKIP");
    expect(ghFake.calls).toHaveLength(0);
  });

  it("fresh range → exit 0 and gh never called", () => {
    const ghFake = makeFakeGh();
    const result = orchestrate({ versions: ["0.162.0"], dryRun: false, gh: ghFake });
    expect(result.exit).toBe(0);
    expect(result.skip).toBeUndefined();
    expect(ghFake.calls).toHaveLength(0);
  });
});
