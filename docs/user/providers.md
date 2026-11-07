# Providers, connections, models and effort

A **connection** is a named way to reach one model API: provider, base URL,
transport, API key and model. Native tabs and Native child sessions run on
connections. Codex and Claude tabs use their own CLI account instead (see
[engines.md](engines.md)).

## Add a connection

**First run.** The welcome screen offers provider tiles plus four subscription
shortcuts: **GLM Coding Plan** (Z.AI), **MiniMax M Plan**, **Kimi (kimi.com)** and
**OpenCode Go**. Each one opens the connection form with that provider preselected and a
link to the provider's key page. Paste the key and press **Connect**. Pricing and
tuning are under **Advanced**.

**Later.** Settings → Provider → add a connection. Choose a catalog provider or
**Custom endpoint**, enter the key, pick a model, and save.
`provider.activeConnectionId` is the default for new Native sessions.

- Every built-in provider authenticates with an **API key**. Subscription plans
  (GLM Coding Plan, MiniMax M Plan, Kimi for Coding, Xiaomi MiMo Token Plan,
  OpenCode Go) are also API keys, issued by the plan's console. Account sign-in
  (ChatGPT, Claude.ai) exists only for the Codex and Claude engines.
- Keys go to `~/.anycode/secrets.json` (mode 0600), encrypted with the operating
  system's keychain. AnyCode stores a key in plaintext only if you agreed to it
  (`security.allowWeakSecretStorage`). Keys never go into `settings.json`.
- Connection ids (`conn-…`) are generated and not shown in the UI. Read them from
  `provider.connections[].id` in `settings.json` when a profile needs `connection:`.

## Built-in providers

| Provider id | What it is | Protocol |
|---|---|---|
| `anthropic` | Anthropic API | Anthropic Messages |
| `z-ai` | Z.AI GLM (pay as you go or Coding Plan key) | Anthropic Messages |
| `deepseek` | DeepSeek | Anthropic Messages |
| `xiaomi-mimo-api`, `xiaomi-mimo-sgp`, `xiaomi-mimo-cn`, `xiaomi-mimo-ams` | Xiaomi MiMo API (pay as you go) or Token Plan by region | Anthropic Messages |
| `moonshot` | Moonshot platform API (Kimi models) | Anthropic Messages |
| `kimi` | kimi.com subscription (Kimi for Coding) | Anthropic Messages |
| `minimax`, `minimax-cn` | MiniMax international / China | Anthropic Messages |
| `opencode` | OpenCode Go gateway, Anthropic protocol | Anthropic Messages |
| `opencode-openai` | OpenCode Go gateway, OpenAI protocol | Chat Completions (or Responses) |
| `openai` | OpenAI API | Responses (or Chat Completions) |
| `openrouter` | OpenRouter | Chat Completions (or Responses) |
| `vllm` | vLLM or any local OpenAI-compatible server; key optional | Chat Completions |
| `custom` | Any endpoint you enter | Anthropic Messages, Chat Completions or Responses |

Open Settings → Provider and open a connection to see its current model choices.
The model list of each
provider is a hint. You can always type a model id, and providers that publish
a model list (for example DeepSeek, OpenCode Go) fetch it live.

**Custom endpoints.** The base URL must be `https://`, or `http://` on
`localhost`, `127.0.0.1` or `[::1]`, and it must not contain a user name or password. Choose the protocol (transport)
the endpoint speaks.

## Models and effort

- **Pick the model** per connection in the drawer, or per tab from the model
  pill in the composer.
- **Reasoning effort** values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  `max`. Each model accepts only some of them. The catalog and connection metadata declare the list per model. The composer shows only the levels the
  current model accepts.
- A reasoning model without a declared list gets `off`, `low`, `medium`, `high`.
  A child requesting `xhigh` uses `max` when `xhigh` is absent and `max` is supported.
- **Custom endpoints:** in the connection's advanced model settings, set
  **Reasoning support** to **Supported** and pick the accepted levels.
  **Auto** clears the list.
- Shell-launched sessions can force a level list with
  `ANYCODE_EFFORT_LEVELS='["low","high"]'`. It applies to every model and wins
  over per-model settings.
- In the CLI, `/effort high` changes the level. The CLI command accepts `off`, `low`,
  `medium`, `high`, `xhigh`, `max`; `minimal` is accepted by environment and
  app settings but not by this slash command in 0.0.90.
