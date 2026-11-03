export const RING_MAX_MSG_CHARS = 500;

export interface RemotePreview {
  type?: string;
  subtype?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
  preview?: { subtype?: string; overflow?: boolean; entries?: Array<{ key?: RemotePreview["preview"]; value: RemotePreview["preview"] }>; type?: string; description?: string; properties?: Array<{ name: string; type: string; value?: string; valuePreview?: RemotePreview["preview"] }> };
}

export function formatConsoleArguments(args: RemotePreview[]): string {
  const format = (arg: RemotePreview, nested = false, depth = 0): string => {
    if (depth > 5) return "…";
    if (arg.preview && (arg.subtype === "map" || arg.subtype === "set")) {
      const entries = (arg.preview.entries ?? []).slice(0, 50).map((entry) => {
        const value = format({ ...entry.value, preview: entry.value }, true, depth + 1);
        return entry.key ? `${format({ ...entry.key, preview: entry.key }, true, depth + 1)} => ${value}` : value;
      });
      if (arg.preview.overflow) entries.push("…");
      return `${arg.description ?? arg.subtype} {${entries.join(", ")}}`;
    }
    if (arg.description && (arg.type === "function" || ["date", "error", "regexp", "typedarray", "node", "promise"].includes(arg.subtype ?? ""))) return arg.description;
    if (arg.preview && ((arg.preview.properties?.length ?? 0) > 0 || arg.preview.overflow || arg.description === undefined)) {
      const array = arg.subtype === "array" || arg.preview.subtype === "array";
      const parts = (arg.preview.properties ?? []).slice(0, 50).map((p) => {
        const value = p.valuePreview ? format({ type: p.type, preview: p.valuePreview }, true, depth + 1)
          : p.type === "string" ? JSON.stringify(p.value ?? "") : (p.value ?? p.type);
        return array && /^\d+$/.test(p.name) ? value : `${p.name}: ${value}`;
      });
      if (arg.preview.overflow) parts.push("…");
      return array ? `[${parts.join(", ")}]` : `{${parts.join(", ")}}`;
    }
    if (arg.unserializableValue !== undefined) return arg.unserializableValue;
    if (arg.value !== undefined) {
      if (typeof arg.value === "string" && !nested) return arg.value;
      try { return JSON.stringify(arg.value) ?? String(arg.value); } catch { try { return String(arg.value); } catch { return "[unavailable]"; } }
    }
    return arg.type === "string" && nested && arg.description !== undefined ? JSON.stringify(arg.description) : arg.description ?? (arg.subtype === "null" ? "null" : arg.type ?? "undefined");
  };
  return args.map((arg) => format(arg)).join(" ").slice(0, RING_MAX_MSG_CHARS);
}
