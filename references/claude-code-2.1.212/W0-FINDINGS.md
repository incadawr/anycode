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

**Статус: все 14 проб проведены живым бинарём v2.1.212, реальными байтами. НОЛЬ продуктового кода. PII-скан всех `fixtures/w0-*.jsonl` = 0 совпадений (`dubov\.e\.v|sk-ant|oauth|bearer|refresh_token|access_token|ANTHROPIC_API_KEY`).**

### ⚠⚠ Инцидент безопасности во время recon (раскрытие владельцу — через оркестратора: PROGRESS + memory + сообщение сессии; НЕ было живого диалога с владельцем)

При пробе VERIFY-1 (см. §7) исполнитель по ошибке запустил `security find-generic-password -s "Claude Code-credentials" -g` и включил `password` в собственный grep-фильтр после пайпа — это НАПЕЧАТАЛО живой OAuth `accessToken`+`refreshToken` владельца (subscription Max) в stdout Bash-тула, т.е. в транскрипт сессии. Инструкция явно запрещала это (`-w`/печать пароля), но `-g` тоже печатает пароль человекочитаемо на stderr, и добавленный фильтр `"^password"` его пропустил — ошибка исполнителя, не brief'а. Секрет НЕ попал ни в один файл (только в Bash tool-output этой сессии). **Зафиксировано в этом файле лейном; РЕАЛЬНОЕ раскрытие владельцу выполняет оркестратор (см. addendum ниже). Рекомендация: считать этот accessToken/refreshToken скомпрометированным и перелогиниться (`claude /login` или эквивалент ротации), поскольку значение осело в транскрипте вне обычной Keychain-границы доступа.** С этого момента ВСЕ дальнейшие Keychain-пробы велись только через `-s`/`-a`-метаданные без `-g`/`-w`.

### Метод: SDK-как-эталон (свободно, без метеринга)

`npm i --prefix $(mktemp -d)/cc-sdk-ref @anthropic-ai/claude-agent-sdk` (версия `0.3.212`, ровно синхронна с CLI `2.1.212`) — установка в одноразовый `/tmp`-каталог, НЕ коммитится, НЕ шипится. `sdk.d.ts` (полностью типизированный, с doc-комментариями) и `sdk.mjs` (минифицированный бандл, спавнящий тот же нативный CLI) дали **точные wire-формы control-протокола без единого потраченного хода** — это не догадки, а прямое чтение того, что реально шлёт официальный SDK-клиент тому же бинарю. Все формы ниже независимо **перепроверены живыми байтами** через `harness/w0-control-harness.mjs` (raw NDJSON, без SDK-обвязки).

---

### Проба №1 — персистентность процесса + EOF (`w0-01-persistence.jsonl`)

