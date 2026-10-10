/**
 * Unit tests for the Vision panel's "Probe" button (TASK.198 срез E2). Every
 * scenario runs over an INJECTED spawner (`RecognizerProbeSpawner`) — no test
 * here starts a process, reads a vault, or touches Electron, matching
 * proxy-probe.test.ts's own discipline for the sibling TASK.141 §6 probe.
 *
 * `settings()`/`noSecret`/`vaultSecret` mirror host-env.test.ts's own
 * fixtures byte-for-byte (same shapes, same names) rather than importing that
 * test file's private helpers — `connectionFixture`/`providerV2Multi` ARE
 * shared (shared/provider-v2-fixture.ts), so those two come from there.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnycodeSettings, SecretKey } from "../shared/settings.js";
import { connectionFixture, providerV2Multi } from "../shared/provider-v2-fixture.js";
import {
  RECOGNIZER_PROBE_IMAGE_BASE64,
  spawnRecognizerProbeChild,
  RECOGNIZER_PROBE_IMAGE_MEDIA_TYPE,
  RECOGNIZER_PROBE_MARKER,
  RECOGNIZER_PROBE_QUESTION,
  classifyRecognizerProbeOutput,
  defaultResolveTelemetryDir,
  handleRecognizerProbeRequest,
  type RecognizerProbeChildInput,
  type RecognizerProbeDeps,
  type RecognizerProbeRawOutput,
  type RecognizerProbeSpawnRequest,
  type RecognizerProbeSpawner,
} from "./recognizer-probe.js";

function settings(over: Partial<AnycodeSettings> = {}): AnycodeSettings {
  return {
    version: 2,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
    ...over,
  };
}

const noSecret = async (_key: SecretKey): Promise<string | undefined> => undefined;
const vaultSecret = (value: string) => async (_key: SecretKey): Promise<string | undefined> => value;

/** Renders a child payload the way the real child (recognizer-probe-child.ts) writes it. */
function stdoutFor(payload: unknown, noise = ""): string {
  return `${noise}${RECOGNIZER_PROBE_MARKER}${JSON.stringify(payload)}\n`;
}

function rawOutput(payload: unknown, overrides: Partial<RecognizerProbeRawOutput> = {}): RecognizerProbeRawOutput {
  return { timedOut: false, exitCode: 0, stdout: stdoutFor(payload), stderr: "", ...overrides };
}

/** A spawner that records every call and always answers with `raw` — used by tests that expect a spawn. */
function spawnerFor(raw: RecognizerProbeRawOutput): { spawn: RecognizerProbeSpawner; calls: RecognizerProbeSpawnRequest[] } {
  const calls: RecognizerProbeSpawnRequest[] = [];
  const spawn: RecognizerProbeSpawner = vi.fn(async (request) => {
    calls.push(request);
    return raw;
  });
  return { spawn, calls };
}

/** A spawner that FAILS the test if it is ever called — for the "must refuse without spawning" cases. */
function spawnerThatMustNotRun(): RecognizerProbeSpawner {
  return vi.fn(async () => {
    throw new Error("spawner must not be called for a refused candidate");
  });
}

function baseDeps(overrides: Partial<RecognizerProbeDeps>): RecognizerProbeDeps {
  return {
    readSettings: () => settings(),
    getSecret: noSecret,
    execPath: "/usr/bin/node",
    childEntry: "/out/main/recognizer-probe-child.js",
    env: { PATH: "/usr/bin" },
    spawn: spawnerThatMustNotRun(),
    // TASK.203: the production handler falls back to defaultResolveTelemetryDir
    // (the real machine's ~/.anycode/config.json) — every pre-existing test
    // here must stay isolated from that, so the default deps carry an explicit
    // "telemetry disabled" resolver.
    resolveTelemetryDir: async () => undefined,
    ...overrides,
  };
}

const visionConnection = connectionFixture({
  id: "openai",
  connectionId: "conn-vision",
  baseUrl: "https://vision.example.com",
  transport: "openai-chat-completions",
});

