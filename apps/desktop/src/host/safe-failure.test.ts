import { describe, expect, it } from "vitest";
import { classifyEngineFailure } from "./safe-failure.js";
import { sanitizeAgentEvent } from "./serialize.js";

describe("engine error custody", () => {
  it.each([
    ["authentication failed", "auth"], ["rate limit", "rate_limited"],
    ["quota exceeded", "quota"], ["fetch failed", "network"],
    ["transport closed", "engine_connection"], ["context length exceeded", "context_limit"],
    ["unsupported protocol", "engine_protocol"],
  ])("classifies %s without forwarding arbitrary engine text", (text, code) => {
    const error = new Error(`${text} Authorization: Bearer sk-poison http://u:password@proxy`);
    expect(classifyEngineFailure(error).code).toBe(code);
    const wire = sanitizeAgentEvent({ type: "error", error });
    expect(JSON.stringify(wire)).not.toMatch(/sk-poison|password|Authorization/);
    expect(wire.type === "error" && wire.error.code).toBe(code);
  });
});
