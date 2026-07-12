import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAlwaysAllowRule,
  loadPersistedAlwaysAllowRules,
  PersistingSessionPermissionRules,
} from "./settings-rules.js";
import { ModePermissionEngine } from "../permissions/engine.js";
import { RuleAwarePermissionEngine } from "../permissions/rules.js";
import type { PermissionRequest, PermissionRule } from "../types/permissions.js";
import type { ToolMetadata } from "../types/tools.js";

function metadataFor(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    name: "Write",
    description: "fake",
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    riskLevel: "medium",
    sideEffectScope: "filesystem",
    needsApproval: false,
    timeoutMs: 120_000,
    ...overrides,
  };
}

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "anycode-settings-rules-"));
  return tmpDir;
}

function settingsPath(dir: string): string {
  return join(dir, "settings.json");
}

describe("loadPersistedAlwaysAllowRules", () => {
  it("returns [] for a missing file", async () => {
    const dir = await freshDir();
    const rules = await loadPersistedAlwaysAllowRules(settingsPath(dir));
    expect(rules).toEqual([]);
  });

  it("returns [] for garbage bytes and leaves the file byte-untouched", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    await writeFile(path, "not json {{{");
    const before = await readFile(path, "utf8");

    const rules = await loadPersistedAlwaysAllowRules(path);

    expect(rules).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("returns [] for a valid object with no permissions section", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    await writeFile(path, JSON.stringify({ version: 1 }));

    const rules = await loadPersistedAlwaysAllowRules(path);

    expect(rules).toEqual([]);
  });

  it("skips malformed entries one at a time, valid siblings survive", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        permissions: {
          alwaysAllow: [
            { toolName: "Bash", pattern: "git *" },
            42,
            { pattern: "x" },
            { toolName: "" },
            { toolName: "Write", pattern: 42 },
            { toolName: "Read" },
          ],
        },
      }),
    );

    const rules = await loadPersistedAlwaysAllowRules(path);

    expect(rules).toEqual([
      { toolName: "Bash", pattern: "git *" },
      { toolName: "Read" },
    ]);
  });
});

