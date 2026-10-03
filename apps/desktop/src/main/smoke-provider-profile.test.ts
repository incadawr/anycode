import { expect, it } from "vitest";
// @ts-expect-error node harness helper is deliberately JavaScript
import { smokeProviderProfile, activeSmokeConnection } from "../../scripts/smoke-provider-profile.mjs";
import { parseSettings } from "../settings/schema.js";
it("v2 env-credential fixture survives the production schema without migration/reset", () => {
  const provider = smokeProviderProfile("z-ai", "glm-5.3", { credentialFromEnv: true });
  const parsed = parseSettings({ version: 2, provider, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } });
  expect(parsed.settings.provider).toEqual(provider);
  expect(activeSmokeConnection(parsed.settings).model).toBe("glm-5.3");
});
it("vault fixtures preserve the real id and reject an invented connection", () => {
  const sourceSettings = { provider: { connections: [{ id: "conn-existing", providerId: "z-ai", label: "Existing", model: "glm-5.2" }] } };
  expect(smokeProviderProfile("z-ai", "glm-5.3", { sourceSettings }).activeConnectionId).toBe("conn-existing");
  expect(() => smokeProviderProfile("anthropic", "claude-model", { sourceSettings })).toThrow("existing connection ID");
  expect(sourceSettings.provider.connections[0]!.model).toBe("glm-5.2");
});
