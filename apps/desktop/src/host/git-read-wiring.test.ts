import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop Git read wiring", () => {
  it("supplies the read capability to the native core session", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("gitRead: new NodeGitReadAdapter(execAdapter)");
  });
});
