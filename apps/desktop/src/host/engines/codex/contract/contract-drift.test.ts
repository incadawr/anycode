/**
 * Two-layer drift gate over the pinned Codex app-server contract (cut §2(h)):
 *
 *  1. Always-on (this file, every `pnpm test` run): the vocabulary constants
 *     already in host/engines/codex/protocol.ts stay a subset of the pinned
 *     methods/decision-enums, `SUPPORTED_CODEX_VERSION` covers the pinned
 *     `generatedFrom`, and every committed fixture line still parses/decodes
 *     without an unknown-throw.
 *  2. Env-gated (`ANYCODE_CODEX_DRIFT_BIN=<path to a codex binary>`): runs
 *     `codex app-server generate-json-schema` for real, re-extracts with the
 *     SAME extractor that produced the committed pinned-contract.json, and
 *     deep-equals the two — a live-schema drift shows up as a red test with a
 *     diff. Skipped (not failed) when the env var is unset, e.g. in CI.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OBSERVED_COMMAND_APPROVAL_METHOD,
  OBSERVED_FILE_CHANGE_APPROVAL_METHOD,
  SUPPORTED_CODEX_VERSION,
  isSupportedCodexVersion,
  parseCodexVersion,
} from "../protocol.js";
import { TurnTranslator } from "../event-translator.js";

const CONTRACT_DIR = new URL(".", import.meta.url).pathname;
const PINNED_PATH = join(CONTRACT_DIR, "pinned-contract.json");
const FIXTURES_DIR = join(CONTRACT_DIR, "fixtures");
// Repo-root-relative: apps/desktop/src/host/engines/codex/contract -> apps/desktop/scripts.
const EXTRACTOR_SCRIPT = join(CONTRACT_DIR, "..", "..", "..", "..", "..", "scripts", "codex-contract-extract.mjs");

interface PinnedMethodShape {
  params: string | null;
  result?: string | null;
}

interface PinnedContract {
  generatedFrom: string;
  methods: {
    clientRequests: Record<string, PinnedMethodShape>;
    serverRequests: Record<string, PinnedMethodShape>;
    serverNotifications: Record<string, PinnedMethodShape>;
  };
  decisionEnums: { commandExecution: string[]; fileChange: string[] };
  definitions: Record<string, unknown>;
}

function loadPinned(): PinnedContract {
  return JSON.parse(readFileSync(PINNED_PATH, "utf8"));
}

/**
 * Decision literals CURRENTLY reachable from product code (cut §2(c)): B1 wired
 * allow -> "accept", deny -> "decline", and Stop-during-approval -> "cancel".
 * `acceptForSession` and the execpolicy/network amendments are deliberately
 * never sent (residual, cut §8). Expand this list as later blocks land more
 * decisions — the assertion below then keeps proving every one of them is still
 * schema-legal for BOTH approval families.
 */
const CODE_DECISION_LITERALS = ["accept", "decline", "cancel"];