describe("handleRecognizerProbeRequest — refuses without spawning (resolveRecognizerConfig's own refusals)", () => {
  it("refuses a malformed request body — the probe's own stand-in for \"no recognizer section to resolve\"", async () => {
    const spawn = spawnerThatMustNotRun();
    const result = await handleRecognizerProbeRequest(baseDeps({ spawn }), { connectionId: "", modelId: "m" });
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "not_configured", message: expect.any(String) });
  });

  it("refuses a dangling connectionId — the connection was deleted out from under a stable id", async () => {
    const spawn = spawnerThatMustNotRun();
    const deps = baseDeps({
      readSettings: () => ({ ...settings(), provider: providerV2Multi(undefined, [visionConnection]) }),
      spawn,
    });
    const result = await handleRecognizerProbeRequest(deps, { connectionId: "conn-gone", modelId: "vision-model" });
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "not_configured", message: expect.any(String) });
  });

  it("refuses an OAuth-authenticated connection — no static key can stand in for a refreshable OAuth token", async () => {
    const oauthConnection = connectionFixture({ id: "anthropic", connectionId: "conn-oauth-vision" });
    const spawn = spawnerThatMustNotRun();
    const deps = baseDeps({
      readSettings: () => ({ ...settings(), provider: providerV2Multi(undefined, [oauthConnection]) }),
      getSecret: vaultSecret("sk-should-never-be-read"),
      authKindFor: () => "oauth",
      spawn,
    });
    const result = await handleRecognizerProbeRequest(deps, { connectionId: "conn-oauth-vision", modelId: "vision-model" });
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "not_configured", message: expect.any(String) });
  });

  it("refuses an unrecognised transport string from the catalog fallback — same allow-list host/index.ts's recognizerEndpointFromFields enforces", async () => {
    // No `transport` on the connection itself, so `resolveEffectiveTransport`
    // takes the catalog-default branch; `RecognizerCatalogInfo.defaultTransport`
    // is a bare `string`, not narrowed to `ProviderTransportId`, so a bogus
    // catalog value reaches this module's own field-mirror unvalidated —
    // exactly the case its transport allow-list exists to catch.
    const noTransportConnection = connectionFixture({ id: "vllm", connectionId: "conn-vllm", baseUrl: "https://vllm.example.com" });
    const spawn = spawnerThatMustNotRun();
    const deps = baseDeps({
      readSettings: () => ({ ...settings(), provider: providerV2Multi(undefined, [noTransportConnection]) }),
      catalogFor: () => ({ baseUrl: "https://vllm.example.com", defaultTransport: "bogus-transport" }),
      spawn,
    });
    const result = await handleRecognizerProbeRequest(deps, { connectionId: "conn-vllm", modelId: "vision-model" });
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "not_configured", message: expect.any(String) });
  });
});

