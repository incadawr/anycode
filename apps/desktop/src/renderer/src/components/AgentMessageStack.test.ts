/**
 * GitHub #19 — `AgentMessageStack`, the grouped agent-delivery block.
 *
 * Same jsdom-free discipline as `ToolCallStack.test.ts`: static markup via
 * `renderToStaticMarkup` for the collapsed contract, and a small slot-backed
 * hook harness (`vi.mock("react")`, the repo's established pattern) to drive
 * the real toggle and re-mount into the expanded state. The expanded body
 * renders `ChildReportBlock`s; their own full-payload/status rendering is
 * pinned here through a direct SSR render with `defaultExpanded`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentMessageStackLabel, agentMessageStackLayout, AgentMessageStack } from "./AgentMessageStack.js";
import { ChildReportBlock } from "./ChildReportBlock.js";
import type { AgentMessageBlock } from "./MessageList.js";
import { agentMessageText, type AgentEnvelope } from "../../../shared/communication.js";

const harness = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, ids: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const slot = harness.cursor++;
      if (harness.slots.length <= slot) {
        harness.slots[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      const set = (next: unknown): void => {
        harness.slots[slot] = typeof next === "function" ? (next as (prev: unknown) => unknown)(harness.slots[slot]) : next;
      };
      return [harness.slots[slot], set];
    },
    useId() {
      harness.ids += 1;
      return `stack-id-${harness.ids}`;
    },
  };
});

const envelope = (messageId: string, payload: string): AgentEnvelope => ({
  messageId,
  sender: "authenticated-local-supervisor",
  recipientSessionId: "s",
  payload,
  kind: "agent_message",
  mode: "next_turn",
  createdAt: "2026-10-04",
});

function member(messageId: string, payload: string, state: "queued" | "acknowledged" | "rejected" | "unknown" = "acknowledged"): AgentMessageBlock {
  return {
    kind: "user_text",
    id: `agent-message:${messageId}`,
    origin: "system",
    agentMessage: true,
    agentMessagePayload: payload,
    agentMessageState: state,
    text: `${agentMessageText(envelope(messageId, payload))}\nDelivery: ${state}`,
  };
}

const three = (): AgentMessageBlock[] => [
  member("a", "first message body", "acknowledged"),
  member("b", "second message body", "queued"),
  member("c", "third and newest message body", "rejected"),
];

type AnyElement = { type: unknown; props: Record<string, unknown> };

function isElement(value: unknown): value is AnyElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

function walk(node: unknown, visit: (element: AnyElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}

function findByClass(tree: unknown, className: string): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (typeof element.props.className === "string" && element.props.className.split(" ").includes(className)) {
      found = element;
    }
  });
  return found;
}

function collectByClass(tree: unknown, className: string): AnyElement[] {
  const found: AnyElement[] = [];
  walk(tree, (element) => {
    if (typeof element.props.className === "string" && element.props.className.split(" ").includes(className)) {
      found.push(element);
    }
  });
  return found;
}

/** Invokes the component as a plain function with a fresh slot cursor. */
function mount(blocks: AgentMessageBlock[]): unknown {
  harness.cursor = 0;
  harness.ids = 0;
  return (AgentMessageStack as unknown as (props: { blocks: AgentMessageBlock[] }) => unknown)({ blocks });
}

const renderStatic = (blocks: AgentMessageBlock[]): string =>
  renderToStaticMarkup(createElement(AgentMessageStack, { blocks }));

beforeEach(() => {
  harness.slots = [];
  harness.cursor = 0;
  harness.ids = 0;
});

