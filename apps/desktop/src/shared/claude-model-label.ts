/**
 * Label suffix for extended-context Claude catalog entries (`opus[1m]`), so
 * they stay distinguishable from the ordinary alias in every picker.
 */
export function claudeModelSuffix(value: string): string {
  return value.endsWith("[1m]") ? " (1M)" : "";
}
