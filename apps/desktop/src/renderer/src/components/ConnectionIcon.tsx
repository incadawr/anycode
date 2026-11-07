import type { CSSProperties, ReactElement } from "react";
import type { ProviderConnection } from "../../../shared/settings.js";

export const CONNECTION_ICON_COLORS = ["#8B90A0", "#5B8DEF", "#2FA8C9", "#5E9E6E", "#D2A044", "#E0743C", "#C4584F", "#8B7CF6"] as const;

export function connectionIconDefaults(connection: ProviderConnection, providerName: string): { text: string; color: string } {
  const name = connection.label?.trim() || providerName.trim() || "Custom";
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const text = (words.length > 1 ? words.slice(0, 2).map(word => Array.from(word)[0]).join("") : Array.from(words[0] ?? "C").slice(0, 2).join("")).toUpperCase();
  let hash = 0;
  for (const char of connection.providerId) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { text, color: CONNECTION_ICON_COLORS[hash % CONNECTION_ICON_COLORS.length]! };
}

export function ConnectionIcon({ connection, providerName }: { connection: ProviderConnection | undefined; providerName: string }): ReactElement | null {
  if (!connection) return null;
  const icon = connectionIconDefaults(connection, providerName);
  return <span className="connection-icon" title={connection.label?.trim() || providerName} style={{ "--connection-icon-color": icon.color } as CSSProperties} aria-hidden="true">{icon.text}</span>;
}
