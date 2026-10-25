/**
 * Browser control driver (Taskana 4759, Phase A): accessibility snapshot,
 * ref-based click/type, waitFor and history navigation over the Chromium
 * DevTools protocol. Electron-free: it talks only to the narrow `PreviewCdpLike`
 * surface and to a few callbacks PreviewHost supplies, so every behaviour is
 * unit-tested against `fake-cdp.ts`.
 *
 * Security boundary (see docs/user/browser.md): the driver never enables the
 * Network/Storage CDP domains, so cookies and storage are not reachable from
 * here; password VALUES never leave a snapshot; typing into password and file
 * fields is refused. Policy decisions (who may act on which origin) live in
 * `checkInteractionPolicy`, called by PreviewHost before any action runs.
 */

import type { PreviewCdpLike } from "./preview-host.js";
import type {
  PreviewControlRequest,
  PreviewControlSuccess,
  PreviewControlTarget,
  PreviewResult,
} from "../../shared/preview.js";

export type ControlFailure = Extract<PreviewResult<unknown>, { ok: false }>;
export type ControlResult = PreviewResult<PreviewControlSuccess>;
type ControlErrorKind = NonNullable<ControlFailure["errorKind"]>;

const SNAPSHOT_MAX_NODES = 1_500;
const SNAPSHOT_DEFAULT_CHARS = 30_000;
const SNAPSHOT_HARD_CHARS = 60_000;
const SNAPSHOT_MAX_DEPTH = 8;
const SNAPSHOT_DESCRIBE_BUDGET = 200;
const SNAPSHOT_VALUE_MAX_CHARS = 200;
const SNAPSHOT_NAME_MAX_CHARS = 200;
const HREF_MAX_CHARS = 200;
const TYPE_MAX_CHARS = 10_000;
const TYPE_ECHO_MAX_CHARS = 80;
const CLICK_SETTLE_MS = 1_500;
const NAVIGATION_WAIT_MS = 5_000;
const WAIT_POLL_MS = 250;
const WAIT_DEFAULT_MS = 5_000;
const WAIT_MAX_MS = 30_000;
const SELECTOR_MAX_CHARS = 500;

/** Roles that become a snapshot line (everything else is dropped; its children are still walked). */
const KEPT_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "tab",
  "option",
  "heading",
  "img",
  "statictext",
  "listitem",
  "row",
  "cell",
  "columnheader",
  "dialog",
  "alert",
  "status",
  "iframe",
]);
/** Roles whose accessible name already carries their static text; StaticText children are not repeated. */
const NAMED_ROLES = new Set(["link", "button", "heading", "menuitem", "tab", "option", "listitem", "cell", "columnheader"]);
const DESCRIBE_ROLES = new Set(["textbox", "searchbox", "combobox", "link"]);

/** Chromium's CDP error texts for a backend node id that no longer exists. */
const STALE_NODE_PATTERN = /No node with given id|Could not find node|Node with given id does not belong/i;

const SENSITIVE_LABEL_PATTERN = /pass|secret|token|card|cvv|otp/i;

export const STALE_REF_MESSAGE = (ref: string): string =>
  `ref ${ref} is stale (the page changed). Call BrowserSnapshot again.`;

export interface BrowserControlContext {
  cdp: PreviewCdpLike;
  previewId: string;
  currentUrl(): string;
  /** Bumped by PreviewHost on every main-frame navigation; a ref minted under another epoch is stale. */
  navEpoch(): number;
  /** Waits for the page to settle; "timeout" when it did not within `timeoutMs`. */
  settle(timeoutMs: number): Promise<"ready" | "failed" | "crashed" | "timeout">;
  reload(): Promise<void>;
  goToOffset(offset: -1 | 1): Promise<void>;
  navigationHistory(): { entries: Array<{ url: string; title: string }>; index: number };
  /** Same policy as the main-frame navigation gate (history targets must pass it). */
  isNavigationAllowed(url: string): Promise<boolean>;
  signal: AbortSignal;
}

export interface BrowserControllerOptions {
  clickSettleMs?: number;
  navigationWaitMs?: number;
  waitPollMs?: number;
}

