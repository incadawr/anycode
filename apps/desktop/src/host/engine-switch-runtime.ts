/** Construction of runtime-owned engine and settings objects without creating a session row. */
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
