/**
 * Test helper (Taskana 4759): a scriptable stand-in for `PreviewCdpLike`. Records
 * every `send`, answers per method from a script (value, function or Error),
 * and lets a test fire CDP events into the listeners the driver registered.
 */

import type { PreviewCdpLike } from "./preview-host.js";

export interface FakeCdpCall {
  method: string;
  params?: object;
}

type Responder = unknown | Error | ((params?: object) => unknown);

export class FakeCdp implements PreviewCdpLike {
  calls: FakeCdpCall[] = [];
  /** Per-method scripted answers; a method without one resolves `{}`. */
  private responders = new Map<string, Responder>();
  private listeners: Array<(method: string, params: unknown) => void> = [];
  attached = true;
  ensureAttachedResult = true;

  respond(method: string, responder: Responder): this {
    this.responders.set(method, responder);
    return this;
  }

  async send(method: string, params?: object): Promise<unknown> {
    this.calls.push({ method, params });
    if (!this.attached && !this.ensureAttachedResult) {
      throw new Error("debugger unavailable (DevTools open on this preview, or the page process is gone)");
    }
    const responder = this.responders.get(method);
    if (responder instanceof Error) {
      throw responder;
    }
    if (typeof responder === "function") {
      return (responder as (p?: object) => unknown)(params);
    }
    return responder ?? {};
  }

  onEvent(listener: (method: string, params: unknown) => void): void {
    this.listeners.push(listener);
  }

  ensureAttached(): boolean {
    if (!this.attached && this.ensureAttachedResult) {
      this.attached = true;
    }
    return this.attached;
  }

  /** Test driver: deliver a CDP event (e.g. `Page.frameNavigated`) to every listener. */
  fire(method: string, params: unknown = {}): void {
    for (const listener of this.listeners) {
      listener(method, params);
    }
  }

  /** Methods sent so far, in order (handy for "no mouse event was sent" assertions). */
  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

export function fakeCdp(): FakeCdp {
  return new FakeCdp();
}
