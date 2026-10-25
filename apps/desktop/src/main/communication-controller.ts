/**
 * Live lifecycle of the Sessions API (Taskana 4747). Owns at most ONE running
 * communication server and is driven by the `communication` settings block
 * (or by the legacy env override, which wins and makes the UI read-only).
 *
 * Every mutation (apply, regenerate, dispose) goes through a single promise
 * queue so rapid toggles cannot interleave two servers. A failed start never
 * throws out of the controller: it becomes an `error/start_failed` status with a
 * FIXED-vocabulary detail, and the app keeps running. Neither the status nor the
 * log ever carries the bearer token or the discovery-file contents.
 */
import { startCommunicationServer, type CommunicationManager, type CommunicationServerOptions, type LiveCommunicationConfig } from "./communication-server.js";
import type { CommunicationStatus } from "../shared/communication-config.js";

export type { CommunicationStatus };

export interface CommunicationServerHandle {
  url: string;
  discoveryFile: string;
  close(): Promise<void>;
}

type StartFn = (options: CommunicationServerOptions & ({ configFile: string } | { config: LiveCommunicationConfig })) => Promise<CommunicationServerHandle>;

export interface CommunicationControllerDeps {
  /** The live tab manager, or null before boot wires it. */
  manager(): CommunicationManager | null;
  userData: string;
  logger: { error(message: string): void };
  /** Injected for tests; defaults to the real server. */
  startServer?: StartFn;
  /** The legacy env override (ANYCODE_COMMUNICATION_CONFIG), read once per apply. */
  env(): string | undefined;
  /** Per-session exposure switch (main-owned), consulted on every request. */
  isSessionExposed(sessionId: string): boolean;
  /** Session handle for `list_sessions` (main-owned). */
  handleOf?(sessionId: string): string | undefined;
  /** Number of sessions currently switched on, for the status line. */
  countExposed?(): number;
}

/** The settings-derived input to apply(). */
export interface CommunicationApplyInput {
  enabled: boolean;
  workspaces: string[];
  port?: number;
}

export type CommunicationStartFailureDetail = "port in use" | "folder not found" | "could not start" | "host not ready";

export type CommunicationRegenerateResult = { ok: true; status: CommunicationStatus } | { ok: false; reason: "not_running" | "env_controlled"; status?: CommunicationStatus };

const START_FAILED_LOG = "[main] communication MCP startup failed; check configuration and file permissions";

function classifyStartFailure(error: unknown): CommunicationStartFailureDetail {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") return "port in use";
  if (code === "ENOENT") return "folder not found";
  if (error instanceof Error && error.message === "Communication listener unavailable") return "could not start";
  return "could not start";
}

export function createCommunicationController(deps: CommunicationControllerDeps) {
  const startServer: StartFn = deps.startServer ?? (startCommunicationServer as StartFn);
  let running: CommunicationServerHandle | null = null;
  let mode: "off" | "settings" | "env" = "off";
  let settingsInput: CommunicationApplyInput | null = null;
  let current: CommunicationStatus = { state: "off", workspaces: 0, sessions: 0 };
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  };
  const sessionCount = () => deps.countExposed?.() ?? 0;
  const portOf = (url: string) => Number(new URL(url).port);
  const listening = (state: "listening" | "env", handle: CommunicationServerHandle, workspaces: number): CommunicationStatus =>
    ({ state, url: handle.url, port: portOf(handle.url), workspaces, sessions: sessionCount() });
  const failed = (error: unknown, workspaces: number): CommunicationStatus => {
    deps.logger.error(START_FAILED_LOG);
    return { state: "error", reason: "start_failed", detail: classifyStartFailure(error), workspaces, sessions: sessionCount() };
  };

  async function stopRunning(): Promise<void> {
    const handle = running;
    running = null;
    if (handle) await handle.close();
  }

  async function startSettings(input: CommunicationApplyInput): Promise<CommunicationStatus> {
    const manager = deps.manager();
    if (!manager) return { state: "error", reason: "start_failed", detail: "host not ready", workspaces: input.workspaces.length, sessions: sessionCount() };
    try {
      running = await startServer({
        manager,
        userData: deps.userData,
        config: { workspaces: input.workspaces, port: input.port ?? 0 },
        isSessionExposed: (sessionId) => deps.isSessionExposed(sessionId),
        handleOf: deps.handleOf ? (sessionId) => deps.handleOf?.(sessionId) : undefined,
      });
      mode = "settings";
      return listening("listening", running, input.workspaces.length);
    } catch (error) {
      mode = "off";
      return failed(error, input.workspaces.length);
    }
  }

  async function applyNow(input: CommunicationApplyInput): Promise<CommunicationStatus> {
    const envConfig = deps.env();
    if (envConfig !== undefined && envConfig !== "") {
      if (mode !== "env" || running === null) {
        await stopRunning();
        const manager = deps.manager();
        if (!manager) return failed(new Error("host not ready"), 0);
        try {
          running = await startServer({ manager, userData: deps.userData, configFile: envConfig, handleOf: deps.handleOf ? (sessionId) => deps.handleOf?.(sessionId) : undefined });
          mode = "env";
          current = listening("env", running, 0);
        } catch (error) {
          mode = "off";
          current = failed(error, 0);
        }
      } else {
        current = listening("env", running, 0);
      }
      return current;
    }
    await stopRunning();
    mode = "off";
    settingsInput = input.enabled ? { enabled: true, workspaces: [...input.workspaces], port: input.port } : null;
    if (!input.enabled) {
      current = { state: "off", workspaces: input.workspaces.length, sessions: sessionCount() };
      return current;
    }
    current = await startSettings(input);
    return current;
  }

  return {
    /** Applies the settings block (or the env override) and returns the resulting status. Never throws. */
    apply(input: CommunicationApplyInput): Promise<CommunicationStatus> {
      return enqueue(() => applyNow(input));
    },
    /** New token = close and start again with the same config. Refused in env mode. */
    regenerateToken(): Promise<CommunicationRegenerateResult> {
      return enqueue(async (): Promise<CommunicationRegenerateResult> => {
        if (mode === "env") return { ok: false, reason: "env_controlled" };
        if (running === null || settingsInput === null) return { ok: false, reason: "not_running" };
        await stopRunning();
        current = await startSettings(settingsInput);
        if (current.state !== "listening") return { ok: false, reason: "not_running", status: current };
        return { ok: true, status: current };
      });
    },
    /** Read-only snapshot. Contains no token and no discovery path. */
    status(): CommunicationStatus {
      return { ...current, sessions: sessionCount() };
    },
    /** The discovery file of the running server, for the copied MCP config only. */
    discoveryFile(): string | undefined {
      return running?.discoveryFile;
    },
    /** Closes the running server on quit. Idempotent. */
    dispose(): Promise<void> {
      return enqueue(async () => {
        await stopRunning();
        mode = "off";
        settingsInput = null;
        current = { state: "off", workspaces: 0, sessions: 0 };
      });
    },
  };
}

export type CommunicationController = ReturnType<typeof createCommunicationController>;

/** Projects the persisted `communication` block to the controller's apply input (absent = disabled). */
export function applyInputFromBlock(block: { enabled: boolean; workspaces: string[]; port?: number } | undefined): CommunicationApplyInput {
  if (block === undefined) return { enabled: false, workspaces: [] };
  return { enabled: block.enabled, workspaces: [...block.workspaces], ...(block.port !== undefined ? { port: block.port } : {}) };
}
export { START_FAILED_LOG };
