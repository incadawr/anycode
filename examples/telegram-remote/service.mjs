/**
 * telegram-remote: talk to your shared AnyCode sessions from one Telegram chat
 * (Taskana 4751). AnyCode runs this as a plugin service after you consent to it.
 * Zero dependencies: Node built-ins and global fetch only.
 *
 * Secrets arrive in the environment (AnyCode resolves `${secret:NAME}` from its
 * secret store): TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS. The Sessions API
 * token is read from the discovery file on each call and never printed, stored or
 * sent to Telegram. Every log line, reply and error passes through redact().
 *
 * Telegram is reached by long polling (getUpdates). Only a private message from an
 * allowlisted user reaches a session. Lines are prefixed [status], [ignored],
 * [cmd] (command name only) or [err].
 */
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  API_OFF_TEXT,
  APPROVAL_EXPIRED_TEXT,
  APPROVAL_OFF_SERVER_TEXT,
  APPROVAL_OFF_TAP_TEXT,
  APPROVAL_OFF_TEXT,
  APPROVAL_TOKEN_MAX,
  APPROVAL_TTL_MS,
  HELP_TEXT,
  approvalAnswerText,
  buildApprovalKeyboard,
  nextApprovalToken,
  parseCallbackData,
  renderApproval,
  screenCallback,
  SESSION_PAYLOAD_MAX,
  TELEGRAM_CHUNK_LIMIT,
  UNREACHABLE_TEXT,
  applyReplyCap,
  chunkText,
  classifyTelegramError,
  clampMaxReply,
  jitter,
  nextBackoff,
  parseAllowlist,
  parseCommand,
  redact,
  renderSessions,
  resolveSession,
  screenUpdate,
  sessionLabel,
} from "./lib.mjs";

const DEFAULT_API_BASE = "https://api.telegram.org";
const PENDING_MAX = 20;
const PENDING_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const TURNS_PER_CHAT_MAX = 3;
const UPDATES_PER_MINUTE_MAX = 20;
const WAIT_MAX_MS = 60 * 60 * 1000;
const NUMBERED_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 10 * 60 * 1000;
const UNKNOWN_LOG_MS = 60 * 1000;
const RESULT_RETRY_MAX = 3;
const APPROVAL_POLL_MS = 3000;
const APPROVAL_OFF_NOTICE_MS = 10 * 60 * 1000;

class TgError extends Error {
  constructor(cls, status) {
    super(`telegram ${status}`);
    this.cls = cls;
  }
}
class NetError extends Error {}
class StopError extends Error {}
/** A Sessions API tool error (the server's own text). */
class ToolError extends Error {}
/** The Sessions API cannot be used right now: `off` (no discovery path) or `unreachable`. */
class ApiError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

/** Reads the environment into a config object. Pure apart from the default state dir. */
export function loadConfig(env = process.env) {
  const apiBase = (env.TELEGRAM_API_BASE ?? "").trim() || DEFAULT_API_BASE;
  return {
    token: (env.TELEGRAM_BOT_TOKEN ?? "").trim(),
    allowlist: parseAllowlist(env.TELEGRAM_ALLOWED_USERS),
    apiBase,
    apiOk: validApiBase(apiBase),
    maxReplyChars: clampMaxReply(env.TELEGRAM_MAX_REPLY_CHARS),
    stateDir: env.TELEGRAM_REMOTE_STATE_DIR || join(homedir(), ".anycode", "plugin-data", "telegram-remote"),
    discoveryPath: env.ANYCODE_SESSIONS_DISCOVERY || undefined,
  };
}

/** Only the real Telegram endpoint or a loopback test server. Any other host would receive the token. */
export function validApiBase(base) {
  try {
    const url = new URL(base);
    if (url.username !== "" || url.password !== "") return false;
    if (url.search !== "" || url.hash !== "") return false;
    if (url.protocol === "https:") return url.hostname === "api.telegram.org" && (url.pathname === "/" || url.pathname === "");
    if (url.protocol === "http:") return url.hostname === "127.0.0.1";
    return false;
  } catch {
    return false;
  }
}

function emptyState() {
  return { offset: undefined, lastUpdateId: 0, chats: {}, pending: [], approvals: [], tokenSeq: 0 };
}

