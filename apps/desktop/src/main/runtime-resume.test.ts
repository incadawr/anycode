import { describe,expect,it } from "vitest";
import { runtimeResumeIdentity } from "./runtime-resume.js";
describe("durable runtime boot identity", () => {
  it.each(["core","codex","claude"])("chooses the persisted %s engine and model before checking readiness", engine => {
    expect(runtimeResumeIdentity({engineId:engine,model:"saved-model",mode:"plan"})).toEqual({engine,engineModel:"saved-model",enginePreset:"plan",modelOverride:engine === "core" ? "saved-model" : undefined});
  });
  it("keeps old rows core and refuses unknown engines", () => {
    expect(runtimeResumeIdentity({model:"legacy",mode:"build"}).engine).toBe("core");
    expect(() => runtimeResumeIdentity({engineId:"unknown",model:"m",mode:"plan"})).toThrow("Unsupported");
  });
});
