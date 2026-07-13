import { describe, expect, it, vi } from "vitest";
import { ENV_HOST_GENERATION } from "../../../shared/engines.js";
import { readHostProcessOwnership } from "./process-ownership.js";

describe("readHostProcessOwnership", () => {
  it("accepts only a positive main-owned generation", () => {
    const report = vi.fn();
    expect(readHostProcessOwnership({ [ENV_HOST_GENERATION]: "4" }, 123, report)).toMatchObject({ hostPid: 123, generation: 4 });
    expect(readHostProcessOwnership({ [ENV_HOST_GENERATION]: "0" }, 123, report)).toBeNull();
    expect(readHostProcessOwnership({ [ENV_HOST_GENERATION]: "bad" }, 123, report)).toBeNull();
  });
});
