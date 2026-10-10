/**
 * TASK.202 guard: the fingerprint (and its new push-side companion
 * `recognizerSecretTargetKey`) must stay vault-free, value-only pure functions
 * — computing "did anything change" must never cost a secret resolution.
 * Two tripwires: (1) a Proxy around the settings document that throws on any
 * trap that is not a plain data read, so a future "just resolve the key here"
 * edit fails loudly the moment it reaches for a vault handle; (2) a mechanical
 * source scan in the spirit of codex-support.drift.test.ts — the module text
 * may not name a vault entry point at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnycodeSettings, CustomProviderRecord, ProviderConnection, SecretKey } from "./settings.js";
import { recognizerFingerprint, recognizerSecretTargetKey } from "./recognizer.js";

function connection(over: Partial<ProviderConnection> = {}): ProviderConnection {
  return { id: "conn-v", providerId: "custom:vision-slug", transport: "openai-chat-completions", ...over };
}

function baseSettings(custom: CustomProviderRecord[], connections: ProviderConnection[], recognizer?: { connectionId: string; modelId: string }): AnycodeSettings {
  return {
    version: 2,
    provider: { connections, custom },
    ...(recognizer === undefined ? {} : { recognizer }),
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

/**
 * Wraps `value` so every proxy trap that would hand out anything beyond a
 * plain read of the object's OWN data (a get of a data property, including the
 * standard array/object methods the module legitimately uses to walk the
 * document — `find`, `startsWith`, `===` comparisons) throws. A vault handle —
 * any OTHER callable — cannot survive a get without tripping this.
 */
function plainDataProxy<T extends object>(value: T, path: string[] = []): T {
  const wrap = (target: object, here: string[]): unknown =>
    new Proxy(target, {
      get(t: object, prop: string | symbol): unknown {
        if (typeof prop === "symbol") {
          throw new Error(`no-vault-read guard: symbol access ${String(prop)} at ${here.join(".")} is not a plain data read`);
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
        // Own data property on a plain object/array: hand out the value (and
        // wrap nested plain objects so the guard follows the whole document).
        if (descriptor !== undefined && "value" in descriptor) {
          const result = descriptor.value as unknown;
          if (result !== null && typeof result === "object") {
            return wrap(result, [...here, prop]);
          }
          if (typeof result === "function") {
            // Standard prototype methods of Array/String the module's own
            // walk uses (`find`, `startsWith`, …) are plain data traversal,
            // not a vault handle — allow-list them by prototype.
            const owner: Record<string, unknown> | null = Array.isArray(t)
              ? (Array.prototype as unknown as Record<string, unknown>)
              : ((Object.getPrototypeOf(t) ?? null) as Record<string, unknown> | null);
            if (owner !== null && owner[prop] === result) {
              return result;
            }
            throw new Error(
              `no-vault-read guard: own function property ${prop} at ${here.join(".")} — the settings document carries no callable a fingerprint should ever reach for`,
            );
          }
          return result;
        }
        // Prototype-chain get (including methods): same prototype allow-list.
        const protoValue: unknown = Reflect.get(t, prop, t);
        if (typeof protoValue === "function") {
          const owner: Record<string, unknown> | null = Array.isArray(t)
            ? (Array.prototype as unknown as Record<string, unknown>)
            : ((Object.getPrototypeOf(t) ?? null) as Record<string, unknown> | null);
          if (owner !== null && owner[prop] === protoValue) {
            return protoValue;
          }
          throw new Error(`no-vault-read guard: method access ${prop} at ${here.join(".")} — not a plain data read`);
        }
        return protoValue;
      },
      set() {
        throw new Error(`no-vault-read guard: set at ${here.join(".")} — computing the fingerprint must not mutate`);
      },
      deleteProperty() {
        throw new Error(`no-vault-read guard: delete at ${here.join(".")}`);
      },
      apply() {
        throw new Error(`no-vault-read guard: apply at ${here.join(".")}`);
      },
      construct() {
        throw new Error(`no-vault-read guard: construct at ${here.join(".")}`);
      },
      defineProperty() {
        throw new Error(`no-vault-read guard: defineProperty at ${here.join(".")}`);
      },
      setPrototypeOf() {
        throw new Error(`no-vault-read guard: setPrototypeOf at ${here.join(".")}`);
      },
    });
  return wrap(value, path) as T;
}

describe("recognizerFingerprint — declared no-vault-read property (TASK.202 guard)", () => {
  const record: CustomProviderRecord = {
    id: "custom:vision-slug",
    name: "Vision custom",
    baseUrl: "https://rec.example.com/v1",
    kind: "openai-compatible",
    models: ["vision-model-x"],
  };
  const recognizer = { connectionId: "conn-v", modelId: "vision-model-x" };
  const connections = [connection()];
  const key: SecretKey = "provider.custom:vision-slug.apiKey";

  it("computes without any secret resolution: the settings document carries no vault handle to call", () => {
    const settings = plainDataProxy(baseSettings([record], connections, recognizer));
    // Both entry points run to completion over a document that refuses every
    // non-data access — no getSecret, no SecretReader, no vault handle.
    const fingerprint = recognizerFingerprint(settings);
    expect(fingerprint).toEqual({
      connectionId: "conn-v",
      modelId: "vision-model-x",
      baseUrl: "https://rec.example.com/v1",
      transport: "openai-chat-completions",
    });
    expect(recognizerSecretTargetKey(settings, key)).toBe(true);
  });

  it("the module's static shape names no vault entry point (mechanical drift guard, codex-support.drift.test.ts spirit)", () => {
    const source = readFileSync(fileURLToPath(new URL("./recognizer.ts", import.meta.url)), "utf8");
    // Identifiers only — strip comments/strings first so the module's own
    // prose ("NEVER reads the vault") cannot satisfy the guard vacuously.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(code).not.toMatch(/\bgetSecret\b/);
    expect(code).not.toMatch(/\bSecretReader\b/);
    expect(code).not.toMatch(/\bvault\b/);
  });
});
