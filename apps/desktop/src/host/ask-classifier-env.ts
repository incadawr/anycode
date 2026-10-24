/**
 * Taskana 4702 Stage 1: reads the ask-zone classifier record from the
 * `ANYCODE_PERMISSION_CLASSIFIER` env var (a JSON mirror of
 * `settings.permissions.classifier`, written by host-env.ts).
 *
 * Fail-closed by construction: unset, blank, malformed JSON, a disabled record,
 * an invalid shape, or a command that splits to nothing all yield `undefined`,
 * which means the classifier is OFF. The function never throws and never returns
 * a partial classifier.
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

export interface AskClassifierBoot {
  classifier: AskClassifier;
  /** Present only when the record set one; the core default applies otherwise. */
  timeoutMs?: number;
}

export function parseAskClassifierEnv(raw: string | undefined): AskClassifierBoot | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
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
    return { classifier, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  } catch {
    return undefined;
  }
}
