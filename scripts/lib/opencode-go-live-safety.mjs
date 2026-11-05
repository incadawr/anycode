/** Fail closed unless a listing explicitly prices this text-only Chat route at zero. */
export function isFreeChatGoModel(row) {
  const input = row?.cost?.text?.input, output = row?.cost?.text?.output;
  const noOverrides = value => value === undefined || (Array.isArray(value) && value.length === 0);
  const onlyKeys = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key));
  return Boolean(onlyKeys(row?.cost, ["text"]) && onlyKeys(row.cost.text, ["input", "output"]) && onlyKeys(input, ["price", "cache", "overrides"]) && onlyKeys(input.cache, ["read", "write"]) && onlyKeys(output, ["price", "overrides"]) && input.price === 0 && input.cache.read === 0 && (input.cache.write === undefined || input.cache.write === 0) && output.price === 0 && noOverrides(input.overrides) && noOverrides(output.overrides) && Object.keys(row.api ?? {}).join() === "chat-completions" && row.api["chat-completions"]?.base_url === "https://opencode.ai/inference/go/openai/v1");
}
