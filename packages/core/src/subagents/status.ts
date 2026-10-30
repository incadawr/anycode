import { scrubApprovalText } from "../utils/scrub-approval-text.js";
import { sanitizeAndCap } from "./summarize-tool.js";

/** A bounded, session-owned view of child activity. */
export type ChildStatusItem = { kind: "assistant" | "tool" | "result"; text: string };
export type ChildStatusState = "running" | "waiting for approval" | "completed" | "failed";
export interface ChildStatus {
  id: string;
  handle?: string;
  description: string;
  state: ChildStatusState;
  startedAt: number;
  endedAt?: number;
  turns: number;
  toolCalls: number;
  currentTool?: string;
  tail: ChildStatusItem[];
}

// Status snapshots can contain model-authored credentials. Scrub before truncation.
export function sanitizeStatusText(text: string, maxChars = CHILD_STATUS_TEXT_MAX, tail = false): string {
  const cleaned = scrubApprovalText(text);
  if (!tail) return sanitizeAndCap(cleaned, maxChars);
  const flat = sanitizeAndCap(cleaned, Number.MAX_SAFE_INTEGER);
  const chars = Array.from(flat);
  return chars.length <= maxChars ? flat : "…" + chars.slice(-(maxChars - 1)).join("");
}

const MAX_CHILDREN = 64;
const MAX_ITEMS = 8;
export const CHILD_STATUS_TEXT_MAX = 160;

export function createChildStatusStore() {
  const children = new Map<string, ChildStatus>();
  let discarded = 0;
  return {
    start(id: string, description: string, handle?: string): void {
      if (children.has(id)) children.delete(id);
      // Prefer retaining live children over old terminal records.
      if (children.size >= MAX_CHILDREN) {
        const oldest = [...children.values()].find((c) => c.state === "completed" || c.state === "failed") ?? children.values().next().value;
        if (oldest) { children.delete(oldest.id); discarded += 1; }
      }
      children.set(id, { id, ...(handle ? { handle } : {}), description: sanitizeStatusText(description, 160), state: "running", startedAt: Date.now(), turns: 0, toolCalls: 0, tail: [] });
    },
    update(id: string, patch: Partial<Pick<ChildStatus, "state" | "turns" | "toolCalls" | "currentTool" | "endedAt">>): void {
      const child = children.get(id);
      if (!child) return;
      Object.assign(child, patch);
      if (child.currentTool !== undefined) child.currentTool = sanitizeAndCap(child.currentTool, 80);
    },
    append(id: string, item: ChildStatusItem): void {
      const child = children.get(id);
      if (!child) return;
      const text = sanitizeStatusText(item.text, CHILD_STATUS_TEXT_MAX, item.kind === "assistant");
      if (!text) return;
      // Repeated streaming snapshots replace the current assistant excerpt.
      if (item.kind === "assistant" && child.tail.at(-1)?.kind === "assistant") child.tail.pop();
      child.tail.push({ kind: item.kind, text });
      if (child.tail.length > MAX_ITEMS) child.tail.shift();
    },
    resetAssistant(id: string): void {
      const child = children.get(id);
      if (child?.tail.at(-1)?.kind === "assistant") child.tail.pop();
    },
    discarded(): number { return discarded; },
    list(): ChildStatus[] { return [...children.values()].map(copy); },
    get(id: string): ChildStatus | undefined {
      const child = children.get(id) ?? [...children.values()].find((c) => c.handle === id);
      return child ? copy(child) : undefined;
    },
  };
}
function copy(child: ChildStatus): ChildStatus { return { ...child, tail: child.tail.map((item) => ({ ...item })) }; }
export type ChildStatusStore = ReturnType<typeof createChildStatusStore>;

// The runner port belongs to one parent loop. Never consult a global session registry.
const inlineStores = new WeakMap<object, ChildStatusStore>();
export function inlineChildStatusStore(port: object): ChildStatusStore {
  let store = inlineStores.get(port);
  if (!store) { store = createChildStatusStore(); inlineStores.set(port, store); }
  return store;
}
