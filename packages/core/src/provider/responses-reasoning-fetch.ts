/** Unblock the SDK's early-error gate when reasoning_text is the first output. */
export function wrapResponsesReasoningFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    let unblocked = false;
    const transformFrame = (frame: string): string => {
      if (unblocked) return frame;
      const data = frame.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      try {
        const value: unknown = JSON.parse(data);
        if (typeof value === "object" && value !== null && "type" in value && (value.type === "response.reasoning_text.delta" || value.type === "response.reasoning_text.done")) {
          unblocked = true;
          // Index zero is a no-op in the SDK, but counts as recognized output.
          return 'data: {"type":"response.reasoning_summary_part.added","item_id":"__anycode_gate__","summary_index":0}\n\n' + frame;
        }
      } catch { /* Preserve non-JSON frames unchanged. */ }
      return frame;
    };
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r\n\r\n|\n\n|\r\r/.exec(pending)) !== null) {
          const end = match.index + match[0].length;
          controller.enqueue(encoder.encode(transformFrame(pending.slice(0, end))));
          pending = pending.slice(end);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(transformFrame(pending)));
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
