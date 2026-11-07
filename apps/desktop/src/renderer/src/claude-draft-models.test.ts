import { describe, expect, it } from "vitest";
import { CLAUDE_DRAFT_MODELS } from "./claude-draft-models.js";
import { resolveClaudeDraftModel } from "./components/StartScreen.js";
import { pickEngineModels } from "./role-model-options.js";

describe("Claude draft fallback", () => {
  it("offers the current versioned models including Fable before a session starts", () => {
    expect(CLAUDE_DRAFT_MODELS).toEqual([
      { id: "default", label: "Default (recommended)" },
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-opus-5-5", label: "Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    ]);
  });

  it("selects ordinary Opus without requesting the extended context variant", () => {
    const opus = CLAUDE_DRAFT_MODELS.find(model => model.label?.startsWith("Opus"))!;
    expect(resolveClaudeDraftModel(opus.id, CLAUDE_DRAFT_MODELS)).toBe("claude-opus-5-5");
    expect(CLAUDE_DRAFT_MODELS.some(model => model.id.includes("[1m]"))).toBe(false);
    expect(resolveClaudeDraftModel(null, CLAUDE_DRAFT_MODELS)).toBe("");
    expect(resolveClaudeDraftModel("opus[1m]", CLAUDE_DRAFT_MODELS)).toBe("default");
  });

  it("preserves versioned live names when a running session supplies its catalog", () => {
    const live = [{ id: "account-model", label: "Account model 6.0" }];
    expect(pickEngineModels({ id: "claude", model: { current: "account-model", available: live } }, CLAUDE_DRAFT_MODELS, []).claude).toBe(live);
  });
});

it("resolves a full fallback id to the confirmed wire alias before rendering", () => {
  expect(resolveClaudeDraftModel("claude-opus-5-5", [{ id: "default", resolvedId: "claude-opus-5-5" }, { id: "opus", resolvedId: "claude-opus-5-5" }])).toBe("opus");
});

it("prefers the ordinary alias when extended context precedes it", () => {
  expect(resolveClaudeDraftModel("full-opus", [{ id: "opus[1m]", resolvedId: "full-opus" }, { id: "default", resolvedId: "full-opus" }, { id: "opus", resolvedId: "full-opus" }])).toBe("opus");
  expect(resolveClaudeDraftModel(null, [{ id: "opus" }])).toBe("");
});
