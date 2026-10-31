/**
 * The channel-echo example (Taskana 4750b): (a) its manifest is valid as a
 * service plugin; (b) the REAL Sessions API server and the REAL service script
 * run together and a file addressed to a handle is answered in the outbox;
 * (c) an unknown handle is answered with an error file; (d) without the
 * Sessions API the service prints the hint and stays idle.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginManifestSchema, servicesHash } from "@anycode/core/plugins-admin";
import { startCommunicationServer } from "./communication-server.js";

const exampleDir = fileURLToPath(new URL("../../../../examples/channel-echo", import.meta.url));
const cleanups: Array<() => Promise<unknown>> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const close of cleanups.splice(0).reverse()) await close();
});

function output(child: ChildProcess): { read(): string } {
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  return { read: () => text };
}

describe("channel-echo example plugin (Taskana 4750b)", () => {
  it("manifest parses as a service plugin and its service hash is stable", async () => {
    const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(join(exampleDir, ".anycode-plugin", "plugin.json"), "utf8")));
    expect(manifest.services).toEqual([{ name: "bridge", command: "node", args: ["./service.mjs"] }]);
    expect(existsSync(join(exampleDir, "service.mjs"))).toBe(true);
    expect(servicesHash(manifest.services)).toMatch(/^[0-9a-f]+$/);
    expect(servicesHash(manifest.services)).toBe(servicesHash(manifest.services));
  });

  it("answers a handle-addressed file end to end through the real server and the real service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-channel-echo-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const inbox = join(dir, "inbox"); const outbox = join(dir, "outbox");
    await mkdir(inbox, { recursive: true });
    const discoveryFile = join(dir, "endpoint.json");
    const request = vi.fn(async (_session: string, op: string, payload?: unknown) => {
      if (op === "get_session_status") return { state: "idle" };
      if (op === "send_message") return { envelope: payload, state: "acknowledged", detail: "transport accepted" };
      if (op === "get_message_result") return { state: "done", latestResult: { publicAnswer: "ECHO:hello", turnId: "t1" }, limitation: "L" };
      return undefined;
    });
    const manager = { listTabs: () => [{ sessionId: "s-build", workspace: dir, state: "running", pid: 1 }], communicationRequest: request };
    const service = await startCommunicationServer({ manager, userData: dir, config: { workspaces: [], port: 0, discoveryFile }, isSessionExposed: () => true, handleOf: (id) => (id === "s-build" ? "build-bot" : undefined), pollMs: 20 });
    cleanups.push(() => service.close());
    const token = JSON.parse(await readFile(discoveryFile, "utf8")).token as string;
    await writeFile(join(inbox, "build-bot__hello.txt"), "hello");
    const child = spawn(process.execPath, [join(exampleDir, "service.mjs")], { env: { PATH: process.env.PATH ?? "", ANYCODE_SESSIONS_DISCOVERY: discoveryFile, CHANNEL_ECHO_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const out = output(child);
    await vi.waitFor(async () => expect(await readFile(join(outbox, "build-bot__hello.answer.txt"), "utf8")).toContain("ECHO:hello"), { timeout: 15000, interval: 50 });
    expect(existsSync(join(inbox, "build-bot__hello.txt"))).toBe(false);
    expect(existsSync(join(inbox, "build-bot__hello.txt.processing"))).toBe(false);
    expect(request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
    expect(out.read()).not.toContain(token);
    child.kill("SIGTERM");
  }, 20000);

  it("answers an unknown handle with an error file and removes the input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-channel-echo-x-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const inbox = join(dir, "inbox"); const outbox = join(dir, "outbox");
    await mkdir(inbox, { recursive: true });
    const discoveryFile = join(dir, "endpoint.json");
    const request = vi.fn(async () => undefined);
    const manager = { listTabs: () => [], communicationRequest: request };
    const service = await startCommunicationServer({ manager, userData: dir, config: { workspaces: [], port: 0, discoveryFile }, isSessionExposed: () => true });
    cleanups.push(() => service.close());
    await writeFile(join(inbox, "nobody__hi.txt"), "hi");
    const child = spawn(process.execPath, [join(exampleDir, "service.mjs")], { env: { PATH: process.env.PATH ?? "", ANYCODE_SESSIONS_DISCOVERY: discoveryFile, CHANNEL_ECHO_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    await vi.waitFor(async () => expect(await readFile(join(outbox, "nobody__hi.error.txt"), "utf8")).toContain("no live session with handle nobody"), { timeout: 15000, interval: 50 });
    expect(existsSync(join(inbox, "nobody__hi.txt"))).toBe(false);
    expect(request).not.toHaveBeenCalledWith(expect.anything(), "send_message", expect.anything(), expect.anything());
    child.kill("SIGTERM");
  }, 20000);

  it("without the Sessions API prints the hint and stays idle", async () => {
    const child = spawn(process.execPath, [join(exampleDir, "service.mjs")], { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const out = output(child);
    // Event-driven: wait for the hint line itself (poll interval bounds the
    // latency; the 15 s deadline tolerates a loaded CI runner) instead of a
    // blind sleep that races node startup under load.
    await vi.waitFor(() => expect(out.read()).toContain("Sessions API is off; enable it in Settings -> Sessions API"), { timeout: 15_000, interval: 50 });
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    child.kill("SIGTERM");
  }, 20000);
});
