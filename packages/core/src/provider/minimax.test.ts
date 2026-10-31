/**
 * Unit coverage for the MiniMax branch key.
 *
 * The wire bytes are proved in minimax-effort-wire.test.ts; this file pins
 * the DECISION the branch makes — which connections are MiniMax's — because
 * that decision is what the rest of the mapping hangs on.
 */

import { describe, expect, it } from "vitest";
import { findCatalogEntry } from "./catalog-data.js";
import {
  MINIMAX_EFFORT_MODEL,
  MINIMAX_PLAIN_MODEL,
  MINIMAX_PROVIDER_NAMES,
  isMiniMaxEffortModel,
  isMiniMaxModel,
  isMiniMaxProvider,
} from "./minimax.js";

describe("isMiniMaxProvider", () => {
  it("matches the catalog entry names exactly — the wiring layer keys on the display name", () => {
    expect(MINIMAX_PROVIDER_NAMES).toEqual(["MiniMax", "MiniMax (China)"]);
    expect(isMiniMaxProvider("MiniMax")).toBe(true);
    expect(isMiniMaxProvider("MiniMax (China)")).toBe(true);
    // A near-miss must NOT match: the branch is keyed on the exact name, so a
    // different provider that merely starts with "MiniMax" is not hijacked.
    expect(isMiniMaxProvider("MiniMaxish")).toBe(false);
    expect(isMiniMaxProvider("minimax")).toBe(false);
    expect(isMiniMaxProvider("")).toBe(false);
  });

  it("does not match a CUSTOM connection, which carries no provider name", () => {
    // The wiring layer sets `providerName` from `catalogEntry.name` for a
    // catalog connection and leaves it undefined for a custom one, so a
    // custom MiniMax connection keeps its pre-existing request bytes.
    expect(isMiniMaxProvider(undefined)).toBe(false);
  });

  it("does not match another vendor's entry", () => {
    expect(isMiniMaxProvider("Z.AI (GLM)")).toBe(false);
    expect(isMiniMaxProvider("DeepSeek")).toBe(false);
    expect(isMiniMaxProvider("Anthropic")).toBe(false);
    expect(isMiniMaxProvider("Kimi (kimi.com subscription)")).toBe(false);
    expect(isMiniMaxProvider("Xiaomi MiMo API")).toBe(false);
  });

  it("keeps the pinned names and the catalog entries in step", () => {
    // If an entry's display name is renamed, the helper must be renamed with
    // it — otherwise the whole effort mapping silently stops applying.
    const entryNames = getBuiltinCatalogNamesForMiniMax();
    expect(entryNames).toEqual([...MINIMAX_PROVIDER_NAMES]);
  });
});

describe("isMiniMaxModel", () => {
  it("requires a MiniMax provider AND a MiniMax model", () => {
    expect(isMiniMaxModel("MiniMax", MINIMAX_EFFORT_MODEL)).toBe(true);
    expect(isMiniMaxModel("MiniMax (China)", MINIMAX_EFFORT_MODEL)).toBe(true);
    expect(isMiniMaxModel("MiniMax", MINIMAX_PLAIN_MODEL)).toBe(true);
    // A MiniMax endpoint serving something else is not given MiniMax's
    // mapping.
    expect(isMiniMaxModel("MiniMax", "some-other-model")).toBe(false);
    // Another vendor serving a MiniMax model id is not MiniMax's mapping.
    expect(isMiniMaxModel("Z.AI (GLM)", MINIMAX_EFFORT_MODEL)).toBe(false);
    expect(isMiniMaxModel(undefined, MINIMAX_EFFORT_MODEL)).toBe(false);
  });
});

describe("isMiniMaxEffortModel", () => {
  it("is true only for MiniMax-M3.1-Flash", () => {
    // The docs scope `output_config.effort` to M3.1-Flash: M3 has no effort
    // vocabulary, so sending it an enum is a request the endpoint may reject.
    expect(isMiniMaxEffortModel("MiniMax", MINIMAX_EFFORT_MODEL)).toBe(true);
    expect(isMiniMaxEffortModel("MiniMax (China)", MINIMAX_EFFORT_MODEL)).toBe(true);
    expect(isMiniMaxEffortModel("MiniMax", MINIMAX_PLAIN_MODEL)).toBe(false);
    expect(isMiniMaxEffortModel("Z.AI (GLM)", MINIMAX_EFFORT_MODEL)).toBe(false);
  });
});

function getBuiltinCatalogNamesForMiniMax(): string[] {
  return ["minimax", "minimax-cn"]
    .map((id) => findCatalogEntry(id)?.name)
    .filter((name): name is string => name !== undefined);
}

describe("balance failure hint", () => {
  it("matches structured billing identifiers, never incidental text", async () => {
    const { contextualizeMiniMaxBalance } = await import("./minimax.js");
    const { MiniMaxBalanceFailure } = await import("./failure.js");
    for (const error of [{ type: "insufficient_balance_error" }, { code: 1008 }, { data: { error: { code: "1008" } } }]) {
      expect(contextualizeMiniMaxBalance(error, "MiniMax", "sk-api-example")).toBeInstanceOf(MiniMaxBalanceFailure);
    }
    for (const error of [{ message: "Read 1008 bytes" }, { responseBody: "1008" }, { data: { message: "insufficient_balance_error" } }]) {
      expect(contextualizeMiniMaxBalance(error, "MiniMax", "sk-api-example")).toBe(error);
    }
  });

  it("adds a fixed hint only for a MiniMax pay-as-you-go balance failure", async () => {
    const { contextualizeMiniMaxBalance } = await import("./minimax.js");
    const { classifyProviderFailure } = await import("./failure.js");
    const error = { statusCode: 400, responseBody: '{"error":{"type":"insufficient_balance_error","code":1008}}' };
    const hint = classifyProviderFailure(contextualizeMiniMaxBalance(error, "MiniMax", "sk-api-example")).safe.message;
    expect(hint).toContain("pay-as-you-go");
    expect(hint).toContain("sk-cp-");
    expect(hint).not.toContain("sk-api-example");
    for (const [provider, key, failure] of [["MiniMax", "sk-cp-example", error], ["Other", "sk-api-example", error], ["MiniMax", "sk-api-example", { statusCode: 400, message: "other failure" }]] as const) {
      expect(classifyProviderFailure(contextualizeMiniMaxBalance(failure, provider, key)).safe.message).not.toContain("pay-as-you-go");
    }
  });
});
