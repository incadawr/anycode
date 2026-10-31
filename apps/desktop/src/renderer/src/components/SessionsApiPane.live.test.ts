/**
 * Live-refresh wiring of the Settings → Sessions API pane (node environment, no
 * DOM — the same slot-backed `vi.mock("react")` harness the Composer wiring test
 * uses). The render tests elsewhere hand the presentational view a new object
 * directly; this file drives the CONTAINER, so it pins the behavior the bug was
 * about: the pane re-reads `bridge.get()` while it stays open, and its missing
 * folder marks follow the disk without reopening Settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunicationGetResult, CommunicationView } from "../../../shared/communication-config.js";

interface PaneHarness {
  state: unknown[];
  cursor: number;
  effects: Array<{ fn: () => unknown; deps?: readonly unknown[] }>;
  effectCursor: number;
  pending: Array<() => unknown>;
}

const h = vi.hoisted((): PaneHarness => ({ state: [], cursor: 0, effects: [], effectCursor: 0, pending: [] }));

function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const slot = h.cursor++;
      if (h.state.length <= slot) {
        h.state[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      const set = (next: unknown): void => {
        h.state[slot] = typeof next === "function" ? (next as (prev: unknown) => unknown)(h.state[slot]) : next;
      };
      return [h.state[slot], set];
    },
    useEffect(fn: () => unknown, deps?: readonly unknown[]) {
      const slot = h.effectCursor++;
      const prev = h.effects[slot];
      if (prev !== undefined && sameDeps(prev.deps, deps)) {
        return;
      }
      h.effects[slot] = { fn, deps };
      h.pending.push(fn);
    },
  };
});

const { SessionsApiPane } = await import("./SessionsApiPane.js");
const { SESSIONS_API_REFRESH_MS } = await import("./sessions-api-refresh.js");

const view = (over: Partial<CommunicationView> = {}): CommunicationView => ({
  enabled: true,
  workspaces: [],
  missingWorkspaces: [],
  port: null,
  defaultSessionAccess: "off",
  status: { state: "off", workspaces: 0, sessions: 0 },
  tabs: [],
  agentProjects: [],
  ...over,
});

type PaneElement = { props: { view?: CommunicationView; portText?: string } };

/** Calls the container again with fresh hook slots-per-render but persistent state. */
function render(bridge: unknown): PaneElement {
  h.cursor = 0;
  h.effectCursor = 0;
  return SessionsApiPane({ bridge } as never) as unknown as PaneElement;
}

/** Runs the effects a mount collected, keeping their cleanups. */
function drain(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  while (h.pending.length > 0) {
    const cleanup = h.pending.shift()!();
    if (typeof cleanup === "function") {
      cleanups.push(cleanup);
    }
  }
  return cleanups;
}

function fakeBridge(read: (call: number) => CommunicationGetResult): { get: () => Promise<CommunicationGetResult> } {
  let call = 0;
  return { get: async () => read(call++) };
}

describe("SessionsApiPane live refresh", () => {
  beforeEach(() => {
    h.state = [];
    h.cursor = 0;
    h.effects = [];
    h.effectCursor = 0;
    h.pending = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a folder that disappears while the pane stays open, without reopening Settings", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const bridge = fakeBridge(() => {
      reads += 1;
      return { ok: true, envControlled: false, view: view({ workspaces: ["/gone"], missingWorkspaces: reads === 1 ? [] : ["/gone"] }) };
    });

    render(bridge);
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(render(bridge).props.view?.missingWorkspaces).toEqual([]);

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    expect(render(bridge).props.view?.missingWorkspaces).toEqual(["/gone"]);
  });

  it("clears the mark again when the folder returns, with the pane still open", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const bridge = fakeBridge(() => {
      reads += 1;
      return { ok: true, envControlled: false, view: view({ workspaces: ["/back"], missingWorkspaces: reads === 1 ? ["/back"] : [] }) };
    });

    render(bridge);
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(render(bridge).props.view?.missingWorkspaces).toEqual(["/back"]);

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    expect(render(bridge).props.view?.missingWorkspaces).toEqual([]);
  });

  it("leaves the port field alone on a refresh, so a half-typed port is never overwritten", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const bridge = fakeBridge(() => {
      reads += 1;
      return { ok: true, envControlled: false, view: view({ port: reads === 1 ? 4310 : 5000 }) };
    });

    render(bridge);
    drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(render(bridge).props.portText).toBe("4310");

    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS);
    expect(render(bridge).props.portText).toBe("4310");
    expect(render(bridge).props.view?.port).toBe(5000);
  });

  it("stops reading once the pane unmounts", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async (): Promise<CommunicationGetResult> => ({ ok: true, envControlled: false, view: view() }));

    render({ get });
    const cleanups = drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);

    for (const cleanup of cleanups) {
      cleanup();
    }
    await vi.advanceTimersByTimeAsync(SESSIONS_API_REFRESH_MS * 3);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
