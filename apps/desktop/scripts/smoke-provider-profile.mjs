/** v2-only smoke seeding. Env-key fixtures are isolated; vault-backed runs
 * must reuse an existing connection id so its credential still resolves. */
export function smokeProviderProfile(providerId, model, { credentialFromEnv = false, sourceSettings } = {}) {
  const source = sourceSettings?.provider?.connections?.find(connection => connection.providerId === providerId);
  if (!credentialFromEnv && !source) throw new Error("Smoke needs an existing connection ID or an explicit env credential; a synthetic vault ID cannot authenticate.");
  const connection = source ? { ...source, model } : { id: `conn-smoke-${providerId}`, providerId, label: "Isolated smoke", model };
  delete connection.reasoningEffort;
  delete connection.lastHealth;
  return {
    activeConnectionId: connection.id, connections: [connection],
    ...(sourceSettings?.provider?.custom ? { custom: sourceSettings.provider.custom } : {}),
  };
}
export function activeSmokeConnection(settings) {
  return settings?.provider?.connections?.find(connection => connection.id === settings.provider.activeConnectionId);
}
