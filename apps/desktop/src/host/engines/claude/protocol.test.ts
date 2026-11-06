import { expect, it } from "vitest";
import { buildControlRequest, buildFlagSettings } from "./protocol.js";

it.each([undefined, "high", "xhigh"])("builds a settings object for effort %s", (effort) => {
  const request = buildControlRequest("effort", "apply_flag_settings", buildFlagSettings(effort));
  expect(request.request).toEqual({ subtype: "apply_flag_settings", settings: effort === undefined ? {} : { effortLevel: effort } });
  expect(JSON.parse(JSON.stringify(request)).request.settings).toBeTypeOf("object");
});
