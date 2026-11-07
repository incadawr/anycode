import { SUBAGENT_MAX_TURNS_CEILING } from "@anycode/core";

export function clampChildMaxTurns(turns: number): number {
  return Math.min(turns, SUBAGENT_MAX_TURNS_CEILING);
}
