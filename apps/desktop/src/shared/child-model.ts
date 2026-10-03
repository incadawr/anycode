/** A model override is an exact id on the selected connection, never an alias
 * sent speculatively to an unrelated compatible API. */
export function assertChildModel(model: string, allowedModels: readonly string[]): void {
  if (!allowedModels.includes(model)) {
    throw new Error("This model is not available on the selected connection. Use its exact model ID and choose a matching provider/connection, or retry without a model override.");
  }
}
export function readAllowedChildModels(raw: string | undefined, currentModel: string): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (Array.isArray(value) && value.every(id => typeof id === "string")) return [...new Set([currentModel, ...value])];
  } catch { /* only the configured model is known */ }
  return [currentModel];
}
