/**
 * Ambient `import.meta.env` typing for the renderer's Vite build. Needed by
 * main.tsx's `import.meta.env.DEV` gate (design/phase-2-smoke-channel.md
 * §2.2) — tsconfig.web.json's `types` is `["node"]` only, so `ImportMeta`
 * otherwise has no `env` member under `tsc --noEmit`.
 */
/// <reference types="vite/client" />
