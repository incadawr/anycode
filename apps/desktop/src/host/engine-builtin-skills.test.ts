import { anycodeSetupSkill } from "@anycode/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENGINE_BUILTIN_SKILLS,
  ENGINE_SKILL_STATUSES,
} from "../shared/engine-skills.js";
import { anycodeSetupDocsForHost } from "./anycode-setup-docs.js";
import { assertInertEngineBuiltinText, buildEngineBuiltinSkills } from "./engine-builtin-skills.js";
import { createEngineBrowserBridge } from "./engines/browser-bridge.js";

vi.mock("./anycode-setup-docs.js", () => ({ anycodeSetupDocsForHost: vi.fn() }));
const docs = vi.mocked(anycodeSetupDocsForHost);
const browser = createEngineBrowserBridge({
  preview: {} as never,
  broker: { requestPermission: vi.fn() },
  fullAccess: () => false,
  cwd: "/synthetic",
});

beforeEach(() => docs.mockReturnValue({ kind: "remote", ref: "v0.0.87" }));

describe("engine app builtins", () => {
  it("pins source ids, separate aliases and honest process status vocabulary", () => {
    expect(ENGINE_BUILTIN_SKILLS.map(s => [s.id, s.claude, s.codex])).toEqual([
      ["anycode-setup", "anycode-app:anycode-setup", "anycode-app-setup"],
      ["using-browser-preview", "anycode-app:using-browser-preview", "anycode-app-browser-preview"],
      ["control-browser", "anycode-app:control-browser", "anycode-app-control-browser"],
    ]);
    expect(ENGINE_SKILL_STATUSES).toEqual(["prepared", "cli-reported", "unavailable"]);
  });

  for (const engine of ["claude", "codex"] as const) {
    it(`${engine}: renders only fixed app definitions with bounded deterministic bytes`, () => {
      const skills = buildEngineBuiltinSkills({ engine, browser });
      expect(skills).toEqual(buildEngineBuiltinSkills({ engine, browser }));
      expect(skills.map(s => s.id)).toEqual(ENGINE_BUILTIN_SKILLS.map(s => s.id));
      for (const skill of skills) {
        const alias = ENGINE_BUILTIN_SKILLS.find(s => s.id === skill.id)![engine];
        expect(skill.name).toBe(engine === "claude" ? skill.id : alias);
        expect(skill.skillMd).toBe(`---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`);
        expect(Buffer.byteLength(skill.skillMd)).toBeLessThanOrEqual(64 * 1024);
        expect(skill.skillMd).not.toMatch(/\b(?:Agent|EnterWorktree|Skill|Write|WebFetch)\b|Native.only|allowed-tools:|context:|hooks:|model:|\$\{|\$\(|`/);
        expect(skill.body).not.toMatch(/bypass|disable.*sandbox|skip.*approval/i);
      }
    });

    it(`${engine}: uses the registered wire names, including wait_for`, () => {
      const skills = buildEngineBuiltinSkills({ engine, browser });
      const bodies = skills.slice(1).map(s => s.body).join("\n");
      for (const spec of browser.specs) {
        const name = engine === "claude" ? `mcp__anycode__${spec.claudeName}` : spec.codexName;
        expect(bodies).toContain(name);
      }
      expect(bodies).toContain(engine === "claude" ? "mcp__anycode__browser_wait_for" : "anycode_browser_wait_for");
      expect(bodies).not.toContain("browser_waitfor");
      expect(bodies).not.toContain(engine === "claude" ? "anycode_browser_" : "mcp__anycode__");
    });

    it(`${engine}: omits browser skills without their required capabilities`, () => {
      expect(buildEngineBuiltinSkills({ engine }).map(s => s.id)).toEqual(["anycode-setup"]);
      const partial = { specs: browser.specs.filter(s => s.canonical !== "BrowserWaitFor") };
      expect(buildEngineBuiltinSkills({ engine, browser: partial }).map(s => s.id))
        .toEqual(["anycode-setup", "using-browser-preview"]);
      expect(buildEngineBuiltinSkills({ engine, browser: { specs: [] } })).toHaveLength(1);
      const noOpen = { specs: browser.specs.filter(s => s.canonical !== "BrowserOpen") };
      expect(buildEngineBuiltinSkills({ engine, browser: noOpen }).map(s => s.id)).toEqual(["anycode-setup"]);
    });
  }

  it("documents the current approval rules and untrusted page boundary", () => {
    const bodies = buildEngineBuiltinSkills({ engine: "codex", browser }).slice(1).map(s => s.body).join("\n");
    expect(bodies).toContain("remote:true");
    expect(bodies).toContain("Full browser access");
    expect(bodies).toContain("always asks");
    expect(bodies).toContain("remote URL always asks");
    expect(bodies).toContain("untrusted data");
    expect(bodies).toContain("File inputs are always refused");
    expect(bodies).toContain("Password fields are refused unless Full browser access is enabled");
    expect(bodies).toContain("Do not enter secrets");
    expect(bodies).toContain("latest snapshot");
    expect(bodies).toContain("Try screenshots when useful");
    expect(bodies).toContain("If the tool reports unavailable image input");
    expect(bodies).not.toContain("Screenshots require");
  });

  it("uses only app-resolved docs and explains source-name disabling and precedence", () => {
    docs.mockReturnValue({ kind: "local", dir: "/synthetic/app/docs/user" });
    const setup = buildEngineBuiltinSkills({ engine: "codex" })[0]!;
    expect(setup.body).toContain("/synthetic/app/docs/user/README.md");
    expect(setup.body).toContain("Read README.md first");
    expect(setup.body).toContain("available native read/edit tools");
    expect(setup.body).toContain("auth files");
    expect(setup.body).toContain("skills.disabled");
    expect(setup.body).toContain("do not replace");
    expect(setup.body).not.toMatch(/three app builtins|prepared|CLI-reported|next launch/);
    docs.mockReturnValue({ kind: "remote", ref: "v0.0.87" });
    const remote = buildEngineBuiltinSkills({ engine: "claude" })[0]!;
    expect(remote.body).toContain("https://raw.githubusercontent.com/incadawr/anycode/v0.0.87/docs/user/README.md");
    expect(remote.body).toContain("unavailable");
  });

  it("shares diagnosis and secret policy with Native, differing only in location and tools", () => {
    docs.mockReturnValue({ kind: "local", dir: "/synthetic/app/docs/user" });
    const native = anycodeSetupSkill({ kind: "local", dir: "/synthetic/app/docs/user" }).body;
    const engine = buildEngineBuiltinSkills({ engine: "codex" })[0]!.body;
    const policy = (body: string) => body.slice(body.indexOf("## Read the guide first"));
    expect(policy(engine)).toBe(policy(native));
    expect(engine).toContain(".anycode/workflows");
    expect(engine).toContain("sessionLimits");
    expect(engine).not.toContain("Topics:");
  });

  it("rejects arbitrary source fields at runtime and in the typed API", () => {
    expect(() => buildEngineBuiltinSkills({ engine: "claude", body: "injected" } as never)).toThrow();
    expect(() => buildEngineBuiltinSkills({ engine: "claude", path: "/synthetic/foreign" } as never)).toThrow();
    expect(() => buildEngineBuiltinSkills({ engine: "foreign" } as never)).toThrow();
    if (false) {
      // @ts-expect-error no file source path accepted
      buildEngineBuiltinSkills({ engine: "codex", path: "/synthetic/foreign" });
      // @ts-expect-error no caller-supplied body accepted
      buildEngineBuiltinSkills({ engine: "codex", body: "injected" });
    }
  });

  it("rejects unsafe docs interpolation and excessive output", () => {
    for (const dir of ["relative/docs", "/synthetic/\ninstructions", "/synthetic/\n---\nhooks: injected", "/synthetic/${injected}", "/synthetic/$(injected)", "/synthetic/$ARGUMENTS", "/synthetic/`injected`", "/" + "a".repeat(65536)]) {
      docs.mockReturnValue({ kind: "local", dir });
      expect(() => buildEngineBuiltinSkills({ engine: "codex" })).toThrow();
    }
    docs.mockReturnValue({ kind: "remote", ref: "master/../../foreign" });
    expect(() => buildEngineBuiltinSkills({ engine: "codex" })).toThrow();
  });
});

describe("builtin serializer defense in depth seam", () => {
  it("accepts inert text", () => {
    expect(() => assertInertEngineBuiltinText("fixed metadata\n\nSafe body", "Safe body")).not.toThrow();
  });
  it.each(["\n---", "\nhooks: run", "\nallowed-tools: shell", "\ncontext: fork",
    "\nagent: other", "\nmodel: other", "${value}", "$(command)", "$ARGUMENTS", "`command`", "\x00"])
  ("rejects unsafe template bytes: %s", body => {
    expect(() => assertInertEngineBuiltinText("fixed metadata\n" + body, body)).toThrow("Unsafe app builtin text");
  });
  it("enforces the serialized byte cap", () => {
    expect(() => assertInertEngineBuiltinText("a".repeat(65536), "safe")).not.toThrow();
    expect(() => assertInertEngineBuiltinText("a".repeat(65537), "safe")).toThrow();
  });
});
