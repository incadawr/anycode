import { createServer, type Server } from "node:http";
import { generateText, streamText } from "ai";
import { createOpenAIResponsesLanguageModel } from "./openai-responses.js";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "../types/events.js";
import type { EndpointConfig } from "./endpoint.js";
import { AiSdkModelPort } from "./model-port.js";
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const result:T[]=[]; for await(const item of items) result.push(item); return result; }
const created = () => ({type:"response.created",response:{id:"resp_1",created_at:1700000000,model:"gpt-oss"}});
const completed = () => ({type:"response.completed",response:{usage:{input_tokens:5,input_tokens_details:{cached_tokens:0},output_tokens:4,output_tokens_details:{reasoning_tokens:0}}}});
const added = {type:"response.output_item.added",output_index:0,item:{type:"reasoning",id:"rs_1"}};
const delta = (text:string) => ({type:"response.reasoning_text.delta",item_id:"rs_1",content_index:0,delta:text});
const done = (texts:string[]) => ({type:"response.output_item.done",output_index:0,item:{type:"reasoning",id:"rs_1",summary:[],content:texts.map(text=>({type:"reasoning_text",text}))}});
const message = [{type:"response.output_item.added",output_index:1,item:{type:"message",id:"msg_1"}},{type:"response.output_text.delta",item_id:"msg_1",delta:"ok"},{type:"response.output_item.done",output_index:1,item:{type:"message",id:"msg_1"}}];
const req = {messages:[{role:"user" as const,content:"hi"}],tools:[]};
const reasoning = (events:ModelStreamEvent[]) => events.filter(e=>e.type.startsWith("reasoning_"));
const text = (events:ModelStreamEvent[]) => events.filter((e):e is Extract<ModelStreamEvent,{type:"reasoning_delta"}>=>e.type==="reasoning_delta").map(e=>e.text).join("");
describe("Responses reasoning text over SSE (#27)",()=>{
 let server:Server; let baseUrl:string; let frames:Array<{chunk:Record<string,unknown>;delayMs?:number}>; let holdOpen:boolean;
 beforeEach(async()=>{ frames=[]; holdOpen=false; server=createServer((req,res)=>{req.resume(); req.on("end",async()=>{res.writeHead(200,{"content-type":"text/event-stream"}); for(const frame of frames){if(frame.delayMs) await new Promise(r=>setTimeout(r,frame.delayMs)); if(!res.destroyed) res.write(`data: ${JSON.stringify(frame.chunk)}\n\n`);} if(!holdOpen) res.end();});}); await new Promise<void>(r=>server.listen(0,"127.0.0.1",r)); baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; });
 afterEach(async()=>{server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));});
 function portFor(retry:NonNullable<EndpointConfig["retry"]>={}) {return new AiSdkModelPort({transport:"openai-responses",baseUrl,apiKey:"test-key",model:"gpt-oss",retry:{maxRetries:0,stallTimeoutMs:5000,...retry}});}
 function set(...chunks:Record<string,unknown>[]) {frames=chunks.map(chunk=>({chunk}));}
 it("streams reasoning_text deltas into the block the SDK opened, without duplicating done or content",async()=>{set(created(),added,delta("First, "),delta("check the file."),{type:"response.reasoning_text.done",item_id:"rs_1",content_index:0,text:"First, check the file."},done(["First, check the file."]),...message,completed()); const e=await collect(portFor().streamText(req)); expect(reasoning(e)).toEqual([{type:"reasoning_start",id:"rs_1:0"},{type:"reasoning_delta",id:"rs_1:0",text:"First, "},{type:"reasoning_delta",id:"rs_1:0",text:"check the file."},{type:"reasoning_end",id:"rs_1:0"}]); expect(e.findIndex(x=>x.type==="reasoning_end")).toBeLessThan(e.findIndex(x=>x.type==="text_delta")); expect(e).toContainEqual(expect.objectContaining({type:"text_delta",text:"ok"})); expect(e.filter(x=>x.type==="error")).toEqual([]);});
 it("delivers reasoning while the server is still holding the stream open", async () => {
   set(created(), delta("Live thinking"));
   holdOpen = true;
   const abort = new AbortController();
   const iterator = portFor().streamText({...req, abortSignal: abort.signal})[Symbol.asyncIterator]();
   try {
     const received = await Promise.race([
       (async () => { for (;;) { const next = await iterator.next(); if (next.done || next.value.type === "reasoning_delta") return next; } })(),
       new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reasoning was buffered")), 1500)),
     ]);
     expect(received.value).toEqual({type:"reasoning_delta", id:"rs_1:0", text:"Live thinking"});
   } finally { abort.abort(); await iterator.return?.(); }
 });
 it("recovers final content parts after streamed reasoning", async () => {
   set(created(), added, delta("A"), done(["A", "B"]), ...message, completed());
   expect(text(await collect(portFor().streamText(req)))).toBe("A\n\nB");
 });
 it("recovers reasoning content from a non-streaming response", async () => {
   server.removeAllListeners("request");
   server.on("request", (request, response) => {
     request.resume();
     request.on("end", () => {
       response.writeHead(200, {"content-type":"application/json"});
       response.end(JSON.stringify({id:"resp_1", object:"response", created_at:1700000000, model:"gpt-oss", output:[{type:"reasoning", id:"rs_1", summary:[], content:[{type:"reasoning_text",text:"Think."}]}], usage:{input_tokens:5, output_tokens:4}}));
     });
   });
   const model = createOpenAIResponsesLanguageModel({transport:"openai-responses",baseUrl,apiKey:"test-key",model:"gpt-oss"});
   const result = await generateText({model, prompt:"hi"});
   expect(result.reasoningText).toBe("Think.");
 });
 it("shows reasoning item content when no reasoning_text deltas were streamed",async()=>{set(created(),added,done(["Plan A.","Plan B."]),...message,completed()); expect(reasoning(await collect(portFor().streamText(req)))).toEqual([{type:"reasoning_start",id:"rs_1:0"},{type:"reasoning_delta",id:"rs_1:0",text:"Plan A.\n\nPlan B."},{type:"reasoning_end",id:"rs_1:0"}]);});
 it("keeps reasoning summaries as the only reasoning when an item also streams reasoning_text",async()=>{set(created(),added,{type:"response.reasoning_summary_part.added",item_id:"rs_1",summary_index:0},{type:"response.reasoning_summary_text.delta",item_id:"rs_1",summary_index:0,delta:"Summary."},delta("raw thoughts"),{type:"response.reasoning_summary_part.done",item_id:"rs_1",summary_index:0},done(["raw thoughts"]),...message,completed()); expect(text(await collect(portFor().streamText(req)))).toBe("Summary.");});
 it("survives a reasoning phase longer than the stall timeout while reasoning_text keeps arriving (#27)",async()=>{frames=[{chunk:created()},...Array.from({length:20},(_,i)=>({chunk:delta(`s${i} `),delayMs:50})),...message.map(chunk=>({chunk})),{chunk:completed()}]; const e=await collect(portFor({stallTimeoutMs:400}).streamText(req)); expect(e.filter(x=>x.type==="stream_retry"||x.type==="error")).toEqual([]); expect(text(e)).toBe(Array.from({length:20},(_,i)=>`s${i} `).join("")); expect(e.findIndex(x=>x.type==="reasoning_start")).toBeLessThan(e.findIndex(x=>x.type==="reasoning_delta")); expect(e.findIndex(x=>x.type==="reasoning_end")).toBeLessThan(e.findIndex(x=>x.type==="finish")); expect(e).toContainEqual(expect.objectContaining({type:"text_delta",text:"ok"}));});
 it("passes a prolonged unknown-event stream through the SDK gate while still open", async () => {
   frames=[{chunk:created()},...Array.from({length:200},(_,i)=>({chunk:{type:"vendor.unknown",sequence:i},delayMs:2}))];
   holdOpen=true;
   const abort=new AbortController();
   const model=createOpenAIResponsesLanguageModel({transport:"openai-responses",baseUrl,apiKey:"test-key",model:"gpt-oss"});
   const stream=streamText({model,prompt:"hi",includeRawChunks:true,abortSignal:abort.signal}).fullStream;
   try {
     const count=await Promise.race([(async()=>{let n=0; for await(const part of stream) { if(part.type==="raw" && (part.rawValue as {type?:string}).type==="vendor.unknown" && ++n===200) return n; } return n;})(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("unknown events buffered")),3000))]);
     expect(count).toBe(200);
   } finally { abort.abort(); }
 });
 it("keeps consuming unknown events beyond the timeout, then stalls on silence", async () => {
   frames=[{chunk:created()},...Array.from({length:30},(_,i)=>({chunk:{type:"vendor.unknown",sequence:i},delayMs:40}))];
   holdOpen=true;
   const started=Date.now();
   await expect(collect(portFor({stallTimeoutMs:250}).streamText(req))).rejects.toThrow(/stream stalled: no events for 250ms/);
   expect(Date.now()-started).toBeGreaterThan(1200);
 });
 it("still stalls when the response goes silent (#27)",async()=>{set(created()); holdOpen=true; await expect(collect(portFor({stallTimeoutMs:200}).streamText(req))).rejects.toThrow(/stream stalled: no events for 200ms/);});
 it("streams text and a function call unchanged through the activity tap",async()=>{set(created(),{type:"response.output_item.added",output_index:0,item:{type:"function_call",id:"item_1",call_id:"call_1",name:"Read",arguments:""}},{type:"response.function_call_arguments.delta",item_id:"item_1",output_index:0,delta:'{"file_path"'},{type:"response.function_call_arguments.delta",item_id:"item_1",output_index:0,delta:':"/a.txt"}'},{type:"response.output_item.done",output_index:0,item:{type:"function_call",id:"item_1",call_id:"call_1",name:"Read",arguments:'{"file_path":"/a.txt"}',status:"completed"}},completed()); const e=await collect(portFor().streamText({...req,tools:[{name:"Read",description:"Reads a file",inputJsonSchema:{type:"object",properties:{file_path:{type:"string"}},required:["file_path"]}}]})); expect(e).toContainEqual(expect.objectContaining({type:"tool_call",toolCall:expect.objectContaining({id:"call_1",name:"Read",input:{file_path:"/a.txt"}})})); expect(e).toContainEqual(expect.objectContaining({type:"finish",finishReason:"tool_calls"})); expect(e.filter(x=>x.type==="error")).toEqual([]);});
});
