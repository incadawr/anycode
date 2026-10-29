/**
 * Byte-level liveness tap for the openai-responses transport (GitHub #27).
 * `@ai-sdk/openai` withholds every stream part (raw parts included) until the
 * first event it recognizes as output and maps unknown event types (e.g.
 * `response.reasoning_text.delta`) to nothing, so a provider that streams only
 * such events looks silent to the stall watchdog. This wrapper reports
 * activity once when response headers arrive and once per body chunk, without
 * altering bytes, status or headers. Non-ok and body-less responses are
 * returned as the same instance; observer failures are swallowed.
 */
export function wrapFetchWithActivity(fetchImpl: typeof fetch, onActivity: () => void): typeof fetch {
  const notify = (): void => {
    try {
      onActivity();
    } catch {
      // Liveness telemetry must never fail a model call.
    }
  };
  return async (input, init) => {
    const res = await fetchImpl(input, init);
    notify();
    if (!res.ok || res.body === null || res.status === 204 || res.status === 205) {
      return res;
    }
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read(); // a rejection errors this stream with the SAME reason
        if (done) {
          controller.close();
          return;
        }
        notify();
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
