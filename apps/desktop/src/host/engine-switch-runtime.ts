/** Construction of runtime-owned engine and settings objects without creating a session row. */
import { beginEngineBootstrap } from "./engines/bootstrap.js";
import { getEnginePlugin } from "./engines/registry.js";
import { CoreEngine, type CoreEngineOptions } from "./engines/core-engine.js";
import { startCodexEngine, type CodexEngineCreateOptions } from "./engines/codex/codex-engine.js";
import { startClaudeEngine, type ClaudeEngineCreateOptions } from "./engines/claude/claude-engine.js";
import { ClaudeSettingsSeam } from "./engines/claude/settings-seam.js";

export function buildCoreRuntime(options: CoreEngineOptions) {
  return { engine: new CoreEngine(options) };
}

export async function buildCodexRuntime(options: CodexEngineCreateOptions) {
  const connected = await startCodexEngine(options);
  return { ...connected, engineSettings: connected.engine };
}

export async function buildClaudeRuntime(options: ClaudeEngineCreateOptions) {
  const connected = await startClaudeEngine(options);
  return { ...connected, engineSettings: new ClaudeSettingsSeam(connected.engine) };
}

/** Trusted host composition, never decoded from renderer messages. */
export type SwitchRuntimeConfig = (
  | { engine: "core"; options: CoreEngineOptions }
  | { engine: "codex"; model: string; options: Omit<CodexEngineCreateOptions, "bootstrap" | "selection"> & { selection?: CodexEngineCreateOptions["selection"] } }
  | { engine: "claude"; model: string; options: Omit<ClaudeEngineCreateOptions, "bootstrap" | "selection"> & { selection?: ClaudeEngineCreateOptions["selection"] } }
) & { cleanup?: () => void };

/**
 * Own the candidate's bootstrap separately from the active runtime. The caller
 * supplies already-resolved host configuration and keeps session services alive.
 */
export async function prepareSwitchRuntime(config: SwitchRuntimeConfig) {
  if (config.engine === "core") return buildCoreRuntime(config.options);
  const plugin = getEnginePlugin(config.engine)!;
  let bootstrap: Awaited<ReturnType<typeof beginEngineBootstrap>> | undefined;
  try {
    bootstrap = await beginEngineBootstrap(plugin);
    const selection = { ...config.options.selection, model: config.model, origin: "draft" as const };
    const runtime = config.engine === "codex"
      ? await buildCodexRuntime({ ...config.options, bootstrap, selection })
      : await buildClaudeRuntime({ ...config.options, bootstrap, selection });
    if (runtime.model !== config.model) {
      await runtime.engine.dispose("session-close");
      throw new Error(`Requested model ${config.model} is unavailable`);
    }
    // Include resolver-owned files in the same candidate lifecycle as its process.
    const dispose = runtime.engine.dispose.bind(runtime.engine);
    let cleaned = false;
    runtime.engine.dispose = async (reason) => {
      try { await dispose(reason); }
      finally {
        if (!cleaned) { cleaned = true; config.cleanup?.(); }
      }
    };
    return runtime;
  } catch (error) {
    await bootstrap?.dispose();
    config.cleanup?.();
    throw error;
  }
}