describe("handleRecognizerProbeRequest — success", () => {
  it("returns the child's answer verbatim and spawns with the production-resolved endpoint", async () => {
    const { spawn, calls } = spawnerFor(rawOutput({ ok: true, text: "the left square is red, the right is blue" }));
    const deps = baseDeps({
      readSettings: () => ({ ...settings(), provider: providerV2Multi(undefined, [visionConnection]) }),
      getSecret: vaultSecret("sk-vision"),
      spawn,
    });
    const result = await handleRecognizerProbeRequest(deps, { connectionId: "conn-vision", modelId: "vision-model" });
    expect(result).toEqual({ ok: true, text: "the left square is red, the right is blue" });
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    // Requirement (coordinator, TASK.198 срез E2): args carries NOTHING but the
    // child entry path — the api key must never be visible in `ps` to any
    // other process on the machine.
    expect(call.args).toEqual(["/out/main/recognizer-probe-child.js"]);
    expect(call.execPath).toBe("/usr/bin/node");
    expect(call.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(call.env.PATH).toBe("/usr/bin");
    // The api key must never ride the env either — stdin is the ONLY channel.
    expect(Object.values(call.env)).not.toContain("sk-vision");

    const childInput = JSON.parse(call.stdin) as RecognizerProbeChildInput;
    expect(childInput.endpoint).toEqual({
      transport: "openai-chat-completions",
      baseUrl: "https://vision.example.com",
      model: "vision-model",
      apiKey: "sk-vision",
      providerName: "openai",
    });
    expect(childInput.question).toBe(RECOGNIZER_PROBE_QUESTION);
    expect(childInput.image).toEqual({ mediaType: RECOGNIZER_PROBE_IMAGE_MEDIA_TYPE, data: RECOGNIZER_PROBE_IMAGE_BASE64 });
  });

  it("defaults an unset transport to anthropic-messages — the SAME default the primary provider path and host/index.ts's own field-mirror share", async () => {
    const bareConnection = connectionFixture({ connectionId: "conn-bare", baseUrl: "https://bare.example.com" });
    const { spawn, calls } = spawnerFor(rawOutput({ ok: true, text: "red, blue" }));
    const deps = baseDeps({
      readSettings: () => ({ ...settings(), provider: providerV2Multi(undefined, [bareConnection]) }),
      spawn,
    });
    await handleRecognizerProbeRequest(deps, { connectionId: "conn-bare", modelId: "m" });
    const childInput = JSON.parse(calls[0]!.stdin) as RecognizerProbeChildInput;
    expect(childInput.endpoint.transport).toBe("anthropic-messages");
  });
});

describe("handleRecognizerProbeRequest — the child's own outcomes", () => {
  function depsWithConnection(spawn: RecognizerProbeSpawner): RecognizerProbeDeps {
    return baseDeps({
      readSettings: () => ({ ...settings(), provider: providerV2Multi(undefined, [visionConnection]) }),
      getSecret: noSecret,
      spawn,
    });
  }

  it("classifies a killed-by-timeout child as a timeout, not a generic error", async () => {
    const { spawn } = spawnerFor({ timedOut: true, exitCode: null, stdout: "", stderr: "" });
    const result = await handleRecognizerProbeRequest(
      depsWithConnection(spawn),
      { connectionId: "conn-vision", modelId: "vision-model" },
    );
    expect(result).toEqual({ ok: false, reason: "timeout", message: expect.any(String) });
  });

  it("classifies the child's own AskResult timeout the same way as a killed child", async () => {
    const { spawn } = spawnerFor(rawOutput({ ok: false, kind: "timeout", error: "recognizer request timed out" }));
    const result = await handleRecognizerProbeRequest(
      depsWithConnection(spawn),
      { connectionId: "conn-vision", modelId: "vision-model" },
    );
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("timeout");
  });

  it("gives an honest 'bad_output' refusal, never a throw, when the child prints garbage instead of JSON", async () => {
    const { spawn } = spawnerFor({ timedOut: false, exitCode: 0, stdout: "TypeError: something exploded\n", stderr: "" });
    const result = await handleRecognizerProbeRequest(
      depsWithConnection(spawn),
      { connectionId: "conn-vision", modelId: "vision-model" },
    );
    expect(result).toEqual({ ok: false, reason: "bad_output", message: expect.any(String) });
  });

  it("classifies an empty answer as empty_response, not a silent success", async () => {
    const { spawn } = spawnerFor(rawOutput({ ok: true, text: "   " }));
    const result = await handleRecognizerProbeRequest(
      depsWithConnection(spawn),
      { connectionId: "conn-vision", modelId: "vision-model" },
    );
    expect(result).toEqual({ ok: false, reason: "empty_response", message: expect.any(String) });
  });

  it("classifies the child's own provider failure as provider_error", async () => {
    const { spawn } = spawnerFor(rawOutput({ ok: false, kind: "provider", error: "upstream returned 500" }));
    const result = await handleRecognizerProbeRequest(
      depsWithConnection(spawn),
      { connectionId: "conn-vision", modelId: "vision-model" },
    );
    expect(result).toEqual({ ok: false, reason: "provider_error", message: "upstream returned 500" });
  });

  it("reports a spawn failure (e.g. ENOENT on execPath) as its own reason, distinct from a timeout", async () => {
    const spawn: RecognizerProbeSpawner = vi.fn(async () => ({
      timedOut: false,
      spawnError: "spawn /usr/bin/node ENOENT",
      exitCode: null,
      stdout: "",
      stderr: "",
    }));
    const result = await handleRecognizerProbeRequest(
      depsWithConnection(spawn),
      { connectionId: "conn-vision", modelId: "vision-model" },
    );
    expect(result).toEqual({ ok: false, reason: "spawn_failed", message: "spawn /usr/bin/node ENOENT" });
  });
});

describe("classifyRecognizerProbeOutput — the child's AskResult kind -> probe reason table", () => {
  it("maps every AskResult failure kind to its own classification", () => {
    expect(classifyRecognizerProbeOutput(rawOutput({ ok: false, kind: "timeout", error: "e" }))).toEqual({ kind: "timeout" });
    expect(classifyRecognizerProbeOutput(rawOutput({ ok: false, kind: "aborted", error: "e" }))).toEqual({ kind: "timeout" });
    expect(classifyRecognizerProbeOutput(rawOutput({ ok: false, kind: "empty", error: "e" }))).toEqual({ kind: "empty_response" });
    expect(classifyRecognizerProbeOutput(rawOutput({ ok: false, kind: "provider", error: "boom" }))).toEqual({
      kind: "provider_error",
      message: "boom",
    });
  });

  it("says it does not know rather than inventing a cause when the child printed nothing parseable", () => {
    expect(classifyRecognizerProbeOutput({ timedOut: false, exitCode: 1, stdout: "", stderr: "segfault" })).toEqual({
      kind: "bad_output",
      message: "segfault",
    });
    expect(classifyRecognizerProbeOutput({ timedOut: false, exitCode: null, stdout: "", stderr: "" })).toEqual({
      kind: "bad_output",
      message: "probe produced no result (exit null)",
    });
  });

  it("finds the marker line among runtime noise on stdout", () => {
    const raw = rawOutput({ ok: true, text: "answer" }, { stdout: `node warning: something\n${stdoutFor({ ok: true, text: "answer" })}` });
    expect(classifyRecognizerProbeOutput(raw)).toEqual({ kind: "success", text: "answer" });
  });
});

describe("secret scrub — the resolved api key never rides a returned text", () => {
  const SECRET = "sk-super-secret-value-123";

  function depsWithSecret(spawn: RecognizerProbeSpawner): RecognizerProbeDeps {
    return baseDeps({
      readSettings: () => ({ ...settings(), provider: providerV2Multi(undefined, [visionConnection]) }),
      getSecret: vaultSecret(SECRET),
      spawn,
    });
  }

  it("scrubs the key out of a provider-error message that echoes it back", async () => {
    const { spawn } = spawnerFor(rawOutput({ ok: false, kind: "provider", error: `upstream rejected key ${SECRET}` }));
    const result = await handleRecognizerProbeRequest(depsWithSecret(spawn), {
      connectionId: "conn-vision",
      modelId: "vision-model",
    });
    expect(result.ok).toBe(false);
    const message = (result as { message: string }).message;
    expect(message).not.toContain(SECRET);
    expect(message).toContain("***");
  });

  it("scrubs the key out of stderr surfaced through a bad_output refusal", async () => {
    const { spawn } = spawnerFor({ timedOut: false, exitCode: 1, stdout: "", stderr: `auth failed for ${SECRET}` });
    const result = await handleRecognizerProbeRequest(depsWithSecret(spawn), {
      connectionId: "conn-vision",
      modelId: "vision-model",
    });
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).not.toContain(SECRET);
  });

  it("scrubs the key out of a SUCCESS answer too, if the model ever echoed it back", async () => {
    const { spawn } = spawnerFor(rawOutput({ ok: true, text: `the key you gave me is ${SECRET}, and the squares are red/blue` }));
    const result = await handleRecognizerProbeRequest(depsWithSecret(spawn), {
      connectionId: "conn-vision",
      modelId: "vision-model",
    });
    expect(result.ok).toBe(true);
    expect((result as { text: string }).text).not.toContain(SECRET);
  });

  it("never places the key in argv or env — only the stdin JSON carries it", async () => {
    const { spawn, calls } = spawnerFor(rawOutput({ ok: true, text: "red, blue" }));
    await handleRecognizerProbeRequest(depsWithSecret(spawn), { connectionId: "conn-vision", modelId: "vision-model" });
    const call = calls[0]!;
    expect(call.args.join(" ")).not.toContain(SECRET);
    expect(Object.values(call.env).join(" ")).not.toContain(SECRET);
    expect(call.stdin).toContain(SECRET);
  });
});