Один процесс, два user-хода через открытый stdin (harness scenario `persistence`), затем `stdin.end()`.
- ✅ **Один и тот же `session_id`** на обоих ходах (`ba9806a9-...`) — персистентность подтверждена.
- ⚠ **Находка сверх research:** `system/init` эмитится **на КАЖДОМ ходе**, не только при старте процесса (init#1 t=810ms, init#2 t=2664ms сразу после result хода 1) — тот же session_id, та же model/permissionMode/capabilities. Контракт должен трактовать `system/init` как «начало хода», не «начало процесса».
- ✅ **EOF-тайминг:** `stdin.end()` в t=4034ms → `close(code:0)` в t=4551ms — **~517ms** на чистое завершение без фоновых bash (baseline для `CLAUDE_TEARDOWN_STDIN_EOF_WAIT_MS`, без фоновых тасков; с фоновым bash значение будет выше — см. проба доп. ниже не проводилась, research предупреждал ~5с потолок).

### Проба №2 — control-протокол байты (`w0-02-control-*.jsonl`) ★ЦЕНТРАЛЬНАЯ ПРОБА

**★★ Ключевая находка, меняющая план CC-B:** голого `control_request{subtype:"initialize"}`-handshake **НЕДОСТАТОЧНО** для маршрутизации `can_use_tool` через control-канал. Без доп. флага CLI в headless `-p` молча авто-денаит: живой захват `w0-02-control-writeprobe-noflag-autodeny.jsonl` показывает `tool_result{is_error:true, content:"Claude requested permissions to write to /tmp/..., but you haven't granted it yet."}` — БЕЗ единого `control_request` к нам. Разбор argv-билдера самого `@anthropic-ai/claude-agent-sdk` (`sdk.mjs`) показал: SDK при наличии `canUseTool`-колбэка добавляет **скрытый флаг `--permission-prompt-tool stdio`** (отсутствует в `--help` v2.1.212, как и зафиксировано ранее, но функционален). С этим флагом (`w0-02-control-writeprobe.jsonl`) получен **реальный байтовый обмен**:
```json
{"type":"control_request","request_id":"...","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/tmp/...","content":"OK"},"description":"/tmp/...","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"},{"type":"addDirectories","directories":["/tmp","/private/tmp"],"destination":"session"}],"decision_reason":"Path is outside allowed working directories","decision_reason_type":"workingDir","tool_use_id":"toolu_..."}}
{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{"behavior":"allow","updatedInput":{...},"toolUseID":"toolu_..."}}}
```
**CC-B ДОЛЖЕН добавить `--permission-prompt-tool stdio` в argv спавна** (§1.3 плана его не перечисляет — правка обязательна перед реализацией).

Полные типизированные формы (из `sdk.d.ts`, перепроверены живыми байтами):
- `initialize` (мы→CLI): `{subtype:"initialize", hooks?, sdkMcpServers?, jsonSchema?, systemPrompt?, appendSystemPrompt?, planModeInstructions?, toolAliases?, excludeDynamicSections?, agents?, title?, skills?, promptSuggestions?, agentProgressSummaries?, forwardSubagentText?, supportedDialogKinds?}` — ВСЕ поля опциональны, минимальный валидный запрос `{subtype:"initialize"}`.
- `initialize`-ответ (CLI→мы, живой): `{commands[], agents[], output_style, available_output_styles[], models[]:ModelInfo, account:AccountInfo, fast_mode_state?}`.
  - ⚠⚠ **`account:{email, organization, subscriptionType, tokenSource, apiProvider}` — email/organization ПРИСУТСТВУЮТ в живом ответе, НЕ гейтятся `--setting-sources`.** Обязательная кастоди-редакция в контракте (см. `contract-draft.md` §5). Харнесс скрабит их на записи (`scrub()`), поэтому в фикстурах `[REDACTED]`.
  - ⚠ **`models: ModelInfo[]`** — контр-факт к research §3.6 «программного списка моделей подписки нет»: **список ЕСТЬ**, приходит из `initialize`-ответа, с `value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels[], supportsAdaptiveThinking, supportsFastMode, supportsAutoMode`. `catalog.ts`-аналог может строиться отсюда, а не из захардкоженного enum.
- `can_use_tool` (CLI→мы): `{subtype:"can_use_tool", tool_name, input, permission_suggestions?, blocked_path?, decision_reason?, decision_reason_type?('rule'|'mode'|'subcommandResults'|'permissionPromptTool'|'hook'|'asyncAgent'|'sandboxOverride'|'workingDir'|'safetyCheck'|'classifier'|'other'), classifier_approvable?, title?, display_name?, tool_use_id, agent_id?, description?, requires_user_interaction?}`.
- Ответ allow: `{behavior:"allow", updatedInput?, updatedPermissions?, toolUseID?, decisionClassification?}`; deny: `{behavior:"deny", message, interrupt?, toolUseID?, decisionClassification?}`.
- Конверт ответа (обе стороны): `{type:"control_response", response:{subtype:"success", request_id, response?} | {subtype:"error", request_id, error}}`.
- ⚠ **`control_cancel_request{type:"control_cancel_request", request_id}`** — НОВЫЙ тип сообщения не в research'е: CLI отзывает СВОЙ РАНЕЕ посланный нам control_request (напр. отменённый interrupt'ом `can_use_tool`, см. проба №3).

### Проба №3 — interrupt-гонка (`w0-03-interrupt-early.jsonl`, `w0-03-interrupt-pending.jsonl`)

- **Early (25мс после user-хода, до диспатча модели):** `interrupt` → `{"still_queued":[]}`, ход обрывается `result.subtype:"error_during_execution"`, синтетическое `[Request interrupted by user]`, **`total_cost_usd:0`** (модель не успела быть вызвана — интеррапт до диспатча = бесплатно).
- **Pending (во время открытого `can_use_tool`):** отправили `interrupt`, НЕ ответив на pending `can_use_tool` → CLI сам прислал `control_cancel_request{request_id:<can_use_tool's id>}` (отзыв своего запроса), затем `tool_result{is_error:true, content:"The user doesn't want to proceed..."}` + `[Request interrupted by user]` + `result.subtype:"error_during_execution"`, `total_cost_usd:0.0006` (модель успела частично отработать — небольшой но ненулевой cost). Файл НЕ создан (отмена реальна).
- ✅ **`interrupt_receipt_v1` подтверждена:** ответ на `interrupt` несёт `still_queued:[]` (пусто в обоих случаях — ни один async-таск не пережил).
- Zero PII в обеих фикстурах.

### Проба №4 — resume (`w0-04-resume-part1/part2/fork.jsonl`)