describe("appendAlwaysAllowRule", () => {
  it("creates a full default-shaped file on ENOENT, mode 0644, trailing newline", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);

    const result = await appendAlwaysAllowRule(path, { toolName: "Bash", pattern: "git *" });

    expect(result).toEqual({ persisted: true });
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      version: 1,
      provider: {},
      tools: {},
      permissions: { alwaysAllow: [{ toolName: "Bash", pattern: "git *" }] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it("dedups an identical {toolName, pattern} rule as a no-op", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    await appendAlwaysAllowRule(path, { toolName: "Bash", pattern: "git *" });
    const before = await readFile(path, "utf8");
    const mtimeBefore = (await stat(path)).mtimeMs;

    const result = await appendAlwaysAllowRule(path, { toolName: "Bash", pattern: "git *" });

    expect(result).toEqual({ persisted: true });
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await stat(path)).mtimeMs).toBe(mtimeBefore);
  });

  it("preserves unknown top-level keys (opaque passthrough)", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        provider: {},
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
        someFutureField: { nested: true },
      }),
    );

    const result = await appendAlwaysAllowRule(path, { toolName: "Read" });

    expect(result).toEqual({ persisted: true });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.someFutureField).toEqual({ nested: true });
    expect(parsed.permissions.alwaysAllow).toEqual([{ toolName: "Read" }]);
  });

  it("refuses a version:2 file with unsupported_version, bytes untouched", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    const original = JSON.stringify({ version: 2, permissions: { alwaysAllow: [] } });
    await writeFile(path, original);

    const result = await appendAlwaysAllowRule(path, { toolName: "Read" });

    expect(result).toEqual({ persisted: false, reason: "unsupported_version" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("refuses a v1 file whose permissions is not a plain object, bytes untouched (does not coerce to {})", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    const original = JSON.stringify({ version: 1, permissions: 42 });
    await writeFile(path, original);

    const result = await appendAlwaysAllowRule(path, { toolName: "Read" });

    expect(result).toEqual({ persisted: false, reason: "malformed" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("refuses a v1 file whose permissions.alwaysAllow is not an array, bytes untouched (does not coerce to [])", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    const original = JSON.stringify({ version: 1, permissions: { alwaysAllow: "x" } });
    await writeFile(path, original);

    const result = await appendAlwaysAllowRule(path, { toolName: "Read" });

    expect(result).toEqual({ persisted: false, reason: "malformed" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("dedups structurally: {toolName:'Bash', pattern: undefined} and {toolName:'Bash', pattern:''} are distinct rules", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    await appendAlwaysAllowRule(path, { toolName: "Bash" });

    const result = await appendAlwaysAllowRule(path, { toolName: "Bash", pattern: "" });

    expect(result).toEqual({ persisted: true });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.permissions.alwaysAllow).toEqual([{ toolName: "Bash" }, { toolName: "Bash", pattern: "" }]);
  });

  it("N parallel appends of distinct rules to a fresh file all survive (in-process serialization)", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    const ruleCount = 20;
    const rules: PermissionRule[] = Array.from({ length: ruleCount }, (_, i) => ({
      toolName: "Bash",
      pattern: `rule-${i}`,
    }));

    const results = await Promise.all(rules.map((rule) => appendAlwaysAllowRule(path, rule)));

    expect(results).toEqual(rules.map(() => ({ persisted: true })));
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.permissions.alwaysAllow).toHaveLength(ruleCount);
    for (const rule of rules) {
      expect(parsed.permissions.alwaysAllow).toContainEqual(rule);
    }
  });

  it("refuses garbage bytes with malformed, bytes untouched", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    const original = "not json at all {{{";
    await writeFile(path, original);

    const result = await appendAlwaysAllowRule(path, { toolName: "Read" });

    expect(result).toEqual({ persisted: false, reason: "malformed" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("resolves to io_error (never throws) for an inaccessible directory", async () => {
    const dir = await freshDir();
    const roBase = join(dir, "ro");
    await mkdir(roBase, { recursive: true });
    await chmod(roBase, 0o500);
    const path = join(roBase, "nested", "settings.json");

    let result;
    await expect(
      (async () => {
        result = await appendAlwaysAllowRule(path, { toolName: "Read" });
      })(),
    ).resolves.not.toThrow();
    expect(result).toEqual({ persisted: false, reason: "io_error" });

    await chmod(roBase, 0o700);
  });
});

describe("PersistingSessionPermissionRules", () => {
  it("add() calls persist exactly once and the store still works like the base", async () => {
    const persistCalls: Array<{ toolName: string; pattern?: string }> = [];
    const store = new PersistingSessionPermissionRules(
      async (rule) => {
        persistCalls.push(rule);
        return { persisted: true };
      },
      () => {
        throw new Error("should not be called on success");
      },
    );

    store.add({ toolName: "Bash", pattern: "ls *" });
    expect(store.list()).toEqual([{ toolName: "Bash", pattern: "ls *" }]);
    expect(store.matches("Bash", { command: "ls -la" })).toBe(true);

    await Promise.resolve();
    expect(persistCalls).toEqual([{ toolName: "Bash", pattern: "ls *" }]);
  });

  it("a persist failure reports via onPersistFailure while the rule stays in the store", async () => {
    const failures: Array<{ rule: unknown; reason: string }> = [];
    const store = new PersistingSessionPermissionRules(
      async () => ({ persisted: false, reason: "io_error" }) as const,
      (rule, reason) => {
        failures.push({ rule, reason });
      },
    );

    store.add({ toolName: "Write" });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.list()).toEqual([{ toolName: "Write" }]);
    expect(failures).toEqual([{ rule: { toolName: "Write" }, reason: "io_error" }]);
  });

  it("persist() rejecting is routed to onPersistFailure instead of becoming an unhandledRejection", async () => {
    const failures: Array<{ rule: unknown; reason: string }> = [];
    const store = new PersistingSessionPermissionRules(
      async () => {
        throw new Error("disk exploded");
      },
      (rule, reason) => {
        failures.push({ rule, reason });
      },
    );

    store.add({ toolName: "Write" });
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toEqual([{ rule: { toolName: "Write" }, reason: "disk exploded" }]);
  });

  it("onPersistFailure itself throwing is swallowed, not surfaced as an unhandledRejection", async () => {
    const store = new PersistingSessionPermissionRules(
      async () => ({ persisted: false, reason: "io_error" }) as const,
      () => {
        throw new Error("failure callback is also broken");
      },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);

    try {
      store.add({ toolName: "Write" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("seedPersisted does NOT call persist", async () => {
    let persistCalls = 0;
    const store = new PersistingSessionPermissionRules(
      async () => {
        persistCalls += 1;
        return { persisted: true };
      },
      () => {},
    );

    store.seedPersisted([{ toolName: "Read" }, { toolName: "Bash", pattern: "git *" }]);
    await Promise.resolve();

    expect(store.list()).toEqual([{ toolName: "Read" }, { toolName: "Bash", pattern: "git *" }]);
    expect(persistCalls).toBe(0);
  });
});

describe("restart-survival integration (DoD-core)", () => {
  it("a rule added by session #1 auto-allows a matching ask in session #2 via one file", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    let persistDone: Promise<unknown> = Promise.resolve();

    const session1 = new PersistingSessionPermissionRules(
      (rule) => {
        const promise = appendAlwaysAllowRule(path, rule);
        persistDone = promise;
        return promise;
      },
      () => {
        throw new Error("persist should succeed in this test");
      },
    );
    session1.add({ toolName: "Bash", pattern: "git *" });
    await persistDone;

    const persisted = await loadPersistedAlwaysAllowRules(path);
    const session2 = new PersistingSessionPermissionRules(
      (rule) => appendAlwaysAllowRule(path, rule),
      () => {},
    );
    session2.seedPersisted(persisted);

    expect(session2.matches("Bash", { command: "git status" })).toBe(true);
  });
});

describe("fail-closed invariant (adversarial)", () => {
  const request: PermissionRequest = {
    toolName: "Write",
    input: { file_path: "/tmp/x" },
    metadata: metadataFor(),
    mode: "plan",
  };

  it("a persisted always-allow rule does not override plan-mode deny for Write", async () => {
    const store = new PersistingSessionPermissionRules(
      async () => ({ persisted: true }),
      () => {},
    );
    store.seedPersisted([{ toolName: "Write" }]);
    const engine = new RuleAwarePermissionEngine(new ModePermissionEngine(), store);

    const ruling = engine.check(request);

    expect(ruling.decision).toBe("deny");
  });

  it("a malformed persisted file behaves byte-identically to an empty store", async () => {
    const dir = await freshDir();
    const path = settingsPath(dir);
    await writeFile(path, "not json {{{");

    const rules = await loadPersistedAlwaysAllowRules(path);
    const store = new PersistingSessionPermissionRules(
      async () => ({ persisted: true }),
      () => {},
    );
    store.seedPersisted(rules);
    const engineWithMalformedSeed = new RuleAwarePermissionEngine(new ModePermissionEngine(), store);

    const emptyStore = new PersistingSessionPermissionRules(
      async () => ({ persisted: true }),
      () => {},
    );
    const engineWithEmptyStore = new RuleAwarePermissionEngine(new ModePermissionEngine(), emptyStore);

    const askRequest: PermissionRequest = {
      toolName: "Bash",
      input: { command: "rm -rf /" },
      metadata: metadataFor({ name: "Bash", riskLevel: "high", sideEffectScope: "process" }),
      mode: "build",
    };

    expect(engineWithMalformedSeed.check(askRequest)).toEqual(engineWithEmptyStore.check(askRequest));
  });
});