describe("contract-drift layer 1 (always-on)", () => {
  const pinned = loadPinned();

  it("SUPPORTED_CODEX_VERSION covers the pinned generatedFrom", () => {
    // generatedFrom is "codex-cli 0.144.x" — substitute a concrete patch to
    // reuse the real parser/range-check rather than re-deriving the range.
    const version = parseCodexVersion("codex-cli 0.144.1");
    expect(version).not.toBeNull();
    expect(isSupportedCodexVersion(version!)).toBe(true);
    // Deliberately a LITERAL, not a re-derivation: raising the ceiling must
    // trip this test, so that admitting a version is always a reviewed edit
    // here rather than a constant quietly drifting upward.
    expect(SUPPORTED_CODEX_VERSION).toBe("<0.152.0");
    expect(pinned.generatedFrom.startsWith("codex-cli 0.144")).toBe(true);
  });

  it("isSupportedCodexVersion agrees with SUPPORTED_CODEX_VERSION at the ceiling", () => {
    // The predicate was once hardcoded (`minor === 144`) while the constant was
    // a display string: widening the string alone advertised a version the
    // code still refused, and the codex-support manifest would have promised
    // users a version the transport rejected on sight.
    //
    // TASK.173 (owner decision, 2026-08-29): the floor is gone, so there is
    // only one boundary left to prove — the ceiling. An arbitrarily old
    // version is accepted by version number alone (it may still fail later,
    // on the wire, for reasons unrelated to this check).
    const at = (text: string): boolean => {
      const version = parseCodexVersion(`codex-cli ${text}`);
      expect(version, `unparsable probe version ${text}`).not.toBeNull();
      return isSupportedCodexVersion(version!);
    };
    const bounds = /^<(\S+)$/.exec(SUPPORTED_CODEX_VERSION);
    expect(bounds, `SUPPORTED_CODEX_VERSION is not a "<max" ceiling: ${SUPPORTED_CODEX_VERSION}`).not.toBeNull();
    const max = bounds![1]!;

    expect(at(max), `${max} is the EXCLUSIVE ceiling and must not be supported`).toBe(false);
    expect(at("0.144.1")).toBe(true);
    expect(at("0.0.1"), "there is no floor: an arbitrarily old version is not rejected by version number").toBe(true);
  });

  it("protocol.ts's observed approval methods are pinned server-request methods", () => {
    expect(Object.keys(pinned.methods.serverRequests)).toContain(OBSERVED_COMMAND_APPROVAL_METHOD);
    expect(Object.keys(pinned.methods.serverRequests)).toContain(OBSERVED_FILE_CHANGE_APPROVAL_METHOD);
  });

  it("every decision literal reachable from product code is schema-legal for BOTH approval families", () => {
    for (const literal of CODE_DECISION_LITERALS) {
      expect(pinned.decisionEnums.commandExecution).toContain(literal);
      expect(pinned.decisionEnums.fileChange).toContain(literal);
    }
  });

  it("the pinned contract covers every consumed method family named in the cut (§3)", () => {
    const client = Object.keys(pinned.methods.clientRequests);
    for (const method of [
      "initialize",
      "account/read",
      "model/list",
      "thread/start",
      "thread/resume",
      "thread/read",
      "turn/start",
      "turn/interrupt",
      "account/login/start",
      "account/login/cancel",
      "account/logout",
    ]) {
      expect(client).toContain(method);
    }
  });

  it("the translator digests every committed fixture line without an unknown-throw", () => {
    const fixtureFiles = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl"));
    expect(fixtureFiles.length).toBeGreaterThan(0);

    for (const file of fixtureFiles) {
      const lines = readFileSync(join(FIXTURES_DIR, file), "utf8").split("\n").filter((line) => line.trim().length > 0);
      // Every line must at least be well-formed JSON-RPC (parse-safe).
      const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

      // Group per (threadId, turnId) so matchingTurn's exact-id gate actually
      // lets each notification reach the translator's switch, not just its
      // early-return guard (cut §7 hazard #2: assert real digestion, not a
      // vacuously-passing loop).
      const turnKeys = new Set<string>();
      for (const message of messages) {
        const params = message.params as Record<string, unknown> | undefined;
        if (typeof params?.threadId === "string" && typeof params?.turnId === "string") {
          turnKeys.add(`${params.threadId} ${params.turnId}`);
        }
      }

      for (const key of turnKeys) {
        const [threadId, turnId] = key.split(" ");
        const translator = new TurnTranslator({ threadId: threadId!, turnId: turnId!, turn: 1 });
        for (const message of messages) {
          if (typeof message.method !== "string" || message.id !== undefined) continue; // notifications only
          expect(() => translator.onNotification({ method: message.method as string, params: message.params })).not.toThrow();
        }
      }
    }
  });
});

