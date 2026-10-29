/** The host identity is authoritative, including null when it has no connection. */
export function modelSettingsTarget(
  hostConnectionId: string | null | undefined,
  pinnedConnectionId: string | undefined,
  legacyActiveConnectionId?: string,
): string | undefined {
  return hostConnectionId === undefined ? pinnedConnectionId ?? legacyActiveConnectionId : hostConnectionId ?? undefined;
}