describe("the embedded probe image (TASK.69's two-square probe)", () => {
  /**
   * The exact 8-byte PNG signature `sniffImageMediaType` (packages/core/src/
   * util/images.ts) checks — reproduced here rather than imported because
   * that function is not on `@anycode/core`'s public export map (no
   * `./util/images` subpath exists), and this package's own discipline keeps
   * main's core imports to curated subpaths rather than reaching past them.
   * The real function WAS run against these exact bytes during development
   * (`sniffImageMediaType(...) === "image/png"`, verified via a one-off tsx
   * script importing it by file path) — this assertion pins the same 8 bytes
   * that call checked, so a future edit to the constant is caught here too.
   */
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("decodes as a valid PNG recognised by the same magic bytes sniffImageMediaType checks", () => {
    const bytes = Buffer.from(RECOGNIZER_PROBE_IMAGE_BASE64, "base64");
    expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(RECOGNIZER_PROBE_IMAGE_MEDIA_TYPE).toBe("image/png");
  });

  it("re-encodes to the exact byte length Pillow produced — not pasted 'by eye'", () => {
    const bytes = Buffer.from(RECOGNIZER_PROBE_IMAGE_BASE64, "base64");
    expect(bytes.byteLength).toBe(157);
  });
});

/**
 * The one place a test here starts a REAL process. Everything above runs over
 * the injected spawner, which by construction cannot exercise the spawner's
 * own stream wiring — and that wiring is where a main-process crash hides: a
 * child that exits before its stdin is drained emits EPIPE on the stdin
 * stream, and an `error` event with no listener THROWS out of the main
 * process, taking the app window with it. No fake spawner can see that, so
 * this one test pays for a ~100ms real spawn.
 */