/**
 * Guards `contract/fixtures/**` against local-identifying data leaking back
 * in with a future probe capture (codex review finding: W0/W1 traces once
 * committed a real `/Users/<name>` home path, a real machine hostname, and a
 * real installation ID — none of them auth tokens, but all of them the kind
 * of thing that should never live in repo history). Always-on, no live
 * binary needed — pure static scan of every committed fixture file's raw
 * text. Deliberately its own describe block (not folded into layer 1 above)
 * so a future contributor adding a new fixture sees a dedicated, obviously-
 * named failure rather than a cryptic digestion-test diff.
 */
describe("contract-drift fixtures — no local-identifying data (always-on guard)", () => {
  const fixtureFileNames = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"));
  expect(fixtureFileNames.length).toBeGreaterThan(0);

  // A real `/Users/<name>` home path (macOS). Placeholders used by the scrub
  // recipe below (e.g. `/scrubbed-home`) live OUTSIDE `/Users/` on purpose so
  // this pattern needs no self-referential allowlist.
  const HOME_PATH_PATTERN = /\/Users\/[A-Za-z0-9_.-]+/;
  // An mDNS-style local hostname (`serverName` in `remoteControl/status/changed`,
  // the exact shape the real capture leaked: `MacBook-Pro.local`).
  const HOSTNAME_PATTERN = /\b[A-Za-z0-9][A-Za-z0-9-]*\.local\b/;
  // A suspiciously long value under an auth-shaped key — defense-in-depth:
  // none of the committed fixtures carry real credentials today (W0/W1 never
  // read one), but a future capture must not silently smuggle one in.
  const TOKEN_KEY_PATTERN =
    /"[a-zA-Z0-9_-]*(?:token|secret|password|apikey|api_key|credential|authorization)[a-zA-Z0-9_-]*"\s*:\s*"([^"]{8,})"/gi;

  for (const file of fixtureFileNames) {
    it(`${file} carries no home path / local hostname / token-shaped value`, () => {
      const content = readFileSync(join(FIXTURES_DIR, file), "utf8");

      const homeMatch = HOME_PATH_PATTERN.exec(content);
      expect(homeMatch?.[0] ?? null, `found a real home path in ${file}`).toBeNull();

      const hostnameMatch = HOSTNAME_PATTERN.exec(content);
      expect(hostnameMatch?.[0] ?? null, `found a local-hostname-shaped value in ${file}`).toBeNull();

      const tokenMatches = [...content.matchAll(TOKEN_KEY_PATTERN)].map((m) => m[0]);
      expect(tokenMatches, `found a token/secret-shaped value in ${file}`).toEqual([]);
    });
  }
});

/**
 * Rebuilds a raw `codex_app_server_protocol.schemas.json`-shaped object (the
 * extractor's real input) purely from the ALREADY-COMMITTED pinned contract —
 * no duplicated method-name vocabulary, no live binary required. `definitions`
 * is reused straight from `pinned.definitions` (already the exact closed/
 * resolved subset a real extraction produces), and `ClientRequest`/
 * `ServerRequest`/`ServerNotification` are synthesized from `pinned.methods.*`
 * — exactly the discriminated-union registry shape
 * `resolveMethodParamsRef` (codex-contract-extract.mjs) reads: each variant
 * carries `properties.method.enum[0]` (the method name) and, when the method
 * takes params, `properties.params.$ref`.
 */
function buildSyntheticSchema(pinned: PinnedContract): Record<string, unknown> {
  function dollarRef(ref: string): { $ref: string } {
    return { $ref: ref.startsWith("v2/") ? `#/definitions/v2/${ref.slice(3)}` : `#/definitions/${ref}` };
  }
  function methodRegistry(methodsMap: Record<string, PinnedMethodShape>): unknown {
    return {
      oneOf: Object.entries(methodsMap).map(([method, shape]) => ({
        type: "object",
        properties: {
          method: { type: "string", enum: [method] },
          params: shape.params !== null ? dollarRef(shape.params) : { type: "null" },
        },
      })),
    };
  }
  return {
    definitions: {
      ...pinned.definitions,
      ClientRequest: methodRegistry(pinned.methods.clientRequests),
      ServerRequest: methodRegistry(pinned.methods.serverRequests),
      ServerNotification: methodRegistry(pinned.methods.serverNotifications),
    },
  };
}

