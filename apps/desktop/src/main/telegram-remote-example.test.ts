/**
 * The telegram-remote example (Taskana 4751). Telegram is ONLY a fake HTTP server
 * on 127.0.0.1; no test contacts api.telegram.org and no real token is used. The
 * Sessions API is the REAL startCommunicationServer with a fake session manager.
 * Only T22 spawns the service script as a child process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginManifestSchema, serviceSecretRefs, servicesHash } from "@anycode/core/plugins-admin";
import { startCommunicationServer } from "./communication-server.js";

const exampleDir = fileURLToPath(new URL("../../../../examples/telegram-remote", import.meta.url));
const TOKEN = "123456:TEST-TOKEN-NOT-REAL-abcdefghijk";
const USER = 111;
const SID_BUILD = "s-build-0001aaaa";
const SID_NOTES = "s-notes-0002bbbb";
const SID_PRIVATE = "s-private-0003cccc";

/** The example's pure rules and the bridge factory, loaded from the plain .mjs files. */
async function loadExample(file: string): Promise<any> {
  return import(/* @vite-ignore */ pathToFileURL(join(exampleDir, file)).href);
}

type Scripted = { status: number; body: unknown } | "hang";

interface FakeTelegram {
  url: string;
  updates: Array<Record<string, unknown>>;
  requests: Array<{ method: string; body: any; url: string }>;
  sent: Array<{ chat_id: number; text: string; at: number }>;
  push(update: Record<string, unknown>): void;
  respondOnce(method: string, scripted: Scripted): void;
  onSend: (() => void) | undefined;
  clock: { t: number };
  close(): Promise<void>;
}

async function startFakeTelegram(): Promise<FakeTelegram> {
  const scripts = new Map<string, Scripted[]>();
  const clock = { t: 1_000_000 };
  const tg: FakeTelegram = {
    url: "",
    updates: [],
    requests: [],
    sent: [],
    push: (update) => {
      tg.updates.push(update);
    },
    respondOnce: (method, scripted) => {
      scripts.set(method, [...(scripts.get(method) ?? []), scripted]);
    },
    onSend: undefined,
    clock,
    close: async () => {},
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path);
      const method = match?.[2] ?? "unknown";
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      tg.requests.push({ method, body, url: path });
      const reply = (status: number, json: unknown) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const queue = scripts.get(method);
      const scripted = queue?.shift();
      if (scripted !== undefined) {
        if (scripted === "hang") return;
        return reply(scripted.status, scripted.body);
      }
      if (match === null || match[1] !== TOKEN) return reply(404, { ok: false, error_code: 404, description: "Not Found" });
      if (method === "getUpdates") {
        const offset = typeof body.offset === "number" ? body.offset : 0;
        const ready = tg.updates.filter((update) => (update.update_id as number) >= offset);
        if (ready.length > 0) return reply(200, { ok: true, result: ready });
        setTimeout(() => reply(200, { ok: true, result: [] }), 60);
        return;
      }
      if (method === "sendMessage") {
        tg.sent.push({ chat_id: body.chat_id, text: body.text, at: clock.t });
        tg.onSend?.();
        return reply(200, { ok: true, result: { message_id: tg.sent.length } });
      }
      return reply(200, { ok: true, result: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  tg.url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  tg.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return tg;
}

interface Harness {
  dir: string;
  stateDir: string;
  discoveryFile: string;
  tg: FakeTelegram;
  lines: string[];
  sleeps: number[];
  calls: Array<{ op: string; sid: string; payload: any }>;
  exposed: Set<string>;
  handles: Record<string, string>;
  tabs: Array<{ id: string; ws: string }>;
  results: Map<string, () => unknown>;
  bridge: any;
  run: Promise<void> | undefined;
  apiCalls: { count: number };
  send: { state: string; detail: string };
  approvals: { on: Set<string>; items: any[]; answer: (payload: any) => unknown; cancel: () => unknown };
  close(): Promise<void>;
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function msg(updateId: number, text: string, from: number = USER): Record<string, unknown> {
  return { update_id: updateId, message: { message_id: updateId, from: { id: from, is_bot: false }, chat: { id: from, type: "private" }, text } };
}

async function harness(opts: { env?: Record<string, string | undefined>; bridge?: Record<string, unknown>; sessionsOn?: boolean; noSessions?: boolean; autoStart?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "anycode-telegram-remote-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const tg = await startFakeTelegram();
  cleanups.push(() => tg.close());
  for (const name of ["ws-build", "ws-notes", "ws-private"]) await mkdir(join(dir, name), { recursive: true });
  const discoveryFile = join(dir, "communication.json");
  const exposed = new Set([SID_BUILD, SID_NOTES]);
  const handles: Record<string, string> = { [SID_BUILD]: "build-bot" };
  const tabs = [
    { id: SID_BUILD, ws: join(dir, "ws-build") },
    { id: SID_NOTES, ws: join(dir, "ws-notes") },
    { id: SID_PRIVATE, ws: join(dir, "ws-private") },
  ];
  const calls: Array<{ op: string; sid: string; payload: any }> = [];
  const results = new Map<string, () => unknown>();
  const lines: string[] = [];
  const sleeps: number[] = [];
  const apiCalls = { count: 0 };
  const send = { state: "acknowledged", detail: "transport accepted" };
  const approvalsOn = new Set<string>(["_none_"]);
  const approvals = {
    on: approvalsOn,
    items: [] as any[],
    answer: (_payload: any): unknown => ({ result: "answered" }),
    cancel: (): unknown => ({ cancelled: true, turnId: "turn-1" }),
  };
  const manager = {
    listTabs: () => tabs.map((tab) => ({ sessionId: tab.id, workspace: tab.ws, state: "idle", pid: 1 })),
    communicationRequest: vi.fn(async (sid: string, op: string, payload: any) => {
      calls.push({ op, sid, payload });
      if (op === "send_message") return { ...send };
      if (op === "get_message_result") {
        const scripted = results.get(payload as string);
        return scripted ? scripted() : { state: "running" };
      }
      if (op === "get_session_status") return { engine: "codex", state: "idle" };
      if (op === "list_pending_approvals") return approvals.items.map((item) => ({ ...item }));
      if (op === "answer_approval") return approvals.answer(payload);
      if (op === "cancel_turn") return approvals.cancel();
      return undefined;
    }),
  };
  const service = await startCommunicationServer({
    manager,
    userData: dir,
    config: { workspaces: [], port: 0, discoveryFile },
    isSessionExposed: (sid: string) => exposed.has(sid),
    isExternalApprovalEnabled: (sid: string) => approvalsOn.has(sid),
    handleOf: (sid: string) => handles[sid],
    pollMs: 10,
  } as any);
  cleanups.push(() => service.close());
  const sessionsOn = opts.noSessions !== true && opts.sessionsOn !== false;
  const env: Record<string, string | undefined> = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_ALLOWED_USERS: String(USER),
    TELEGRAM_API_BASE: tg.url,
    TELEGRAM_REMOTE_STATE_DIR: join(dir, "state"),
    ...(sessionsOn ? { ANYCODE_SESSIONS_DISCOVERY: discoveryFile } : {}),
    ...opts.env,
  };
  const lib = await loadExample("service.mjs");
  const bridge = lib.createBridge({
    approvalLoop: false,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    now: () => tg.clock.t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      tg.clock.t += ms;
      return Promise.resolve();
    },
    random: () => 0.5,
    paceMs: 0,
    pollTimeoutSec: 1,
    waitSliceMs: 30,
    log: (line: string) => lines.push(line),
    readDiscovery: undefined,
    fetch: (url: string, init: RequestInit) => {
      if (!url.startsWith(tg.url)) apiCalls.count += 1;
      return fetch(url, init);
    },
    ...opts.bridge,
  });
  const h: Harness = {
    dir,
    stateDir: join(dir, "state"),
    discoveryFile,
    tg,
    lines,
    sleeps,
    calls,
    exposed,
    handles,
    tabs,
    results,
    bridge,
    run: undefined,
    apiCalls,
    send,
    approvals,
    close: async () => {
      await bridge.stop();
      await h.run?.catch(() => {});
    },
  };
  // Teardown waits for the poll loop to exit, so no late write can race the temp-dir removal.
  cleanups.push(() => h.close());
  if (opts.autoStart !== false) h.run = bridge.run();
  return h;
}

async function waitFor(check: () => boolean, timeout = 6000): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout, interval: 10 });
}

