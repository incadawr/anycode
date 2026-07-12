/**
 * Lifecycle owner created before engine-specific boot work. An external engine
 * can register its child disposal handle immediately after spawn, so a later
 * initialize/account/thread failure is cleaned up even when no Session exists.
 */

import type { EnginePlugin } from "./registry.js";

export interface EngineBootstrap {
  readonly id: EnginePlugin["id"];
  /** Idempotently adopts an already-started engine-local resource. */
  adopt(dispose: () => Promise<void>): void;
  dispose(): Promise<void>;
}

class BootstrapScope implements EngineBootstrap {
  private disposer: (() => Promise<void>) | undefined;
  private disposed = false;

  constructor(readonly id: EnginePlugin["id"]) {}

  adopt(dispose: () => Promise<void>): void {
    if (this.disposed) {
      void dispose().catch(() => {});
      return;
    }
    this.disposer = dispose;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const dispose = this.disposer;
    this.disposer = undefined;
    if (dispose === undefined) return;
    try {
      await dispose();
    } catch {
      // Boot cleanup is fail-soft: the host still needs to surface its init
      // error or finish the remaining shutdown stages.
    }
  }
}

/** Probe before provider/core construction; unavailable adapters fail closed. */
export async function beginEngineBootstrap(plugin: EnginePlugin): Promise<EngineBootstrap> {
  const availability = await plugin.probe({});
  if (!availability.available) {
    throw new Error(availability.reason ?? `Engine ${plugin.id} is unavailable`);
  }
  return new BootstrapScope(plugin.id);
}
