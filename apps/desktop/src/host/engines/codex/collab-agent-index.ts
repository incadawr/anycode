/**
 * TASK.95 — session-lifetime correlation index for Codex collab (Agent)
 * tool calls.
 *
 * A spawn CALL completing is NOT the same thing as the CHILD completing: the
 * outer Agent tool card settles with the call's own observed outcome, while
 * the subagent region stays live until terminal CHILD observations arrive —
 * which can land in a LATER parent turn (`wait`/`sendInput`/`resumeAgent`/
 * `closeAgent`, or plain `subAgentActivity`). A per-turn translator therefore
 * cannot own this state; the engine owns ONE index for the whole session and
 * hands it to every per-turn translator.
 *
 * Honesty rules encoded here (TASK.95 §"Contract and lifecycle"):
 *  - only `completed`/`errored`/`shutdown` are terminal CHILD states; every
 *    other string (pendingInit/running/interrupted/notFound, or a future
 *    unknown member) is an observation, never proof of completion;
 *  - a spawn with several receivers emits at most ONE child terminal, and only
 *    after EVERY known receiver has a known terminal observation;
 *  - a terminal is latched exactly once (no resurrection by duplicates);
 *  - different spawn card ids stay independent;
 *  - session-lifetime retention is deliberate — no process-global state, and
 *    `clear()` (engine disposal) drops everything.
 */

export interface CollabAgentObservation {
  status: string;
  message?: string;
}

export interface CollabAgentCardSnapshot {
  prompt?: string | null;
  model?: string | null;
  receiverThreadIds?: readonly string[];
}

export interface CollabAgentCard {
  readonly cardId: string;
  prompt: string | null;
  model: string | null;
  receiverThreadIds: string[];
  states: Map<string, CollabAgentObservation>;
  terminalEmitted: boolean;
}

/** Terminal CHILD states. Anything outside this map is a non-terminal observation. */
const TERMINAL_CHILD_STATUS: Record<string, "completed" | "cancelled" | "error"> = {
  completed: "completed",
  errored: "error",
  shutdown: "cancelled",
};

export class CollabAgentCardIndex {
  private readonly cards = new Map<string, CollabAgentCard>();
  /** Reverse correlation: child `agentThreadId` -> the spawn card that owns it. */
  private readonly receiverToCard = new Map<string, string>();

  /**
   * Registers a spawn card (idempotent). A second call MERGES: sparse metadata
   * never overwrites a known prompt/model, and receiver ids are unioned. New
   * cards never fabricate state — `states` starts empty and `terminalEmitted`
   * starts false.
   */
  register(cardId: string, snapshot: CollabAgentCardSnapshot = {}): CollabAgentCard {
    const existing = this.cards.get(cardId);
    if (existing !== undefined) {
      this.merge(cardId, snapshot);
      return existing;
    }
    const card: CollabAgentCard = {
      cardId,
      prompt: snapshot.prompt != null && snapshot.prompt.length > 0 ? snapshot.prompt : null,
      model: snapshot.model != null && snapshot.model.length > 0 ? snapshot.model : null,
      receiverThreadIds: [],
      states: new Map(),
      terminalEmitted: false,
    };
    this.cards.set(cardId, card);
    this.mergeReceivers(cardId, snapshot.receiverThreadIds ?? []);
    return card;
  }

  /**
   * Sparse merge of metadata + receivers into an existing card. Only fills
   * prompt/model that are still unknown; unions receiver ids. A missing card
   * is a deterministic no-op (never creates a phantom card).
   */
  merge(cardId: string, snapshot: CollabAgentCardSnapshot): void {
    const card = this.cards.get(cardId);
    if (card === undefined) return;
    if (card.prompt === null && snapshot.prompt != null && snapshot.prompt.length > 0) card.prompt = snapshot.prompt;
    if (card.model === null && snapshot.model != null && snapshot.model.length > 0) card.model = snapshot.model;
    this.mergeReceivers(cardId, snapshot.receiverThreadIds ?? []);
  }

  /**
   * Unions receiver ids onto the card and maintains the reverse mapping.
   * Deterministic first-wins: if a (malformed/duplicate) id was already
   * claimed by a DIFFERENT card, the existing mapping is kept rather than
   * silently overwritten.
   */
  mergeReceivers(cardId: string, receiverThreadIds: readonly string[]): void {
    const card = this.cards.get(cardId);
    if (card === undefined) return;
    for (const id of receiverThreadIds) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (!card.receiverThreadIds.includes(id)) card.receiverThreadIds.push(id);
      if (!this.receiverToCard.has(id)) this.receiverToCard.set(id, cardId);
    }
  }

  get(cardId: string): CollabAgentCard | undefined {
    return this.cards.get(cardId);
  }

  /** The spawn card that owns a child `agentThreadId`, if any. */
  cardFor(agentThreadId: string): string | undefined {
    return this.receiverToCard.get(agentThreadId);
  }

  /**
   * Folds the latest per-receiver states onto the card. A missing card is a
   * deterministic no-op. Storing a state is only ever an OBSERVATION — it never
   * fabricates a terminal.
   */
  observeStates(cardId: string, states: Record<string, CollabAgentObservation>): void {
    const card = this.cards.get(cardId);
    if (card === undefined) return;
    for (const [receiver, observation] of Object.entries(states)) {
      card.states.set(receiver, { ...observation });
    }
  }

  stateFor(cardId: string, receiver: string): CollabAgentObservation | undefined {
    return this.cards.get(cardId)?.states.get(receiver);
  }

  /**
   * Aggregate child terminal for the card — `null` until EVERY known receiver
   * has a KNOWN terminal observation. Precedence: error, then cancelled, then
   * completed. A card with zero known receivers never settles here.
   */
  terminalFor(cardId: string): "completed" | "cancelled" | "error" | null {
    const card = this.cards.get(cardId);
    if (card === undefined || card.receiverThreadIds.length === 0) return null;
    const terminals: ("completed" | "cancelled" | "error")[] = [];
    for (const receiver of card.receiverThreadIds) {
      const observation = card.states.get(receiver);
      if (observation === undefined) return null;
      const terminal = TERMINAL_CHILD_STATUS[observation.status];
      if (terminal === undefined) return null;
      terminals.push(terminal);
    }
    if (terminals.includes("error")) return "error";
    if (terminals.includes("cancelled")) return "cancelled";
    return "completed";
  }

  /** True once the card has already emitted its one child terminal. */
  hasTerminal(cardId: string): boolean {
    return this.cards.get(cardId)?.terminalEmitted === true;
  }

  /** Latches the card's single child terminal (idempotent). */
  markTerminal(cardId: string): void {
    const card = this.cards.get(cardId);
    if (card !== undefined) card.terminalEmitted = true;
  }

  /** True once ANY child state has ever been observed for the card. */
  hasObservedChild(cardId: string): boolean {
    return (this.cards.get(cardId)?.states.size ?? 0) > 0;
  }

  /** Drops all correlation (engine disposal). */
  clear(): void {
    this.cards.clear();
    this.receiverToCard.clear();
  }
}