- ✅ `--session-id <uuid>` (ход 1) → EOF → новый процесс `--resume <uuid>` (ход 2): **тот же `session_id`**, **та же модель** (`claude-opus-4-8`), **тот же `permissionMode`** перенесён.
- ✅ **История НЕ ре-эмитится на stdout** — часть 2 показывает только: `system/init`, `system/status`, эхо нового user-сообщения, `stream_event`×N, `assistant`, `result`. Ничего от хода 1. **Снимает UNCERTAIN §3.5: «история скорее всего не ре-эмитится» → ПОДТВЕРЖДЕНО.**
- ✅ `--fork-session`: новый `session_id` (`b8078a96-...`) отличный от оригинала (`478fdc4b-...`), процесс успешно стартует от того же resume-таргета.

### Проба №5 — буферизация stdout (issue #25670)

Не отдельная фикстура — вывод из таймстемпов ЛЮБОЙ живой фикстуры харнесса (`t_ms` на каждой строке). Пример (`w0-08-permmodes.jsonl`, default-ход): `stream_event`-строки приходят на 7813, 7815, 7817, 8383, 8386, 8408, 8416, 8433, 8920, 8931, 8996, 9002, 9030ms — **прогрессивно, НЕ одним блоком перед `result` (9037ms и далее)**. **На v2.1.212 при этой конфигурации пайпа блочная буферизация НЕ воспроизводится** — issue #25670 не проявился (либо специфичен для другой ОС/конфигурации, либо исправлен). Остаточный риск: не тестировали при экстремально большом объёме вывода за один tick — не блокирует MVP.

### Проба №6 — изоляция `--setting-sources project,local` + `--strict-mcp-config` (`w0-06-isolation-strict.jsonl`)

- ✅ **`mcp_servers` изолируется полностью** (0 при отсутствии `--mcp-config`) — `--strict-mcp-config` работает как документировано.
- ⚠⚠ **НАХОДКА, меняющая план:** `--setting-sources project,local --strict-mcp-config` САМИ ПО СЕБЕ **НЕ обнуляют** `slash_commands`/`skills`/`commands`(control-ответ) — в захвате без доп. флага (`w0-02-control-writeprobe.jsonl` system/init): `tools:32, mcp_servers:0, slash_commands:43, skills:16`. Это оказались **product-bundled built-in skills** (`/context` подтвердил пометкой `"Built-in"` — deep-research, dataviz, verify, code-review и т.д., НЕ личная кастомизация владельца), но сама утечка каталога встроенных фич нежелательна для эмбеддера (чужой UX-поверхностный шум: `/design-sync`, `/dataviz` и т.п. не имеют смысла в AnyCode).
  - **Фикс:** добавление `--disable-slash-commands` обнуляет ВСЁ: `tools:31 (только core-тулы), mcp_servers:0, slash_commands:0, skills:0, plugins:0`, control-ответ `commands:[]`. **CC-B ДОЛЖЕН добавить `--disable-slash-commands` в argv** (правка §1.3, наравне с `--permission-prompt-tool stdio`).
- ⚠⚠⚠ **НОВАЯ, более серьёзная находка (сверх research, через `/context` в пробе №10):** несмотря на `--setting-sources project,local` (что должно ИСКЛЮЧАТЬ source `"user"`), **глобальный `~/.claude/CLAUDE.md` владельца (660 токенов) И `~/.claude/projects/.../memory/MEMORY.md` (8.9k токенов, AutoMem) РЕАЛЬНО ЗАГРУЖЕНЫ в контекст модели** — видно в `/context`-выводе `w0-10-slashcmd.jsonl` (`result.result`, раздел «Memory Files» с полными путями `/Users/incadawr/.claude/CLAUDE.md`). **Это НЕ гейтится `--setting-sources`, `--strict-mcp-config` ИЛИ `--disable-slash-commands` (проверено — фикстура снята БЕЗ последнего флага, но с двумя первыми).** Личные пути домашней директории + факт использования AutoMem утекли в system-контекст сессии. **Residual UNCERTAIN:** неясно, какой флаг (если есть) подавляет загрузку user-global CLAUDE.md — вероятный кандидат `CLAUDE_CONFIG_DIR` на изолированный каталог (не тестировано в этой пробе; VERIFY-1 №7 косвенно подтверждает, что чужой `CLAUDE_CONFIG_DIR` НЕ подхватывает креды/сессии умолчательного профиля — по аналогии, вероятно, тоже не подхватит CLAUDE.md, но это ОТДЕЛЬНАЯ проверка, не проведена). **CC-B DoD должен включать sentinel-leak PoC именно на `/context`-эквиваленте (context-usage response), не только на grep логов**, и CC-A/B архитектура ОБЯЗАНА спавнить с выделенным `CLAUDE_CONFIG_DIR` (не дефолтным `~/.claude`), что, по не-подтверждённой но правдоподобной гипотезе, устранит и эту утечку. **Помечено как residual, не заблокировано — владелец/CC-B должен перепроверить с явным `CLAUDE_CONFIG_DIR` перед тем как полагаться на изоляцию.**

