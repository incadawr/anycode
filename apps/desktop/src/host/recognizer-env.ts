import type { ProviderTransport, RecognizerEndpoint } from "@anycode/core";

/**
 * The three valid `ProviderTransport` ids (packages/core/src/provider/
 * catalog.ts's `PROVIDER_TRANSPORT_VALUES`/env.ts's validation of the same
 * set) — copied as a literal because that list is not exported from the
 * package barrel, and `packages/core/**` is out of reach here regardless.
 * Same "host stays core-free / cross-layer literal mirror" convention this
 * file already follows for the ANYCODE_RECOGNIZER_* env-var names below.
 */
const RECOGNIZER_TRANSPORT_VALUES: readonly string[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

/**
 * Fills the two fields a resolved connection may leave unset (main/host-env.ts's
 * `resolveRecognizerConfig` own doc: "a bare/custom connection has no
 * `providerName`, a keyless local server has no `apiKey`") plus a `transport`
 * DEFAULT for the one case a wire/env source may omit that core's
 * `RecognizerEndpoint` (vision/recognizer.ts) does not accept — the SAME
 * final fallback the primary provider ladder above already uses
 * (`providerTransport = envConfig.providerTransport ?? catalogEntry?.
 * defaultTransport ?? "anthropic-messages"`), never a second policy invented
 * for the recognizer alone.
 *
 * Returns `null` (a disabled recognizer, never a "configured but broken" one)
 * on either of two malformed inputs, checked at this ONE construction point
 * so both callers below (the boot-env snapshot in `parseRecognizerEnv`, and
 * main's live config push) are covered by a single check each:
 *  - `baseUrl` blank after trimming (live-run fix, follow-up): the
 *    unconfigured-recognizer placeholder a few lines below is literally
 *    `{transport: "anthropic-messages", baseUrl: "", model: ""}`, the exact
 *    anthropic+blank-address pair a live run turned into `Invalid Anthropic
 *    base URL: "" is empty after trimming` after `InspectImage` had already
 *    registered and been called;
 *  - `transport` PRESENT but not one of the three known `ProviderTransport`
 *    ids — parity with core's own `loadEnvConfig` validation (env.ts: an
 *    invalid transport "is rejected the same way as any other invalid
 *    value"), restored here because this field's cast to `ProviderTransport`
 *    was unchecked (any string was silently accepted as a valid transport).
 *    A transport that is simply ABSENT is NOT malformed — that is the
 *    documented legacy-fallback default two lines below, shared with the
 *    primary provider ladder, and is left alone.
 *
 * The transport check here is NOT redundant with main/host-env.ts's own
 * `resolveEffectiveTransport`-based ladder in `resolveRecognizerConfig` — the
 * two sit at NON-OVERLAPPING injection points. That ladder governs
 * RESOLUTION (what settings/catalog value main picks, and when it honestly
 * refuses); this check governs what can arrive AFTER resolution, from a path
 * that ladder never sees: `applyRecognizerEnv`'s `fillFromSettings` is
 * env-value-wins, so an ambient `ANYCODE_RECOGNIZER_TRANSPORT` in this
 * fork's OWN environment can override whatever main resolved, and main's
 * live RECOGNIZER_CONFIG_CHANGED push (the other caller below) carries a
 * `transport` string that never passes through main's ladder at all. Drop
 * either gate and the hole the other one does not cover reopens.
 */
export function recognizerEndpointFromFields(fields: {
  transport?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  providerName?: string;
  contextWindowTokens?: number;
}): RecognizerEndpoint | null {
  if (fields.baseUrl === undefined || fields.baseUrl.trim() === "") {
    return null;
  }
  if (fields.transport !== undefined && !RECOGNIZER_TRANSPORT_VALUES.includes(fields.transport)) {
    return null;
  }
  return {
    transport: (fields.transport as ProviderTransport | undefined) ?? "anthropic-messages",
    baseUrl: fields.baseUrl,
    model: fields.model,
    ...(Number.isSafeInteger(fields.contextWindowTokens) && fields.contextWindowTokens! > 0 ? { contextWindowTokens: fields.contextWindowTokens } : {}),
    ...(fields.apiKey !== undefined && fields.apiKey !== "" ? { apiKey: fields.apiKey } : {}),
    ...(fields.providerName !== undefined && fields.providerName !== "" ? { providerName: fields.providerName } : {}),
  };
}

/**
 * срез C: `ANYCODE_RECOGNIZER_{TRANSPORT,BASE_URL,API_KEY,MODEL,
 * PROVIDER_NAME}` -> a core `RecognizerEndpoint`, or null when the fallback
 * is unconfigured. Literal local var-name copies mirror main/host-env.ts's
 * `ENV_RECOGNIZER_*` constants by contract — the same "host stays core-free
 * / cross-layer literal mirror, never a wrong-direction import" convention
 * every other env-var family in this file already follows (host never
 * imports from `../main/`). A blank `ANYCODE_RECOGNIZER_MODEL` is one honest
 * "off" signal, checked here; a blank `ANYCODE_RECOGNIZER_BASE_URL` and an
 * unknown `ANYCODE_RECOGNIZER_TRANSPORT` are the other two (live-run fix,
 * follow-up) — `resolveRecognizerConfig` can emit a model with no
 * resolvable address (an unconfigured `needsBaseUrl` catalog template, or a
 * legacy/unknown providerId), and this env family carries no validation of
 * its own on the transport string — both gates live in
 * `recognizerEndpointFromFields` below, the one construction point this and
 * the live-push caller both go through.
 */
export function parseRecognizerEnv(env: NodeJS.ProcessEnv): RecognizerEndpoint | null {
  const model = env.ANYCODE_RECOGNIZER_MODEL;
  if (model === undefined || model.trim() === "") {
    return null;
  }
  return recognizerEndpointFromFields({
    transport: env.ANYCODE_RECOGNIZER_TRANSPORT,
    baseUrl: env.ANYCODE_RECOGNIZER_BASE_URL,
    apiKey: env.ANYCODE_RECOGNIZER_API_KEY,
    model,
    providerName: env.ANYCODE_RECOGNIZER_PROVIDER_NAME,
    contextWindowTokens: (!env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL || env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL === model) && /^\d+$/.test(env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW ?? "") ? Number(env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW) : undefined,
  });
}


/** Preserve a shell-supplied window for the model it names across live updates. */
export function recognizerLiveWindow(env: NodeJS.ProcessEnv, next: RecognizerEndpoint): number | undefined {
  const raw = env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW;
  const explicit = env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_FROM_SETTINGS !== "1" && /^\d+$/.test(raw ?? "") ? Number(raw) : undefined;
  const binding = env.ANYCODE_RECOGNIZER_CONTEXT_WINDOW_MODEL;
  return explicit !== undefined && Number.isSafeInteger(explicit) && explicit > 0 && (!binding || binding === next.model)
    ? explicit : next.contextWindowTokens;
}
