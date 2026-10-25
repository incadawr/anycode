/**
 * Taskana 4730 xfix D4: HONEST connection pinning for the model-kind ask
 * classifier (`kind:"model"` in the permissions settings' classifier record).
 *
 * The pre-fix wiring resolved a `connectionId`+`model` record by calling the
 * session's own `modelPortFactory(model)` regardless of which connection the
 * record named — silently billing the WRONG account and, worse, letting a
 * record that pinned a foreign connection resolve its model against the
 * session's connection. The decision table this module pins:
 *
 *   - no `connectionId` at all: the session's own connection is the implied
 *     one, so the session's switchable port (no connectionId) or the factory
 *     (an explicit `model`) is honest;
 *   - a `connectionId` equal to the session's ACTIVE connection: same
 *     account — resolve normally (the factory knows that connection);
 *   - a `connectionId` that names ANY other connection: the host CANNOT
 *     resolve it (main owns connections; the host process only ever holds
 *     the one it was forked with) — the classifier turns OFF with a notice
 *     the user sees, never a silent fallback to the session's own
 *     connection, and never a `model` resolved against a different
 *     connection than the one named.
 *
 * A foreign-connection record is a deliberate "use my other account" pin; the
 * honest behavior is to say so and stay off, not to quietly guess. Main's
 * fork env already limits ANYCODE_* env to the session's own connection
 * (tabs.ts admits exactly one), so an unresolvable pin can only mean the
 * settings named a connection this tab does not run on.
 */

/**
 * The limited port resolution a host process has. `portFor` is the session's
 * own `modelPortFactory` — it resolves models on the SESSION's connection and
 * nothing else; `allowedModels` is that connection's allowed-models list.
 */
export interface ModelClassifierPortSource {
  /** Models the SESSION's connection permits (child-model.ts's validated list). */
  allowedModels(): readonly string[];
  /** Builds a port for `model` on the SESSION's connection. */
  portFor(model: string): unknown;
}

/** The model-kind classifier record from the permissions settings (already zod-parsed). */
export interface ModelClassifierRecord {
  kind: "model";
  model?: string;
  connectionId?: string;
}

/** What the host should do about the model-kind classifier. */
export type ModelClassifierBoot =
  | {
      ok: true;
      /** The model to classify with. */
      model: string;
      /** True when the port is the SESSION's own switchable port (no explicit model). */
      usesSessionPort: boolean;
    }
  | {
      ok: false;
      /** Human-visible reason the classifier is OFF (surfaced as a host notice). */
      notice: string;
    };

/**
 * The pure decision table. `context.activeConnectionId` is the connection the
 * host process was forked for (main's ENV_CONNECTION_ID) — the ONLY
 * connection the host can resolve ports on.
 */
export function resolveModelClassifierBoot(
  record: ModelClassifierRecord,
  context: {
    source: ModelClassifierPortSource;
    /** The session's currently-selected model. */
    sessionModel: string;
    /** The connection this host process serves (ENV_CONNECTION_ID). */
    activeConnectionId: string | undefined;
  },
): ModelClassifierBoot {
  // D4: an explicit pin that does not name the session's ACTIVE connection is
  // unresolvable by this host — OFF with a notice, never a silent fallback.
  if (record.connectionId !== undefined && record.connectionId !== context.activeConnectionId) {
    return {
      ok: false,
      notice:
        `Permissions classifier: the model classifier is pinned to connection "${record.connectionId}", ` +
        `which this session is not running on` +
        (context.activeConnectionId !== undefined ? ` (this session runs on "${context.activeConnectionId}")` : "") +
        `. The classifier stays off rather than billing a different connection. ` +
        `Move the model classifier to this session's connection, or clear its connection field.`,
    };
  }
  // No pin (or a pin on the session's own active connection): the session's
  // connection IS the one the record means, so resolution is honest.
  if (record.model === undefined) {
    return { ok: true, model: context.sessionModel, usesSessionPort: true };
  }
  if (!context.source.allowedModels().includes(record.model)) {
    return {
      ok: false,
      notice:
        `Permissions classifier: model "${record.model}" is not on this session's connection's allowed list. ` +
        `The classifier stays off rather than resolving the model against a different connection.`,
    };
  }
  context.source.portFor(record.model);
  return { ok: true, model: record.model, usesSessionPort: false };
}
