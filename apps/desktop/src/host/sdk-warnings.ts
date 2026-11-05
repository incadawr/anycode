globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
  for (const warning of warnings) {
    console.warn(`[AI SDK${provider ? ` ${provider}` : ""}${model ? ` ${model}` : ""}] ${JSON.stringify(warning)}`);
  }
};