describe("AgentMessageStack — collapsed (SSR)", () => {
  it("renders the header count and the newest member's one-line preview", () => {
    const html = renderStatic(three());
    expect(html).toContain(agentMessageStackLabel(3));
    expect(html).toContain("3 agent messages");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="agent-message-preview"');
    expect(html).toContain(">third and newest message body</div>");
    // Preview is plain text — no markup interpretation, no member bodies.
    expect(html).not.toContain("agent-message-stack-body");
    expect(html).not.toContain("message-child-report");
  });

  it("keeps exactly one data-block-id and one minimap mark per original message", () => {
    const blocks = three();
    const html = renderStatic(blocks);
    // Head id on the root, tail ids on zero-height in-flow anchors.
    expect(html).toContain('class="agent-message-stack minimap-turn"');
    expect(html).toContain('data-block-id="agent-message:a"');
    expect(collectByClass(mount(blocks), "minimap-turn")).toHaveLength(3);
    const anchors = collectByClass(mount(blocks), "agent-message-stack-anchor");
    expect(anchors.map((anchor) => anchor.props["data-block-id"])).toEqual(["agent-message:b", "agent-message:c"]);
    for (const anchor of anchors) {
      expect(anchor.props["aria-hidden"]).toBe("true");
      expect(anchor.type).toBe("span");
    }
    // The anchors are in-flow zero-height blocks (CSS contract), NOT display:none.
    expect(agentMessageStackLayout(blocks, false)).toEqual({
      rootId: "agent-message:a",
      anchorIds: ["agent-message:b", "agent-message:c"],
      bodyIds: [],
    });
  });

  it("wires the toggle button (aria-controls -> body id, no nested controls)", () => {
    const tree = mount(three());
    const toggle = findByClass(tree, "agent-message-stack-toggle");
    expect(toggle).toBeDefined();
    expect(toggle!.type).toBe("button");
    expect(toggle!.props["aria-expanded"]).toBe(false);
    expect(toggle!.props["aria-controls"]).toEqual(expect.any(String));
  });
});

describe("AgentMessageStack — expanded (slot-backed hook harness)", () => {
  it("a real toggle click expands the group and reveals every member, in order", () => {
    const blocks = three();
    const collapsed = mount(blocks);
    (findByClass(collapsed, "agent-message-stack-toggle")!.props.onClick as () => void)();

    const expanded = mount(blocks);
    const toggle = findByClass(expanded, "agent-message-stack-toggle");
    expect(toggle!.props["aria-expanded"]).toBe(true);
    const body = findByClass(expanded, "agent-message-stack-body");
    expect(body).toBeDefined();
    const members = collectByClass(expanded, "agent-message-stack-body")[0]!.props.children as AnyElement[];
    expect(members.map((element) => element.props.defaultExpanded)).toEqual([true, true, true]);
    expect(members.map((element) => (element.props.block as AgentMessageBlock).id)).toEqual([
      "agent-message:a",
      "agent-message:b",
      "agent-message:c",
    ]);
    // Expanded: no anchors, and the root no longer owns the head id.
    expect(collectByClass(expanded, "agent-message-stack-anchor")).toHaveLength(0);
    expect(agentMessageStackLayout(blocks, true)).toEqual({
      rootId: undefined,
      anchorIds: [],
      bodyIds: ["agent-message:a", "agent-message:b", "agent-message:c"],
    });
  });

  it("toggling twice collapses again", () => {
    const blocks = three();
    mount(blocks);
    (findByClass(mount(blocks), "agent-message-stack-toggle")!.props.onClick as () => void)();
    expect(findByClass(mount(blocks), "agent-message-stack-toggle")!.props["aria-expanded"]).toBe(true);
    (findByClass(mount(blocks), "agent-message-stack-toggle")!.props.onClick as () => void)();
    const collapsed = mount(blocks);
    expect(findByClass(collapsed, "agent-message-stack-toggle")!.props["aria-expanded"]).toBe(false);
    expect(findByClass(collapsed, "agent-message-stack-body")).toBeUndefined();
  });

  it("an expanded member card shows its full payload and its own state label", () => {
    // What the expanded body renders for each member (`defaultExpanded`).
    for (const block of three()) {
      const html = renderToStaticMarkup(createElement(ChildReportBlock, { block, defaultExpanded: true }));
      expect(html).toContain(block.agentMessagePayload!);
      expect(html).toContain(`Agent message · ${block.agentMessageState}`);
      expect(html).toContain('aria-expanded="true"');
    }
  });
});