function texts(h: Harness): string[] {
  return h.tg.sent.map((entry) => entry.text);
}

function apiCallsOf(h: Harness, op: string): Array<{ op: string; sid: string; payload: any }> {
  return h.calls.filter((call) => call.op === op);
}

describe("telegram-remote example (Taskana 4751)", () => {
  // ── pure rules ──

  it("T1 parseAllowlist accepts positive ids and drops everything else; empty fails closed", async () => {
    const lib = await loadExample("lib.mjs");
    expect(lib.parseAllowlist("1, 2 3")).toEqual([1, 2, 3]);
    expect(lib.parseAllowlist("abc, -5, 0, 1.5, 99999999999999999999, 42")).toEqual([42]);
    expect(lib.parseAllowlist("")).toEqual([]);
    expect(lib.parseAllowlist(undefined)).toEqual([]);
    expect(lib.parseAllowlist("abc")).toEqual([]);
  });

  it("T2 chunkText respects the 4000 limit with headers counted and never splits a surrogate pair", async () => {
    const lib = await loadExample("lib.mjs");
    expect(lib.chunkText("")).toEqual([]);
    expect(lib.chunkText("\n\n \n")).toEqual([]);
    expect(lib.chunkText("a".repeat(3999))).toHaveLength(1);
    expect(lib.chunkText("a".repeat(4000))).toEqual(["a".repeat(4000)]);
    const four = lib.chunkText("a".repeat(4001));
    expect(four).toHaveLength(2);
    expect(four.every((chunk: string) => chunk.length <= 4000)).toBe(true);
    const big = lib.chunkText("word ".repeat(1800));
    expect(big.length).toBeGreaterThan(1);
    expect(big.every((chunk: string) => chunk.length <= 4000 && chunk.trim() !== "")).toBe(true);
    expect(big[0]!.startsWith(`(1/${big.length})\n`)).toBe(true);
    // An emoji (surrogate pair) at the hard-cut position stays whole.
    const emoji = "a" + "😀".repeat(2500);
    const cut = lib.chunkText(emoji);
    expect(cut.length).toBeGreaterThan(1);
    for (const chunk of cut) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
      const body = chunk.replace(/^\(\d+\/\d+\)\n/, "");
      expect(body).toMatch(/^a?(😀)*$/u);
    }
    expect(lib.chunkText("x".repeat(9000)).every((chunk: string) => chunk.length <= 4000)).toBe(true);
    expect(lib.chunkText("x".repeat(9000))).toHaveLength(3);
  });

  it("T3 parseCommand handles suffixes, case, empty args and unknown commands", async () => {
    const lib = await loadExample("lib.mjs");
    expect(lib.parseCommand("/use@MyBot build-bot")).toEqual({ kind: "command", name: "use", args: "build-bot" });
    expect(lib.parseCommand("/USE x")).toEqual({ kind: "command", name: "use", args: "x" });
    expect(lib.parseCommand("/steer")).toEqual({ kind: "command", name: "steer", args: "" });
    expect(lib.parseCommand("hello /sessions")).toEqual({ kind: "text", text: "hello /sessions" });
    expect(lib.parseCommand("/unknown")).toEqual({ kind: "command", name: "help", args: "" });
    expect(lib.parseCommand("/")).toEqual({ kind: "command", name: "help", args: "" });
  });

  it("T4 redact removes the bot token, 64-hex strings and Bearer values from any text", async () => {
    const lib = await loadExample("lib.mjs");
    const hex = "a".repeat(32) + "0123456789abcdef".repeat(2);
    const out = lib.redact(`token ${TOKEN} hex ${hex} auth Bearer abc.def`, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(hex);
    expect(out).not.toContain("abc.def");
    expect(out).toContain("***");
    expect(lib.redact(`https://api.telegram.org/bot${TOKEN}/getUpdates`)).not.toContain("TEST-TOKEN-NOT-REAL");
  });

  it("T5 nextBackoff: conflict ladder 5..60 s, offline 1..30 s, jitter stays within bounds", async () => {
    const lib = await loadExample("lib.mjs");
    const conflict = [0, 1, 2, 3, 4, 5].map((attempt) => lib.nextBackoff("conflict", attempt));
    expect(conflict).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    const offline = [0, 1, 2, 3, 4, 5, 6].map((attempt) => lib.nextBackoff("offline", attempt));
    expect(offline).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(lib.jitter(1000, 0)).toBe(800);
    expect(lib.jitter(1000, 0.999)).toBeLessThanOrEqual(1200);
  });

  // ── Telegram transport ──

  it("T6 a 409 conflict backs off on the ladder, logs once, never calls deleteWebhook and recovers", async () => {
    const h = await harness();
    for (let i = 0; i < 4; i += 1) {
      h.tg.respondOnce("getUpdates", { status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } });
    }
    h.tg.push(msg(1, "/help"));
    await waitFor(() => texts(h).some((text) => text.startsWith("AnyCode remote control")));
    expect(h.sleeps.slice(0, 4)).toEqual([5000, 10000, 20000, 40000]);
    const conflictLines = h.lines.filter((line) => line.startsWith("[status] conflict"));
    expect(conflictLines).toHaveLength(1);
    expect(conflictLines[0]).toContain("one bot per machine");
    expect(h.lines.some((line) => line === "[status] online")).toBe(true);
    expect(h.tg.requests.some((request) => request.method === "deleteWebhook")).toBe(false);
    expect(h.apiCalls.count).toBe(0);
  });

  it("T6b a webhook conflict names deleteWebhook as the fix, without calling it", async () => {
    const h = await harness();
    h.tg.respondOnce("getUpdates", { status: 409, body: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } });
    await waitFor(() => h.lines.some((line) => line.startsWith("[status] conflict")));
    expect(h.lines.find((line) => line.startsWith("[status] conflict"))).toContain("remove it with deleteWebhook");
    expect(h.tg.requests.some((request) => request.method === "deleteWebhook")).toBe(false);
  });

  it("T7 a network drop goes offline on the ladder, logs per state change and processes the pending update exactly once", async () => {
    let failures = 2;
    const h = await harness({
      bridge: {
        fetch: (url: string, init: RequestInit) => {
          if (url.includes("/getUpdates") && failures > 0) {
            failures -= 1;
            return Promise.reject(new TypeError("fetch failed"));
          }
          return fetch(url, init);
        },
      },
    });
    h.tg.push(msg(5, "/help"));
    await waitFor(() => texts(h).some((text) => text.startsWith("AnyCode remote control")));
    expect(h.sleeps.slice(0, 2)).toEqual([1000, 2000]);
    expect(h.lines.filter((line) => line.startsWith("[status] offline"))).toHaveLength(1);
    expect(texts(h).filter((text) => text.startsWith("AnyCode remote control"))).toHaveLength(1);
  });

  it("T8 missing token is bad_config with no network call; invalid token stops polling; no allowlist is no_allowlist", async () => {
    const noToken = await harness({ env: { TELEGRAM_BOT_TOKEN: "" } });
    await waitFor(() => noToken.lines.some((line) => line.startsWith("[status] bad_config")));
    expect(noToken.tg.requests).toHaveLength(0);

    const invalid = await harness();
    invalid.tg.respondOnce("getUpdates", { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    await waitFor(() => invalid.lines.some((line) => line.startsWith("[status] token_invalid")));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(invalid.tg.requests.filter((request) => request.method === "getUpdates")).toHaveLength(1);
    expect(invalid.lines.join("\n")).not.toContain(TOKEN);
    expect(invalid.lines.join("\n")).not.toContain("TEST-TOKEN-NOT-REAL");

    const noList = await harness({ env: { TELEGRAM_ALLOWED_USERS: "abc" } });
    await waitFor(() => noList.lines.some((line) => line.startsWith("[status] no_allowlist")));
    expect(noList.tg.requests).toHaveLength(0);
  });

  it("T9 an API base that is not the Telegram endpoint or loopback is bad_config with zero requests", async () => {
    for (const base of ["https://evil.example", "http://localhost.evil", "https://api.telegram.org.evil.example", "http://127.0.0.1.evil.example"]) {
      const h = await harness({ env: { TELEGRAM_API_BASE: base } });
      await waitFor(() => h.lines.some((line) => line.startsWith("[status] bad_config")));
      expect(h.tg.requests).toHaveLength(0);
      expect(h.lines.join("\n")).not.toContain(TOKEN);
    }
    const lib = await loadExample("service.mjs");
    expect(lib.validApiBase("https://api.telegram.org")).toBe(true);
    expect(lib.validApiBase("http://127.0.0.1:9999")).toBe(true);
    expect(lib.validApiBase("https://user:pw@api.telegram.org")).toBe(false);
  });

  it("T10 429 honours retry_after on getUpdates and sendMessage; 403 logs user_blocked and does not loop", async () => {
    const h = await harness();
    h.tg.respondOnce("getUpdates", { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } } });
    h.tg.respondOnce("sendMessage", { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } } });
    h.tg.push(msg(1, "/help"));
    await waitFor(() => texts(h).some((text) => text.startsWith("AnyCode remote control")));
    expect(h.sleeps).toContain(3000);
    expect(h.sleeps).toContain(2000);

    const blocked = await harness();
    blocked.tg.respondOnce("sendMessage", { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } });
    blocked.tg.push(msg(1, "/help"));
    await waitFor(() => blocked.lines.some((line) => line.startsWith("[status] user_blocked")));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(blocked.tg.requests.filter((request) => request.method === "sendMessage")).toHaveLength(1);
  });

  // ── security ──

  it("publishes update progress only after its state is saved", async () => {
    let release!: () => void;
    let saving = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness({ bridge: { store: {
      load: async () => ({ lastUpdateId: 0, chats: {}, pending: [], approvals: [], tokenSeq: 0 }),
      save: async (state: { offset?: number }) => { if (state.offset === 9) { saving = true; await gate; } },
    } } });
    try {
      h.tg.push(msg(8, "/sessions", 999));
      await waitFor(() => saving);
      expect(h.bridge.state().lastUpdateId).toBe(0);
      expect(h.bridge.state().offset).toBeUndefined();
      release();
      await waitFor(() => h.bridge.state().offset === 9);
      expect(h.bridge.state().lastUpdateId).toBe(8);
    } finally { release(); }
  });

  it("T11 only a private message from an allowlisted owner reaches the bridge; the rest is dropped before parsing", async () => {
    const h = await harness();
    h.tg.push(msg(1, "/sessions", 999));
    h.tg.push(msg(2, "/sessions", 999));
    h.tg.push({ update_id: 3, message: { message_id: 3, from: { id: USER, is_bot: false }, chat: { id: -100, type: "group" }, text: "/sessions" } });
    h.tg.push({ update_id: 4, message: { message_id: 4, from: { id: USER, is_bot: false }, chat: { id: 777, type: "private" }, text: "/sessions" } });
    h.tg.push({ update_id: 5, edited_message: { message_id: 5, from: { id: USER, is_bot: false }, chat: { id: USER, type: "private" }, text: "/sessions" } });
    h.tg.push({ update_id: 6, callback_query: { id: "cb", from: { id: USER, is_bot: false }, data: "x" } });
    h.tg.push({ update_id: 7, channel_post: { message_id: 7, chat: { id: -200, type: "channel" }, text: "/sessions" } });
    h.tg.push({ update_id: 8, message: { message_id: 8, from: { id: USER, is_bot: true }, chat: { id: USER, type: "private" }, text: "/sessions" } });
    await waitFor(() => h.bridge.state().lastUpdateId === 8);
    expect(h.tg.sent).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    const persisted = JSON.parse(await readFile(join(h.stateDir, "state.json"), "utf8"));
    expect(persisted.offset).toBe(9);
    const ignored = h.lines.filter((line) => line.startsWith("[ignored]"));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain("id 999");
    expect(h.lines.join("\n")).not.toContain("/sessions");
  });

  it("T12 no Sessions API token, bot token or 64-hex secret reaches Telegram bodies, logs or state", async () => {
    const h = await harness();
    const discovery = JSON.parse(await readFile(h.discoveryFile, "utf8")) as { token: string };
    h.tg.push(msg(1, "/use build-bot"));
    h.tg.push(msg(2, "hello"));
    await waitFor(() => h.bridge.state().lastUpdateId === 2);
    expect(apiCallsOf(h, "send_message")).toHaveLength(1);
    // The session answers with both secrets inside its text.
    const messageId = (apiCallsOf(h, "send_message")[0]!.payload as { messageId: string }).messageId;
    h.results.set(messageId, () => ({ state: "done", latestResult: { publicAnswer: `leak ${discovery.token} and ${TOKEN}`, turnId: "t1" }, limitation: "L" }));
    await waitFor(() => texts(h).some((text) => text.startsWith("[build-bot]")));
    const answer = texts(h).find((text) => text.startsWith("[build-bot]"))!;
    expect(answer).not.toContain(discovery.token);
    expect(answer).not.toContain(TOKEN);
    expect(answer).toContain("***");
    const bodies = h.tg.requests.map((request) => JSON.stringify(request.body)).join("\n");
    expect(bodies).not.toContain(discovery.token);
    expect(bodies).not.toContain(TOKEN);
    expect(h.lines.join("\n")).not.toContain(discovery.token);
    expect(h.lines.join("\n")).not.toContain(TOKEN);
    const stateText = await readFile(join(h.stateDir, "state.json"), "utf8");
    expect(stateText).not.toContain(discovery.token);
    expect(stateText).not.toContain(TOKEN);
  });

  it("T13 only sessions with the switch on appear; an unshared id is refused like an unknown one", async () => {
    const h = await harness();
    h.tg.push(msg(1, "/sessions"));
    h.tg.push(msg(2, `/use ${SID_PRIVATE}`));
    await waitFor(() => texts(h).length >= 2);
    const list = texts(h)[0]!;
    expect(list).toContain("build-bot");
    expect(list).toContain("s-notes-");
    expect(list).not.toContain("s-private");
    expect(texts(h)[1]).toBe("No such shared session. Send /sessions.");
  });

  // ── commands and flow ──

  it("T14 /sessions formatting, every /use form, ambiguity, expiry and the no-args form", async () => {
    const h = await harness();
    h.tg.push(msg(1, "/sessions"));
    await waitFor(() => texts(h).length === 1);
    expect(texts(h)[0]).toBe("1. build-bot — idle — ws-build\n2. s-notes- — idle — ws-notes");
    h.tg.push(msg(2, "/use build-bot"));
    h.tg.push(msg(3, "/use"));
    h.tg.push(msg(4, `/use ${SID_NOTES}`));
    h.tg.push(msg(5, "/use s-notes"));
    h.tg.push(msg(6, "/use 2"));
    h.tg.push(msg(7, "/use nothing-like-this"));
    await waitFor(() => texts(h).length === 7);
    expect(texts(h).slice(1)).toEqual([
      "Selected build-bot.",
      "Selected: build-bot.",
      `Selected ${SID_NOTES.slice(0, 8)}.`,
      "Selected s-notes-.",
      `Selected ${SID_NOTES.slice(0, 8)}.`,
      "No such shared session. Send /sessions.",
    ]);
    // Ambiguous prefix: two shared sessions that share 8 leading characters.
    h.tabs.push({ id: "s-same-0005xxxx", ws: join(h.dir, "ws-build") });
    h.tabs.push({ id: "s-same-0005yyyy", ws: join(h.dir, "ws-build") });
    h.exposed.add("s-same-0005xxxx");
    h.exposed.add("s-same-0005yyyy");
    h.tg.push(msg(8, "/use s-same-0005"));
    await waitFor(() => texts(h).length === 8);
    expect(texts(h)[7]).toBe("Ambiguous, use the handle or a longer id.");
    // Expired numbers: the list from /sessions is valid for 10 minutes only.
    h.tg.push(msg(9, "/sessions"));
    await waitFor(() => texts(h).length === 9);
    h.tg.clock.t += 11 * 60 * 1000;
    h.tg.push(msg(10, "/use 2"));
    await waitFor(() => texts(h).length === 10);
    expect(texts(h)[9]).toBe("No such shared session. Send /sessions.");
  });

  it("T14b /sessions shows at most 30 lines and says how many more, and an empty list gets the hint", async () => {
    const lib = await loadExample("lib.mjs");
    const many = Array.from({ length: 35 }, (_, i) => ({ sessionId: `s-many-${String(i).padStart(4, "0")}xxxx`, workspace: "/w/p", state: "idle" }));
    const text = lib.renderSessions(many, undefined);
    expect(text.split("\n")).toHaveLength(31);
    expect(text.endsWith("…and 5 more")).toBe(true);
    expect(lib.renderSessions([], undefined)).toContain("Sessions API row");
  });

  it("T15 plain text needs a selection; with one it sends a next_turn with the update id as key; 32001 chars and non-text are refused locally", async () => {
    const h = await harness();
    h.tg.push(msg(1, "hello first"));
    await waitFor(() => texts(h).length === 1);
    expect(texts(h)[0]).toBe("No session selected. Send /sessions, then /use <name>.");
    h.tg.push(msg(2, "/use build-bot"));
    h.tg.push(msg(3, "do the thing"));
    h.tg.push(msg(4, "x".repeat(32001)));
    h.tg.push({ update_id: 5, message: { message_id: 5, from: { id: USER, is_bot: false }, chat: { id: USER, type: "private" }, photo: [{ file_id: "p" }] } });
    await waitFor(() => texts(h).length === 5);
    expect(texts(h)[2]).toBe("Sent to build-bot (sent)");
    expect(texts(h)[3]).toBe("Message too long (max 32000).");
    expect(texts(h)[4]).toBe("Only text is supported.");
    const sends = apiCallsOf(h, "send_message");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.sid).toBe(SID_BUILD);
    expect(sends[0]!.payload).toMatchObject({ payload: "do the thing", mode: "next_turn", correlationId: "tg-3" });
  });

  it("T16 /steer sends a steer, reports a rejection and asks for usage when empty", async () => {
    const h = await harness();
    h.tg.push(msg(1, "/use build-bot"));
    h.tg.push(msg(2, "/steer focus on tests"));
    h.tg.push(msg(3, "/steer"));
    await waitFor(() => texts(h).length === 3);
    expect(texts(h)[2]).toBe("Usage: /steer <text>");
    expect(apiCallsOf(h, "send_message")[0]!.payload).toMatchObject({ mode: "steer", payload: "focus on tests" });
    // A refused steer is reported with the server's detail.
    h.send.state = "rejected";
    h.send.detail = "steer needs an active turn";
    h.tg.push(msg(4, "/steer again"));
    await waitFor(() => texts(h).length === 4);
    expect(texts(h)[3]).toBe("Steer rejected: steer needs an active turn");
    h.send.state = "acknowledged";
    h.send.detail = "transport accepted";
  });

  it("T17 a pending result is polled until done; the answer comes back in order with the next turn", async () => {
    const h = await harness();
    let polls = 0;
    h.tg.push(msg(1, "/use build-bot"));
    h.tg.push(msg(2, "first"));
    await waitFor(() => texts(h).some((text) => text.startsWith("Sent to")));
    const messageId = (apiCallsOf(h, "send_message")[0]!.payload as { messageId?: string }).messageId ?? "";
    expect(messageId).toBeTruthy();
    h.results.set(messageId, () => {
      polls += 1;
      if (polls < 3) return { state: "running" };
      return { state: "done", latestResult: { publicAnswer: "FIRST ANSWER", turnId: "t1" }, limitation: "L" };
    });
    await waitFor(() => texts(h).some((text) => text === "[build-bot] FIRST ANSWER"));
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(texts(h).filter((text) => text.includes("FIRST ANSWER"))).toHaveLength(1);
  });

  it("T17b a rejected turn and an empty answer are reported as such", async () => {
    const h = await harness();
    h.tg.push(msg(1, "/use build-bot"));
    h.tg.push(msg(2, "one"));
    await waitFor(() => texts(h).some((text) => text.startsWith("Sent to")));
    const first = (apiCallsOf(h, "send_message")[0]!.payload as { messageId: string }).messageId;
    h.results.set(first, () => ({ state: "rejected", detail: "turn aborted" }));
    await waitFor(() => texts(h).includes("Rejected: turn aborted"));
    h.tg.push(msg(3, "two"));
    await waitFor(() => texts(h).length === 4);
    const second = (apiCallsOf(h, "send_message")[1]!.payload as { messageId: string }).messageId;
    h.results.set(second, () => ({ state: "done", latestResult: { publicAnswer: "   " }, limitation: "L" }));
    await waitFor(() => texts(h).includes("[build-bot] (empty answer)"));
  });

  it("T18 a huge answer is capped, chunked within 4096 and paced at one second per message; a 400 'too long' re-chunks once at 3000", async () => {
    const h = await harness({ bridge: { paceMs: 1000 } });
    h.tg.push(msg(1, "/use build-bot"));
    h.tg.push(msg(2, "go"));
    await waitFor(() => texts(h).some((text) => text.startsWith("Sent to")));
    const messageId = (apiCallsOf(h, "send_message")[0]!.payload as { messageId: string }).messageId;
    h.results.set(messageId, () => ({ state: "done", latestResult: { publicAnswer: "y".repeat(50000), turnId: "t" }, limitation: "L" }));
    await waitFor(() => texts(h).some((text) => text.includes("[truncated")), 20000);
    const answerChunks = texts(h).filter((text) => /^\(\d+\/\d+\)\n/.test(text));
    expect(answerChunks.length).toBeLessThanOrEqual(5);
    expect(answerChunks.every((text) => text.length <= 4096)).toBe(true);
    expect(answerChunks[answerChunks.length - 1]).toContain("[truncated");
    const times = h.tg.sent.map((entry) => entry.at);
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000);
  });

  it("T18b with a larger cap and a 4096-boundary text no chunk exceeds 4096, and the 400 'too long' case re-chunks at 3000", async () => {
    const h = await harness({ env: { TELEGRAM_MAX_REPLY_CHARS: "60000" } });
    h.tg.push(msg(1, "/use build-bot"));
    h.tg.push(msg(2, "go"));
    await waitFor(() => texts(h).some((text) => text.startsWith("Sent to")));
    // The next send (the first answer chunk) is refused as too long, once.
    h.tg.respondOnce("sendMessage", { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message is too long" } });
    const messageId = (apiCallsOf(h, "send_message")[0]!.payload as { messageId: string }).messageId;
    const boundary = `${"a".repeat(4094)}\n${"b".repeat(4000)}`;
    h.results.set(messageId, () => ({ state: "done", latestResult: { publicAnswer: boundary, turnId: "t" }, limitation: "L" }));
    await waitFor(() => texts(h).some((text) => text.includes("bbbb")), 20000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const answerSends = texts(h).filter((text) => /^\(\d+\/\d+\)\n/.test(text));
    expect(answerSends.every((text) => text.length <= 4096)).toBe(true);
    expect(answerSends.some((text) => text.length <= 3000)).toBe(true);
  });

  it("T19 a revoked session is reported: between turns, during a wait, when its tab closes; a handle re-pointed does not move an old selection", async () => {
    // (a) switched off between turns
    const a = await harness();
    a.tg.push(msg(1, "/use build-bot"));
    await waitFor(() => texts(a).length === 1);
    a.exposed.delete(SID_BUILD);
    a.tg.push(msg(2, "anyone there?"));
    await waitFor(() => texts(a).length === 2);
    expect(texts(a)[1]).toBe("Session build-bot is no longer shared or was closed.");
    expect(apiCallsOf(a, "send_message")).toHaveLength(0);
    a.tg.push(msg(3, "again"));
    await waitFor(() => texts(a).length === 3);
    expect(texts(a)[2]).toBe("No session selected. Send /sessions, then /use <name>.");

    // (b) switched off while a waiter runs
    const b = await harness();
    b.tg.push(msg(1, "/use build-bot"));
    b.tg.push(msg(2, "long task"));
    await waitFor(() => texts(b).some((text) => text.startsWith("Sent to")));
    b.exposed.delete(SID_BUILD);
    await waitFor(() => texts(b).includes("Session build-bot is no longer shared or was closed."));
    // The reply goes out before the waiter drops its pending entry; wait for that write rather than racing it.
    await waitFor(() => b.bridge.state().pending.length === 0);
    expect(b.bridge.state().pending).toHaveLength(0);

    // (c) the tab closes mid-turn
    const c = await harness();
    c.tg.push(msg(1, "/use build-bot"));
    c.tg.push(msg(2, "task"));
    await waitFor(() => texts(c).some((text) => text.startsWith("Sent to")));
    const messageId = (apiCallsOf(c, "send_message")[0]!.payload as { messageId: string }).messageId;
    c.results.set(messageId, () => {
      throw new Error("Session closed");
    });
    await waitFor(() => texts(c).includes("Lost track of the turn (Session closed)."));

    // (d) the handle is re-pointed: a selection by session id is not silently moved
    const d = await harness();
    d.tg.push(msg(1, `/use ${SID_BUILD}`));
    await waitFor(() => texts(d).length === 1);
    d.handles[SID_BUILD] = undefined as unknown as string;
    d.handles[SID_NOTES] = "build-bot";
    d.tg.push(msg(2, "still here?"));
    await waitFor(() => apiCallsOf(d, "send_message").length === 1);
    expect(apiCallsOf(d, "send_message")[0]!.sid).toBe(SID_BUILD);
    d.tg.push(msg(3, "/use build-bot"));
    await waitFor(() => texts(d).length === 3);
    expect(texts(d)[2]).toBe("Selected build-bot.");
    expect(d.bridge.state().chats[String(USER)].sessionId).toBe(SID_NOTES);
  });

  it("T20 Sessions API off: the hint on every command, Telegram still polled; a rotated token retries once; a missing file or a closed port is a notice, not a crash", async () => {
    const off = await harness({ sessionsOn: false });
    off.tg.push(msg(1, "/sessions"));
    off.tg.push(msg(2, "hi"));
    off.tg.push(msg(3, "/help"));
    await waitFor(() => texts(off).length === 3);
    expect(texts(off)[0]).toContain("Sessions API is off");
    expect(texts(off)[1]).toContain("Sessions API is off");
    expect(texts(off)[2]).toContain("Sessions API is off");
    await waitFor(() => off.lines.some((line) => line === "[status] no_sessions_api"));
    expect(off.tg.requests.some((request) => request.method === "getUpdates")).toBe(true);

    // Rotated token: the first tool call gets 401, the bridge re-reads the discovery file and succeeds.
    let unauthorized = 1;
    const rotated = await harness({
      bridge: {
        fetch: (url: string, init: RequestInit) => {
          if (!url.includes("/bot") && unauthorized > 0 && String(init?.body ?? "").includes("list_sessions")) {
            unauthorized -= 1;
            return Promise.resolve(new Response("unauthorized", { status: 401 }));
          }
          return fetch(url, init);
        },
      },
    });
    rotated.tg.push(msg(1, "/sessions"));
    await waitFor(() => texts(rotated).length === 1);
    expect(texts(rotated)[0]).toContain("build-bot");

    // Discovery file removed mid-run: a notice; restored: recovery.
    const gone = await harness();
    gone.tg.push(msg(1, "/sessions"));
    await waitFor(() => texts(gone).length === 1);
    const saved = join(gone.dir, "saved.json");
    await rename(gone.discoveryFile, saved);
    gone.tg.push(msg(2, "/sessions"));
    await waitFor(() => texts(gone).length === 2);
    expect(texts(gone)[1]).toBe("AnyCode is not reachable right now.");
    await rename(saved, gone.discoveryFile);
    gone.tg.push(msg(3, "/sessions"));
    await waitFor(() => texts(gone).length === 3);
    expect(texts(gone)[2]).toContain("build-bot");

    // AnyCode quit: connection refused on the endpoint.
    const quit = await harness();
    const discovery = JSON.parse(await readFile(quit.discoveryFile, "utf8")) as { url: string; token: string; workspaces: string[] };
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    await writeFile(quit.discoveryFile, JSON.stringify({ ...discovery, url: `http://127.0.0.1:${closed}/mcp` }));
    quit.tg.push(msg(1, "/sessions"));
    await waitFor(() => texts(quit).length === 1);
    expect(texts(quit)[0]).toBe("AnyCode is not reachable right now.");
    expect(quit.bridge.status()).not.toBe("bad_config");
  });

  it("T21 restart without duplicate processing: the offset is persisted, the redelivered turn keeps its idempotency key, pending waiters resume", async () => {
    const h = await harness({ autoStart: false });
    const lib = await loadExample("service.mjs");
    const realStore = lib.fileStore(h.stateDir);
    h.tg.push(msg(100, "/use build-bot"));
    h.tg.push(msg(101, "restart me"));
    const crashing = lib.createBridge({
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: String(USER), TELEGRAM_API_BASE: h.tg.url, TELEGRAM_REMOTE_STATE_DIR: h.stateDir, ANYCODE_SESSIONS_DISCOVERY: h.discoveryFile },
      now: () => h.tg.clock.t,
      sleep: () => Promise.resolve(),
      paceMs: 0,
      pollTimeoutSec: 1,
      waitSliceMs: 30,
      log: (line: string) => h.lines.push(line),
      store: {
        load: () => realStore.load(),
        save: async (state: { offset?: number }) => {
          if (state.offset === 102) throw new Error("simulated crash after dispatch");
          return realStore.save(state);
        },
      },
    });
    const crashed = crashing.run();
    await expect(crashed).rejects.toThrow("simulated crash after dispatch");
    const firstSends = apiCallsOf(h, "send_message");
    expect(firstSends).toHaveLength(1);
    const messageId = (firstSends[0]!.payload as { messageId: string }).messageId;
    // The result is still running while the bridge restarts.
    let released = false;
    h.results.set(messageId, () => (released ? { state: "done", latestResult: { publicAnswer: "AFTER RESTART", turnId: "t" }, limitation: "L" } : { state: "running" }));
    await crashing.stop();

    const persisted = JSON.parse(await readFile(join(h.stateDir, "state.json"), "utf8"));
    expect(persisted.offset).toBe(101);
    expect(persisted.lastUpdateId).toBe(100);
    expect(persisted.pending.map((entry: { messageId: string }) => entry.messageId)).toEqual([messageId]);

    h.tg.requests.length = 0;
    const restarted = lib.createBridge({
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: String(USER), TELEGRAM_API_BASE: h.tg.url, TELEGRAM_REMOTE_STATE_DIR: h.stateDir, ANYCODE_SESSIONS_DISCOVERY: h.discoveryFile },
      now: () => h.tg.clock.t,
      sleep: () => Promise.resolve(),
      paceMs: 0,
      pollTimeoutSec: 1,
      waitSliceMs: 30,
      log: (line: string) => h.lines.push(line),
    });
    const restartedRun = restarted.run();
    await vi.waitFor(() => expect(h.tg.requests.some((request) => request.method === "getUpdates")).toBe(true), { timeout: 5000 });
    const firstPoll = h.tg.requests.find((request) => request.method === "getUpdates")!;
    expect(firstPoll.body.offset).toBe(101);
    released = true;
    await vi.waitFor(() => expect(h.tg.sent.some((entry) => entry.text === "[build-bot] AFTER RESTART")).toBe(true), { timeout: 15000 });
    // One turn only: the redelivered update reused the same idempotency key and the ledger returned the existing record.
    expect(apiCallsOf(h, "send_message")).toHaveLength(1);
    expect(restarted.state().lastUpdateId).toBe(101);
    expect(restarted.state().offset).toBe(102);
    await restarted.stop();
    await restartedRun;

    // A corrupt state file starts clean (offset undefined), no crash.
    await writeFile(join(h.stateDir, "state.json"), "{not json");
    const corrupt = lib.createBridge({
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: String(USER), TELEGRAM_API_BASE: h.tg.url, TELEGRAM_REMOTE_STATE_DIR: h.stateDir },
      now: () => h.tg.clock.t,
      sleep: () => Promise.resolve(),
      pollTimeoutSec: 1,
      log: (line: string) => h.lines.push(line),
    });
    h.tg.requests.length = 0;
    const corruptRun = corrupt.run();
    await vi.waitFor(() => expect(h.tg.requests.some((request) => request.method === "getUpdates")).toBe(true), { timeout: 5000 });
    expect(h.tg.requests.find((request) => request.method === "getUpdates")!.body.offset).toBeUndefined();
    await corrupt.stop();
    await corruptRun;

    if (process.platform !== "win32") {
      expect((await stat(h.stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(h.stateDir, "state.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("T22 the real service script: polls, answers /help, exits 0 on SIGTERM; with no env it says bad_config and stays alive", async () => {
    const tg = await startFakeTelegram();
    cleanups.push(() => tg.close());
    const dir = await mkdtemp(join(tmpdir(), "anycode-telegram-child-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    tg.push(msg(1, "/help"));
    const child: ChildProcess = spawn(process.execPath, [join(exampleDir, "service.mjs")], {
      env: { PATH: process.env.PATH ?? "", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: String(USER), TELEGRAM_API_BASE: tg.url, TELEGRAM_REMOTE_STATE_DIR: join(dir, "state") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    await vi.waitFor(() => expect(tg.sent.some((entry) => entry.text.startsWith("AnyCode remote control"))).toBe(true), { timeout: 15000 });
    const sentAt = Date.now();
    child.kill("SIGTERM");
    const result = await exited;
    expect(result.code).toBe(0);
    expect(Date.now() - sentAt).toBeLessThan(2000);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("TEST-TOKEN-NOT-REAL");

    const idle = spawn(process.execPath, [join(exampleDir, "service.mjs")], { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(idle);
    let idleOutput = "";
    idle.stdout?.on("data", (chunk: Buffer) => (idleOutput += chunk.toString("utf8")));
    await vi.waitFor(() => expect(idleOutput).toContain("[status] bad_config"), { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(idle.exitCode).toBeNull();
    expect(idleOutput).not.toContain("TEST-TOKEN-NOT-REAL");
  });

  it("T23 the manifest parses with the real schema; the service hash is stable; the two secret names are referenced", async () => {
    const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(join(exampleDir, ".anycode-plugin", "plugin.json"), "utf8")));
    expect(manifest.name).toBe("telegram-remote");
    const services = manifest.services ?? [];
    expect(services).toHaveLength(1);
    expect(serviceSecretRefs(services[0]!)).toEqual(["TELEGRAM_ALLOWED_USERS", "TELEGRAM_BOT_TOKEN"]);
    expect(servicesHash(services)).toMatch(/^[0-9a-f]{64}$/);
    expect(servicesHash(services)).toBe(servicesHash(services));
  });
});

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

// ── approvals and /stop (Taskana 4763) ──

const OFF_TEXT = "External approvals are off for this session; approve in AnyCode or switch them on in the session menu.";
const sendsOf = (h: Harness) => h.tg.requests.filter((r) => r.method === "sendMessage");
const approvalSends = (h: Harness) => sendsOf(h).filter((r) => String(r.body.text).startsWith("Approval needed"));
const requestsOf = (h: Harness, method: string) => h.tg.requests.filter((r) => r.method === method);
const tap = (updateId: number, data: string, from: number = USER, chat: Record<string, unknown> = { id: USER, type: "private" }) =>
  ({ update_id: updateId, callback_query: { id: `cb-${updateId}`, from: { id: from, is_bot: false }, data, message: { message_id: 1, chat } } });
const item = (approvalId: string, extra: Record<string, unknown> = {}) => ({ approvalId, tool: "Bash", description: "npm test", presented: true, expiresInMs: 100000, answerable: true, ...extra });

/** Selects the build session by handle and sends one turn, so the chat has a pending turn to watch. */
async function selectAndSend(h: Harness): Promise<void> {
  h.tg.push(msg(100, "/use build-bot"));
  await waitFor(() => h.bridge.state().lastUpdateId === 100);
  h.tg.push(msg(101, "run the tests"));
  await waitFor(() => h.bridge.state().pending.length === 1);
}

async function restartBridge(h: Harness): Promise<any> {
  const lib = await loadExample("service.mjs");
  const bridge = lib.createBridge({
    approvalLoop: false,
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: String(USER), TELEGRAM_API_BASE: h.tg.url, TELEGRAM_REMOTE_STATE_DIR: h.stateDir, ANYCODE_SESSIONS_DISCOVERY: h.discoveryFile },
    now: () => h.tg.clock.t,
    sleep: (ms: number) => { h.tg.clock.t += ms; return Promise.resolve(); },
    random: () => 0.5,
    paceMs: 0,
    pollTimeoutSec: 1,
    waitSliceMs: 30,
    log: (line: string) => h.lines.push(line),
  });
  const runP = bridge.run();
  cleanups.push(async () => {
    await bridge.stop();
    await runP.catch(() => {});
  });
  // run() loads state.json first; the selected chat only shows up once that load has landed.
  await waitFor(() => bridge.state().chats[String(USER)] !== undefined);
  return bridge;
}

describe("telegram-remote approvals and /stop (Taskana 4763)", () => {
  it("T33 /stop calls cancel_turn once and replies Stopped.; idle -> Nothing is running.; no selection -> hint", async () => {
    const h = await harness();
    h.tg.push(msg(1, "/stop"));
    await waitFor(() => h.bridge.state().lastUpdateId === 1);
    expect(texts(h)).toContain("No session selected. Send /sessions, then /use <name>.");
    expect(apiCallsOf(h, "cancel_turn")).toHaveLength(0);
    h.tg.push(msg(2, "/use build-bot"));
    h.tg.push(msg(3, "/stop"));
    await waitFor(() => texts(h).includes("Stopped."));
    expect(apiCallsOf(h, "cancel_turn")).toEqual([expect.objectContaining({ sid: SID_BUILD })]);
    h.approvals.cancel = () => ({ cancelled: false, reason: "idle" });
    h.tg.push(msg(4, "/stop"));
    await waitFor(() => texts(h).includes("Nothing is running."));
  });

  it("T34 a pending approval produces exactly one message with Allow/Deny; a second sweep does not duplicate it; a restart does not re-send it", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-1")];
    await h.bridge.sweepApprovals();
    await h.bridge.sweepApprovals();
    expect(approvalSends(h)).toHaveLength(1);
    const sent = approvalSends(h)[0]!;
    expect(sent.body.text).toBe("Approval needed [build-bot]: Bash — npm test");
    expect(sent.body.reply_markup.inline_keyboard[0]).toHaveLength(2);
    await h.close();
    const restarted = await restartBridge(h);
    expect(restarted.state().approvals).toHaveLength(1);
    await restarted.sweepApprovals();
    expect(approvalSends(h)).toHaveLength(1);
    await restarted.stop();
  });

  it("T35 Allow tap calls answer_approval allow once, edits the message to Allowed., removes the keyboard and answers the callback", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-1")];
    await h.bridge.sweepApprovals();
    const data = approvalSends(h)[0]!.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    expect(data).toMatch(/^a:[0-9a-z]{1,8}:y$/);
    h.tg.push(tap(200, data));
    await waitFor(() => requestsOf(h, "editMessageText").length === 1);
    expect(apiCallsOf(h, "answer_approval")).toEqual([expect.objectContaining({ sid: SID_BUILD, payload: { approvalId: "ap-1", decision: "allow" } })]);
    const edit = requestsOf(h, "editMessageText")[0]!;
    expect(edit.body.text).toMatch(/Allowed\.$/);
    expect(edit.body).not.toHaveProperty("reply_markup");
    expect(requestsOf(h, "answerCallbackQuery")).toHaveLength(1);
  });

  it("T36 Deny tap calls answer_approval deny and says Denied.", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-2")];
    await h.bridge.sweepApprovals();
    const data = approvalSends(h)[0]!.body.reply_markup.inline_keyboard[0][1].callback_data as string;
    expect(data.endsWith(":n")).toBe(true);
    h.tg.push(tap(201, data));
    await waitFor(() => requestsOf(h, "editMessageText").length === 1);
    expect(apiCallsOf(h, "answer_approval")[0]!.payload).toEqual({ approvalId: "ap-2", decision: "deny" });
    expect(requestsOf(h, "editMessageText")[0]!.body.text).toMatch(/Denied\.$/);
  });

  it("T37 a callback from a non-allowlisted user, from a group, or with chat.id !== from.id causes no API call and no reply; the offset advances", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-3")];
    await h.bridge.sweepApprovals();
    const data = approvalSends(h)[0]!.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    const before = { sent: h.tg.sent.length, answers: requestsOf(h, "answerCallbackQuery").length };
    h.tg.push(tap(300, data, 999, { id: 999, type: "private" }));
    h.tg.push(tap(301, data, USER, { id: -100, type: "group" }));
    h.tg.push(tap(302, data, USER, { id: 777, type: "private" }));
    await waitFor(() => h.bridge.state().offset === 303);
    expect(requestsOf(h, "answerCallbackQuery")).toHaveLength(before.answers);
    expect(requestsOf(h, "editMessageText")).toHaveLength(0);
    expect(apiCallsOf(h, "answer_approval")).toHaveLength(0);
    expect(h.tg.sent.length).toBe(before.sent);
    const persisted = JSON.parse(await readFile(join(h.stateDir, "state.json"), "utf8"));
    expect(persisted.offset).toBe(303);
  });

  it("T38 forged or foreign callback data makes zero Sessions API answer calls", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-4")];
    await h.bridge.sweepApprovals();
    h.tg.push(tap(400, "a:zzzz:y"));
    h.tg.push(tap(401, "x"));
    h.tg.push(tap(402, `a:${"b".repeat(70)}:y`));
    await waitFor(() => h.bridge.state().lastUpdateId === 402);
    expect(apiCallsOf(h, "answer_approval")).toHaveLength(0);
    for (const answer of requestsOf(h, "answerCallbackQuery")) expect(answer.body.text === undefined || answer.body.text === "This request expired or was already settled.").toBe(true);
    expect(requestsOf(h, "editMessageText")).toHaveLength(0);
  });

  it("T39 UI answered first: the tap reports Already answered (in AnyCode).", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-5")];
    await h.bridge.sweepApprovals();
    const data = approvalSends(h)[0]!.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    h.approvals.answer = () => ({ result: "already_answered", settledBy: "ui" });
    h.tg.push(tap(500, data));
    await waitFor(() => requestsOf(h, "editMessageText").length === 1);
    expect(requestsOf(h, "editMessageText")[0]!.body.text).toMatch(/Already answered \(in AnyCode\)\.$/);
  });

  it("T40 with the switch off the owner gets the off notice exactly once", async () => {
    const h = await harness();
    await selectAndSend(h);
    h.approvals.items = [item("ap-6")];
    await h.bridge.sweepApprovals();
    await h.bridge.sweepApprovals();
    expect(texts(h).filter((t) => t === OFF_TEXT)).toHaveLength(1);
    expect(approvalSends(h)).toHaveLength(0);
  });

  it("T41 an answerable:false approval is sent without buttons and says to answer in AnyCode", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-plan", { tool: "ExitPlanMode", description: "the plan", answerable: false })];
    await h.bridge.sweepApprovals();
    const sent = approvalSends(h)[0]!;
    expect(sent.body.text).toBe("Approval needed [build-bot]: ExitPlanMode — the plan — answer this in AnyCode");
    expect(sent.body).not.toHaveProperty("reply_markup");
  });

  it("T42 token hygiene: neither the bot token nor the Sessions API token appears in callback data, logs, state.json or any outgoing body", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-7")];
    await h.bridge.sweepApprovals();
    const data = approvalSends(h)[0]!.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    expect(data).not.toContain(SID_BUILD);
    h.tg.push(tap(700, data));
    await waitFor(() => requestsOf(h, "editMessageText").length === 1);
    const discoveryToken = JSON.parse(await readFile(h.discoveryFile, "utf8")).token as string;
    const state = await readFile(join(h.stateDir, "state.json"), "utf8");
    // Outgoing bodies only: the bot token legitimately appears in the request URL path.
    const everything = JSON.stringify(h.tg.requests.map((r) => r.body)) + state + h.lines.join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(discoveryToken);
  });

  it("T43 a description carrying a Bearer credential reaches Telegram scrubbed", async () => {
    const h = await harness();
    h.approvals.on.add(SID_BUILD);
    await selectAndSend(h);
    h.approvals.items = [item("ap-8", { description: "curl -H Authorization: Bearer abc123def456ghi789 https://x.test" })];
    await h.bridge.sweepApprovals();
    const sent = approvalSends(h)[0]!;
    expect(sent.body.text).not.toContain("abc123def456ghi789");
    expect(sent.body.text).toContain("***");
  });
});

describe("telegram-remote store and shutdown (Taskana 4785)", () => {
  it("T44 stop() waits for a state write already in flight: it resolves only after that write lands, and run() resolves instead of rejecting", async () => {
    const h = await harness({ autoStart: false });
    const lib = await loadExample("service.mjs");
    const realStore = lib.fileStore(h.stateDir);
    let stopping = false;
    let started = 0;
    let completed = 0;
    const bridge = lib.createBridge({
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: String(USER), TELEGRAM_API_BASE: h.tg.url, TELEGRAM_REMOTE_STATE_DIR: h.stateDir, ANYCODE_SESSIONS_DISCOVERY: h.discoveryFile },
      now: () => h.tg.clock.t,
      sleep: () => Promise.resolve(),
      paceMs: 0,
      pollTimeoutSec: 1,
      waitSliceMs: 30,
      log: (line: string) => h.lines.push(line),
      store: {
        load: () => realStore.load(),
        save: async (state: unknown) => {
          started += 1;
          // Writes issued before stop() are slow; the write stop() itself issues is immediate.
          if (!stopping) await new Promise((resolve) => setTimeout(resolve, 250));
          await realStore.save(state);
          completed += 1;
        },
      },
    });
    cleanups.push(() => bridge.stop());
    const runP = bridge.run();
    h.tg.push(msg(100, "/help"));
    await waitFor(() => started > completed);
    expect(started).toBeGreaterThan(completed);
    stopping = true;
    await bridge.stop();
    expect(completed).toBe(started);
    await expect(runP).resolves.toBeUndefined();
    const persisted = JSON.parse(await readFile(join(h.stateDir, "state.json"), "utf8"));
    expect(persisted.offset).toBe(101);
    expect(h.lines.some((line) => line.includes("[err]"))).toBe(false);
  });

  it("T45 concurrent fileStore saves queue instead of colliding on the temp file: last write wins and no temp file is left behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-telegram-store-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const lib = await loadExample("service.mjs");
    const store = lib.fileStore(dir);
    await Promise.all([store.save({ a: 1 }), store.save({ a: 2 }), store.save({ a: 3 })]);
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8"))).toEqual({ a: 3 });
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