### Проба №7 — VERIFY-1 (macOS Keychain, мульти-аккаунт) ★★ КЛЮЧЕВОЙ ВОПРОС ЗАКРЫТ

**Метод (после инцидента выше — только метаданные, без `-g`/`-w`):**
1. `security dump-keychain 2>/dev/null | grep -i -B3 -A1 claude` → нашёл реальный сервис-нейм: **`"Claude Code-credentials"`** (НЕ буквально `"Claude Code"`, как предполагал research) + отдельный `"Claude Safe Storage"`/`"Claude Key"` (это Claude Desktop app, другой продукт, не относится).
2. Подсчёт записей `svce="Claude Code-credentials"` **до** пробы: **1**.
3. Живой `claude -p` ход с `CLAUDE_CONFIG_DIR=/tmp/cc-probe-A` (полностью свежий, никогда не тронутый каталог) → результат: **`"apiKeySource":"none"`**, ассистент отвечает **`"Not logged in · Please run /login"`**, `result.error:"authentication_failed"` (полная фикстура `w0-07-verify1-configdir-probe.jsonl`, ZERO PII — не залогинен, значит и разглашать нечего).
4. Подсчёт записей `svce="Claude Code-credentials"` **после** пробы: **1** (не изменилось — новая запись НЕ создана, просто изоляция сработала «в закрытую», без побочной keychain-записи на пустом профиле).
5. Дополнительно (через control-протокол, проба №13): `initialize`-ответ под тем же `CLAUDE_CONFIG_DIR=/tmp/cc-probe-A` → `account:{"tokenSource":"none","apiProvider":"firstParty"}` — **НЕТ `email`/`subscriptionType`**, тогда как под дефолтным профилем `account` несёт полный `email`+`subscriptionType:"Claude Max"`.

