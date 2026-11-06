import { afterEach, expect, it, vi } from "vitest";
import { AiSdkModelPort } from "./model-port.js";

type Frame = Record<string, unknown>;
const kinds = ["output_text", "reasoning_text", "reasoning_summary_text"];
function part(kind: string, id: string, output: number, index = 0) {
  const summary = kind === "reasoning_summary_text";
  const address = { item_id: id, output_index: output, [summary ? "summary_index" : "content_index"]: index };
  const item = { id, type: kind === "output_text" ? "message" : "reasoning" };
  return {
    add: { type: "response.output_item.added", output_index: output, item },
    seed: (text: string) => ({ type: summary ? "response.reasoning_summary_part.added" : "response.content_part.added", ...address, part: { type: summary ? "summary_text" : kind, text } }),
    delta: (delta: string) => ({ type: `response.${kind}.delta`, ...address, delta }),
    done: (text: string) => ({ type: `response.${kind}.done`, ...address, text }),
    close: { type: summary ? "response.reasoning_summary_part.done" : "response.content_part.done", ...address },
    end: { type: "response.output_item.done", output_index: output, item },
  };
}
afterEach(() => vi.unstubAllGlobals());
async function run(frames: Frame[], size: number, label = "fixture") {
  const bytes = new TextEncoder().encode([
    { type: "response.created", response: { id: "r", created_at: 1, model: "fixture" } }, ...frames,
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
    c.close();
  } }), { headers: { "content-type": "text/event-stream" } }));
  const port = new AiSdkModelPort({ transport: "openai-responses", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: "fixture", retry: { maxRetries: 0 } });
  const texts: Record<string, string> = {};
  const errors = [];
  for await (const event of port.streamText({ messages: [{ role: "user", content: "hi" }], tools: [] })) {
    if (event.type === "error") errors.push(event);
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      const id = event.id.replace(/:\d+$/, "");
      texts[id] = (texts[id] ?? "") + event.text;
    }
  }
  expect(errors, label).toEqual([]);
  return texts;
}
for (const kind of kinds) {
  it.each([1, 7, 100000])(`${kind}: declared items cannot borrow previews (%s bytes)`, async size => {
    const a = part(kind, "a", 0), b = part(kind, "b", 1);
    const seed = a.seed("Alpha");
    delete (seed as Frame).output_index;
    expect(await run([a.add, seed, b.add, b.seed(""), b.delta("Bravo"), b.done("Bravo"), b.close,
      a.delta("Alpha"), a.done("Alpha"), a.close, a.end, b.end], size)).toEqual({ b: "Bravo", a: "Alpha" });
  });
  it.each([1, 7, 100000])(`${kind}: repeated preview retains prefix (%s bytes)`, async size => {
    const a = part(kind, "a", 0);
    expect(await run([a.add, a.seed("Kafka down"), a.delta("K"), a.seed("Kafka down"), a.delta("afka down"),
      a.done("Kafka down"), a.close, a.end], size)).toEqual({ a: "Kafka down" });
  });
  it.each([1, 7, 100000])(`${kind}: anonymous delta and identified done (%s bytes)`, async size => {
    const a = part(kind, "a", 0), delta: Frame = a.delta("Hi");
    delete delta.item_id; delete delta.output_index;
    expect(await run([a.add, delta, a.done("Hi"), a.close, a.end], size)).toEqual({ a: "Hi" });
  });
  it.each([1, 7, 100000])(`${kind}: extended previews preserve progress (%s bytes)`, async size => {
    const a = part(kind, "a", 0);
    expect(await run([a.add, a.seed("Kafka down"), a.delta("K"), a.seed("Kafka down!"),
      a.delta("afka down!"), a.done("Kafka down!"), a.close, a.end], size)).toEqual({ a: "Kafka down!" });
    expect(await run([a.add, a.seed("Hello"), a.delta("Hello"), a.seed("Hello world"),
      a.delta(" world"), a.done("Hello world"), a.close, a.end], size)).toEqual({ a: "Hello world" });
  });
  it(`${kind}: separately declared indices own their text`, async () => {
    const a = part(kind, "a", 0), b = part(kind, "a", 0, 1);
    expect(await run([a.add, a.seed("Alpha"), b.seed(""), b.delta("Bravo"), b.done("Bravo"), b.close,
      a.delta("Alpha"), a.done("Alpha"), a.close, a.end], 7)).toEqual({
      a: kind === "reasoning_text" ? "Alpha\n\nBravo" : "BravoAlpha",
    });
  });
  it(`${kind}: undeclared explicit owners and indices cannot borrow previews`, async () => {
    const a = part(kind, "a", 0), x = part(kind, "x", 1), b = part(kind, "a", 0, 1);
    expect(await run([a.add, a.seed("Alpha"), x.delta("Bravo"), x.done("Bravo"),
      a.delta("Alpha"), a.close, a.end, x.end], 7)).toEqual({ x: "Bravo", a: "Alpha" });
    const start = b.seed("");
    expect(await run([a.add, a.seed("Alpha"), start, b.delta("Bravo"), b.done("Bravo"), b.close,
      a.delta("Alpha"), a.close, a.end], 7)).toEqual({ a: kind === "reasoning_text" ? "Alpha\n\nBravo" : "BravoAlpha" });
  });
  it(`${kind}: changed preview preserves preceding text`, async () => {
    const a = part(kind, "a", 0);
    expect(await run([a.add, a.seed("First."), a.delta("Fi"), a.seed("Second."), a.delta("Sec"),
      a.delta("ond."), a.done("Second."), a.close, a.end], 7)).toEqual({ a: "First.Second." });
  });
}

