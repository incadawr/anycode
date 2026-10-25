/**
 * parseMcpSecretsEnv (Taskana 4752, part C): the host-side resolver built from the
 * ANYCODE_MCP_SECRETS value main handed over. Pure; no env, no fs.
 */
import { describe, expect, it } from "vitest";
import { parseMcpSecretsEnv } from "./mcp-secrets.js";

describe("parseMcpSecretsEnv (Taskana 4752, part C)", () => {
  it("resolves the names present in a well-formed object", () => {
    const resolve = parseMcpSecretsEnv('{"GH_TOKEN":"ghp_value_1","OTHER":"o-value"}');
    expect(resolve("GH_TOKEN")).toBe("ghp_value_1");
    expect(resolve("OTHER")).toBe("o-value");
  });

  it("returns undefined for a name that is not in the object", () => {
    expect(parseMcpSecretsEnv('{"A":"a-value"}')("B")).toBeUndefined();
  });

  it("C-21: bad JSON => a resolver that resolves nothing (never throws)", () => {
    const resolve = parseMcpSecretsEnv("{not json");
    expect(resolve("A")).toBeUndefined();
  });

  it("C-21: a non-object JSON value (array, string, null, number) resolves nothing", () => {
    for (const raw of ['["x"]', '"s"', "null", "42"]) {
      expect(parseMcpSecretsEnv(raw)("A")).toBeUndefined();
    }
  });

  it("C-21: an undefined or empty raw value resolves nothing", () => {
    expect(parseMcpSecretsEnv(undefined)("A")).toBeUndefined();
    expect(parseMcpSecretsEnv("")("A")).toBeUndefined();
  });

  it("drops non-string values inside an otherwise valid object", () => {
    const resolve = parseMcpSecretsEnv('{"A":123,"B":"b-value","C":{"x":1}}');
    expect(resolve("A")).toBeUndefined();
    expect(resolve("C")).toBeUndefined();
    expect(resolve("B")).toBe("b-value");
  });

  it("C-10: __proto__ and constructor are never resolved, even though Object.prototype has them", () => {
    const resolve = parseMcpSecretsEnv('{"A":"a-value"}');
    expect(resolve("__proto__")).toBeUndefined();
    expect(resolve("constructor")).toBeUndefined();
    expect(resolve("toString")).toBeUndefined();
    const withJsonProto = parseMcpSecretsEnv('{"__proto__":"p-value"}');
    expect(withJsonProto("constructor")).toBeUndefined();
    expect(withJsonProto("hasOwnProperty")).toBeUndefined();
  });

  it("refuses a name that does not match the secret-name shape", () => {
    const resolve = parseMcpSecretsEnv('{"a-b":"x-value","1x":"y-value","OK":"ok-value"}');
    expect(resolve("a-b")).toBeUndefined();
    expect(resolve("1x")).toBeUndefined();
    expect(resolve("OK")).toBe("ok-value");
  });
});

import { takeMcpSecretsEnv } from "./mcp-secrets.js";

describe("takeMcpSecretsEnv — read once, delete before any child (Taskana 4752, C-20)", () => {
  it("C-20: returns a resolver for the value and removes ANYCODE_MCP_SECRETS from the env in the same step", () => {
    const env: NodeJS.ProcessEnv = { ANYCODE_MCP_SECRETS: '{"GH":"ghp_taken_value"}', PATH: "/bin" };
    const resolve = takeMcpSecretsEnv(env);
    expect(env.ANYCODE_MCP_SECRETS).toBeUndefined();
    expect("ANYCODE_MCP_SECRETS" in env).toBe(false);
    expect(env.PATH).toBe("/bin");
    expect(resolve("GH")).toBe("ghp_taken_value");
  });

  it("C-20: an env without the var yields a resolver that resolves nothing, and still no var", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    expect(takeMcpSecretsEnv(env)("GH")).toBeUndefined();
    expect("ANYCODE_MCP_SECRETS" in env).toBe(false);
  });

  it("C-20: a child env built after the take cannot contain the value", () => {
    const env: NodeJS.ProcessEnv = { ANYCODE_MCP_SECRETS: '{"GH":"ghp_child_check"}', PATH: "/bin" };
    takeMcpSecretsEnv(env);
    const childEnv = { ...env };
    expect(JSON.stringify(childEnv)).not.toContain("ghp_child_check");
  });
});
