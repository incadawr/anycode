/**
 * Pure rules for the Telegram remote-control bridge (Taskana 4751). No I/O and
 * no imports beyond Node built-ins, so each rule is unit-tested in isolation.
 * service.mjs wires these to Telegram and to the AnyCode Sessions API.
 */

/** Telegram accepts 4096 characters per message; keep a margin. */
export const TELEGRAM_CHUNK_LIMIT = 4000;
/** Room for a "(i/n)\n" header (n < 100) inside the chunk limit. */
const HEADER_RESERVE = 12;
/** Largest message `send_message` accepts (Sessions API payload cap). */
export const SESSION_PAYLOAD_MAX = 32000;
export const SESSIONS_LIST_MAX = 30;
export const DEFAULT_MAX_REPLY_CHARS = 16000;

/**
 * Parses TELEGRAM_ALLOWED_USERS: comma or space separated positive integers.
 * Anything else is dropped. An empty result means fail closed.
 */
export function parseAllowlist(raw) {
  const ids = new Set();
  for (const token of String(raw ?? "").split(/[\s,]+/)) {
    if (!/^[1-9][0-9]{0,15}$/.test(token)) continue;
    const id = Number(token);
    if (Number.isSafeInteger(id)) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

export function isAllowed(allowlist, userId) {
  return typeof userId === "number" && allowlist.includes(userId);
}

/** TELEGRAM_MAX_REPLY_CHARS: default 16000, clamped to 1000..60000. */
export function clampMaxReply(raw) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return DEFAULT_MAX_REPLY_CHARS;
  return Math.min(60000, Math.max(1000, value));
}

const KNOWN_COMMANDS = new Set(["start", "help", "sessions", "use", "steer", "status"]);

/**
 * Splits an incoming text into a plain message or a command. Commands are
 * case-insensitive and may carry a `@BotName` suffix. Unknown commands and
 * malformed ones answer with the help text.
 */
export function parseCommand(input) {
  const text = String(input ?? "").trim();
  if (!text.startsWith("/")) return { kind: "text", text };
  const match = /^\/([A-Za-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { kind: "command", name: "help", args: "" };
  const name = match[1].toLowerCase();
  return { kind: "command", name: KNOWN_COMMANDS.has(name) ? name : "help", args: (match[2] ?? "").trim() };
}

/**
 * Screens one Telegram update BEFORE any parsing. Only a private message whose
 * sender is the chat owner and is on the allowlist passes. Everything else is
 * dropped; `senderId` is set only for a private non-allowlisted sender so the
 * caller can rate-limit its one log line.
 */
export function screenUpdate(update, allowlist) {
  if (!update || typeof update !== "object" || typeof update.update_id !== "number") return { drop: "invalid" };
  if (!("message" in update)) return { drop: "not_message" };
  const message = update.message;
  const from = message?.from;
  const chat = message?.chat;
  if (!from || !chat || typeof from !== "object" || typeof chat !== "object") return { drop: "not_message" };
  if (from.is_bot === true) return { drop: "bot" };
  if (chat.type !== "private" || chat.id !== from.id) return { drop: "not_private" };
  if (!isAllowed(allowlist, from.id)) return { drop: "not_allowlisted", senderId: from.id };
  return { message };
}

/**
 * Splits text into Telegram-sized chunks. Text that fits is one chunk with no
 * header. Longer text is split at the last blank line, newline or space in the
 * final 20 % of the window, else cut hard, never inside a surrogate pair. Each
 * chunk is numbered "(i/n)" and stays within `limit`, header included.
 */
export function chunkText(input, limit = TELEGRAM_CHUNK_LIMIT) {
  const text = String(input ?? "");
  if (text.trim() === "") return [];
  if (text.length <= limit) return [text];
  const pieces = splitBody(text, limit - HEADER_RESERVE);
  return pieces.map((piece, index) => `(${index + 1}/${pieces.length})\n${piece}`);
}

function splitBody(text, budget) {
  const out = [];
  let rest = text;
  while (rest.length > budget) {
    const cut = cutPoint(rest, budget);
    const piece = rest.slice(0, cut).replace(/\s+$/, "");
    rest = rest.slice(cut).replace(/^\s+/, "");
    if (piece !== "") out.push(piece);
  }
  if (rest.trim() !== "") out.push(rest);
  return out;
}

function cutPoint(rest, budget) {
  const floor = Math.floor(budget * 0.8);
  for (const separator of ["\n\n", "\n", " "]) {
    const at = rest.lastIndexOf(separator, budget - separator.length);
    if (at >= floor && at > 0) return at + separator.length;
  }
  let cut = budget;
  const code = rest.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // keep a surrogate pair whole
  return cut > 0 ? cut : budget;
}

/**
 * Caps an answer at `maxChars`. The cut leaves room for a notice, so the
 * result is never longer than `maxChars`.
 */
export function applyReplyCap(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return { text: value, truncated: 0 };
  const notice = (count) => `\n\n[truncated ${count} characters; read the rest in AnyCode]`;
  let cut = maxChars - notice(value.length).length;
  const code = value.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  const removed = value.length - cut;
  return { text: value.slice(0, cut).replace(/\s+$/, "") + notice(removed), truncated: removed };
}

/**
 * Removes secrets from any text before it is logged, replied or thrown: the
 * given literal values, 64-hex strings (Sessions API tokens), `Bearer` tokens
 * and Telegram-shaped bot tokens.
 */
export function redact(input, secrets = []) {
  let out = String(input ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 6) out = out.split(secret).join("***");
  }
  // Exactly 64 hex characters (a Sessions API token); longer hex runs are ordinary text.
  out = out.replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "***");
  out = out.replace(/Bearer\s+\S+/gi, "***");
  // No leading \b: a bot token sits right after `bot` in the URL path (`/bot123:...`).
  out = out.replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, "***");
  return out;
}

