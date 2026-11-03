export const RING_MAX_MSG_CHARS = 500;

export interface RemotePreview {
  type?: string;
  subtype?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
  preview?: { subtype?: string; overflow?: boolean; properties?: Array<{ name: string; type: string; value?: string; valuePreview?: RemotePreview["preview"] }> };
}

export function formatConsoleArguments(args: RemotePreview[]): string {
  const format = (arg: RemotePreview, nested = false): string => {
    if (arg.preview) {
      const array = arg.subtype === "array" || arg.preview.subtype === "array";
      const parts = (arg.preview.properties ?? []).map((p) => {
        const value = p.valuePreview ? format({ type: p.type, preview: p.valuePreview }, true)
          : p.type === "string" ? JSON.stringify(p.value ?? "") : (p.value ?? p.type);
        return array && /^\d+$/.test(p.name) ? value : `${p.name}: ${value}`;
      });
      if (arg.preview.overflow) parts.push("…");
      return array ? `[${parts.join(", ")}]` : `{${parts.join(", ")}}`;
    }
    if (arg.unserializableValue !== undefined) return arg.unserializableValue;
    if (arg.value !== undefined) return typeof arg.value === "string" && !nested ? arg.value : JSON.stringify(arg.value);
    return arg.description ?? (arg.subtype === "null" ? "null" : arg.type ?? "undefined");
  };
  return args.map((arg) => format(arg)).join(" ").slice(0, RING_MAX_MSG_CHARS);
}