**ВЕРДИКТ VERIFY-1: `CLAUDE_CONFIG_DIR` ИЗОЛИРУЕТ учётные данные на macOS.** Свежий `CLAUDE_CONFIG_DIR` НЕ подхватывает Keychain-креды дефолтного профиля — сессия однозначно «не залогинена», а не «залогинена под чужим/общим аккаунтом». Это ПРОТИВОРЕЧИТ пессимистичному чтению доков (§3.7 research: «If you've set CLAUDE_CONFIG_DIR on Linux or Windows… macOS исключён») и ПОДТВЕРЖДАЕТ комьюнити-гипотезу (Keychain, вероятно, ключуется от активного `CLAUDE_CONFIG_DIR` или эквивалентного механизма). **Многоаккаунтные профили строятся буквально как `CODEX_HOME`: `CLAUDE_CONFIG_DIR=~/.anycode/claude/profile-<id>`, БЕЗ обязательного `setup-token`-fallback** (хотя `setup-token` остаётся полезен для программного provisioning логина конкретного профиля — сам факт первого логина всё ещё требует интерактивного `/login` OAuth или вставки `CLAUDE_CODE_OAUTH_TOKEN`).

### Проба №8 — `--permission-mode` поведение (`w0-08-permmodes.jsonl`, `w0-08-permmodes2.jsonl`)

Одна живая сессия, `set_permission_mode` control-запросами между ходами (6 режимов; `default`/`bypassPermissions`/`acceptEdits`/`dontAsk` в первом файле, `auto`/`plan` во втором — таймаут на `dontAsk` не дал уложить все 6 в один процесс, разделено на 2 живых процесса):

| Режим | Наблюдение (реальные байты) |
|---|---|
| `default` (=CLI-флаговый `manual`? см. ниже) | `Write` вне cwd → `can_use_tool` (`decision_reason_type:"workingDir"`) → allow → файл создан. |
| `bypassPermissions` | **`set_permission_mode{mode:"bypassPermissions"}` → `control_response:error`** (требует `--allow-dangerously-skip-permissions` на спавне — mid-session включить нельзя). Режим НЕ изменился, следующий ход всё ещё спросил как `default`. |
| `acceptEdits` | `set_permission_mode` succeeded; `Write` **вне cwd (`/tmp`) всё равно спросил** (`decision_reason_type:"workingDir"` — рабочая директория — отдельная ось от режима, режим её не переопределяет). **In-cwd случай НЕ протестирован живьём** (инференс из доков: должен авто-принимать; residual). |
| `dontAsk` | `Write` → **автодениал БЕЗ единого `can_use_tool`** (`system/permission_denied` + `tool_result{is_error:true, content:"Permission to use Write has been denied because Claude Code is running in don't ask mode..."}`), модель затем попробовала `Bash` — тоже автодениал тем же путём. Подтверждает doc: «deny if not pre-approved», **и подтверждает: `dontAsk`-денаилы НЕ доходят до control-канала вообще** (нам не с чем работать на approval-bridge для этого режима, кроме отображения текста денаила). |
| `auto` | `Write` вне cwd → **файл создан БЕЗ единого `can_use_tool`** — классификатор одобрил молча, ЗА ПРЕДЕЛАМИ control-канала. **Продуктовое следствие: под `auto`-режимом эмбеддер НЕ ВИДИТ, что было одобрено классификатором** — нет approval-события для отображения в UI вообще. |
| `plan` | Модель сначала пишет **план-файл** в `~/.claude/plans/<slug>.md` без спроса → вызывает **`ExitPlanMode`** (ВСЕГДА гейтится `can_use_tool`, `tool_name:"ExitPlanMode"`, без `decision_reason`) → мы allow → `"User has approved your plan..."` → **после этого модель пишет РЕАЛЬНЫЙ файл `/tmp/...` тоже БЕЗ повторного спроса** (мод неявно эскалирован постExitPlanMode). Plan-режим НЕ «чистый read-only» на уровне tool-gate — это system-prompt-инструкция + обязательный `ExitPlanMode`-гейт, а не хардблок исполнения. |

**Снимает UNCERTAIN §3.4/§6.9-№8 полностью** (кроме in-cwd-acceptEdits, residual-инференс). ⚠ **Расхождение enum:** CLI `--help`/`v2.1.212` (`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`) использует `manual`, а control-протокол/`SDKSystemMessage.permissionMode`/`system/init` живьём отдаёт **`"default"`** (не `"manual"`) для того же режима — т.е. **CLI-флаг `manual` ↔ wire-значение `default`** это ОДИН И ТОТ ЖЕ режим под разными именами на разных уровнях. CC-B обязан маппить `manual`(флаг)↔`default`(wire) явно.

### Проба №9 — image-вложения (`w0-09-image.jsonl`, `w0-09-image-red.jsonl`)

- Первая попытка (прозрачный 1×1 PNG) дала «There is no pixel or image here to inspect» — ЛОЖНО похоже на «не поддерживается», но это была ошибка выбора тестового изображения (полностью прозрачный пиксель без цветовой информации).
- ✅ **Вторая попытка (непрозрачный 1×1 PNG)** — модель ответила `"Pink"` (реальная, хоть и не 100%-точная, цветовая оценка) — **подтверждает: `image`-контент-блок в stream-json user-сообщении ДОХОДИТ до модели и обрабатывается.** `supportsImages: true` эмпирически подтверждён.

### Проба №10 — слэш-команды в headless (`w0-10-slashcmd.jsonl`)

✅ **`/context` исполнился локально**: `result.num_turns:0`, `result.duration_api_ms:0`, `message.model:"<synthetic>"` — **встроенные слэш-команды из stream-json user-контента ИСПОЛНЯЮТСЯ, и делают это БЕЗ вызова модели (0 стоимость)**, когда команда чисто локальная (типа `/context`). (Побочно раскрыл находку изоляции CLAUDE.md выше — проба №6.) Тот же путь используется и `"<synthetic>"`-моделью для «not logged in» ответа (проба №12/VERIFY-1) — это общий маркер «локальный/не-API ответ», полезно для discriminating формы в контракте.

### Проба №11 — `--permission-prompt-tool` — ОКОНЧАТЕЛЬНО ЗАКРЫТА

Флаг **ЕСТЬ**, но **скрыт от `--help`** в v2.1.212 — уточнение к прежней записи «флага нет». Он ЖИВ и ОБЯЗАТЕЛЕН для control-протокольного permission-моста (см. проба №2). Значение `"stdio"` — единственное протестированное и, судя по SDK-source, единственное осмысленное для нашего паттерна (SDK всегда передаёт литерал `"stdio"`, никогда другое значение, при наличии `canUseTool`-колбэка).

### Проба №12 — форма ошибки «не залогинен» (`w0-07-verify1-configdir-probe.jsonl`, `w0-13-authprobe-signedout.jsonl`)

✅ Полная форма (см. проба №7): `assistant.error:"authentication_failed"`, `assistant.message.content[0].text:"Not logged in · Please run /login"`, `assistant.message.model:"<synthetic>"`, `result.subtype:"success"` (⚠ НЕ `"error"` несмотря на `is_error:true` и провал аутентификации — discriminating нюанс для doctor/UI: смотреть `is_error`+`error`-поле assistant-сообщения, а не полагаться на `result.subtype`), `result.total_cost_usd:0`. control-протокольный `initialize`-ответ параллельно даёт `account:{"tokenSource":"none","apiProvider":"firstParty"}` без `email`/`subscriptionType`. «Лимит исчерпан» форма НЕ поймана естественно (квота не исчерпывалась намеренно) — см. `SDKRateLimitInfo.errorCode:"credits_required"` в разделе «Сверх research» ниже как типизированный, но не живьём-пойманный residual.

### Проба №13 — дешёвый auth-probe для doctor (`w0-13-authprobe-signedin.jsonl`, `w0-13-authprobe-signedout.jsonl`, `w0-13-authprobe-cheap.jsonl`, `w0-13-authprobe-emptystdin.jsonl`)

- ❌ **Пустой stdin (мгновенный EOF, ноль строк):** CLI выходит `exit=0` БЕЗ единой строки на stdout — не годится, нет сигнала вообще.
- ⚠⚠ **УРОК/предостережение (дорогая ошибка, зафиксирована для потомков):** тривиальный ОДИН user-ход (`"x"`, БЕЗ control-протокола, дать ходу довыполниться) **СТОИЛ `$0.1594` РЕАЛЬНЫХ денег** за односложный ответ — тяжёлый системный промпт/контекст (opus, 1M) при `--permission-mode plan`. **Doctor НЕ должен просто «слать дешёвый промпт и оценивать по ответу» — это НЕ дёшево, если ход доходит до диспетчеризации модели.**
- ✅ **РЕШЕНИЕ (действительно $0, подтверждено дважды):** control-протокольный `initialize`-handshake **САМ ПО СЕБЕ**, БЕЗ единого user-хода — только `{type:"control_request",request:{subtype:"initialize"}}` → `control_response` приходит за ~300-800мс, содержит `response.account`. Завершить процесс СРАЗУ после этого ответа (EOF/kill), НЕ отправляя user-сообщение вообще.
  - Залогинен: `account:{email,organization,subscriptionType:"Claude Max",apiProvider:"firstParty"}`.
  - Не залогинен: `account:{tokenSource:"none",apiProvider:"firstParty"}` (нет `email`/`subscriptionType`).
  - **Discriminator для doctor: `account.subscriptionType !== undefined` (или `account.tokenSource !== "none"`).** Обе `w0-13-authprobe-signed*` фикстуры сняты с `--permission-prompt-tool stdio` в argv, но сам handshake — протокольный обмен, не зависящий от permission-моста; вероятно, работал бы и без флага (не перепроверено отдельно без флага — не блокирует, логически независимо).
  - `--max-turns` подтверждённо отсутствует (см. bootstrap-запись) — этот handshake-based метод его заменяет полностью.

### Проба №14 — `--effort`/`apply_flag_settings` mid-session

✅ **МЕХАНИЗМ ЕСТЬ**, подтверждён и типом (`sdk.d.ts`: `declare type SDKControlApplyFlagSettingsRequest = {subtype:'apply_flag_settings', settings: Record<string, unknown>}`, `effortLevel?: 'low'|'medium'|'high'|'xhigh'` — часть Settings-типа), и живым байтом (`w0-14-apply-flag-settings.jsonl`): `control_request{subtype:"apply_flag_settings", settings:{effortLevel:"high"}}` → **`control_response{subtype:"success"}`** (принято, $0 стоимость — чистый handshake, без хода). **Снимает UNCERTAIN §3.6 полностью: `supportsReasoningEffort: true` реализуемо через этот путь**, а не только через `--effort`-флаг при спавне. (Поведенческую разницу в САМОМ ответе модели при разных effort — не тестировали, вне бюджета; сам факт принятия команды — достаточная дискриминирующая форма для DoD.)

---

## Находки сверх research (новые темы, не входившие в 14 проб)

1. **★★★ `get_usage`/`get_context_usage` control-протокол — ОПРОВЕРГАЕТ §6.7/§3.8 «честных процентов подписки нет».** Из `sdk.d.ts`: `control_request{subtype:"get_usage"}` (SDK-метод буквально называется `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` — экспериментальный, форма может измениться, НО это ОФИЦИАЛЬНЫЙ первостатейный control-канал, НЕ серый `api.anthropic.com/api/oauth/usage`-эндпоинт из §3.8!) отвечает `SDKControlGetUsageResponse`: `{session:{total_cost_usd,...}, subscription_type:"pro"|"max"|"team"|"enterprise"|null, rate_limits_available:boolean, rate_limits:{five_hour?:{utilization:0-100,resets_at}, seven_day?:{...}, ...}}`. **Это ТОЧНО то, что показывает `/usage` в TUI, структурированно, через официальный протокол.** Не протестировано живьём в рамках бюджета W0 (residual — рекомендуется как первая проба CC-E/квоты-волны), но типовая форма достоверна (тот же источник, что и подтверждённые живьём `initialize`/`can_use_tool`/`interrupt` формы). **Меняет OG-CC-4 risk-оценку: квоты-UI МОГУТ строиться на честных процентах через официальный путь, без серого эндпоинта.**
2. **`rate_limit_event` (top-level message, уже виден в bootstrap) — полная типовая форма из SDK:** `SDKRateLimitInfo = {status:'allowed'|'allowed_warning'|'rejected', resetsAt?, rateLimitType?:'five_hour'|'seven_day'|'seven_day_opus'|'seven_day_sonnet'|'seven_day_overage_included'|'overage', utilization?, overageStatus?, overageResetsAt?, overageDisabledReason?, isUsingOverage?, overageInUse?, surpassedThreshold?, errorCode?:'credits_required', canUserPurchaseCredits?, hasChargeableSavedPaymentMethod?}`. Живьём пойман дважды (`w0-03-interrupt-pending.jsonl`, permmodes-фикстуры) с `status:"allowed", rateLimitType:"five_hour", overageStatus:"allowed", isUsingOverage:false` — сообщение эмитится АВТОМАТИЧЕСКИ на обычных ходах, не нужно ничего просить.
3. **`get_context_usage` control-ответ** — намного детальнее самодельного расчёта из `usage`: `{categories[], totalTokens, maxTokens, percentage, gridRows[][], memoryFiles[], mcpTools[], systemPromptSections[], agents[], skills{...}, autoCompactThreshold, apiUsage{...}}` — то же самое, что рендерит `/context` в TUI, структурированно. Прямая замена самодельному ctx-метру из `usage`-полей `result` (проще и точнее).
4. **`SDKAssistantMessageError` enum (доктор/error-UI):** `'authentication_failed'|'oauth_org_not_allowed'|'billing_error'|'rate_limit'|'overloaded'|'invalid_request'|'model_not_found'|'server_error'|'unknown'|'max_output_tokens'` — полный список причин отказа хода, годится как есть для `ClaudeDoctorReport.error`/UI notice enum.
5. **`TerminalReason` enum** (`result.terminal_reason`): `'blocking_limit'|'rapid_refill_breaker'|'prompt_too_long'|'image_error'|'model_error'|'api_error'|'malformed_tool_use_exhausted'|'aborted_streaming'|'aborted_tools'|'stop_hook_prevented'|'hook_stopped'|'tool_deferred'|'max_turns'|'background_requested'|'completed'|'budget_exhausted'|'structured_output_retry_exhausted'|'tool_deferred_unavailable'|'turn_setup_failed'` — точнее чем парсинг `result.subtype`/`stop_reason` строк, стоит завести как каноническую причину «почему ход закончился» в translator'е.
6. **`--max-budget-usd` (упомянут в cut §0.3, не протестирован в W0)** — residual, кандидат на CC-C смоук-предохранитель, НЕ проверен живьём в этом бюджете.
7. **`control_cancel_request`** — см. проба №3, новый тип сообщения (CLI отзывает свой pending control_request к нам).
8. **`system/permission_denied`** (`SDKPermissionDeniedMessage`-аналог) — отдельный top-level `system`-подтип, эмитится ПАРАЛЛЕЛЬНО с `tool_result{is_error:true}` при auto-deny (`dontAsk`-режим) — полезный структурированный сигнал для UI-нотиса, не нужно парсить текст `tool_result`.
9. **`ExitPlanMode` ВСЕГДА требует `can_use_tool`**, независимо от режима (кроме уже bypassPermissions, не проверено) — единственный по-настоящему универсальный approval-гейт в системе; хорошая якорная точка для approval-bridge MVP (гарантированно видимое событие).

---

## Итог: UNCERTAIN-маркеры research §3/§6.9 — статус

| UNCERTAIN (research) | Статус | Где |
|---|---|---|
| §3.3 control-протокол wire-байты | ✅ СНЯТО (реальные байты) | проба №2 |
| §3.4 `--permission-prompt-tool` жив? | ✅ СНЯТО (скрыт, но жив и ОБЯЗАТЕЛЕН) | проба №2/№11 |
| §3.5 resume ре-эмитит историю? | ✅ СНЯТО (НЕ ре-эмитит) | проба №4 |
| §3.6 список моделей подписки есть? | ✅ СНЯТО (ЕСТЬ, из `initialize`-ответа) | проба №2 |
| §3.6 effort mid-session есть? | ✅ СНЯТО (ЕСТЬ, `apply_flag_settings`) | проба №14 |
| §3.7 VERIFY-1 (Keychain-изоляция) | ✅ СНЯТО (**изолирует**) | проба №7 |
| §3.8/§6.7 честные % подписки недоступны | ✅ **ОПРОВЕРГНУТО** (доступны через `get_usage`, типово подтверждено, живьём — residual) | «Находки сверх research» №1 |
| §3.11 семантика SIGINT/SIGTERM in-flight | ❌ residual, НЕ протестировано (бюджет ушёл на control-протокол; `interrupt` control-request протестирован вместо raw-сигналов) | — |
| §6.9-№5 буферизация stdout | ✅ СНЯТО (не воспроизвелась в этой конфигурации) | проба №5 |
| §6.9-№13 дешёвый auth-probe | ✅ СНЯТО (handshake-only, $0, конкретный дискриминатор) | проба №13 |
| acceptEdits in-cwd auto-accept | ⚠ residual (инференс из доков, не подтверждено живьём) | проба №8 |
| CLAUDE.md/AutoMem изоляция при `--setting-sources project,local` | ⚠⚠ residual (НОВАЯ находка, НЕ решена — нужна доп. проба с явным `CLAUDE_CONFIG_DIR`) | проба №6 |
| `--max-budget-usd` поведение | ⚠ residual, не тестировано | «Находки сверх research» №6 |
| «лимит исчерпан» живая форма | ⚠ residual (не воспроизвели естественно; типовая форма `errorCode:"credits_required"` известна) | проба №12 |

## Бюджет ходов (метеринг владельца)

Точное число не подсчитывалось построчно, но категории:
- **$0-стоимость (chat не диспетчерился модели):** все control-only handshake'и (init, apply_flag_settings, authprobe×2, isolation-strict), interrupt-early (до диспетча), `/context` слэш-команда, VERIFY-1 signed-out проба, permmodes-денаилы (dontAsk/auto без can_use_tool). Это БОЛЬШИНСТВО проведённых проб.
- **Ненулевая, но малая стоимость:** interrupt-pending (~$0.0006, частичный диспетч), обычные короткие ходы (writeprobe, baseline, resume×3, image×2, permmodes-успешные ветки, persistence×2) — порядка 15-20 полных ходов по несколько центов каждый.
- **⚠ Одна дорогая ошибка:** проба «дешёвого» tривиального хода БЕЗ control-протокола (`w0-13-authprobe-cheap.jsonl`) обошлась в **$0.16** за один word-ответ — задокументирована как антипаттерн, НЕ повторять.
- Итоговый порядок расхода: заметно выше первоначальной оценки «~10-12 ходов» (много больше отдельных живых процессов), но подавляющее большинство — $0 или доли цента благодаря control-only и early-interrupt паттернам.

## Остаток / что НЕ входит в CC-W0

- Raw OS-level SIGINT/SIGTERM семантика (только `control_request interrupt` протестирован).
- `get_usage`/`get_context_usage` — типовая форма подтверждена из SDK, живой байтовый захват НЕ снят (residual для CC-E/квоты-волны, первая рекомендуемая проба).
- CLAUDE.md/AutoMem-изоляция под явным нестандартным `CLAUDE_CONFIG_DIR` — не перепроверено.
- `--max-budget-usd` живое поведение при срабатывании.
- «Лимит исчерпан» живая форма (не воспроизведена естественно).
- acceptEdits in-cwd (не вне cwd) — не проверено живьём.

---

## Addendum оркестратора (iter-1, session 6bf52dd2) — статус инцидента с кредом

Проверено и выполнено оркестратором ПОСЛЕ завершения lane'а:

- **Blast radius (скан count/filenames-only, значение секрета в контекст оркестратора НЕ читалось):** живой OAuth accessToken+refreshToken владельца обнаружен ТОЛЬКО в транскрипте мёртвого lane-процесса `~/.claude/projects/-Users-incadawr-projects-tools-anycode-track-claude-engine/d4cf5863-….jsonl` (вне репозитория, git его не трекает). Лейн-лог `w0-lane.log` = 0. **Все коммитируемые файлы `references/**` = 0** (все 21 фикстур + contract-draft.md + W0-FINDINGS.md PII-чисты). task-output dir = 0.
- **Defense-in-depth:** оркестратор отредактировал (redact) токен-образные строки в мёртвом lane-транскрипте (`sk-ant-…`/`eyJ…` → плейсхолдер); повторный скан = 0 нередактированных токенов; NDJSON цел (510/510 строк валидны). Секрет более не лежит в plaintext ни в одном контролируемом on-disk месте.
- **⛔ ТРЕБУЕТСЯ ДЕЙСТВИЕ ВЛАДЕЛЬЦА (redact ≠ ротация):** значение живого токена находилось в plaintext-транскрипте вне Keychain-границы. **Считать accessToken/refreshToken скомпрометированными и ротировать (`claude` → `/login` / повторная авторизация подписки).** Redact — только снижение остаточной экспозиции, НЕ замена ротации.
- **Durable-урок для будущих Keychain-проб:** `security find-generic-password` печатает пароль НЕ только на `-w`, но и на `-g` (в stderr, человекочитаемо). Брифовать: **запрещены и `-g`, и `-w`**; VERIFY-1-класс проб вести ТОЛЬКО метаданными (`-s`/`-a`, атрибуты сервиса/аккаунта) ЛИБО поведенчески (создаётся ли новая запись / просит ли повторный логин); секрет-печатающие пробы — не делегировать.
