/**
 * Taskana 4702 Stage 1 / Taskana 4730: reads the ask-zone classifier record
 * from the `ANYCODE_PERMISSION_CLASSIFIER` env var (a JSON mirror of
 * `settings.permissions.classifier`, written by host-env.ts).
 *
 * Fail-closed by construction: unset, blank, malformed JSON, a disabled record,
 * an invalid shape, or a command that splits to nothing all yield `undefined`,
 * which means the classifier is OFF. The functions never throw and never return
 * a partial classifier.
 *
 * Taskana 4730: `kind:"model"` (implementation B) needs a ModelPort, which only
 * the host boot can resolve (a connection id / model id -> port). It is
 * therefore parsed SHAPE-ONLY here (`parseAskClassifierEnvKind`); the host
 * index builds the classifier itself. `parseAskClassifierEnv` stays the
 * command-only wrapper so existing callers/tests are unchanged.
 */

import { z } from "zod";
import {
  createCommandAskClassifier,
  parseClassifierCommand,
  type AskClassifier,
} from "@anycode/core";

const askClassifierEnvSchema = z.object({
  enabled: z.literal(true),
  kind: z.literal("command"),
  command: z.string(),
  timeoutMs: z.number().int().positive().optional(),
});

const askClassifierModelEnvSchema = z.object({
  enabled: z.literal(true),
  kind: z.literal("model"),
  connectionId: z.string().refine((id) => id.trim().length > 0).optional(),
  model: z.string().refine((model) => model.trim().length > 0).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export interface AskClassifierBoot {
  classifier: AskClassifier;
  /** Present only when the record set one; the core default applies otherwise. */
  timeoutMs?: number;
}

/**
 * Taskana 4730: the shape-only parse of a `kind:"model"` record. No classifier
 * is built here — the host resolves the ModelPort (connection/model) and calls
 * `createModelAskClassifier` itself.
 */
export interface AskClassifierModelBoot {
  kind: "model";
  connectionId?: string;
  model?: string;
  timeoutMs?: number;
}

export type AskClassifierKindBoot =
  | { kind: "command"; boot: AskClassifierBoot }
  | AskClassifierModelBoot;

function parseJson(raw: string | undefined): unknown | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Taskana 4730: parses BOTH kinds. `kind:"command"` yields a ready boot (same
 * fail-closed rules as parseAskClassifierEnv); `kind:"model"` yields the
 * shape-only record for the host to resolve. Everything else is undefined.
 */
export function parseAskClassifierEnvKind(raw: string | undefined): AskClassifierKindBoot | undefined {
  const json = parseJson(raw);
  if (json === undefined) return undefined;
  const model = askClassifierModelEnvSchema.safeParse(json);
  if (model.success) {
    return {
      kind: "model",
      ...(model.data.connectionId !== undefined ? { connectionId: model.data.connectionId } : {}),
      ...(model.data.model !== undefined ? { model: model.data.model } : {}),
      ...(model.data.timeoutMs !== undefined ? { timeoutMs: model.data.timeoutMs } : {}),
    };
  }
  const parsed = askClassifierEnvSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const argv = parseClassifierCommand(parsed.data.command);
  if (argv.length === 0) return undefined;
  const timeoutMs = parsed.data.timeoutMs;
  try {
    const classifier = createCommandAskClassifier({
      argv,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return { kind: "command", boot: { classifier, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } };
  } catch {
    return undefined;
  }
}

export function parseAskClassifierEnv(raw: string | undefined): AskClassifierBoot | undefined {
  const parsed = parseAskClassifierEnvKind(raw);
  if (parsed === undefined || parsed.kind !== "command") return undefined;
  return parsed.boot;
}
