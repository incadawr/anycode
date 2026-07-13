import { describe, expect, it } from "vitest";
import { resolveCodexBinary } from "./codex-binary.js";

describe("resolveCodexBinary", () => {
  it("requires an absolute executable POSIX file", () => {
    const fs = { stat: () => ({ isFile: () => true, mode: 0o755 }) };
    expect(resolveCodexBinary("/opt/codex", fs, "darwin")).toEqual({ path: "/opt/codex" });
    expect(resolveCodexBinary("codex", fs, "darwin")).toMatchObject({ path: null, reason: expect.stringContaining("absolute") });
    expect(resolveCodexBinary("/opt/codex", { stat: () => ({ isFile: () => true, mode: 0o644 }) }, "darwin"))
      .toMatchObject({ path: null, reason: expect.stringContaining("executable") });
  });

  it("does not infer POSIX executable bits on Windows", () => {
    const fs = { stat: () => ({ isFile: () => true, mode: 0o644 }) };
    expect(resolveCodexBinary("C:\\Codex\\codex.exe", fs, "win32")).toEqual({ path: "C:\\Codex\\codex.exe" });
  });
});
