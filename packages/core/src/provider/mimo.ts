export function isMiMoModel(providerName?: string, modelId?: string): boolean {
  return (providerName === "Xiaomi MiMo API" || providerName?.startsWith("Xiaomi MiMo Token Plan (")) === true
    && /^(mimo-v2\.6-pro|mimo-v2\.6-flash)$/.test(modelId ?? "");
}
