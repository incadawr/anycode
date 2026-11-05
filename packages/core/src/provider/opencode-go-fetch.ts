import type { EndpointConfig } from "./endpoint.js";

/** Remove SDK defaults that this specific Go model has not declared. */
export function wrapOpenCodeGoFetch(fetcher: typeof fetch, config: EndpointConfig): typeof fetch {
  const policy = config.goModelPolicy;
  if (!policy) return fetcher;
  return (input, init) => {
    if (typeof init?.body !== "string") return fetcher(input, init);
    const body = JSON.parse(init.body) as Record<string, any>;
    if (policy.capabilities?.temperature !== true) delete body.temperature;
    const choice = body.tool_choice;
    const kind = typeof choice === "string" ? choice : choice?.type === "any" ? "required" : choice?.type;
    if (kind && !policy.apiCapabilities?.tools?.choice?.includes(kind)) delete body.tool_choice;
    if (policy.apiCapabilities?.tools?.strict !== true && Array.isArray(body.tools)) {
      for (const tool of body.tools) { delete tool.strict; if (tool.function) delete tool.function.strict; }
    }
    if (config.transport !== "openai-chat-completions") delete body.stream_options;
    if (config.transport === "anthropic-messages" && config.goDisableThinking) body.thinking = { type: "disabled" };
    return fetcher(input, { ...init, body: JSON.stringify(body) });
  };
}