export type InteractionKind = "file" | "localhost" | "remote" | "dom-md" | "unknown";

/**
 * Policy for the actions that touch the page (single source; PreviewHost calls it
 * before any action). OFF-state matrix:
 *   - file / localhost pages: click, type allowed; eval needs approval;
 *   - remote (consented) pages: click, type, eval need approval (`allowRemote`);
 *   - dom-md, unknown: refused.
 * Reading actions (snapshot, waitFor, history navigation) are always allowed on a web page.
 * `fullAccess` (the per-session "Full browser access" switch) allows every
 * http(s) interaction without approval.
 */
export function checkInteractionPolicy(
  action: PreviewControlRequest["action"] | "eval",
  kind: InteractionKind,
  allowRemote: boolean,
  url: string,
  fullAccess = false,
): { allow: true } | { allow: false; errorKind: ControlErrorKind; error: string } {
  if (kind === "dom-md") {
    return {
      allow: false,
      errorKind: "invalid_input",
      error: "this is a markdown preview rendered natively; browser control is not supported",
    };
  }
  if (kind === "unknown") {
    return { allow: false, errorKind: "unavailable", error: "this preview cannot be controlled" };
  }
  if (action !== "click" && action !== "type" && action !== "eval") {
    return { allow: true };
  }
  if (fullAccess) {
    return { allow: true };
  }
  if (kind === "remote" && !allowRemote) {
    return {
      allow: false,
      errorKind: "not_allowed",
      error: `this preview shows a remote origin (${originOf(url)}); the call needs the user's approval. Retry with remote:true so the user is asked.`,
    };
  }
  if (action === "eval" && !allowRemote) {
    return { allow: false, errorKind: "not_allowed", error: "BrowserEval always needs the user's approval" };
  }
  return { allow: true };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function failure(errorKind: ControlErrorKind, error: string): ControlFailure {
  return { ok: false, error, errorKind };
}

function cdpMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStaleNodeError(error: unknown): boolean {
  return STALE_NODE_PATTERN.test(cdpMessage(error));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

function quote(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}

/** Unknown AX property read: `properties[].value.value`. */
interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface RefEntry {
  backendNodeId: number;
  epoch: number;
  label: string;
}

interface SnapshotEntry {
  depth: number;
  role: string;
  name: string;
  backendNodeId?: number;
  value?: string;
  password: boolean;
  checked?: boolean;
  disabled?: boolean;
  level?: number;
  href?: string;
  isIframe: boolean;
}

function axString(node: AxNode, key: string): string {
  const raw = node.properties?.find((p) => p.name === key)?.value?.value;
  return typeof raw === "string" ? raw : "";
}

function axFlag(node: AxNode, key: string): boolean | undefined {
  const raw = node.properties?.find((p) => p.name === key)?.value?.value;
  return typeof raw === "boolean" ? raw : undefined;
}

function axNumber(node: AxNode, key: string): number | undefined {
  const raw = node.properties?.find((p) => p.name === key)?.value?.value;
  return typeof raw === "number" ? raw : undefined;
}

/**
 * One controller per preview record (PreviewHost stores it on the record and
 * calls `invalidate()` on main-frame navigation or debugger detach). Refs are
 * minted from a monotonic counter and map to backend node ids; only the most
 * recent snapshot's map is kept, so an older ref can never alias a newer node.
 */
export class BrowserController {
  private refs = new Map<string, RefEntry>();
  private counter = 0;
  private domainsEnabled = false;
  private readonly clickSettleMs: number;
  private readonly navigationWaitMs: number;
  private readonly waitPollMs: number;

  constructor(options: BrowserControllerOptions = {}) {
    this.clickSettleMs = options.clickSettleMs ?? CLICK_SETTLE_MS;
    this.navigationWaitMs = options.navigationWaitMs ?? NAVIGATION_WAIT_MS;
    this.waitPollMs = options.waitPollMs ?? WAIT_POLL_MS;
  }

  /** Drops every ref and the enabled-domain state (navigation, detach, or close). */
  invalidate(): void {
    this.refs = new Map();
    this.domainsEnabled = false;
  }

  async run(request: PreviewControlRequest, ctx: BrowserControlContext): Promise<ControlResult> {
    switch (request.action) {
      case "snapshot":
        return this.snapshot(request.maxChars, ctx);
      case "click":
        return this.click(request.target, request.doubleClick === true, request.button ?? "left", ctx);
      case "type":
        return this.type(request.target, request.text, request.clear ?? true, request.submit === true, ctx);
      case "waitFor":
        return this.waitFor(request, ctx);
      case "navigate":
        return this.navigateHistory(request.to, ctx);
    }
  }

  // ── domains ──

  private async ensureDomains(ctx: BrowserControlContext): Promise<ControlFailure | undefined> {
    if (this.domainsEnabled) {
      return undefined;
    }
    try {
      await ctx.cdp.send("Page.enable");
      await ctx.cdp.send("DOM.enable");
      await ctx.cdp.send("Accessibility.enable");
      await ctx.cdp.send("Runtime.enable");
    } catch (error) {
      return { ok: false, error: cdpMessage(error), errorKind: "unavailable" };
    }
    this.domainsEnabled = true;
    return undefined;
  }

  // ── snapshot ──

  private async snapshot(maxChars: number | undefined, ctx: BrowserControlContext): Promise<ControlResult> {
    const enableError = await this.ensureDomains(ctx);
    if (enableError) {
      return enableError;
    }
    const charCap = Math.min(maxChars ?? SNAPSHOT_DEFAULT_CHARS, SNAPSHOT_HARD_CHARS);
    let tree: { nodes?: AxNode[] };
    try {
      tree = (await ctx.cdp.send("Accessibility.getFullAXTree", {})) as { nodes?: AxNode[] };
    } catch (error) {
      return failure("unavailable", `could not read the page's accessibility tree: ${cdpMessage(error)}`);
    }
    const nodes = tree.nodes ?? [];
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const entries: SnapshotEntry[] = [];
    const root = nodes[0];
    if (root !== undefined) {
      this.collect(root, 0, false, byId, entries);
    }

    // Refs are minted for entries that actually render (monotonic across snapshots).
    this.refs = new Map();
    const lines: string[] = [];
    let rendered = 0;
    let used = `url: ${ctx.currentUrl()}\n`.length;
    let describeBudget = SNAPSHOT_DESCRIBE_BUDGET;
    let truncatedAt = -1;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (rendered >= SNAPSHOT_MAX_NODES) {
        truncatedAt = index;
        break;
      }
      const details = await this.describe(entry, ctx, () => {
        if (describeBudget <= 0) return false;
        describeBudget -= 1;
        return true;
      });
      const line = this.renderLine(entry, details, ctx.navEpoch());
      if (used + line.length + 1 > charCap) {
        truncatedAt = index;
        break;
      }
      lines.push(line);
      used += line.length + 1;
      rendered += 1;
    }

    const header = `url: ${ctx.currentUrl()}`;
    const body = lines.join("\n");
    let text = body.length > 0 ? `${header}\n${body}` : `${header}\n(no interactive or labelled elements found)`;
    const truncated = truncatedAt >= 0;
    if (truncated) {
      const more = entries.length - truncatedAt;
      text += `\n... truncated: ${more} more nodes; use BrowserSnapshot after scrolling, or a narrower BrowserRead selector`;
    }
    return {
      ok: true,
      value: {
        previewId: ctx.previewId,
        url: ctx.currentUrl(),
        text,
        refs: rendered,
        truncated,
      },
    };
  }

  /** Depth-first walk that keeps KEPT_ROLES entries and skips StaticText already named by its parent. */
  private collect(
    node: AxNode,
    depth: number,
    parentNamed: boolean,
    byId: Map<string, AxNode>,
    out: SnapshotEntry[],
  ): void {
    const role = typeof node.role?.value === "string" ? node.role.value : "";
    const roleKey = role.toLowerCase();
    const name = clip(typeof node.name?.value === "string" ? node.name.value : "", SNAPSHOT_NAME_MAX_CHARS);
    let keptDepth = depth;
    let namedHere = parentNamed;
    const keep =
      node.ignored !== true &&
      KEPT_ROLES.has(roleKey) &&
      !(roleKey === "statictext" && (name.length === 0 || parentNamed)) &&
      !(roleKey === "img" && name.length === 0);
    if (keep) {
      const entry: SnapshotEntry = {
        depth: Math.min(depth, SNAPSHOT_MAX_DEPTH),
        role: roleKey === "statictext" ? "text" : roleKey,
        name,
        ...(node.backendDOMNodeId !== undefined ? { backendNodeId: node.backendDOMNodeId } : {}),
        password: false,
        isIframe: roleKey === "iframe",
      };
      const value = clip(
        typeof node.value?.value === "string" ? node.value.value : axString(node, "value"),
        SNAPSHOT_VALUE_MAX_CHARS,
      );
      if (value.length > 0) {
        entry.value = value;
      }
      const checked = axString(node, "checked");
      if (checked === "true") entry.checked = true;
      if (axFlag(node, "disabled") === true) entry.disabled = true;
      const level = axNumber(node, "level");
      if (level !== undefined) entry.level = level;
      if (axFlag(node, "protected") === true) entry.password = true;
      out.push(entry);
      keptDepth = depth + 1;
      namedHere = NAMED_ROLES.has(roleKey) && name.length > 0;
      if (entry.isIframe) {
        // Iframe contents are out of scope (documented): the iframe is a leaf line.
        return;
      }
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child !== undefined) {
        this.collect(child, keptDepth, namedHere, byId, out);
      }
    }
  }

  /** `DOM.describeNode` for textbox/link entries (budgeted): password detection and the href. */
  private async describe(
    entry: SnapshotEntry,
    ctx: BrowserControlContext,
    takeBudget: () => boolean,
  ): Promise<Map<string, string> | undefined> {
    if (entry.backendNodeId === undefined || !DESCRIBE_ROLES.has(entry.role)) {
      return undefined;
    }
    if (!takeBudget()) {
      return undefined;
    }
    try {
      const response = (await ctx.cdp.send("DOM.describeNode", { backendNodeId: entry.backendNodeId })) as {
        node?: { attributes?: string[] };
      };
      const attrs = new Map<string, string>();
      const raw = response.node?.attributes ?? [];
      for (let i = 0; i + 1 < raw.length; i += 2) {
        attrs.set(raw[i]!.toLowerCase(), raw[i + 1]!);
      }
      return attrs;
    } catch {
      return undefined;
    }
  }

  /** One snapshot line. A ref is minted only for entries that have a backend node to act on. */
  private renderLine(entry: SnapshotEntry, attrs: Map<string, string> | undefined, epoch: number): string {
    const parts: string[] = [];
    if (entry.backendNodeId !== undefined) {
      this.counter += 1;
      const ref = `e${this.counter}`;
      this.refs.set(ref, { backendNodeId: entry.backendNodeId, epoch, label: entry.name || entry.role });
      parts.push(`[${ref}] ${entry.role}`);
    } else {
      parts.push(entry.role);
    }
    if (entry.name.length > 0) {
      parts.push(quote(entry.name));
    }
    const isTextInput = entry.role === "textbox" || entry.role === "searchbox" || entry.role === "combobox";
    if (isTextInput) {
      // Password VALUES never render. Without a describe we cannot tell a
      // password field from a text field, so the value is omitted (fail safe).
      const isPassword = entry.password || (attrs?.get("type") ?? "").toLowerCase() === "password";
      if (isPassword) {
        parts.push("[password, value hidden]");
      } else if (attrs !== undefined && entry.value !== undefined && entry.value.length > 0) {
        parts.push(`value=${quote(entry.value)}`);
      }
    } else if (entry.value !== undefined && entry.value.length > 0 && entry.role !== "text") {
      parts.push(`value=${quote(entry.value)}`);
    }
    if (entry.checked) parts.push("checked");
    if (entry.disabled) parts.push("disabled");
    if (entry.level !== undefined) parts.push(`level=${entry.level}`);
    if (entry.role === "link") {
      const href = attrs?.get("href");
      if (href !== undefined && href.length > 0) {
        parts.push(`-> ${clip(href, HREF_MAX_CHARS)}`);
      }
    }
    return `${"  ".repeat(entry.depth)}${parts.join(" ")}`;
  }

  // ── target resolution ──

  private async resolveRef(ref: string, ctx: BrowserControlContext): Promise<{ backendNodeId: number; label: string } | ControlFailure> {
    const entry = this.refs.get(ref);
    if (entry === undefined || entry.epoch !== ctx.navEpoch()) {
      return { ok: false, error: STALE_REF_MESSAGE(ref), errorKind: "stale_ref" };
    }
    return { backendNodeId: entry.backendNodeId, label: entry.label };
  }

  /** CSS selector on the main document; never pierces shadow roots or iframes. */
  private async resolveSelector(selector: string, ctx: BrowserControlContext): Promise<{ backendNodeId: number; label: string } | ControlFailure> {
    if (selector.length > SELECTOR_MAX_CHARS) {
      return { ok: false, error: "selector is too long", errorKind: "invalid_input" };
    }
    try {
      const doc = (await ctx.cdp.send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
      const found = (await ctx.cdp.send("DOM.querySelectorAll", {
        nodeId: doc.root.nodeId,
        selector,
      })) as { nodeIds: number[] };
      if (found.nodeIds.length === 0) {
        return { ok: false, error: "selector matched nothing", errorKind: "invalid_input" };
      }
      if (found.nodeIds.length > 1) {
        return {
          ok: false,
          error: `selector matched ${found.nodeIds.length} elements; use a ref or a more specific selector`,
          errorKind: "invalid_input",
        };
      }
      const described = (await ctx.cdp.send("DOM.describeNode", { nodeId: found.nodeIds[0] })) as {
        node: { backendNodeId: number };
      };
      return { backendNodeId: described.node.backendNodeId, label: selector };
    } catch (error) {
      return { ok: false, error: `selector failed: ${cdpMessage(error)}`, errorKind: "invalid_input" };
    }
  }

  private async resolveTarget(
    target: PreviewControlTarget,
    ctx: BrowserControlContext,
  ): Promise<{ backendNodeId: number; label: string } | ControlFailure> {
    if ("ref" in target) {
      return this.resolveRef(target.ref, ctx);
    }
    return this.resolveSelector(target.selector, ctx);
  }

  /** Scrolls into view and returns the centre of the visible content quad. */
  private async centreOf(
    backendNodeId: number,
    ref: PreviewControlTarget,
    ctx: BrowserControlContext,
  ): Promise<{ x: number; y: number } | ControlFailure> {
    try {
      await ctx.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch (error) {
      if (isStaleNodeError(error)) {
        return this.staleFor(ref);
      }
      // Scrolling is best-effort; the box check below decides visibility.
    }
    let box: { model?: { content?: number[] } };
    try {
      box = (await ctx.cdp.send("DOM.getBoxModel", { backendNodeId })) as { model?: { content?: number[] } };
    } catch (error) {
      if (isStaleNodeError(error)) {
        return this.staleFor(ref);
      }
      return failure("unavailable", "preview is not visible; open the preview panel");
    }
    const quad = box.model?.content;
    if (quad === undefined || quad.length < 8) {
      return failure("invalid_input", "element is not visible");
    }
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (maxX - minX <= 0 || maxY - minY <= 0) {
      return failure("invalid_input", "element is not visible");
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  private staleFor(target: PreviewControlTarget): ControlFailure {
    const ref = "ref" in target ? target.ref : "the selector target";
    return { ok: false, error: STALE_REF_MESSAGE(ref), errorKind: "stale_ref" };
  }

  // ── click ──

  private async click(
    target: PreviewControlTarget,
    doubleClick: boolean,
    button: "left" | "right",
    ctx: BrowserControlContext,
  ): Promise<ControlResult> {
    const enableError = await this.ensureDomains(ctx);
    if (enableError) {
      return enableError;
    }
    const resolved = await this.resolveTarget(target, ctx);
    if ("ok" in resolved) {
      return resolved;
    }
    const centre = await this.centreOf(resolved.backendNodeId, target, ctx);
    if ("ok" in centre) {
      return centre;
    }
    const epochBefore = ctx.navEpoch();
    try {
      await ctx.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: centre.x, y: centre.y });
      const clickCount = doubleClick ? 2 : 1;
      await ctx.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: centre.x,
        y: centre.y,
        button,
        clickCount,
      });
      await ctx.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: centre.x,
        y: centre.y,
        button,
        clickCount,
      });
    } catch (error) {
      return failure("unavailable", `click failed: ${cdpMessage(error)}`);
    }

    const where = "ref" in target ? `[${target.ref}]` : "selector";
    const report = `clicked ${where} ${quote(resolved.label)}`;
    await this.sleep(this.clickSettleMs);
    if (ctx.navEpoch() === epochBefore) {
      return this.ok(ctx, report, false);
    }
    const settled = await ctx.settle(this.navigationWaitMs);
    if (settled === "failed" || settled === "crashed") {
      return failure("load_failed", "page navigated after the click but failed to load");
    }
    return this.ok(ctx, `${report}; page navigated to ${ctx.currentUrl()}`, true);
  }

  // ── type ──

  private async type(
    target: PreviewControlTarget,
    text: string,
    clear: boolean,
    submit: boolean,
    ctx: BrowserControlContext,
  ): Promise<ControlResult> {
    if (text.length > TYPE_MAX_CHARS) {
      return failure("invalid_input", `text is longer than ${TYPE_MAX_CHARS} characters`);
    }
    const enableError = await this.ensureDomains(ctx);
    if (enableError) {
      return enableError;
    }
    const resolved = await this.resolveTarget(target, ctx);
    if ("ok" in resolved) {
      return resolved;
    }
    let objectId: string | undefined;
    let info: { tag: string; type: string; editable: boolean; readOnly: boolean; disabled: boolean; label: string };
    try {
      const resolvedNode = (await ctx.cdp.send("DOM.resolveNode", { backendNodeId: resolved.backendNodeId })) as {
        object?: { objectId?: string };
      };
      objectId = resolvedNode.object?.objectId;
      if (objectId === undefined) {
        return this.staleFor(target);
      }
      const described = (await ctx.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: DESCRIBE_FIELD_FUNCTION,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const value = described.result?.value as typeof info | undefined;
      if (value === undefined) {
        return failure("invalid_input", "element is not an input, textarea or contenteditable");
      }
      info = value;
    } catch (error) {
      if (isStaleNodeError(error)) {
        return this.staleFor(target);
      }
      return failure("unavailable", `type failed: ${cdpMessage(error)}`);
    }

    if (info.type === "password") {
      return failure("not_allowed", "typing into password fields is not permitted");
    }
    if (info.type === "file") {
      return failure("not_allowed", "typing into file inputs is not permitted");
    }
    if (info.tag !== "input" && info.tag !== "textarea" && !info.editable) {
      return failure("invalid_input", "element is not an input, textarea or contenteditable");
    }
    if (info.disabled) {
      return failure("invalid_input", "element is disabled");
    }
    if (info.readOnly) {
      return failure("invalid_input", "element is read-only");
    }

    const centre = await this.centreOf(resolved.backendNodeId, target, ctx);
    if ("ok" in centre) {
      return centre;
    }
    try {
      await ctx.cdp.send("DOM.focus", { backendNodeId: resolved.backendNodeId });
      if (clear) {
        await ctx.cdp.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: SELECT_ALL_FUNCTION,
          returnByValue: true,
        });
      }
      await ctx.cdp.send("Input.insertText", { text });
      if (submit) {
        await ctx.cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await ctx.cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      }
    } catch (error) {
      return failure("unavailable", `type failed: ${cdpMessage(error)}`);
    }

    const label = info.label.length > 0 ? info.label : resolved.label;
    const echo = SENSITIVE_LABEL_PATTERN.test(label)
      ? `typed ${text.length} chars`
      : `typed ${quote(clip(text, TYPE_ECHO_MAX_CHARS))}`;
    const where = "ref" in target ? `[${target.ref}]` : "selector";
    if (submit) {
      await this.sleep(this.clickSettleMs);
    }
    return this.ok(ctx, `${echo} into ${where} ${quote(label)}${submit ? "; submitted with Enter" : ""}`, false);
  }

  // ── waitFor ──

  private async waitFor(
    request: Extract<PreviewControlRequest, { action: "waitFor" }>,
    ctx: BrowserControlContext,
  ): Promise<ControlResult> {
    if (request.text === undefined && request.selector === undefined) {
      return failure("invalid_input", "at least one of text or selector is required");
    }
    if (request.selector !== undefined && request.selector.length > SELECTOR_MAX_CHARS) {
      return failure("invalid_input", "selector is too long");
    }
    const enableError = await this.ensureDomains(ctx);
    if (enableError) {
      return enableError;
    }
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? WAIT_DEFAULT_MS, 0), WAIT_MAX_MS);
    const gone = request.gone === true;
    const parts: string[] = [];
    if (request.text !== undefined) {
      parts.push(`(document.body ? document.body.innerText : '').includes(${JSON.stringify(request.text)})`);
    }
    if (request.selector !== undefined) {
      parts.push(`!!document.querySelector(${JSON.stringify(request.selector)})`);
    }
    const expression = `(${parts.join(" && ")})`;
    const awaited = [
      request.text !== undefined ? `text ${quote(request.text)}` : undefined,
      request.selector !== undefined ? `selector ${quote(request.selector)}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" and ");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (ctx.signal.aborted) {
        return failure("cancelled", "wait was cancelled");
      }
      let result: { result?: { value?: unknown }; exceptionDetails?: unknown };
      try {
        result = (await ctx.cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as typeof result;
      } catch (error) {
        return failure("unavailable", `wait failed: ${cdpMessage(error)}`);
      }
      if (result.exceptionDetails !== undefined) {
        return failure("invalid_input", "selector is not valid CSS");
      }
      const present = result.result?.value === true;
      if (present !== gone) {
        return this.ok(ctx, `${gone ? "gone" : "found"}: ${awaited}`, false);
      }
      if (Date.now() >= deadline) {
        return failure(
          "timeout",
          `timed out after ${timeoutMs}ms waiting for ${awaited} to be ${gone ? "gone" : "present"}`,
        );
      }
      await this.sleep(Math.min(this.waitPollMs, Math.max(deadline - Date.now(), 0)));
    }
  }

  // ── history ──

  private async navigateHistory(
    to: { history: "back" | "forward" | "reload" } | { url: string },
    ctx: BrowserControlContext,
  ): Promise<ControlResult> {
    if (!("history" in to)) {
      return failure("invalid_input", "navigate by url is handled by the preview host");
    }
    if (to.history === "reload") {
      await ctx.reload();
    } else {
      const history = ctx.navigationHistory();
      const offset = to.history === "back" ? -1 : 1;
      const targetIndex = history.index + offset;
      const entry = history.entries[targetIndex];
      if (targetIndex < 0 || entry === undefined) {
        return failure("invalid_input", `no history entry to go ${to.history}`);
      }
      if (!(await ctx.isNavigationAllowed(entry.url))) {
        return failure("not_allowed", "history target is not an allowed origin");
      }
      await ctx.goToOffset(offset);
    }
    const settled = await ctx.settle(this.navigationWaitMs);
    if (settled === "failed" || settled === "crashed") {
      return failure("load_failed", "the page failed to load after navigating");
    }
    return this.ok(ctx, `navigated ${to.history} to ${ctx.currentUrl()}`, true);
  }

  // ── helpers ──

  private ok(ctx: BrowserControlContext, text: string, navigated: boolean): ControlResult {
    return {
      ok: true,
      value: {
        previewId: ctx.previewId,
        url: ctx.currentUrl(),
        text,
        ...(navigated ? { navigated: true } : {}),
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Evaluated on the element (`this`): field facts only, never its value. */
const DESCRIBE_FIELD_FUNCTION = `function () {
  const el = this;
  const tag = (el.tagName || '').toLowerCase();
  const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
  const label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.id)) || '';
  return {
    tag,
    type,
    editable: !!el.isContentEditable,
    readOnly: !!el.readOnly,
    disabled: !!el.disabled,
    label: String(label).slice(0, 200),
  };
}`;

const SELECT_ALL_FUNCTION = `function () {
  if (typeof this.select === 'function') { this.select(); return true; }
  document.execCommand('selectAll');
  return true;
}`;