/** Tolerant load: anything unreadable or malformed becomes defaults. Pending turns older than 2 h are dropped. */
export function sanitizeState(raw, now) {
  if (!raw || typeof raw !== "object") return emptyState();
  const offset = Number.isSafeInteger(raw.offset) && raw.offset >= 0 ? raw.offset : undefined;
  const lastUpdateId = Number.isSafeInteger(raw.lastUpdateId) && raw.lastUpdateId >= 0 ? raw.lastUpdateId : 0;
  const chats = {};
  if (raw.chats && typeof raw.chats === "object") {
    for (const [id, chat] of Object.entries(raw.chats)) {
      if (chat && typeof chat === "object" && typeof chat.sessionId === "string") {
        chats[id] = { sessionId: chat.sessionId, ...(typeof chat.handle === "string" ? { handle: chat.handle } : {}) };
      }
    }
  }
  const pending = Array.isArray(raw.pending)
    ? raw.pending
        .filter((p) => p && typeof p === "object" && typeof p.chatId === "number" && typeof p.sessionId === "string" && typeof p.messageId === "string" && Number.isFinite(p.startedAt) && now - p.startedAt <= PENDING_MAX_AGE_MS)
        .map((p) => ({ chatId: p.chatId, sessionId: p.sessionId, messageId: p.messageId, startedAt: p.startedAt, label: typeof p.label === "string" ? p.label : p.sessionId.slice(0, 8) }))
        .slice(0, PENDING_MAX)
    : [];
  // Approval tokens: a tap maps back to {chatId, sessionId, approvalId} only through this list.
  const approvals = Array.isArray(raw.approvals)
    ? raw.approvals
        .filter((a) => a && typeof a === "object" && typeof a.token === "string" && typeof a.chatId === "number" && typeof a.sessionId === "string" && typeof a.approvalId === "string" && Number.isFinite(a.at) && now - a.at <= APPROVAL_TTL_MS)
        .map((a) => ({ token: a.token, chatId: a.chatId, sessionId: a.sessionId, approvalId: a.approvalId, text: typeof a.text === "string" ? a.text : "", at: a.at, ...(Number.isSafeInteger(a.messageId) ? { messageId: a.messageId } : {}) }))
        .slice(-APPROVAL_TOKEN_MAX)
    : [];
  const tokenSeq = Number.isSafeInteger(raw.tokenSeq) && raw.tokenSeq >= 0 ? raw.tokenSeq : 0;
  return { offset, lastUpdateId, chats, pending, approvals, tokenSeq };
}

/** The default state store: a 0700 directory and 0600 files, written atomically. */
export function fileStore(dir, now = () => Date.now()) {
  const file = join(dir, "state.json");
  // Saves run one at a time: overlapping writes would share the temp name and the second rename would find nothing.
  let saveChain = Promise.resolve();
  return {
    async load() {
      try {
        return sanitizeState(JSON.parse(await readFile(file, "utf8")), now());
      } catch {
        return emptyState();
      }
    },
    save(state) {
      const write = saveChain.then(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700).catch(() => {});
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await rename(temporary, file);
        await chmod(file, 0o600).catch(() => {});
      });
      saveChain = write.catch(() => {});
      return write;
    },
  };
}

/** Reads the Sessions API discovery file: `{url, token, workspaces}`. Throws when it is missing or malformed. */
export async function readDiscoveryFile(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed?.url !== "string" || typeof parsed?.token !== "string") throw new Error("discovery file malformed");
  return parsed;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The bridge. Every seam is injectable (fetch, clock, sleep, state store,
 * discovery reader, log) so the tests drive it with a fake clock and servers.
 * `run()` resolves after `stop()`.
 */
