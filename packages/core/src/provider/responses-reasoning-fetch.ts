/** Normalize gateway text segments and missing item starts before the SDK parses SSE. */
export function wrapResponsesReasoningFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    let unblocked = false;
    const items = new Map<string, string>();
    const fallbackKeys = new Map<string, string>();
    const completed = new Set<string>();
    const startedParts = new Set<string>();
    const synthesized = new Set<string>();
    const indices = new Map<number, string>();
    type Segment = { id: string; kind: string; text: string; matched: number; emitted: boolean; event: Record<string, unknown>; snapshot?: string; delivered?: string; offset?: number; terminal?: boolean };
    const seeds = new Map<string, Segment>();
    const addresses = new Map<string, { id: string; kind: string; index: number; closed: boolean }>();
    const resolve = (event: Record<string, unknown>, kind: string, reasoning: boolean) => {
      const explicit = typeof event.item_id === "string" ? event.item_id : (event.item as { id?: string } | undefined)?.id;
      const owner = typeof event.output_index === "number" ? indices.get(event.output_index) : undefined;
      const compatible = [...items].filter(([id, type]) => !completed.has(id) && type === (reasoning ? "reasoning" : "message"));
      const open = [...addresses].filter(([, a]) => a.kind === kind && !a.closed);
      let id = explicit ?? owner ?? (open.length === 1 ? open[0]![1].id : undefined)
        ?? (compatible.length === 1 ? compatible[0]![0] : undefined) ?? (reasoning ? "reasoning" : "message");
      const indexField = kind === "summary" ? "summary_index" : "content_index";
      const parts = open.filter(([, a]) => a.id === id);
      let index = typeof event[indexField] === "number" ? event[indexField] as number
        : parts.length === 1 ? parts[0]![1].index : 0;
      let key = JSON.stringify([id, kind, index]);
      const fallback = [...addresses].filter(([k, a]) => a.kind === kind && a.index === index
        && a.id === (reasoning ? "reasoning" : "message") && synthesized.has(a.id) && seeds.has(k));
      const added = String(event.type).endsWith("part.added");
      if (added) fallbackKeys.delete(key);
      if (!added && !addresses.has(key) && parts.length === 1 && seeds.get(parts[0]![0])?.emitted === false) {
        fallbackKeys.set(key, parts[0]![0]);
      }
      if (fallbackKeys.has(key)) key = fallbackKeys.get(key)!;
      else if (explicit && !addresses.has(key) && fallback.length === 1 && open.length <= 1 && !items.has(explicit)) {
        fallbackKeys.set(key, fallback[0]![0]);
        key = fallback[0]![0];
      }
      id = addresses.get(key)?.id ?? id;
      index = addresses.get(key)?.index ?? index;
      if (String(event.type).match(/(?:text\.(?:delta|done)|part\.(?:added|done))$/) && !addresses.has(key)) addresses.set(key, { id, kind, index, closed: false });
      const output = event.output_index === undefined ? undefined : [...indices].find(([, value]) => value === id)?.[0] ?? event.output_index;
      return { id, key, event: { ...event, item_id: id, ...(output === undefined ? {} : { output_index: output }), [indexField]: index } };
    };
    const flushSeeds = (id?: string, key?: string, kind?: string): string => {
      let result = "";
      for (const [partKey, seed] of seeds) {
        if ((id === undefined || seed.id === id || seed.event.item_id === id) && (key === undefined || partKey === key) && (kind === undefined || seed.kind === kind)) {
          if (!seed.emitted) result += encodeFrame(seed.event);
          if (!seed.emitted) seed.delivered = (seed.delivered ?? "") + seed.text;
          seed.emitted = true;
        }
      }
      return result;
    };
    const encodeFrame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const normalize = (value: unknown, frame: string): string => {
      if (typeof value !== "object" || value === null) return frame;
      const event = value as Record<string, unknown>;
      const type = event.type;
      const part = event.part as { type?: string; text?: string } | undefined;
      const summary = typeof type === "string" && type.startsWith("response.reasoning_summary_");
      const reasoning = summary || (typeof type === "string" && type.startsWith("response.reasoning_text.")) || part?.type === "reasoning_text"
        || (type === "response.content_part.done" && items.get(String(event.item_id)) === "reasoning");
      const added = type === "response.content_part.added" || type === "response.reasoning_summary_part.added";
      const kind = summary ? "summary" : reasoning ? "reasoning" : "text";
      const resolved = resolve(event, kind, reasoning);
      const { id, key } = resolved;
      const normalized: Record<string, unknown> = resolved.event;
      if (added) { addresses.get(key)!.closed = false; startedParts.add(key); }
      if (type === "response.content_part.done" || type === "response.reasoning_summary_part.done") {
        if (addresses.has(key)) addresses.get(key)!.closed = true;
        return flushSeeds(id, key) + (event.item_id === id && event.content_index === normalized.content_index
          && event.summary_index === normalized.summary_index && event.output_index === normalized.output_index ? frame : encodeFrame(normalized));
      }
      if (type === "response.completed" || type === "response.failed" || type === "error") return flushSeeds() + frame;
      if (type === "response.output_item.added") {
        const item = event.item as { id?: string; type?: string } | undefined;
        if (item?.id && item.type) {
          if (typeof event.output_index === "number") indices.set(event.output_index, item.id);
          if (synthesized.delete(item.id)) return "";
          items.set(item.id, item.type);
        }
        return frame;
      }
      if (type === "response.output_item.done") {
        const pendingSeeds = flushSeeds(id);
        completed.add(id);
        for (const a of addresses.values()) if (a.id === id) a.closed = true;
        const item = event.item as { id?: string; type?: string } | undefined;
        if (item?.type === "reasoning" && item.id && !items.has(item.id)) {
          items.set(item.id, item.type);
          return pendingSeeds + encodeFrame({ type: "response.output_item.added", output_index: event.output_index ?? 0, item }) + frame;
        }
        return pendingSeeds + frame;
      }
      const seed = (type === "response.content_part.added" || type === "response.reasoning_summary_part.added")
        && typeof part?.text === "string" && part.text !== "";
      const text = type === "response.output_text.delta" || type === "response.output_text.done" || (seed && part?.type === "output_text");
      if (!text && !reasoning) return frame;
      if (typeof normalized.output_index === "number" && !indices.has(normalized.output_index)) indices.set(normalized.output_index, id);
      let prefix = "";
      const indexField = summary ? "summary_index" : "content_index";
      if (typeof event.delta === "string" && event[indexField] === undefined
        && [...addresses.values()].filter(a => a.id === id && a.kind === kind && !a.closed).length > 1) {
        prefix += flushSeeds(id, undefined, kind);
      }
      if (!items.has(id)) {
        const itemType = reasoning ? "reasoning" : "message";
        items.set(id, itemType);
        synthesized.add(id);
        prefix += encodeFrame({ type: "response.output_item.added", output_index: event.output_index ?? 0, item: { type: itemType, id } });
      }
      if (summary && Number(normalized.summary_index) > 0 && !startedParts.has(key)) {
        startedParts.add(key);
        prefix += encodeFrame({ ...normalized,
          type: "response.reasoning_summary_part.added", part: { type: "summary_text", text: "" } });
      }
      if (seed) {
        const previous = seeds.get(key);
        if (previous) {
          const snapshot = previous.snapshot ?? previous.text;
          if (part!.text === snapshot || previous.delivered?.startsWith(part!.text!)) return prefix + frame;
          if (previous.delivered && !part!.text!.startsWith(previous.delivered)) return prefix + frame;
          if (part!.text!.startsWith(snapshot)) {
            previous.snapshot = part!.text;
            if (previous.emitted) {
              previous.offset = previous.delivered?.length ?? (previous.offset ?? 0) + previous.text.length;
              previous.text = part!.text!.slice(previous.offset);
              previous.matched = 0;
              previous.emitted = false;
            } else previous.text = part!.text!.slice(previous.offset ?? 0);
            previous.event = { ...previous.event, delta: previous.text };
            return prefix + frame;
          }
          if (previous.emitted) return prefix + frame;
        }
        prefix += flushSeeds(undefined, key);
        seeds.set(key, { id, kind, text: part!.text!, matched: 0, emitted: false, event: { ...normalized,
          type: summary ? "response.reasoning_summary_text.delta" : text ? "response.output_text.delta" : "response.reasoning_text.delta",
          item_id: id, delta: part!.text,
        } });
        return prefix + frame;
      }
      const textDone = typeof type === "string" && /^response\.(output_text|reasoning_text|reasoning_summary_text)\.done$/.test(type);
      if (typeof event.delta === "string" || textDone) {
        const held = seeds.get(key);
        if (held?.terminal) return prefix + (textDone ? encodeFrame(normalized) : "");
        if (held && !held.emitted) {
          const incoming = textDone ? (typeof event.text === "string" ? event.text.slice(held.offset ?? 0) : "") : event.delta as string;
          const accumulated = textDone ? incoming : held.text.slice(0, held.matched) + incoming;
          if (!textDone && accumulated !== held.text && held.text.startsWith(accumulated)) {
            held.matched = accumulated.length;
            return prefix;
          }
          const reconciled = accumulated.startsWith(held.text) ? accumulated
            : textDone && held.text.startsWith(accumulated) ? held.text : held.text + accumulated;
          held.delivered = (held.delivered ?? "") + reconciled;
          held.emitted = true;
          held.terminal = textDone;
          // Preview, delta and done share this single emission path.
          return prefix + encodeFrame({ ...held.event, item_id: id,
            output_index: normalized.output_index ?? held.event.output_index,
            content_index: normalized.content_index, summary_index: normalized.summary_index,
            delta: reconciled }) + (textDone ? encodeFrame(normalized) : "");
        }
        if (held?.emitted && !textDone) held.delivered = (held.delivered ?? "") + event.delta;
        // Done-only parts use the same delta source as preview reconciliation.
        if (textDone && !held && typeof event.text === "string" && event.text !== "") {
          seeds.set(key, { id, kind, text: "", matched: 0, emitted: true, terminal: true, event: normalized });
          return prefix + encodeFrame({ ...normalized, type: String(type).replace(/done$/, "delta"), delta: event.text })
            + encodeFrame(normalized);
        }
        if (!textDone && !held && event.delta !== "") {
          seeds.set(key, { id, kind, text: "", matched: 0, emitted: true, delivered: event.delta as string, event: normalized });
        }
      }
      return prefix + (event.item_id === id && event.content_index === normalized.content_index
        && event.summary_index === normalized.summary_index && event.output_index === normalized.output_index ? frame : encodeFrame(normalized));
    };
    const transformFrame = (frame: string): string => {
      const data = frame.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      try {
        const value: unknown = JSON.parse(data);
        const type = typeof value === "object" && value !== null && "type" in value ? value.type : undefined;
        frame = normalize(value, frame);
        if (!unblocked && (typeof type !== "string" || !["response.created", "response.failed", "error"].includes(type))) {
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
        while ((match = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/.exec(pending)) !== null) {
          const end = match.index + match[0].length;
          if (end === pending.length && pending.endsWith("\r")) break;
          controller.enqueue(encoder.encode(transformFrame(pending.slice(0, end))));
          pending = pending.slice(end);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(transformFrame(pending)));
        controller.enqueue(encoder.encode(flushSeeds()));
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
