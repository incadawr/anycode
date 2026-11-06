/** Local admission failure; no provider request was sent. */
export class GoInputLimitError extends Error {
  constructor(input: number, limit: number) {
    super(`Estimated prompt (${input} tokens) exceeds the provider input limit (${limit}). Reduce the prompt or compact the conversation.`);
    this.name = "GoInputLimitError";
  }
}