/** The label a user sees for a session: its handle, else the first 8 characters of its id. */
export function sessionLabel(session) {
  return typeof session.handle === "string" && session.handle !== "" ? session.handle : String(session.sessionId).slice(0, 8);
}

/** Last path segment of a workspace (never the full path). */
export function folderName(workspace) {
  const parts = String(workspace ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "?";
}

/** `/sessions` text: one numbered line per session, at most SESSIONS_LIST_MAX lines. */
export function renderSessions(sessions, selectedId) {
  if (sessions.length === 0) {
    return "No shared sessions. In AnyCode, switch on the Sessions API row in the tab's environment menu.";
  }
  const lines = sessions.slice(0, SESSIONS_LIST_MAX).map((session, index) => {
    const mark = session.sessionId === selectedId ? " [selected]" : "";
    return `${index + 1}. ${sessionLabel(session)} — ${session.state ?? "?"} — ${folderName(session.workspace)}${mark}`;
  });
  if (sessions.length > SESSIONS_LIST_MAX) lines.push(`…and ${sessions.length - SESSIONS_LIST_MAX} more`);
  return lines.join("\n");
}

/**
 * Resolves a `/use` argument against a fresh session list: exact handle, exact
 * session id, a unique id prefix of at least 6 characters, then a number from the
 * last `/sessions` (`numbered` is that list of session ids, or undefined when expired).
 */
export function resolveSession(sessions, query, numbered) {
  const q = String(query ?? "").trim();
  const byHandle = sessions.filter((session) => session.handle === q);
  if (byHandle.length === 1) return { session: byHandle[0] };
  const byId = sessions.find((session) => session.sessionId === q);
  if (byId) return { session: byId };
  if (q.length >= 6) {
    const prefixed = sessions.filter((session) => String(session.sessionId).startsWith(q));
    if (prefixed.length === 1) return { session: prefixed[0] };
    if (prefixed.length > 1) return { error: "ambiguous" };
  }
  if (/^[0-9]+$/.test(q) && numbered !== undefined) {
    const id = numbered[Number(q) - 1];
    const session = id === undefined ? undefined : sessions.find((candidate) => candidate.sessionId === id);
    if (session) return { session };
  }
  return { error: "none" };
}

/** Conflict ladder 5, 10, 20, 40, 60 s (cap 60). Offline ladder 1, 2, 4 ... 30 s (cap 30). Exact values. */
export function nextBackoff(kind, attempt) {
  const step = Math.max(0, attempt);
  if (kind === "conflict") return Math.min(5000 * 2 ** step, 60000);
  return Math.min(1000 * 2 ** step, 30000);
}

/** Spreads a delay by +-20 % using `random` in [0, 1). */
export function jitter(ms, random) {
  return Math.round(ms * (0.8 + 0.4 * random));
}

/**
 * Maps a Telegram HTTP status and body to what the bridge does next.
 * `conflict` means another poller or a webhook holds this bot token.
 */
export function classifyTelegramError(status, body) {
  const description = String(body?.description ?? "");
  const lower = description.toLowerCase();
  if (status === 409) return { kind: "conflict", webhook: lower.includes("webhook") };
  if (status === 401 || status === 404) return { kind: "token_invalid" };
  if (status === 429) return { kind: "rate_limited", retryAfter: Number(body?.parameters?.retry_after) || 1 };
  if (status === 403) return { kind: "blocked" };
  if (status === 400 && lower.includes("message is too long")) return { kind: "too_long" };
  if (status >= 500) return { kind: "server" };
  return { kind: "client", description };
}

export const HELP_TEXT = [
  "AnyCode remote control",
  "/sessions — list shared sessions",
  "/use <name|id|number> — choose a session",
  "/steer <text> — add to the running turn (Codex only)",
  "/status — session and bridge status",
  "/help — this list",
  "Any other text starts a new turn in the selected session.",
].join("\n");

export const API_OFF_TEXT = "AnyCode Sessions API is off. Enable it in Settings -> Sessions API.";
export const UNREACHABLE_TEXT = "AnyCode is not reachable right now.";
