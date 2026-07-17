# CC-W0 — Protocol Recon Findings (claude CLI v2.1.212)

- **Бинарь:** `/Users/incadawr/.local/bin/claude` v2.1.212 (залогинен владельцем, подписка).
- **Метод:** одноразовые локальные пробы + записанные wire-фикстуры в `fixtures/`. Ноль продуктового кода.
- **Статус OG-CC-1:** НЕ снят на момент CC-W0 ⇒ только recon.
- Легенда: ✅ подтверждено на живом бинаре · ⚠ находка сверх research · ❓ ещё открыто (проба не проведена).

---

## Bootstrap-прогон (оркестратор, seed) — ПРОВЕДЁН

Команда (plan-mode, один user-ход, EOF-закрытие):
```
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with exactly the two characters: OK"}}' \
| claude -p --input-format stream-json --output-format stream-json \
    --verbose --include-partial-messages --replay-user-messages \
    --permission-mode plan --debug-file <ref>/fixtures/w0-bootstrap-debug.log -d api
```
Фикстуры: `fixtures/w0-bootstrap-stdout.jsonl` (17 строк), `w0-bootstrap-debug.log` (232 строки), `w0-bootstrap-stderr.log`.

### Подтверждено / находки

- ✅ **Техника капчи работает:** stream-json in (одна user-JSON-строка на stdin) → полный turn на stdout → EOF завершает. exit=0.
- ✅ **Типы сообщений stdout за ход:** `system` (subtypes: `hook_started`, `hook_response`, `init`, `status`), `stream_event` (×7, токен-дельты), `assistant`, `user`, `result`, ⚠ `rate_limit_event`.
- ✅ **`system/init` ключи:** `session_id, model, permissionMode, cwd, output_style, tools[], mcp_servers[], capabilities[], slash_commands[]`.
  - ⚠ **`capabilities` = `["interrupt_receipt_v1","msg_lifecycle_v1"]`** — research знал только `interrupt_receipt_v1`; **`msg_lifecycle_v1` — новая** (выяснить назначение, вероятно якорь фичедетекта). Фичедетект по `capabilities[]` подтверждён.
  - `model` в init = `claude-fable-5` (подхватился дефолт владельца).
- ✅ **`result` ключи:** `subtype:"success", is_error:false, num_turns, duration_ms, total_cost_usd (есть), usage{...}, modelUsage{<model-id>:{...}}, permission_denials[]`.
  - **`usage` ключи:** `input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation{...}, iterations, server_tool_use, service_tier, speed, inference_geo`. ⇒ ctx-метр `input+cache_read+cache_creation` доступен из коробки ⇒ **`supportsContextUsage:true` реально.**
  - `modelUsage` ключуется id модели ⇒ истинная модель отсюда.
- ⚠ **`rate_limit_event`** (тип верхнего уровня) с полями `{type, rate_limit_info, session_id, uuid}`. **Потенциально машиночитаемый сигнал квоты** — research (§3.8/§6.7) считал, что честных процентов подписки нет кроме серого эндпоинта. **ПРОБА-ПРИОРИТЕТ:** глубоко захватить `rate_limit_info` (ключи/значения), понять, несёт ли utilization/reset по окнам. Если да — пересматривает OG-CC-4/квоты-деградацию.
- ⚠ **Изоляция от `~/.claude` НЕ включена по умолчанию (probe #6 подтверждён HARD):** без `--setting-sources project,local` в сессию УТЕКЛИ пользовательские **hooks** (`SessionStart:startup` fired — видно `hook_started`/`hook_response`), **30 tools**, **4 mcp_servers**, **73 slash_commands**. Для эмбеддера ОБЯЗАТЕЛЬНО `--setting-sources project,local` (+`--strict-mcp-config`). Проверить, что с флагом утечка исчезает (сравнительная проба).
- ✅ **Probe #11 (`--permission-prompt-tool`):** ФЛАГА НЕТ в help v2.1.212 ⇒ мост пермишенов = control-протокол `can_use_tool` (единственный путь). Уточнение TASK.3 подтверждено.
- ✅ **Probe #8 (`--permission-mode` enum) в v2.1.212:** ровно `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. `default` в enum ОТСУТСТВУЕТ (research упоминал `default`≈`manual`). Поведение per-mode — отдельная проба.
- ⚠ **Probe #13 (дешёвый auth-probe для doctor):** `--max-turns` ОТСУТСТВУЕТ в `-p --help` v2.1.212 ⇒ рецепт research'а `claude -p "" --max-turns 0` под вопросом. Подобрать иной дешёвый signed-in-probe (кандидаты: пустой ход + немедленный EOF; форма ошибки auth в `system/api_retry`/`result`).
- ✅ **Probe #2 частично:** `-d api` + `--debug-file` захватывает диагностику (232 строки: загрузка settings, MDM, symlink-проверки), но **0 байт control-протокола** — потому что мы НЕ обслуживали `initialize`-handshake ⇒ CLI не роутил `can_use_tool` нам. **Вывод: захват control-байтов ТРЕБУЕТ родительского контрол-харнеса** (см. ниже). `-d api` сам по себе недостаточен.
- ✅ **`--debug-file <path>`** существует (неявно включает debug) — годится для диагностики.
- Прочие флаги v2.1.212 присутствуют: `--input-format/--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--replay-user-messages`, `--session-id`, `--resume [value]`, `-c/--continue`, `--fork-session`, `--no-session-persistence`, `--setting-sources`, `--strict-mcp-config`, `--settings`, `--bare`, `--mcp-config`, `--allowedTools/--disallowedTools/--tools`, `--model`, `--fallback-model`, `--effort`, `--disable-slash-commands` («Disable all skills»).

---

## Остаток проб (для CC-W0 lane — см. §6.9 research + план cut §2)

(Заполняется lane'ом по мере выполнения. Каждая проба: команда → фикстура → снятый UNCERTAIN.)