- **Codex tabs** take their effort levels from the Codex CLI's model list.
  **Claude tabs** use `low`, `medium`, `high`, `xhigh`, `max`.

## Per-model settings in the connection drawer

| Setting | Values | Effect |
|---|---|---|
| Image input | Auto / On / Off | Overrides the catalog answer for that model. Off means images go through Vision (below). |
| Reasoning support / levels | Auto / Supported + levels | Declares the effort levels a custom model accepts. |
| Reasoning replay | Automatic / On / Off | Whether returned reasoning is sent back on later turns. Automatic replays returned reasoning unless the provider has an explicit exception; Responses replays only original encrypted reasoning. If the provider rejects replay, AnyCode retries once without it and remembers the rejection. |
| Context window | tokens (1,024–1,000,000) | Overrides the window AnyCode budgets compaction against. |
| Max output tokens | tokens | Caps the response length. |
| Cost estimate | subscription / catalog / custom rates | Controls the cost shown in the session. |
| Proxy | application / none / profile | See [proxy.md](proxy.md). |

Some catalog entries have a usable context budget below the advertised window.
The context meter and compaction use that budget.

## Image input

The per-model Image input switch overrides catalog image support. When disabled
or unsupported, images need a configured Vision recognizer. `InspectImage` allows
up to eight questions per image; it reports when the limit is reached.

Settings → Vision sets `recognizer` `{ connectionId, modelId }`. When the main
model cannot see images, this model answers `InspectImage` calls. Unset means
the fallback is off.

## Quotas and usage

When supported by the provider, the connection card shows quota windows and
reset times. Plan pollers refresh no more often than once per minute:

- providers that report limits in response headers (`x-ratelimit-*`,
  `anthropic-ratelimit-*`); persisted at most every 30 seconds (the live display can update sooner);
- **Z.AI Coding Plan** keys: 5-hour and weekly windows, polled every 60 seconds
  (pay-as-you-go keys are not polled);
- **MiniMax M Plan**: token-plan remains, polled every 60 seconds;
- **OpenCode Go**: 5-hour, weekly and monthly windows with reset times.

Settings → Profile shows usage statistics from local telemetry.

## Export and import

Settings → Provider → **Export setup** saves connections and role profiles as JSON,
without keys or tokens. **Import setup** previews the file and lets you update, copy
or skip each collision. After import, enter keys through each connection's
credential button. Proxy profiles, project assignments, app settings and
secrets are not exported.

## Environment overrides for providers

When a provider variable is set in the app's launch environment, the Provider
pane shows an "Environment override" notice. Other variables that change model
behaviour for shell-launched sessions: `ANYCODE_EFFORT_LEVELS`,
`ANYCODE_IMAGE_INPUT`, `ANYCODE_PRESERVE_REASONING`, `ANYCODE_REASONING_HISTORY`
(see [configuration.md](configuration.md)).

## How to verify

Start a new Native tab and send a short message. The connection card shows
its last health check. A refused key shows a sanitized provider message in the
tab.

## Reasoning history

Returned reasoning is stored in history separately from what is replayed to the
provider. Per-model **Reasoning replay** offers Automatic, On and Off and applies
to new sessions. `ANYCODE_PRESERVE_REASONING` in the launch environment overrides it.
Responses transport replays original encrypted reasoning only; modified text and
factual summaries are excluded.

For experiments, `ANYCODE_REASONING_HISTORY` accepts:

- Unset or `full`: replay original reasoning under the provider policy and overrides.
- `none`: omit reasoning from requests.
- `factual_N`: create a fixed factual summary per response at low effort; `N` is
  a positive byte budget, for example `factual_500`. Full field lines are kept,
  so the result can be shorter.

The compactor uses the current endpoint and model unless
`ANYCODE_REASONING_COMPACTOR_MODEL` selects another model on that endpoint.
The original response remains in history. Summary usage is recorded separately;
a failed or cancelled summary preserves the completed response. In factual mode,
reasoning without a usable summary is omitted from replay, including older history.
Endpoint compatibility must be established before using modified thinking.

See the [reasoning history reference](https://github.com/incadawr/anycode/blob/master/docs/development/reasoning-history.md)
for transport fields and provider compatibility.
