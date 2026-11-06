import { describe, expect, it } from "vitest";
import { mergeRuntimeHistory, scopeRuntimeHistory } from "./runtime-history.js";
import type { HistoryItem } from "../types/history.js";
import type { RuntimeHandoff } from "../ports/runtime-segments.js";

const user = (id: string,text=id): HistoryItem => ({ id,createdAt:1,turnId:"turn",message:{role:"user",content:text} });
describe("segment-aware canonical merge", () => {
  it("keeps colliding native item ids and stable turn ids across segments, idempotently", () => {
    const first = mergeRuntimeHistory([],"a",[user("same","first")]);
    const both = mergeRuntimeHistory(first,"b",[user("same","second")]);
    expect(both.map(item => item.id)).toEqual(["segment:a:same","segment:b:same"]);
    expect(both.map(item => item.turnId)).toEqual(["turn","turn"]);
    expect(mergeRuntimeHistory(both,"b",[user("same","second")])).toEqual(both);
    expect(mergeRuntimeHistory(both,"b",scopeRuntimeHistory("b",[user("same","second")]))).toEqual(both);
  });
  it("preserves tools, images and compaction coverage as display data", () => {
    const items: HistoryItem[] = [
      {...user("image"),message:{role:"user",content:"photo",images:[{mediaType:"image/png",data:"AA=="}]}},
      {id:"tool",createdAt:2,message:{role:"tool",content:[{type:"tool_result",toolCallId:"call",toolName:"Read",text:"full result",status:"success"}]}},
      {...user("summary"),kind:"compact_summary"},
    ];
    expect(mergeRuntimeHistory([],"native",items).map(item => item.message)).toEqual(items.map(item => item.message));
    expect(mergeRuntimeHistory(scopeRuntimeHistory("native",items),"native",[])).toHaveLength(3);
  });
  it("normalizes the one recorded injection without synthetic-message growth or prefix heuristics", () => {
    const handoff: RuntimeHandoff = {id:"h",segmentId:"b",sourceWatermark:"a:last",payload:"excerpt",digest:"digest",state:"accepted",turnId:"outer",originalText:"typed",injectedText:"excerpt\n\n# user (current message)\ntyped"};
    const merged = mergeRuntimeHistory(scopeRuntimeHistory("a",[user("old")]),"b",[user("new",handoff.injectedText!)],handoff);
    expect(merged.at(-1)).toMatchObject({turnId:"outer",message:{role:"user",content:"typed"}});
    expect(mergeRuntimeHistory(merged,"b",[user("new",handoff.injectedText!)],handoff)).toEqual(merged);
    expect(scopeRuntimeHistory("b",[user("other","excerpt legit text")],handoff)[0]?.message.content).toBe("excerpt legit text");
    expect(() => mergeRuntimeHistory(merged,"b",scopeRuntimeHistory("a",[user("old")]))).toThrow("another runtime");
  });
});
