/** A locally identified billing failure, carrying no credential material. */
export class MiniMaxBalanceFailure extends Error {
  constructor(readonly original: unknown) { super("MiniMax balance exhausted"); }
}

export function unwrapMiniMaxFailure(error: unknown): unknown {
  while (error instanceof MiniMaxBalanceFailure) error = error.original;
  return error;
}