describe("spawnRecognizerProbeChild — the real spawner's stream wiring", () => {
  it("resolves instead of throwing when the child exits before its stdin is drained", async () => {
    // 4 MB against a 64 KB pipe buffer: the write CANNOT complete before a
    // child whose only statement is `process.exit(0)` is gone, so the EPIPE
    // path is taken deterministically rather than by timing luck.
    const oversizedStdin = "x".repeat(4 * 1024 * 1024);
    const result = await spawnRecognizerProbeChild({
      execPath: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdin: oversizedStdin,
      timeoutMs: 10_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
});

// ── TASK.203: telemetry rides the probe's stdin ──

/** A deps bag with the vision connection resolved, for the telemetry describes below. */
function depsWithVision(spawn: RecognizerProbeSpawner, overrides: Partial<RecognizerProbeDeps> = {}): RecognizerProbeDeps {
  return baseDeps({
    readSettings: () => ({ ...settings(), provider: providerV2Multi(undefined, [visionConnection]) }),
    getSecret: noSecret,
    spawn,
    ...overrides,
  });
}

describe("handleRecognizerProbeRequest — telemetry resolution (TASK.203)", () => {
  it("attaches a vision-probe numeric session and resolved dir to the stdin when telemetry resolves", async () => {
    const { spawn, calls } = spawnerFor(rawOutput({ ok: true, text: "red, blue" }));
    const deps = depsWithVision(spawn, { resolveTelemetryDir: async () => "/tmp/telemetry-dir" });
    await handleRecognizerProbeRequest(deps, { connectionId: "conn-vision", modelId: "vision-model" });
    const childInput = JSON.parse(calls[0]!.stdin) as RecognizerProbeChildInput;
    expect(childInput.telemetry).toBeDefined();
    expect(childInput.telemetry!.dir).toBe("/tmp/telemetry-dir");
    expect(childInput.telemetry!.session).toMatch(/^vision-probe-\d+$/);
  });

  it("omits telemetry entirely when resolution returns undefined (disabled), and still probes successfully", async () => {
    const { spawn, calls } = spawnerFor(rawOutput({ ok: true, text: "red, blue" }));
    const deps = depsWithVision(spawn, { resolveTelemetryDir: async () => undefined });
    const result = await handleRecognizerProbeRequest(deps, { connectionId: "conn-vision", modelId: "vision-model" });
    expect(result).toEqual({ ok: true, text: "red, blue" });
    const childInput = JSON.parse(calls[0]!.stdin) as RecognizerProbeChildInput;
    expect(childInput.telemetry).toBeUndefined();
  });

  it("omits telemetry when the resolver THROWS — a telemetry failure must not fail the probe", async () => {
    const { spawn, calls } = spawnerFor(rawOutput({ ok: true, text: "red, blue" }));
    const deps = depsWithVision(spawn, {
      resolveTelemetryDir: async () => {
        throw new Error("config read exploded");
      },
    });
    const result = await handleRecognizerProbeRequest(deps, { connectionId: "conn-vision", modelId: "vision-model" });
    expect(result).toEqual({ ok: true, text: "red, blue" });
    const childInput = JSON.parse(calls[0]!.stdin) as RecognizerProbeChildInput;
    expect(childInput.telemetry).toBeUndefined();
  });

  it("two clicks with a fixed clock still get distinct sessions (monotonic module-local timestamp)", async () => {
    const { spawn, calls } = spawnerFor(rawOutput({ ok: true, text: "red, blue" }));
    const deps = depsWithVision(spawn, { resolveTelemetryDir: async () => "/tmp/telemetry-dir" });
    const realNow = Date.now;
    try {
      const fixed = 1_700_000_000_000;
      Date.now = () => fixed;
      await handleRecognizerProbeRequest(deps, { connectionId: "conn-vision", modelId: "vision-model" });
      await handleRecognizerProbeRequest(deps, { connectionId: "conn-vision", modelId: "vision-model" });
    } finally {
      Date.now = realNow;
    }
    const first = JSON.parse(calls[0]!.stdin) as RecognizerProbeChildInput;
    const second = JSON.parse(calls[1]!.stdin) as RecognizerProbeChildInput;
    expect(first.telemetry!.session).toMatch(/^vision-probe-\d+$/);
    expect(second.telemetry!.session).toMatch(/^vision-probe-\d+$/);
    expect(second.telemetry!.session).not.toBe(first.telemetry!.session);
  });
});

describe("defaultResolveTelemetryDir — isolated-home config resolution (TASK.203)", () => {
  /** Writes `<home>/.anycode/config.json` with the given telemetry section (or removes the section key). */
  async function writeHomeConfig(home: string, telemetry: unknown): Promise<void> {
    await mkdir(join(home, ".anycode"), { recursive: true });
    const body = telemetry === undefined ? {} : { telemetry };
    await writeFile(join(home, ".anycode", "config.json"), JSON.stringify(body), "utf-8");
  }

  async function withTempHome(): Promise<{ home: string; dispose: () => Promise<void> }> {
    const home = await mkdtemp(join(tmpdir(), "probe-home-"));
    return { home, dispose: () => rm(home, { recursive: true, force: true }) };
  }

  it("enabled:true with an explicit dir returns that directory", async () => {
    const { home, dispose } = await withTempHome();
    try {
      await writeHomeConfig(home, { enabled: true, dir: join(home, "sink") });
      await expect(defaultResolveTelemetryDir({}, home)).resolves.toBe(join(home, "sink"));
    } finally {
      await dispose();
    }
  });

  it("enabled:false — and a missing telemetry section — both resolve to undefined", async () => {
    const { home, dispose } = await withTempHome();
    try {
      await writeHomeConfig(home, { enabled: false, dir: join(home, "sink") });
      await expect(defaultResolveTelemetryDir({}, home)).resolves.toBeUndefined();
      await writeHomeConfig(home, undefined);
      await expect(defaultResolveTelemetryDir({}, home)).resolves.toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("ANYCODE_TELEMETRY=off disables even an enabled config", async () => {
    const { home, dispose } = await withTempHome();
    try {
      await writeHomeConfig(home, { enabled: true, dir: join(home, "sink") });
      await expect(defaultResolveTelemetryDir({ ANYCODE_TELEMETRY: "off" }, home)).resolves.toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("ANYCODE_TELEMETRY_DIR redirects an enabled config; alone (no enabled section) it does NOT enable", async () => {
    const { home, dispose } = await withTempHome();
    try {
      const redirect = join(home, "elsewhere");
      await writeHomeConfig(home, { enabled: true, dir: join(home, "sink") });
      await expect(defaultResolveTelemetryDir({ ANYCODE_TELEMETRY_DIR: redirect }, home)).resolves.toBe(redirect);
      // Override alone, config not enabled — still disabled.
      await writeHomeConfig(home, undefined);
      await expect(defaultResolveTelemetryDir({ ANYCODE_TELEMETRY_DIR: redirect }, home)).resolves.toBeUndefined();
    } finally {
      await dispose();
    }
  });
});