export function createBridge(options = {}) {
  const env = options.env ?? process.env;
  const cfg = options.config ?? loadConfig(env);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const pacingMs = options.paceMs ?? 1000;
  const pollTimeoutSec = options.pollTimeoutSec ?? 30;
  /** One long-poll slice of wait_for_result (tests shorten it). */
  const waitSliceMs = options.waitSliceMs ?? 50000;
  const store = options.store ?? fileStore(cfg.stateDir, now);
  const readDiscovery = options.readDiscovery ?? (() => readDiscoveryFile(cfg.discoveryPath));
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  let lastToken;
  const secrets = () => [cfg.token, lastToken].filter((value) => typeof value === "string" && value !== "");
  const log = (line) => (options.log ?? ((text) => console.log(text)))(redact(line, secrets()));

  let state = emptyState();
  let status = "starting";
  let lastHeartbeat = -Infinity;
  let stopped = false;
  const stopController = new AbortController();
  let resolveStopped;
  const stoppedPromise = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  let keepAlive;
  const chainByChat = new Map();
  const lastSentByChat = new Map();
  const waiters = new Map();
  const numbered = new Map();
  const updateWindows = new Map();
  const lastNoticeAt = new Map();
  const lastUnknownLogAt = new Map();

  const pause = (ms) => Promise.race([sleep(Math.max(0, ms)), stoppedPromise]);

  function setStatus(next, detail) {
    if (next === status) return;
    status = next;
    lastHeartbeat = now();
    log(detail === undefined ? `[status] ${next}` : `[status] ${next}: ${detail}`);
  }

  function idleForever() {
    keepAlive ??= setInterval(() => {}, 1 << 30);
    return stoppedPromise;
  }

  // Writes go through one tail so stop() can wait for the last one started, even with an injected store.
  let writeTail = Promise.resolve();
  async function persist() {
    const write = writeTail.then(() => store.save(state));
    writeTail = write.catch(() => {});
    await write;
  }

  // Publish polling progress only after the corresponding state is durable.
  async function persistProgress(lastUpdateId, offset) {
    const write = writeTail.then(async () => {
      await store.save({ ...state, lastUpdateId, offset });
      state.lastUpdateId = lastUpdateId;
      state.offset = offset;
    });
    writeTail = write.catch(() => {});
    await write;
  }

  // ── Telegram transport ──

  async function tg(method, body, timeoutMs) {
    const url = `${cfg.apiBase}/bot${cfg.token}/${method}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (stopped) throw new StopError("stopped");
      throw new NetError(redact(error instanceof Error ? error.message : String(error), secrets()));
    }
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (response.ok && json?.ok === true) return json.result;
    throw new TgError(classifyTelegramError(response.status, json), response.status);
  }

  // ── Sessions API ──

  /** One MCP tools/call. Re-reads the discovery file (a regenerated token is picked up), retries once on 401 or an unreadable file. */
  async function api(name, args) {
    if (!cfg.discoveryPath) throw new ApiError("off");
    for (let attempt = 0; ; attempt += 1) {
      let discovery;
      try {
        discovery = await readDiscovery();
        lastToken = discovery.token;
      } catch {
        if (attempt === 0) continue;
        throw new ApiError("unreachable");
      }
      let response;
      try {
        response = await fetchImpl(discovery.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${discovery.token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: attempt + 1, method: "tools/call", params: { name, arguments: args } }),
          signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(65_000)]),
        });
      } catch {
        if (stopped) throw new StopError("stopped");
        throw new ApiError("unreachable");
      }
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new ApiError("unreachable");
      const message = parseRpc(await response.text());
      const text = message.result?.content?.[0]?.text ?? "";
      if (message.result?.isError) throw new ToolError(text || "tool error");
      if (message.error) throw new ApiError("unreachable");
      try {
        return JSON.parse(text);
      } catch {
        throw new ApiError("unreachable");
      }
    }
  }

  /** Plain JSON, or the first `data:` line of a Server-Sent Events body. */
  function parseRpc(body) {
    const trimmed = body.trimStart();
    const json = trimmed.startsWith("{") ? trimmed : (trimmed.split("\n").find((line) => line.startsWith("data:")) ?? "{}").slice(5);
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  // ── outgoing messages (per chat: ordered, paced, redacted, chunked) ──

  function reply(chatId, text) {
    const previous = chainByChat.get(chatId) ?? Promise.resolve();
    const next = previous.then(() => deliver(chatId, text)).catch((error) => {
      if (!(error instanceof StopError)) log(`[err] reply failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    chainByChat.set(chatId, next);
    return next;
  }

  async function deliver(chatId, text) {
    const safe = redact(text, secrets());
    const capped = applyReplyCap(safe, cfg.maxReplyChars).text;
    for (const chunk of chunkText(capped, TELEGRAM_CHUNK_LIMIT)) {
      const result = await sendOne(chatId, chunk);
      if (result === "too_long") {
        for (const smaller of chunkText(chunk, 3000)) await sendOne(chatId, smaller);
      }
    }
  }

  async function sendOne(chatId, text) {
    if (text.trim() === "") return "dropped";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wait = (lastSentByChat.get(chatId) ?? -Infinity) + pacingMs - now();
      if (wait > 0) await pause(wait);
      if (stopped) throw new StopError("stopped");
      try {
        await tg("sendMessage", { chat_id: chatId, text }, 30_000);
        lastSentByChat.set(chatId, now());
        return "sent";
      } catch (error) {
        if (error instanceof StopError) throw error;
        if (error instanceof TgError) {
          const cls = error.cls;
          if (cls.kind === "rate_limited") {
            await pause(Math.min(cls.retryAfter, 120) * 1000);
            continue;
          }
          if (cls.kind === "too_long") return "too_long";
          if (cls.kind === "blocked") {
            log("[status] user_blocked: the user blocked the bot; reply dropped");
            return "dropped";
          }
          log(`[err] sendMessage refused (HTTP ${error.message.replace(/\D/g, "") || "?"}); reply dropped`);
          return "dropped";
        }
        await pause(jitter(nextBackoff("offline", attempt), random()));
      }
    }
    log("[err] sendMessage failed after retries; reply dropped");
    return "dropped";
  }

  /** Runs a task after the chat's queued replies, so approval messages and answers keep their order. */
  function inChat(chatId, task) {
    const previous = chainByChat.get(chatId) ?? Promise.resolve();
    const next = previous.then(task);
    chainByChat.set(chatId, next.catch(() => {}));
    return next;
  }

  /** Sends one message (paced like reply) and returns its Telegram message_id. */
  async function sendWithId(chatId, text, markup) {
    const wait = (lastSentByChat.get(chatId) ?? -Infinity) + pacingMs - now();
    if (wait > 0) await pause(wait);
    if (stopped) throw new StopError("stopped");
    const body = { chat_id: chatId, text: redact(text, secrets()) };
    if (markup !== undefined) body.reply_markup = markup;
    const result = await tg("sendMessage", body, 30_000);
    lastSentByChat.set(chatId, now());
    return Number.isSafeInteger(result?.message_id) ? result.message_id : undefined;
  }

  // ── pending turns and result waiters ──

  const pendingFor = (chatId) => state.pending.filter((entry) => entry.chatId === chatId);

  async function addPending(entry) {
    if (state.pending.some((item) => item.messageId === entry.messageId)) return;
    state.pending = [...state.pending, entry].slice(-PENDING_MAX);
    await persist();
  }

  async function removePending(messageId) {
    const before = state.pending.length;
    state.pending = state.pending.filter((item) => item.messageId !== messageId);
    if (state.pending.length !== before) await persist();
  }

  function startWaiter(entry) {
    if (waiters.has(entry.messageId)) return;
    const running = runWaiter(entry)
      .catch((error) => {
        if (!(error instanceof StopError)) log(`[err] result waiter: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => waiters.delete(entry.messageId));
    waiters.set(entry.messageId, running);
  }

  async function clearSelectionIf(chatId, sessionId) {
    if (state.chats[String(chatId)]?.sessionId === sessionId) {
      delete state.chats[String(chatId)];
      await persist();
    }
  }

  async function runWaiter(entry) {
    let transient = 0;
    for (;;) {
      if (stopped) return;
      if (now() - entry.startedAt > WAIT_MAX_MS) {
        await reply(entry.chatId, "Still running after 60 min; check /status.");
        await removePending(entry.messageId);
        return;
      }
      let result;
      try {
        result = await api("wait_for_result", { sessionId: entry.sessionId, messageId: entry.messageId, timeoutMs: waitSliceMs });
        transient = 0;
      } catch (error) {
        if (stopped) throw new StopError("stopped");
        if (error instanceof ToolError) {
          const text = error.message;
          if (text === "Session unavailable or outside authorized workspace") {
            await reply(entry.chatId, `Session ${entry.label} is no longer shared or was closed.`);
            await clearSelectionIf(entry.chatId, entry.sessionId);
            await removePending(entry.messageId);
            return;
          }
          if (text !== "Too many waiters") {
            await reply(entry.chatId, `Lost track of the turn (${text}).`);
            await removePending(entry.messageId);
            return;
          }
        }
        transient += 1;
        if (transient > RESULT_RETRY_MAX) {
          await reply(entry.chatId, "Could not read the result.");
          await removePending(entry.messageId);
          return;
        }
        await pause(5000);
        continue;
      }
      if (result.status === "pending") continue;
      if (result.status === "done" && result.latestResult?.terminalReason === "cancelled") {
        const partial = result.latestResult?.publicAnswer;
        const tail = typeof partial === "string" && partial.trim() !== "" ? `\n${partial}` : "";
        await reply(entry.chatId, `[${entry.label}] Stopped.${tail}`);
      } else if (result.status === "done") {
        const answer = result.latestResult?.publicAnswer;
        await reply(entry.chatId, `[${entry.label}] ${typeof answer === "string" && answer.trim() !== "" ? answer : "(empty answer)"}`);
      } else if (result.status === "rejected") {
        await reply(entry.chatId, `Rejected: ${result.detail ?? "no detail"}`);
      } else {
        await reply(entry.chatId, `Delivery unknown; not retried: ${result.detail ?? "no detail"}`);
      }
      await removePending(entry.messageId);
      return;
    }
  }

  // ── commands and plain messages ──

  const labelOfSelection = (chatId) => {
    const chat = state.chats[String(chatId)];
    return chat ? sessionLabel(chat) : undefined;
  };

  async function sessionsNow() {
    const list = await api("list_sessions", {});
    return Array.isArray(list?.sessions) ? list.sessions : [];
  }

  /** Revalidates the selected session against a fresh list. Clears the selection and tells the user when it is gone. */
  async function revalidate(chatId) {
    const chat = state.chats[String(chatId)];
    if (!chat) return undefined;
    const session = (await sessionsNow()).find((candidate) => candidate.sessionId === chat.sessionId);
    if (!session) {
      await reply(chatId, `Session ${sessionLabel(chat)} is no longer shared or was closed.`);
      await clearSelectionIf(chatId, chat.sessionId);
      return undefined;
    }
    return session;
  }

  async function sendTurn(chatId, updateId, text, mode) {
    if (!state.chats[String(chatId)]) {
      await reply(chatId, "No session selected. Send /sessions, then /use <name>.");
      return;
    }
    if (text.length > SESSION_PAYLOAD_MAX) {
      await reply(chatId, `Message too long (max ${SESSION_PAYLOAD_MAX}).`);
      return;
    }
    if (pendingFor(chatId).length >= TURNS_PER_CHAT_MAX) {
      await reply(chatId, "Too many pending messages, wait for an answer.");
      return;
    }
    const session = await revalidate(chatId);
    if (!session) return;
    const key = `tg-${updateId}`;
    const record = await api("send_message", {
      sessionId: session.sessionId,
      payload: text,
      mode,
      kind: "agent_message",
      correlationId: key,
      idempotencyKey: key,
    });
    const label = sessionLabel(session);
    const recordState = record?.state;
    if (recordState === "queued" || recordState === "acknowledged") {
      const verb = mode === "steer" ? "Steer sent to" : "Sent to";
      await reply(chatId, `${verb} ${label} (${recordState === "queued" ? "queued" : "sent"})`);
      const entry = { chatId, sessionId: session.sessionId, messageId: record.envelope.messageId, startedAt: now(), label };
      await addPending(entry);
      startWaiter(entry);
      return;
    }
    if (mode === "steer") {
      await reply(chatId, `Steer rejected: ${record?.detail ?? "no detail"}`);
    } else if (recordState === "unknown") {
      await reply(chatId, `Delivery unknown; not retried: ${record?.detail ?? "no detail"}`);
    } else {
      await reply(chatId, `Not sent: ${record?.detail ?? "no detail"}`);
    }
  }

  async function runCommand(chatId, updateId, command) {
    const { name, args } = command;
    if (name === "help" || name === "start") {
      await reply(chatId, cfg.discoveryPath ? HELP_TEXT : `${HELP_TEXT}\n\n${API_OFF_TEXT}`);
      return;
    }
    if (name === "status") {
      const lines = [`Bridge: ${status}`, `Pending turns: ${pendingFor(chatId).length}`];
      const chat = state.chats[String(chatId)];
      if (!chat) {
        lines.push("No session selected.");
      } else {
        const session = (await sessionsNow()).find((candidate) => candidate.sessionId === chat.sessionId);
        if (!session) {
          await reply(chatId, `${lines.join("\n")}\nSession ${sessionLabel(chat)} is no longer shared or was closed.`);
          await clearSelectionIf(chatId, chat.sessionId);
          return;
        }
        const detail = await api("get_session_status", { sessionId: chat.sessionId });
        const busy = Boolean(detail?.running ?? detail?.busy ?? detail?.activeTurnId);
        lines.push(`Session ${sessionLabel(chat)}: ${detail?.engine ?? "engine unknown"}, ${busy ? "running" : "idle"}`);
      }
      await reply(chatId, lines.join("\n"));
      return;
    }
    if (name === "stop") {
      if (!state.chats[String(chatId)]) {
        await reply(chatId, "No session selected. Send /sessions, then /use <name>.");
        return;
      }
      const session = await revalidate(chatId);
      if (!session) return;
      const result = await api("cancel_turn", { sessionId: session.sessionId });
      if (result?.cancelled === true) await reply(chatId, "Stopped.");
      else if (result?.reason === "idle") await reply(chatId, "Nothing is running.");
      else await reply(chatId, `Cannot stop right now (${result?.reason ?? "unknown"}).`);
      return;
    }
    if (name === "approvals") {
      const chat = state.chats[String(chatId)];
      if (!chat) {
        await reply(chatId, "No session selected. Send /sessions, then /use <name>.");
        return;
      }
      await sweepChat(chatId, chat.sessionId, { listAll: true });
      return;
    }
    if (name === "sessions") {
      const list = await sessionsNow();
      numbered.set(chatId, { at: now(), ids: list.map((session) => session.sessionId) });
      await reply(chatId, renderSessions(list, state.chats[String(chatId)]?.sessionId));
      return;
    }
    if (name === "use") {
      if (args === "") {
        const label = labelOfSelection(chatId);
        await reply(chatId, label ? `Selected: ${label}.` : "No session selected. Send /sessions, then /use <name>.");
        return;
      }
      const list = await sessionsNow();
      const fresh = numbered.get(chatId);
      const ids = fresh !== undefined && now() - fresh.at <= NUMBERED_TTL_MS ? fresh.ids : undefined;
      const found = resolveSession(list, args, ids);
      if (found.error === "ambiguous") {
        await reply(chatId, "Ambiguous, use the handle or a longer id.");
        return;
      }
      if (found.error !== undefined) {
        await reply(chatId, "No such shared session. Send /sessions.");
        return;
      }
      state.chats[String(chatId)] = { sessionId: found.session.sessionId, ...(found.session.handle ? { handle: found.session.handle } : {}) };
      await persist();
      await reply(chatId, `Selected ${sessionLabel(found.session)}.`);
      return;
    }
    if (name === "steer") {
      if (args === "") {
        await reply(chatId, "Usage: /steer <text>");
        return;
      }
      await sendTurn(chatId, updateId, args, "steer");
      return;
    }
    await reply(chatId, HELP_TEXT);
  }

  /** Per-chat budget: at most UPDATES_PER_MINUTE_MAX processed per minute; one notice per minute for the excess. */
  function withinRate(chatId) {
    const at = now();
    const window = (updateWindows.get(chatId) ?? []).filter((time) => at - time < 60_000);
    if (window.length >= UPDATES_PER_MINUTE_MAX) {
      updateWindows.set(chatId, window);
      if (at - (lastNoticeAt.get(chatId) ?? -Infinity) >= 60_000) {
        lastNoticeAt.set(chatId, at);
        reply(chatId, "Too many messages; slow down. Extra messages are dropped for a minute.");
      }
      return false;
    }
    window.push(at);
    updateWindows.set(chatId, window);
    return true;
  }

  // ── approvals (Taskana 4763) ──

  async function dropApproval(token) {
    const before = state.approvals.length;
    state.approvals = state.approvals.filter((entry) => entry.token !== token);
    if (state.approvals.length !== before) await persist();
  }

  /** Removes the buttons of a message whose approval is gone. Best effort. */
  async function clearButtons(entry) {
    if (entry.messageId === undefined) return;
    await inChat(entry.chatId, () => tg("editMessageReplyMarkup", { chat_id: entry.chatId, message_id: entry.messageId, reply_markup: { inline_keyboard: [] } }, 30_000)).catch(() => {});
  }

  async function offNotice(chatId, sessionId) {
    const key = `approvals-off:${sessionId}`;
    const at = now();
    if (at - (lastNoticeAt.get(key) ?? -Infinity) < APPROVAL_OFF_NOTICE_MS) return;
    lastNoticeAt.set(key, at);
    await reply(chatId, APPROVAL_OFF_TEXT);
  }

  async function notifyApproval(chatId, sessionId, item, label) {
    state.tokenSeq += 1;
    const token = nextApprovalToken(state.tokenSeq);
    const text = renderApproval(item, label);
    const entry = { token, chatId, sessionId, approvalId: String(item.approvalId), text, at: now() };
    state.approvals = [...state.approvals, entry].slice(-APPROVAL_TOKEN_MAX);
    await persist();
    const markup = item.answerable === false ? undefined : buildApprovalKeyboard(token);
    const messageId = await inChat(chatId, () => sendWithId(chatId, text, markup)).catch(() => undefined);
    if (messageId !== undefined) {
      entry.messageId = messageId;
      await persist();
    }
  }

  /**
   * One look at a selected session's pending approvals: notifies new ones, drops
   * the buttons of ones that are gone. `listAll` (for /approvals) re-sends every
   * current item with its buttons.
   */
  async function sweepChat(chatId, sessionId, { listAll = false } = {}) {
    let items;
    try {
      const page = await api("list_pending_approvals", { sessionId });
      items = Array.isArray(page?.approvals) ? page.approvals : [];
    } catch (error) {
      if (error instanceof ToolError && error.message === APPROVAL_OFF_SERVER_TEXT) {
        await offNotice(chatId, sessionId);
      } else if (listAll && error instanceof ToolError) {
        await reply(chatId, `AnyCode: ${error.message}`);
      }
      return;
    }
    const listed = new Set(items.map((item) => String(item.approvalId)));
    for (const entry of state.approvals.filter((e) => e.sessionId === sessionId && e.chatId === chatId && !listed.has(e.approvalId))) {
      await clearButtons(entry);
      await dropApproval(entry.token);
    }
    const label = labelOfSelection(chatId) ?? sessionId.slice(0, 8);
    if (listAll && items.length === 0) await reply(chatId, "No approvals waiting.");
    for (const item of items) {
      const known = state.approvals.some((e) => e.sessionId === sessionId && e.approvalId === String(item.approvalId));
      if (known && !listAll) continue;
      await notifyApproval(chatId, sessionId, item, label);
    }
  }

  /** Every chat with a selected session and a pending turn, once. */
  async function sweepApprovals() {
    for (const [key, chat] of Object.entries(state.chats)) {
      const chatId = Number(key);
      if (pendingFor(chatId).length === 0) continue;
      if (stopped) return;
      await sweepChat(chatId, chat.sessionId).catch(() => {});
    }
  }

  async function approvalLoop() {
    while (!stopped) {
      await sweepApprovals().catch((error) => log(`[err] approvals: ${error instanceof Error ? error.message : String(error)}`));
      await pause(APPROVAL_POLL_MS);
    }
  }

  /** A tap on Allow/Deny. Only our own tokens from the same private chat are acted on. */
  async function dispatchCallback(update) {
    const screened = screenCallback(update, cfg.allowlist);
    if (screened.drop !== undefined) {
      if (screened.drop === "not_allowlisted") logUnknown(screened.senderId);
      return;
    }
    const callback = screened.callback;
    const parsed = parseCallbackData(callback.data);
    if (parsed === null) return;
    const chatId = callback.message.chat.id;
    const entry = state.approvals.find((candidate) => candidate.token === parsed.token);
    if (!entry) {
      await tg("answerCallbackQuery", { callback_query_id: callback.id, text: APPROVAL_EXPIRED_TEXT }, 30_000).catch(() => {});
      return;
    }
    if (entry.chatId !== chatId) return;
    await tg("answerCallbackQuery", { callback_query_id: callback.id }, 30_000).catch(() => {});
    let text;
    try {
      const answer = await api("answer_approval", { sessionId: entry.sessionId, approvalId: entry.approvalId, decision: parsed.decision });
      text = approvalAnswerText(answer?.status, parsed.decision, answer?.settledBy);
    } catch (error) {
      if (error instanceof ToolError && error.message === APPROVAL_OFF_SERVER_TEXT) {
        await reply(chatId, APPROVAL_OFF_TAP_TEXT);
        return;
      }
      if (error instanceof StopError) throw error;
      text = approvalAnswerText("error", parsed.decision);
    }
    if (entry.messageId !== undefined) {
      await inChat(chatId, () => tg("editMessageText", { chat_id: chatId, message_id: entry.messageId, text: redact(`${entry.text}\n\n${text}`, secrets()) }, 30_000)).catch(() => {});
    }
    await dropApproval(entry.token);
  }

  async function dispatch(update) {
    const screened = screenUpdate(update, cfg.allowlist);
    if (screened.drop !== undefined) {
      if (screened.drop === "not_allowlisted") logUnknown(screened.senderId);
      return;
    }
    const message = screened.message;
    const chatId = message.chat.id;
    if (!withinRate(chatId)) return;
    if (typeof message.text !== "string" || message.text.trim() === "") {
      await reply(chatId, "Only text is supported.");
      return;
    }
    const command = parseCommand(message.text);
    const helpLike = command.kind === "command" && (command.name === "help" || command.name === "start");
    try {
      if (!cfg.discoveryPath && !helpLike) {
        await reply(chatId, API_OFF_TEXT);
        return;
      }
      if (command.kind === "text") {
        await sendTurn(chatId, update.update_id, command.text, "next_turn");
        return;
      }
      log(`[cmd] ${command.name}`);
      await runCommand(chatId, update.update_id, command);
    } catch (error) {
      await reply(chatId, apiNotice(error));
    }
  }

  function apiNotice(error) {
    if (error instanceof ApiError) return error.kind === "off" ? API_OFF_TEXT : UNREACHABLE_TEXT;
    if (error instanceof ToolError) return `AnyCode: ${error.message}`;
    if (error instanceof StopError) return "";
    return "AnyCode could not complete that request.";
  }

  function logUnknown(senderId) {
    const at = now();
    if (at - (lastUnknownLogAt.get(senderId) ?? -Infinity) < UNKNOWN_LOG_MS) return;
    lastUnknownLogAt.set(senderId, at);
    log(`[ignored] update from a non-allowlisted sender (id ${senderId})`);
  }

  // ── polling ──

  async function pollLoop() {
    let conflictAttempt = 0;
    let offlineAttempt = 0;
    while (!stopped) {
      let updates;
      try {
        updates = await tg("getUpdates", { offset: state.offset, timeout: pollTimeoutSec, allowed_updates: ["message", "callback_query"] }, (pollTimeoutSec + 15) * 1000);
      } catch (error) {
        if (stopped || error instanceof StopError) return;
        if (error instanceof TgError) {
          const cls = error.cls;
          if (cls.kind === "conflict") {
            setStatus(
              "conflict",
              cls.webhook
                ? "a webhook is set on this bot; remove it with deleteWebhook"
                : "another process is polling this bot token (one bot per machine; use a separate bot per computer)",
            );
            await pause(nextBackoff("conflict", conflictAttempt));
            conflictAttempt += 1;
            continue;
          }
          if (cls.kind === "token_invalid") {
            setStatus("token_invalid", "Telegram rejected the bot token; fix TELEGRAM_BOT_TOKEN in Settings -> MCP -> Secrets and press Restart");
            return;
          }
          if (cls.kind === "rate_limited") {
            await pause(Math.min(cls.retryAfter, 120) * 1000);
            continue;
          }
        }
        setStatus("offline", "Telegram is not reachable; retrying");
        await pause(jitter(nextBackoff("offline", offlineAttempt), random()));
        offlineAttempt += 1;
        continue;
      }
      conflictAttempt = 0;
      offlineAttempt = 0;
      setStatus(cfg.discoveryPath ? "online" : "no_sessions_api");
      if (now() - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now();
        log(`[status] ${status} (offset ${state.offset ?? 0})`);
      }
      for (const update of Array.isArray(updates) ? updates : []) {
        if (stopped) return;
        if (typeof update?.update_id !== "number") continue;
        if (update.update_id > state.lastUpdateId) {
          try {
            if (update.callback_query !== undefined) await dispatchCallback(update);
            else await dispatch(update);
          } catch (error) {
            log(`[err] dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const lastUpdateId = Math.max(state.lastUpdateId, update.update_id);
        // A save that fails because stop() already began (state dir gone, shutdown) is not a poll failure.
        await persistProgress(lastUpdateId, update.update_id + 1).catch((error) => {
          if (!stopped) throw error;
        });
      }
    }
  }

  // ── lifecycle ──

  async function run() {
    state = await store.load();
    if (!cfg.apiOk) {
      setStatus("bad_config", "TELEGRAM_API_BASE is not an allowed Telegram endpoint; nothing was sent");
      return idleForever();
    }
    if (cfg.token === "") {
      setStatus("bad_config", "TELEGRAM_BOT_TOKEN is not set; add it in Settings -> MCP -> Secrets and press Restart");
      return idleForever();
    }
    if (cfg.allowlist.length === 0) {
      setStatus("no_allowlist", "TELEGRAM_ALLOWED_USERS has no valid user id; add your numeric Telegram id and press Restart");
      return idleForever();
    }
    setStatus("starting");
    for (const entry of [...state.pending]) startWaiter(entry);
    // The 3 s approval poll is switched on by main() only; tests drive sweepApprovals() directly.
    if (options.approvalLoop === true) void approvalLoop();
    await pollLoop();
    if (!stopped) return idleForever();
    return stoppedPromise;
  }

  async function stop() {
    if (stopped) return stoppedPromise;
    stopped = true;
    stopController.abort();
    clearInterval(keepAlive);
    resolveStopped();
    await Promise.allSettled([...waiters.values(), ...chainByChat.values()]);
    await writeTail;
    await persist().catch(() => {});
  }

  return { run, stop, status: () => status, state: () => state, sweepApprovals };
}

/** Process entry: runs the bridge and keeps the process alive while idle. */
export async function main() {
  const log = (line) => console.log(line);
  const bridge = createBridge({ log, approvalLoop: true });
  const shutdown = () => {
    const timer = setTimeout(() => process.exit(0), 2000);
    timer.unref();
    bridge.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("uncaughtException", (error) => {
    log(`[err] ${redact(error instanceof Error ? error.message : String(error), [process.env.TELEGRAM_BOT_TOKEN ?? ""])}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    log(`[err] ${redact(error instanceof Error ? error.message : String(error), [process.env.TELEGRAM_BOT_TOKEN ?? ""])}`);
    process.exit(1);
  });
  await bridge.run();
  process.exit(0);
}

// Run as a script (the plugin service), not when imported by the tests.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
