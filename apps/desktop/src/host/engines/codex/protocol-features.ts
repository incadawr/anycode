import type { CodexProtocolFeatures } from "./protocol.js";

type SchemaObject = Record<string, unknown>;
function object(value: unknown): SchemaObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as SchemaObject : null;
}

/** Verify the registry and every lifecycle shape the maintenance operation consumes. */
export function decodeCodexProtocolFeatures(schema: unknown): CodexProtocolFeatures {
  const unsupported = { manualCompact: false };
  try {
    const root = object(schema);
    if (root === null) return unsupported;
    const resolve = (value: unknown): SchemaObject => {
      let node = object(value);
      const seen = new Set<string>();
      while (node?.$ref !== undefined) {
        const ref = node.$ref;
        if (typeof ref !== "string" || !ref.startsWith("#/") || seen.has(ref)) throw new Error("Invalid local reference");
        seen.add(ref);
        let target: unknown = root;
        for (const key of ref.slice(2).split("/")) target = object(target)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
        node = object(target);
      }
      if (node === null) throw new Error("Invalid schema object");
      return node;
    };
    const field = (node: SchemaObject, key: string): SchemaObject => resolve(object(node.properties)?.[key]);
    const required = (node: SchemaObject, key: string): boolean => Array.isArray(node.required) && node.required.includes(key);
    const string = (node: SchemaObject, key: string): boolean => required(node, key) && field(node, key).type === "string";
    const tagged = (node: SchemaObject, key: string, value: string): boolean => {
      const values = field(node, key).enum;
      return Array.isArray(values) && values.includes(value);
    };
    const definitions = object(root.definitions);
    const method = (registry: string, name: string): SchemaObject => {
      const variants = resolve(definitions?.[registry]).oneOf;
      if (!Array.isArray(variants)) throw new Error("Invalid method registry");
      const entry = variants.map(resolve).find(v => tagged(v, "method", name));
      if (!entry) throw new Error("Missing method registry entry");
      const params = field(entry, "params");
      if (params.type !== "object") throw new Error("Invalid method parameters");
      return params;
    };
    const params = method("ClientRequest", "thread/compact/start");
    if (!string(params, "threadId") || !Array.isArray(params.required) || params.required.some(key => key !== "threadId")) return unsupported;
    const response = resolve(object(definitions?.v2)?.ThreadCompactStartResponse);
    if (response.type !== "object" || (response.required !== undefined && (!Array.isArray(response.required) || response.required.length > 0))) return unsupported;
    for (const name of ["turn/started", "turn/completed"]) {
      const notification = method("ServerNotification", name);
      const turn = field(notification, "turn");
      if (!string(notification, "threadId") || !required(notification, "turn") || turn.type !== "object" || !string(turn, "id")) return unsupported;
      if (name === "turn/completed" && (!required(turn, "status") || !["completed", "interrupted", "failed"].every(status => tagged(turn, "status", status)))) return unsupported;
    }
    for (const name of ["item/started", "item/completed"]) {
      const notification = method("ServerNotification", name);
      if (!string(notification, "threadId") || !string(notification, "turnId") || !required(notification, "item")) return unsupported;
      const variants = field(notification, "item").oneOf;
      if (!Array.isArray(variants) || !variants.map(resolve).some(v => v.type === "object" && tagged(v, "type", "contextCompaction") && string(v, "id") && required(v, "type"))) return unsupported;
    }
    return { manualCompact: true };
  } catch {
    return unsupported;
  }
}