it("matches a deterministic stream model (printable seed on failure)", async () => {
  const covered = new Set<string>();
  const mark = (name: string) => covered.add(name);
  for (const seed of [1, 17, 42, 12345, 0xdeadbeef, 0xabcdef]) {
    let state = seed;
    const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state >>> 8) % n; };
    for (const kind of kinds) {
      const h = part(kind, "identified", 0), d: Frame = h.delta(`F${random(100)}`);
      delete d.item_id; delete d.output_index;
      const fallbackId = kind === "output_text" ? "message" : "reasoning";
      const label = `seed=${seed}, fallback=${kind}`;
      expect(await run([d, h.done(String(d.delta)), h.close, h.done(String(d.delta))], 7, label), label)
        .toEqual({ [fallbackId]: d.delta });
      mark("deterministic-fallback");
    }
    for (let trial = 0; trial < 5; trial++) {
      const queues: Frame[][] = [], prefix: Frame[] = [], expected: Record<string, string> = {};
      // Separate items for raw reasoning and summaries: recovery intentionally prefers summaries.
      for (let output = 0; output < 6; output++) {
        const kind = kinds[output % 3]!, id = `item${output}`;
        const first = part(kind, id, output), queue: Frame[] = [first.add];
        const count = 1 + random(3), texts: string[] = [];
        for (let index = 0; index < count; index++) {
          const h = part(kind, id, output, index), text = `P${output}/${index}:思-${random(100)}!`;
          texts.push(text);
          const preview = random(2) === 0, doneOnly = random(4) === 0;
          const omitted = random(3) === 0;
          if (!omitted) queue.push(h.seed(preview ? text.slice(0, -1) : ""));
          else mark("omitted-part-added");
          if (doneOnly) mark("done-only");
          if (!doneOnly) {
            for (let at = 0; at < text.length;) {
              const end = Math.min(text.length, at + 1 + random(5));
              const delta: Frame = h.delta(text.slice(at, end));
              const missing = random(4);
              if (missing === 0) { delete delta.item_id; mark("index-owner"); }
              if (missing === 1) { delete delta.output_index; mark("id-owner"); }
              if (missing === 2 && (!omitted || at > 0)) { delete delta[kind === "reasoning_summary_text" ? "summary_index" : "content_index"]; mark("open-part-index"); }
              queue.push(delta);
              if (preview && !omitted && random(3) === 0) {
                queue.push(h.seed(text), h.seed(text)); mark("extended-and-repeated");
              }
              at = end;
            }
          }
          if (doneOnly && random(2) === 0) {
            queue.push(h.done(text), h.delta(text)); mark("done-before-delta");
          }
          queue.push(h.done(text));
          if (preview && !omitted) { queue.push(h.seed("contradiction")); mark("changed-after-emission"); }
          queue.push(h.close, h.done(text)); mark("repeated-done");
        }
        queue.push(first.end); queues.push(queue);
        // Prime a sole compatible owner before interleaving: fully anonymous deltas,
        // omitted part starts, then identified done must use the same key.
        if (output < 3) {
          const anon = part(kind, `anon${output}`, output + 10), d: Frame = anon.delta("Hi");
          delete d.item_id; delete d.output_index;
          delete d[kind === "reasoning_summary_text" ? "summary_index" : "content_index"];
          prefix.push(anon.add, d, anon.done("Hi"), anon.close, anon.done("Hi"), anon.end);
          expected[`anon${output}`] = "Hi"; mark("anonymous-owner");
        }
        expected[id] = texts.join(kind === "reasoning_text" ? "\n\n" : "");
      }
      const frames: Frame[] = [...prefix];
      while (queues.some(q => q.length)) {
        const live = queues.filter(q => q.length);
        frames.push(live[random(live.length)]!.shift()!);
        if (live.length > 1) mark("interleaved");
      }
      const label = `seed=${seed}, trial=${trial}`;
      expect(await run(frames, [1, 7, 100000][trial % 3]!, label), label).toEqual(expected);
    }
  }
  expect([...covered].sort()).toEqual(["anonymous-owner", "changed-after-emission", "deterministic-fallback", "done-before-delta", "done-only", "extended-and-repeated", "id-owner",
    "index-owner", "interleaved", "omitted-part-added", "open-part-index", "repeated-done"].sort());
}, 10000);