/** Renames one method-registry variant in place (deep-owned by `schema`, a fresh object per test — never the shared `pinned` fixture). */
function renameMethodInRegistry(schema: Record<string, unknown>, registryName: string, oldMethod: string, newMethod: string): void {
  const definitions = schema.definitions as Record<string, unknown>;
  const registry = definitions[registryName] as { oneOf: Array<{ properties: { method: { enum: string[] } } }> };
  const variant = registry.oneOf.find((candidate) => candidate.properties.method.enum[0] === oldMethod);
  if (!variant) {
    throw new Error(`test setup: no "${oldMethod}" variant in synthetic ${registryName} registry`);
  }
  variant.properties.method.enum[0] = newMethod;
}

/** Runs the REAL extractor CLI as a subprocess (same posture as layer 2 below) over a synthetic schema written to a scratch dir. */
function runExtractor(schema: unknown, generatedFrom: string): { contract: PinnedContract } | { error: string } {
  const tmp = mkdtempSync(join(tmpdir(), "anycode-codex-drift-mutation-"));
  try {
    writeFileSync(join(tmp, "codex_app_server_protocol.schemas.json"), JSON.stringify(schema));
    const outFile = join(tmp, "out.json");
    try {
      execFileSync(process.execPath, [EXTRACTOR_SCRIPT, tmp, outFile, generatedFrom], { timeout: 30_000, stdio: "pipe" });
    } catch (error) {
      const withStreams = error as { stderr?: Buffer; message?: string };
      return { error: withStreams.stderr?.toString("utf8") ?? withStreams.message ?? String(error) };
    }
    return { contract: JSON.parse(readFileSync(outFile, "utf8")) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Hardens the drift gate itself (cut §2(h): "verify it actually FAILS on an
 * incompatible change rather than passing vacuously — a gate that cannot fail
 * is worse than no gate"). Always-on (no env gate, no live binary needed):
 * the extractor used to trust a SECOND hardcoded method->paramsRef table
 * wholesale, so a CLI renaming a consumed method (e.g. `turn/start` ->
 * `turn/begin`) while leaving `TurnStartParams`'s shape untouched produced a
 * byte-identical pinned contract and a vacuously green gate. The extractor
 * now resolves each consumed method's params ref by matching its name
 * against the schema's OWN `ClientRequest`/`ServerRequest`/
 * `ServerNotification` registries (codex-contract-extract.mjs
 * `resolveMethodParamsRef`) — these tests prove that lookup is real: an
 * unmutated round-trip still passes (the harness itself isn't just always
 * red), and a renamed method in each of the three registries throws.
 */
describe("contract-drift hardening — the gate can actually go red (always-on, cut §2(h) harden)", () => {
  const pinned = loadPinned();

  it("sanity: a synthetic schema rebuilt FROM the pinned contract, left UNMUTATED, round-trips through the real extractor", () => {
    const schema = buildSyntheticSchema(pinned);
    const result = runExtractor(schema, pinned.generatedFrom);
    if ("error" in result) {
      throw new Error(`extractor rejected an unmutated synthetic schema — the hardening harness itself is broken:\n${result.error}`);
    }
    expect(result.contract.methods).toEqual(pinned.methods);
    expect(result.contract.decisionEnums).toEqual(pinned.decisionEnums);
  });

  it("a renamed CLIENT REQUEST method (turn/start) makes the gate throw, not silently pass", () => {
    const schema = buildSyntheticSchema(pinned);
    renameMethodInRegistry(schema, "ClientRequest", "turn/start", "turn/begin");
    const result = runExtractor(schema, pinned.generatedFrom);
    expect("error" in result, "extractor accepted a schema where a consumed client method was renamed — the gate cannot fail").toBe(
      true,
    );
    if ("error" in result) {
      expect(result.error).toContain("turn/start");
    }
  });

  it("a renamed SERVER NOTIFICATION method (turn/completed) makes the gate throw, not silently pass", () => {
    const schema = buildSyntheticSchema(pinned);
    renameMethodInRegistry(schema, "ServerNotification", "turn/completed", "turn/finished");
    const result = runExtractor(schema, pinned.generatedFrom);
    expect(
      "error" in result,
      "extractor accepted a schema where a consumed notification was renamed — the gate cannot fail",
    ).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("turn/completed");
    }
  });

  it("a renamed SERVER REQUEST method (command-execution approval) makes the gate throw, not silently pass", () => {
    const schema = buildSyntheticSchema(pinned);
    renameMethodInRegistry(schema, "ServerRequest", "item/commandExecution/requestApproval", "item/commandExecution/approve");
    const result = runExtractor(schema, pinned.generatedFrom);
    expect(
      "error" in result,
      "extractor accepted a schema where a consumed approval method was renamed — the gate cannot fail",
    ).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("item/commandExecution/requestApproval");
    }
  });
});

/**
 * Definition shapes that a LATER in-range Codex removed, each reviewed once and
 * found unconsumed by the adapter — the allowance that lets `shapeRegressions`
 * stay strict about everything else. Verified by grepping host/engines/codex
 * for each name: none appears outside this contract directory. A removal NOT
 * listed here fails the gate, which is the point.
 */
const REVIEWED_REMOVALS: Readonly<Record<string, string>> = {
  // Bedrock credential plumbing; AnyCode never reads an Account's credential source.
  "v2/AmazonBedrockCredentialSource": "0.147: replaced by usesCodexManagedCredentials",
  "v2/Account/amazonBedrock/credentialSource": "0.147: replaced by usesCodexManagedCredentials",
  // App-template id on an MCP tool call; the translator reads name/arguments/status only.
  "v2/McpToolCallAppContext/templateId": "0.147: dropped from the app context",
};

/**
 * Every way the live schema is NOT a compatible superset of the pin, as a list
 * of human-readable paths (empty means compatible). Compatible means: every
 * pinned definition still exists, every pinned object property still exists,
 * and every pinned union VARIANT — keyed by its `type` discriminator, the
 * literal the adapter actually switches on — still exists. Additions are
 * invisible to this check by construction; a removal must be reviewed into
 * REVIEWED_REMOVALS to pass.
 */
function shapeRegressions(pinnedDefs: unknown, freshDefs: unknown): string[] {
  const out: string[] = [];

  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  /** The `type` discriminator literal of one oneOf variant, or null when it is not a discriminated variant. */
  const discriminator = (variant: unknown): string | null => {
    if (!isObj(variant)) return null;
    const props = variant.properties;
    if (!isObj(props)) return null;
    const type = props.type;
    if (!isObj(type)) return null;
    const values = type.enum;
    return Array.isArray(values) && typeof values[0] === "string" ? values[0] : null;
  };

  const walk = (pinnedNode: unknown, freshNode: unknown, path: string): void => {
    if (REVIEWED_REMOVALS[path] !== undefined) return;
    if (freshNode === undefined) {
      out.push(path);
      return;
    }
    if (!isObj(pinnedNode) || !isObj(freshNode)) return;

    const pinnedProps = pinnedNode.properties;
    const freshProps = freshNode.properties;
    if (isObj(pinnedProps)) {
      for (const name of Object.keys(pinnedProps)) {
        walk(pinnedProps[name], isObj(freshProps) ? freshProps[name] : undefined, `${path}/${name}`);
      }
    }

    const pinnedVariants = pinnedNode.oneOf;
    const freshVariants = freshNode.oneOf;
    if (Array.isArray(pinnedVariants)) {
      const freshByDiscriminator = new Map<string, unknown>();
      for (const variant of Array.isArray(freshVariants) ? freshVariants : []) {
        const key = discriminator(variant);
        if (key !== null) freshByDiscriminator.set(key, variant);
      }
      for (const variant of pinnedVariants) {
        const key = discriminator(variant);
        if (key === null) continue;
        walk(variant, freshByDiscriminator.get(key), `${path}/${key}`);
      }
    }
  };

  if (!isObj(pinnedDefs) || !isObj(freshDefs)) return ["definitions"];
  for (const group of Object.keys(pinnedDefs)) {
    const pinnedGroup = pinnedDefs[group];
    const freshGroup = freshDefs[group];
    // `definitions.v2` is a MAP of definitions; every sibling is a definition itself.
    if (group === "v2") {
      if (!isObj(pinnedGroup)) continue;
      for (const name of Object.keys(pinnedGroup)) {
        walk(pinnedGroup[name], isObj(freshGroup) ? freshGroup[name] : undefined, `v2/${name}`);
      }
      continue;
    }
    walk(pinnedGroup, freshGroup, group);
  }
  return out;
}

describe.skipIf(!process.env.ANYCODE_CODEX_DRIFT_BIN)("contract-drift layer 2 (env-gated, live binary)", () => {
  it("the live binary's version is within SUPPORTED_CODEX_VERSION, and its freshly-generated schema structurally matches the pinned contract", () => {
    const bin = process.env.ANYCODE_CODEX_DRIFT_BIN!;
    // Version comes from the REAL binary (cut §2(h) harden), never a stamped
    // literal: a binary AT OR ABOVE the ceiling now fails this test explicitly
    // instead of silently deep-equaling on type shape alone (a binary that
    // happens to keep our CONSUMED subset's shape unchanged while being
    // genuinely above the reviewed ceiling must not pass). There is no floor
    // (TASK.173) to fail this probe from the other side.
    const rawVersion = execFileSync(bin, ["--version"], { timeout: 10_000, stdio: "pipe" }).toString("utf8").trim();
    const version = parseCodexVersion(rawVersion);
    expect(version, `unrecognized \`${bin} --version\` output: ${JSON.stringify(rawVersion)}`).not.toBeNull();
    expect(
      isSupportedCodexVersion(version!),
      `${rawVersion} is outside SUPPORTED_CODEX_VERSION (${SUPPORTED_CODEX_VERSION}) — raise the ceiling deliberately ` +
        `(contract/README.md) before trusting this binary's schema`,
    ).toBe(true);

    const tmp = mkdtempSync(join(tmpdir(), "anycode-codex-drift-"));
    try {
      execFileSync(bin, ["app-server", "generate-json-schema", "--out", tmp], { timeout: 30_000, stdio: "pipe" });
      // Reuse the SAME extractor+canonicalizer that produced pinned-contract.json
      // by invoking it exactly as the regeneration recipe (README.md) does — a
      // subprocess call, not an import, so this test needs no .d.ts for the
      // dependency-free .mjs CLI script.
      const outFile = join(tmp, "fresh-contract.json");
      execFileSync(process.execPath, [EXTRACTOR_SCRIPT, tmp, outFile, rawVersion], { timeout: 30_000, stdio: "pipe" });
      const fresh: PinnedContract = JSON.parse(readFileSync(outFile, "utf8"));
      // generatedFrom intentionally differs from the pin: the committed file
      // keeps the reviewed "codex-cli 0.144.x" RANGE placeholder
      // (contract/README.md), while `fresh` carries the EXACT patch this run
      // actually probed (already asserted in-range above) — only the
      // schema-derived structure below is drift-relevant.
      const pinned = loadPinned();
      // The DISPATCH surface stays byte-equal: a consumed method or an approval
      // decision literal that changed is a break no matter which version
      // produced it.
      expect(fresh.methods).toEqual(pinned.methods);
      expect(fresh.decisionEnums).toEqual(pinned.decisionEnums);
      // The SHAPES are checked as a compatible superset instead. The pin is one
      // version's snapshot while SUPPORTED_CODEX_VERSION is a ceiling covering
      // many versions, so a later binary under that ceiling that only ADDS
      // optional fields is compatible and must not fail — deep equality here
      // would make every ceiling wider than a single patch unverifiable by
      // this instrument.
      expect(shapeRegressions(pinned.definitions, fresh.definitions)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
