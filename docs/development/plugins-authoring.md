# Authoring AnyCode plugins

A plugin is a directory carrying a `.anycode-plugin/plugin.json` manifest plus
the content it contributes. This page is the v1 authoring reference: the
manifest spec, the on-disk layout, the official index format, and the signing
runbook (keygen / sign-index) for publishing to the official index.

For the user-facing story (tiers, install flow, consent), see
[../user/plugins.md](../user/plugins.md).

## Manifest v1 spec

`.anycode-plugin/plugin.json`:

```json
{
  "name": "ozon-tools",
  "version": "0.3.1",
  "description": "Marketplace helpers: skills, an agent profile, and an MCP server.",
  "skills": ["skills"],
  "agents": ["agents"],
  "workflows": ["workflows"],
  "mcpServers": {
    "api": {
      "command": "node",
      "args": ["api.js"],
      "cwd": "."
    }
  }
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | required | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Globally identifies the plugin; runtime MCP names derive from it. |
| `version` | string | — | Optional (legacy plugins may omit it). Semver-style strings are what the index compares. |
| `description` | string | — | Shown in the Plugins pane. |
| `skills` | string[] | `["skills"]` | Directories relative to the plugin root contributing `SKILL.md` folders. An absolute path or one escaping the root is rejected fail-soft (the rest of the plugin still loads). |
| `agents` | string[] | `["agents"]` | Directories contributing `*.md` subagent profiles, same containment rule. |
| `mcpServers` | record | — | Same entry shape as explicit config (`command`+`args` xor `url`, `env`/`headers` as `${env:VAR}` references, `inheritEnv`, `enabled`). Keys share the name alphabet. At runtime a server is renamed `plugin_<plugin>_<server>`; an explicit config row with that name always wins. |
| `engines` | string | — | Optional semver range of AnyCode versions this plugin supports (index-mediated; incompatible versions are not offered). |
| `workflows` | string[] | `["workflows"]` | Directories contributing `*.json` workflow presets (same schema as `.anycode/workflows`). Plugin presets sit between your own workflows and the bundled ones. Same containment rule. |
| `services` | `{name, command, args?, env?}[]` | — | Background processes AnyCode supervises after the user consents to their exact definition. `name` is unique within the plugin; `command` is a bare executable, a `./` path inside the plugin, or an absolute path; `env` keys match `^[A-Za-z_][A-Za-z0-9_]*$` and may not start with `ANYCODE_`. See the user guide's *Services* section. |

Unknown top-level keys are ignored — a richer future manifest never breaks an
older app. Any schema violation fails the whole manifest fail-soft: the plugin
is skipped with one problem line in the pane, never a crash of the app.

Capabilities are **derived from content, never self-declared**: a plugin that
ships no `mcpServers` block simply has no MCP capability, whatever its
description claims.

## On-disk layout

```
ozon-tools/
  .anycode-plugin/plugin.json
  skills/
    listing/SKILL.md
  agents/
    marketplace-watcher.md
  api.js
```

`skills`/`agents` entries must stay inside the plugin root; `cwd` may point
anywhere (it is trusted config, like a config-file `cwd`). Local dev linking
(Install… → From folder) points AnyCode at a directory you edit — changes
apply to newly started tasks.

## The official index format

The official index is a JSON document mapping plugin names to their version
history plus integrity metadata, served over HTTPS, and **signed with
Ed25519**:

```json
{
  "serial": 42,
  "generatedAt": "2026-10-24T10:00:00Z",
  "plugins": {
    "ozon-tools": {
      "displayName": "Ozon Tools",
      "description": "Marketplace helpers.",
      "default": false,
      "versions": {
        "0.3.1": {
          "url": "https://plugins.anycode.dev/ozon-tools-0.3.1.tgz",
          "sha256": "<64 hex chars>",
          "engines": ">=0.0.35",
          "capabilities": ["skills", "agents", "mcp"]
        }
      }
    }
  },
  "signature": "<Ed25519 signature over the canonical JSON with signature removed>"
}
```

- `serial` is monotonic; clients refuse to roll back to a lower serial.
- `sha256` is the archive checksum verified on every download; a mismatch
  refuses the install with `integrity` and nothing is written.
- `signature` is verified against the built-in Ed25519 public key before the
  index is trusted at all (`signature_failed` → the cached copy stays in use,
  no new installs or updates).
- `engines` ranges gate what the Plugins pane offers: incompatible versions
  render greyed with the range as the reason.
- `capabilities` in the index mirror what the manifest actually contains —
  the index re-derives them at publish time; it never amplifies a plugin.

## Signing runbook

Signing uses Ed25519 keys via `node:crypto` — no extra dependency.

### One-time keygen

```bash
node scripts/plugins-keygen.mjs   # writes a fresh ed25519 keypair
```

This prints a **private key** (kept by the publisher, never committed — treat
it like a release credential; `~/.anycode/`-adjacent secret storage, mode
0600) and the **public key** that ships compiled into the app for
verification.

### Signing an index

```bash
node scripts/plugins-sign-index.mjs index.json private.pem
```

Canonicalises the JSON (sorted keys, no whitespace, `signature` removed),
signs it with Ed25519, and writes the `signature` field back into
`index.json`. Publish the signed file; bump `serial` on every change.

### Verifying locally

```bash
node scripts/plugins-verify-index.mjs index.json public.pem
```

Prints `ok` and the serial, or a refusal. The app does exactly this check on
every index fetch, plus the sha256 check per download.

## Publishing checklist

1. `name` unique, `version` bumped, `engines` honest.
2. Pack the `.tgz` from a clean checkout (no `.git`, no secrets) and record
   its sha256.
3. Add/replace the version entry; bump `serial`.
4. Sign with the publisher key; verify with the shipped public key.
5. Upload the archive to the pinned URL — the URL must serve exactly the
   bytes you hashed.
