import { expect, it } from "vitest";
import { loadEnvConfig } from "../provider/env.js";
import { createListConnectionsTool } from "../tools/list-connections.js";
import type { ToolContext } from "../types/tools.js";
import { cliConnectionTargets } from "./connection-targets.js";

it("exposes the configured CLI endpoint without credentials or URLs", async () => {
  const config = loadEnvConfig({ ANYCODE_API_KEY: "fake-cli-key", ANYCODE_BASE_URL: "https://fake-user:fake-password@example.test", ANYCODE_MODEL: "local-model", ANYCODE_TRANSPORT: "openai-chat-completions" });
  const tool = createListConnectionsTool(() => cliConnectionTargets(config, undefined, "openai-chat-completions", "local-model"));
  const result = await tool.handler({}, {} as ToolContext);
  expect(result).toMatchObject({ ok: true, output: { current: { connectionId: "cli", model: "local-model" }, connections: [{ id: "cli", providerId: "custom", models: [{ id: "local-model", default: true }] }] } });
  const text = JSON.stringify(result);
  for (const secret of ["fake-cli-key", "fake-user", "fake-password", "example.test"]) expect(text).not.toContain(secret);
});
