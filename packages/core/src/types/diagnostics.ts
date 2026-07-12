/**
 * Named diagnostics seam (slice 5.6 Wave B): a typed, injectable sink
 * replacing the anonymous provider-artifact `console.warn` call. The default
 * sink reproduces the pre-5.6 behaviour byte-for-byte so callers that never
 * inject a custom sink (desktop, CLI) see zero behavioural change.
 */

export type DiagnosticEvent =
  | { kind: "provider_stream_artifact"; signature: string };

export type DiagnosticSink = (event: DiagnosticEvent) => void;

/** Default sink: reproduces the pre-5.6 console.warn bytes verbatim (behavior-preserving). */
export const consoleDiagnosticSink: DiagnosticSink = (event) => {
  switch (event.kind) {
    case "provider_stream_artifact":
      console.warn(`[anycode] dropping unparsable provider stream artifact: ${event.signature}`);
      return;
  }
};
