/**
 * Named diagnostics seam (slice 5.6 Wave B): a typed, injectable sink
 * replacing the anonymous provider-artifact `console.warn` call. The default
 * sink reproduces the pre-5.6 behaviour byte-for-byte so callers that never
 * inject a custom sink (desktop, CLI) see zero behavioural change.
 */

export type DiagnosticEvent =
  | { kind: "provider_stream_artifact"; signature: string }
  /**
   * TASK.168: the model port confirmed, via a one-shot retry, that a strict
   * openai-chat-completions endpoint's HTTP 400 was caused by
   * `stream_options.include_usage` and has permanently disabled the flag for
   * this endpoint (the port instance's lifetime — see AiSdkModelPort's
   * `#includeUsageDisabledForEndpoint`). Fired exactly once per port instance,
   * the moment the disable is committed, never per request.
   */
  | { kind: "include_usage_disabled"; baseUrl: string; model: string };

export type DiagnosticSink = (event: DiagnosticEvent) => void;

/** Default sink: reproduces the pre-5.6 console.warn bytes verbatim (behavior-preserving). */
export const consoleDiagnosticSink: DiagnosticSink = (event) => {
  switch (event.kind) {
    case "provider_stream_artifact":
      console.warn(`[anycode] dropping unparsable provider stream artifact: ${event.signature}`);
      return;
    case "include_usage_disabled":
      console.warn(
        `[anycode] ${event.baseUrl} (model ${event.model}) rejected stream_options.include_usage with HTTP 400 — ` +
          `disabling it for this endpoint. Token usage will not be tracked here. ` +
          `Set ANYCODE_INCLUDE_USAGE=0 to skip this probe and disable it permanently.`,
      );
      return;
  }
};
