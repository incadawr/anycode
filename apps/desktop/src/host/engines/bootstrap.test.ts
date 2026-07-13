import { describe, expect, it, vi } from "vitest";
import { beginEngineBootstrap } from "./bootstrap.js";
import { selectEnginePlugin } from "./registry.js";

describe("engine bootstrap boundary", () => {
  it("selects the static Codex bootstrap before any AnyCode provider configuration is needed", async () => {
    const plugin = selectEnginePlugin({ ANYCODE_ENGINE: "codex" });

    await expect(beginEngineBootstrap(plugin)).resolves.toMatchObject({ id: "codex" });
  });

  it("owns an adopted init resource even if Session construction never happens", async () => {
    const bootstrap = await beginEngineBootstrap(selectEnginePlugin({}));
    const dispose = vi.fn(async () => {});

    bootstrap.adopt(dispose);
    await bootstrap.dispose();
    await bootstrap.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown engine before core boot can begin", () => {
    expect(() => selectEnginePlugin({ ANYCODE_ENGINE: "unreviewed" })).toThrow("Unknown session engine");
  });
});
