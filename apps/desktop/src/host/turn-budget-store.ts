/**
 * TASK.4721: the desktop host's turn-budget history — the one place core's
 * learned base budget is fed from and read back.
 *
 * Storage is a JSONL append log at `<home>/.anycode/turn-budget-history.jsonl`
 * (next to settings.json). Every host is its own process, so the writer uses
 * one O_APPEND line per record: an append of one small line is atomic enough
 * for this purpose, and a torn or foreign line is simply skipped on read. The
 * file is capped at TURN_BUDGET_HISTORY_MAX_BYTES; past the cap the writer
 * best-effort rewrites its newest tail through tmp+rename and swallows any
 * failure. Core never touches this file: it sees only the SubagentBudgetPort.
 *
 * Only the adaptive mode writes or reads it (the caller gates on the flag).
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { isAcceptedBudgetSample, learnBaseBudget, type BudgetSample } from "@anycode/core";
import { anycodeDir } from "../settings/files.js";

export const TURN_BUDGET_HISTORY_FILE = "turn-budget-history.jsonl";
/** Hard cap on the history file; past it the writer keeps only the newest tail. */
export const TURN_BUDGET_HISTORY_MAX_BYTES = 256 * 1024;
/** Newest records kept per role on read (the learner only reads 30 anyway). */
export const TURN_BUDGET_HISTORY_KEEP_PER_ROLE = 200;

/** One stored line. `v` is the schema version; any other value is skipped. */
interface StoredRecord {
  v: 1;
  role: string;
  model?: string;
  turns: number;
  at: number;
}

export function defaultTurnBudgetHistoryPath(home: string = homedir()): string {
  return join(anycodeDir(home), TURN_BUDGET_HISTORY_FILE);
}

function parseLine(line: string): BudgetSample | undefined {
  if (line.trim() === "") {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const record = raw as Partial<StoredRecord>;
  if (record.v !== 1 || typeof record.role !== "string" || record.role.length === 0) {
    return undefined;
  }
  if (typeof record.turns !== "number" || !Number.isInteger(record.turns) || record.turns < 1) {
    return undefined;
  }
  if (record.model !== undefined && typeof record.model !== "string") {
    return undefined;
  }
  return {
    role: record.role,
    ...(record.model !== undefined ? { model: record.model } : {}),
    turns: record.turns,
  };
}

/** Tolerant reader: a missing file is empty history; bad lines are skipped. */
export function readTurnBudgetHistory(path: string): BudgetSample[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const parsed: BudgetSample[] = [];
  for (const line of text.split("\n")) {
    const sample = parseLine(line);
    if (sample !== undefined) {
      parsed.push(sample);
    }
  }
  // Keep the newest KEEP_PER_ROLE per role, preserving file (chronological) order.
  const seen = new Map<string, number>();
  const keep: boolean[] = new Array(parsed.length).fill(false);
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const role = parsed[i]!.role;
    const count = seen.get(role) ?? 0;
    if (count < TURN_BUDGET_HISTORY_KEEP_PER_ROLE) {
      keep[i] = true;
      seen.set(role, count + 1);
    }
  }
  return parsed.filter((_, index) => keep[index]);
}

/** Rewrites the file to its newest complete lines within half the cap. Best-effort. */
function compactIfOverCap(path: string): void {
  try {
    if (statSync(path).size <= TURN_BUDGET_HISTORY_MAX_BYTES) {
      return;
    }
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
    const budget = TURN_BUDGET_HISTORY_MAX_BYTES / 2;
    const kept: string[] = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const size = Buffer.byteLength(lines[i]!, "utf8") + 1;
      if (bytes + size > budget) {
        break;
      }
      bytes += size;
      kept.unshift(lines[i]!);
    }
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "");
      renameSync(tmp, path);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // tmp may not exist; nothing else to clean up.
      }
    }
  } catch {
    // Fail-soft: the cap is advisory; an append must never fail because of it.
  }
}

/** Appends one accepted run. Never throws: a history write must not cost the run. */
export function appendTurnBudgetRecord(
  path: string,
  entry: { role: string; model?: string; turns: number },
  now: number = Date.now(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const record: StoredRecord = {
      v: 1,
      role: entry.role,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      turns: entry.turns,
      at: now,
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    compactIfOverCap(path);
  } catch {
    // Fail-soft (see above).
  }
}

/** The shape core's AgentLoopConfig.subagentBudget expects (structural). */
export interface TurnBudgetPort {
  learned(key: { role: string; model?: string }): number | undefined;
  record(entry: { role: string; model?: string; turns: number }): void;
}

/** The request fields the session-tier budget helpers read (structural). */
export interface SessionBudgetRequest {
  agentType: string;
  model?: string;
  maxTurns?: number;
  engine?: unknown;
}

/**
 * Session-tier stamping (TASK.4721): a learned base budget becomes the child's
 * `maxTurns` ONLY when adaptive is on and nothing more specific was given: no
 * explicit request maxTurns, no `tools.subagentMaxTurns` setting, and no engine
 * child (a foreign CLI cannot enforce a turn budget). Returns the SAME object
 * when nothing applies, so the adaptive-off path is untouched.
 */
export function stampLearnedMaxTurns<R extends SessionBudgetRequest>(
  req: R,
  input: { adaptive: boolean; settingsBudgetSet: boolean; port: Pick<TurnBudgetPort, "learned"> | undefined },
): R {
  if (!input.adaptive || input.settingsBudgetSet || req.maxTurns !== undefined || req.engine !== undefined) {
    return req;
  }
  if (input.port === undefined) {
    return req;
  }
  const learned = input.port.learned({
    role: req.agentType,
    ...(req.model !== undefined ? { model: req.model } : {}),
  });
  return learned === undefined ? req : { ...req, maxTurns: learned };
}

/**
 * Records one finished session child IFF it passes core's training filter
 * (isAcceptedBudgetSample) and is not an engine child. The caller decides WHEN
 * (sync outcome; or the detached terminal) and passes `undefined` when adaptive
 * is off, which makes this a no-op.
 */
export function recordAcceptedChildBudget(
  port: Pick<TurnBudgetPort, "record"> | undefined,
  outcome: {
    status: string;
    turns: number;
    truncated?: boolean;
    declaredDoneAtCeiling?: boolean;
    /**
     * GitHub #17 slice D: an admission/handoff outcome (the
     * child is still running) rather than a finished run. Checked BEFORE every
     * other filter: a dispatch that took zero turns must never train a
     * completed-run sample, whatever its status says.
     */
    background?: { reason: "requested" | "join_budget" };
  },
  req: SessionBudgetRequest,
): void {
  if (outcome.background !== undefined) {
    return;
  }
  if (port === undefined || req.engine !== undefined || !isAcceptedBudgetSample(outcome)) {
    return;
  }
  port.record({
    role: req.agentType,
    ...(req.model !== undefined ? { model: req.model } : {}),
    turns: outcome.turns,
  });
}

/**
 * The SubagentBudgetPort the host hands to core's AgentLoopConfig.subagentBudget:
 * `learned` reads the file and applies core's formula; `record` appends.
 */
export function createSubagentBudgetPort(path: string): TurnBudgetPort {
  return {
    learned(key) {
      try {
        return learnBaseBudget(readTurnBudgetHistory(path), key);
      } catch {
        return undefined;
      }
    },
    record(entry) {
      appendTurnBudgetRecord(path, entry);
    },
  };
}
