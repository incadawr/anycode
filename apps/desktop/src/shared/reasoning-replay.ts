/** Narrow host observation; connection identity and persistence belong to main. */
export const REASONING_REPLAY_REJECTED = "reasoning_replay_rejected";
export interface ReasoningReplayRejection {
  type: typeof REASONING_REPLAY_REJECTED;
  reason: "provider-rejected";
  baseUrl: string;
  model: string;
}
