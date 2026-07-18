# CC-W0 — Protocol Recon Findings (claude CLI v2.1.212)

- **Бинарь:** `[HOME]/.local/bin/claude` v2.1.212 (залогинен владельцем, подписка); для R5 дополнительно
  `[HOME]/.local/share/claude/versions/2.1.214` (`--version`-верифицированы оба — сравнение идёт между
  двумя реально разными бинарями, не одним и тем же дважды).
- **Метод:** одноразовые локальные пробы + записанные wire-фикстуры в `fixtures/`. Ноль продуктового кода.
- **Статус OG-CC-1:** НЕ снят на момент CC-W0 ⇒ только recon.
- Легенда: ✅ подтверждено на живом бинаре · ⚠ находка сверх research · ❓ ещё открыто (проба не проведена).

---

## Статус CC-W0 (итог волны)

| | |
|---|---|
| **Пробы 1-14** | все 14 проведены живым бинарём, реальными байтами. Закрыты полностью — 12; закрыты с явно-мотивированным остатком — 2 (№8 in-cwd `acceptEdits`, №12 «лимит исчерпан»). |
| **Добивочные R1-R5** | R1 (кастоди `CLAUDE_CONFIG_DIR`) ✅ ЗАКРЫТ · R2 (`get_usage`/`get_context_usage` живьём) ✅ ЗАКРЫТ · R3 (`set_model`) ✅ ЗАКРЫТ · R5 (version-drift 2.1.212→2.1.214) ✅ ЗАКРЫТ. R4 = эта финализация (слияние+контракт), не проба. |
| **Фикстуры** | 28 git-трекаемых `fixtures/w0-*.jsonl` (27 непустых + `w0-13-authprobe-emptystdin.jsonl` — пустой намеренно, отсутствие вывода И ЕСТЬ находка). Плюс 3 gitignore-нутых bootstrap-захвата. |
| **Живые ходы (метеринг)** | основной лейн проб 1-14: ~15-20 полных ходов, из них **одна дорогая ошибка $0.16** (`w0-13-authprobe-cheap`, антипаттерн) + ~$0.0006 на interrupt-pending; бóльшая часть проб — **$0** (control-only handshake / early-interrupt / слэш-команды). Добивочные **R1/R2/R3/R5: ровно 0 ходов** — все 7 новых фикстур сняты handshake-only, доказательство в §«$0-подтверждение R1-R5». |
| **Переносится дальше** | 15 остаточных пунктов, каждый с причиной и адресом волны — см. §«Таблица остатка» в конце. Ни одного немотивированного residual. |
| **⛔ Открытый инцидент** | OAuth-токен владельца напечатан в транскрипт при пробе VERIFY-1 ⇒ **требуется РОТАЦИЯ владельцем** (redact выполнен, ротация — нет). См. §Addendum. |

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

**Статус: все 14 проб проведены живым бинарём v2.1.212, реальными байтами. НОЛЬ продуктового кода.**

**Кредовый скан всех `fixtures/w0-*.jsonl`** (`dubov\.e\.v|sk-ant|oauth|bearer|refresh_token|access_token|ANTHROPIC_API_KEY`)
**= 0 живых совпадений.** Два формальных хита по `oauth` в `w0-15-usage.jsonl` и
`w0-18-version-drift-2.1.214.jsonl` — это **имя поля** `"seven_day_oauth_apps"` (ведро rate-limit),
значение которого проверено как литеральный `null`, не токен; с нейтрализацией этого имени остаток
скана = 0. ⚠ **Этот скан НЕ покрывает домашний путь/имя пользователя** — по ним есть реальный остаток,
см. **R-W0-8** в таблице остатка.

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
- ⚠⚠⚠ **НОВАЯ, более серьёзная находка (сверх research, через `/context` в пробе №10):** несмотря на `--setting-sources project,local` (что должно ИСКЛЮЧАТЬ source `"user"`), **глобальный `~/.claude/CLAUDE.md` владельца (660 токенов) И `~/.claude/projects/.../memory/MEMORY.md` (8.9k токенов, AutoMem) РЕАЛЬНО ЗАГРУЖЕНЫ в контекст модели** — видно в `/context`-выводе `w0-10-slashcmd.jsonl` (`result.result`, раздел «Memory Files» с полными путями `[HOME]/.claude/CLAUDE.md`). **Это НЕ гейтится `--setting-sources`, `--strict-mcp-config` ИЛИ `--disable-slash-commands` (проверено — фикстура снята БЕЗ последнего флага, но с двумя первыми).** Личные пути домашней директории + факт использования AutoMem утекли в system-контекст сессии.

#### R1 — residual ЗАКРЫТ: `CLAUDE_CONFIG_DIR` действительно закрывает утечку контента

Прежняя формулировка этого пункта («residual UNCERTAIN: неясно, какой флаг подавляет загрузку
user-global CLAUDE.md; вероятный кандидат `CLAUDE_CONFIG_DIR`, НЕ тестировано») **снята живой
трёхплечевой пробой** (`fixtures/w0-17-custody-{A-default,B-isolated,C-project}.jsonl`, 0 живых ходов —
ответ снят структурным `get_context_usage` сразу после `initialize`-ack, ни одного `user`-сообщения
не отправлялось; ни в одной из трёх фикстур нет даже `result`-события, которое можно было бы
оплатить).

| Плечо | `CLAUDE_CONFIG_DIR` | `memoryFiles[]` | Memory-категория | `totalTokens` |
|---|---|---|---|---|
| A — baseline (RED) | не задан (реальный `~/.claude`) | `[HOME]/.claude/CLAUDE.md` (Project, **660 tok**) + `.../memory/MEMORY.md` (AutoMem, **8969 tok**) | `"Memory files": 9629` | 28385 |
| B — изолирован | свежий пустой `mktemp -d` | `[HOME]/.claude/CLAUDE.md` (Project, **0 tok**), AutoMem-записи **нет вообще** | категории нет вовсе | 1931 |
| C — изолирован + project cwd | свежий пустой + cwd = корень worktree (там `AGENTS.md`) | **байт-в-байт как B** | **байт-в-байт как B** | 1931 |

**Ответ R1: ДА — `CLAUDE_CONFIG_DIR` закрывает утечку КОНТЕНТА.** Контент глобального `CLAUDE.md`
падает до **0 токенов**, запись AutoMem `MEMORY.md` исчезает из разбивки **целиком** (CLI просто не
знает о ней: `CLAUDE_CONFIG_DIR` релоцирует и поиск AutoMem — в кросс-чек-фикстуре
`system/init.memory_paths.auto` резолвится в пустой `<isolated-tmp>/projects/.../memory/`).
Подтверждено двумя независимыми методами на одном плече (структурный `get_context_usage` +
человекочитаемый `/context`, `fixtures/w0-17-custody-C-project-slashcheck.jsonl` — результат по
memory-файлам байт-идентичен: одна строка `Project | [HOME]/.claude/CLAUDE.md | 0`, ни AutoMem, ни
строки от `AGENTS.md`).

**Остаточная LOW-находка (не закрыта, и это важно для §5 контракта):** сам **путь** глобального
`CLAUDE.md` остаётся перечислимым как 0-токенная метаданная даже при полной изоляции — в плече B
`memoryFiles == [{"path":"[HOME]/.claude/CLAUDE.md","type":"Project","tokens":0}]`, причём путь
**реальный домашний**, а не изолированный tmp. Контент не пересекает границу; пересекает факт
существования пути (⇒ имя пользователя и раскладка home). Для эмбеддера это значит: изоляция
`CLAUDE_CONFIG_DIR` — необходимое, но **не достаточное** условие; `memoryFiles[].path` обязан
редактироваться на клиентском слое перед логом/показом (см. `contract-draft.md` §5).

**Следствие для архитектуры:** запланированная схема
`CLAUDE_CONFIG_DIR=~/.anycode/claude/profile-<id>` **валидирована как правильный механизм кастоди** —
второго, отдельного механизма для удержания личных `CLAUDE.md`/`MEMORY.md` вне контекста спавненного
движка не требуется (поверх того, что она уже делает для кредов — VERIFY-1, проба №7). **CC-B DoD
по-прежнему должен включать sentinel-leak PoC именно на `get_context_usage`-ответе** (не только grep
логов) — но теперь как регресс-тест известного-хорошего состояния, а не как проверку гипотезы.

**Что R1 НЕ закрыл (честные пределы, оба перенесены в таблицу остатка):**
- **Project-level (`AGENTS.md`) pickup** — не проверяем этой пробой: `AGENTS.md` не появляется
  отдельной строкой `memoryFiles` **ни в одном** плече, включая baseline A. Дискриминирующего сигнала
  в базлайне нет ⇒ сравнивать плечо C не с чем. Гипотезы (не проверены): `memoryFiles` этой версии
  перечисляет только файлы с именем `CLAUDE.md`, а `AGENTS.md` свёрнут в «System prompt»-токены; либо
  pickup материализуется только на живом ходе.
- **Исчезновение категорий `System prompt`/`System tools`/`System tools (deferred)` в плечах B/C**
  (в A они есть: 2610+14055+15555 tok) **НЕ атрибутируется `CLAUDE_CONFIG_DIR`**: свежий config-dir не
  имеет кредов, т.е. плечи B/C неизбежно **signed-out** (`account:{"tokenSource":"none"}` в кросс-чек-
  фикстуре). Отделить «изоляция убирает категории» от «signed-out сессия их не считает вовсе» можно
  только залогиненным изолированным профилем — вне скоупа W0 (запрет на обращение с кредами).

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
| `acceptEdits` | `set_permission_mode` succeeded; `Write` **вне cwd (`/tmp`) всё равно спросил** (`decision_reason_type:"workingDir"` — рабочая директория — отдельная ось от режима, режим её не переопределяет). **In-cwd случай НЕ протестирован живьём** — residual **R-W0-2**: все снятые ходы писали в `/tmp`, т.е. ВНЕ cwd; проверка требует живого хода ($) с записью ВНУТРИ cwd. Инференс из доков: должен авто-принимать. |
| `dontAsk` | `Write` → **автодениал БЕЗ единого `can_use_tool`** (`system/permission_denied` + `tool_result{is_error:true, content:"Permission to use Write has been denied because Claude Code is running in don't ask mode..."}`), модель затем попробовала `Bash` — тоже автодениал тем же путём. Подтверждает doc: «deny if not pre-approved», **и подтверждает: `dontAsk`-денаилы НЕ доходят до control-канала вообще** (нам не с чем работать на approval-bridge для этого режима, кроме отображения текста денаила). |
| `auto` | `Write` вне cwd → **файл создан БЕЗ единого `can_use_tool`** — классификатор одобрил молча, ЗА ПРЕДЕЛАМИ control-канала. **Продуктовое следствие: под `auto`-режимом эмбеддер НЕ ВИДИТ, что было одобрено классификатором** — нет approval-события для отображения в UI вообще. |
| `plan` | Модель сначала пишет **план-файл** в `~/.claude/plans/<slug>.md` без спроса → вызывает **`ExitPlanMode`** (ВСЕГДА гейтится `can_use_tool`, `tool_name:"ExitPlanMode"`, без `decision_reason`) → мы allow → `"User has approved your plan..."` → **после этого модель пишет РЕАЛЬНЫЙ файл `/tmp/...` тоже БЕЗ повторного спроса** (мод неявно эскалирован постExitPlanMode). Plan-режим НЕ «чистый read-only» на уровне tool-gate — это system-prompt-инструкция + обязательный `ExitPlanMode`-гейт, а не хардблок исполнения. |

#### R3 — `set_model`: вторая мутирующая control-команда, снята живьём (`w0-16-setmodel.jsonl`)

Рядом с `set_permission_mode` в том же классе «мутирующих» control-запросов стоит `set_model`.
Снят живьём, 0 ходов. Валидная модель берётся из `initialize`-ответа `models[].value` (на этой сборке
предлагаются: `default`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `haiku`).

- **Успех** (L9→L11): `{"subtype":"set_model","model":"claude-fable-5[1m]"}` →
  `{"type":"control_response","response":{"subtype":"success","request_id":"…"}}`.
  **У успеха НЕТ тела `response` вообще** — ключ отсутствует, не пустой. Это отличается от
  `set_permission_mode`, который эхом возвращает `{"mode":…}`. ⇒ применённую модель из ack прочитать
  нельзя, только «принято».
- **Отказ** (L17→L18): `{"model":"no-such-model-xyz"}` → `{"subtype":"error","error":"Model
  \"no-such-model-xyz\" is not a recognized model id. Run /model to see available models."}`.
  **Дискриминатор — `response.subtype` (`success`|`error`), НЕ текст ошибки** (текст — человеческая
  проза, будет дрейфовать). Латентность отказа 4мс против ~1мс на принятие ⇒ валидация локальная,
  против того же списка `models[]`, без round-trip на сервер.
- ✅ **Эффект наблюдаем за $0** (проба ожидала здесь residual — его нет): `get_context_usage.model` —
  бесплатный read-back, поэтому мутации зажаты между чтениями контекста:

| Шаг | строка фикстуры | `get_context_usage.model` |
|---|---|---|
| базлайн после `initialize` | L6 | `claude-opus-4-8[1m]` |
| после **валидного** `set_model claude-fable-5[1m]` | L14 | **`claude-fable-5`** |
| после **отклонённого** `set_model no-such-model-xyz` | L21 | `claude-fable-5` (не изменилась) |

  Три факта, все доказаны байтами: (1) успешный `set_model` применяется **немедленно**, ход не нужен;
  (2) отклонённый — **чистый no-op**, не сбрасывает ранее применённую модель (падение безопасно);
  (3) ⚠ **read-back возвращает РЕЗОЛВНУТЫЙ id, а не запрошенный** (`claude-fable-5[1m]` →
  `claude-fable-5`; аналогично `opus[1m]` → `claude-opus-4-8[1m]`). **Продукт, который выставил `X` и
  ассертит `context.model === X`, поймает ложное расхождение** — сравнивать надо с `resolvedModel`
  выбранной записи `initialize.models[]`, либо не round-trip-ассертить вовсе.
- ⚠⚠ **Побочная находка (класс дефекта для стрим-консьюмера):** успешный `set_model` эмитит
  **незапрошенный кадр `type:"user"`** (L10) — **ДО** control-ack (L11):
  `{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to
  claude-fable-5[1m] (claude-fable-5)</local-command-stdout>"},…,"isReplay":true}`.
  Очевидное подозрение, что это просто `--replay-user-messages`, **опровергнуто**: пере-прогон того же
  сценария без флага (`W0_NO_REPLAY=1`) даёт тот же кадр, один раз, с тем же `isReplay:true`.
  ⇒ Консьюмер, рендерящий каждый `type:"user"` как ход пользователя, **нарисует фантомное
  пользовательское сообщение в транскрипте на каждом переключении модели**. Фильтровать по
  `isReplay === true` и/или обёртке `<local-command-stdout>`. Отклонённый `set_model` такого кадра не
  эмитит — эхо заодно служит (избыточным) сигналом успеха.

**Снимает UNCERTAIN §3.4/§6.9-№8 полностью** (кроме in-cwd-acceptEdits, residual-инференс). ⚠ **Расхождение enum:** CLI `--help`/`v2.1.212` (`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`) использует `manual`, а control-протокол/`SDKSystemMessage.permissionMode`/`system/init` живьём отдаёт **`"default"`** (не `"manual"`) для того же режима — т.е. **CLI-флаг `manual` ↔ wire-значение `default`** это ОДИН И ТОТ ЖЕ режим под разными именами на разных уровнях. CC-B обязан маппить `manual`(флаг)↔`default`(wire) явно.

### Проба №9 — image-вложения (`w0-09-image.jsonl`, `w0-09-image-red.jsonl`)

- Первая попытка (прозрачный 1×1 PNG) дала «There is no pixel or image here to inspect» — ЛОЖНО похоже на «не поддерживается», но это была ошибка выбора тестового изображения (полностью прозрачный пиксель без цветовой информации).
- ✅ **Вторая попытка (непрозрачный 1×1 PNG)** — модель ответила `"Pink"` (реальная, хоть и не 100%-точная, цветовая оценка) — **подтверждает: `image`-контент-блок в stream-json user-сообщении ДОХОДИТ до модели и обрабатывается.** `supportsImages: true` эмпирически подтверждён.

### Проба №10 — слэш-команды в headless (`w0-10-slashcmd.jsonl`)

✅ **`/context` исполнился локально**: `result.num_turns:0`, `result.duration_api_ms:0`, `message.model:"<synthetic>"` — **встроенные слэш-команды из stream-json user-контента ИСПОЛНЯЮТСЯ, и делают это БЕЗ вызова модели (0 стоимость)**, когда команда чисто локальная (типа `/context`). (Побочно раскрыл находку изоляции CLAUDE.md выше — проба №6.) Тот же путь используется и `"<synthetic>"`-моделью для «not logged in» ответа (проба №12/VERIFY-1) — это общий маркер «локальный/не-API ответ», полезно для discriminating формы в контракте.

### Проба №11 — `--permission-prompt-tool` — ОКОНЧАТЕЛЬНО ЗАКРЫТА

Флаг **ЕСТЬ**, но **скрыт от `--help`** в v2.1.212 — уточнение к прежней записи «флага нет». Он ЖИВ и ОБЯЗАТЕЛЕН для control-протокольного permission-моста (см. проба №2). Значение `"stdio"` — единственное протестированное и, судя по SDK-source, единственное осмысленное для нашего паттерна (SDK всегда передаёт литерал `"stdio"`, никогда другое значение, при наличии `canUseTool`-колбэка).

### Проба №12 — форма ошибки «не залогинен» (`w0-07-verify1-configdir-probe.jsonl`, `w0-13-authprobe-signedout.jsonl`)

✅ Полная форма (см. проба №7): `assistant.error:"authentication_failed"`, `assistant.message.content[0].text:"Not logged in · Please run /login"`, `assistant.message.model:"<synthetic>"`, `result.subtype:"success"` (⚠ НЕ `"error"` несмотря на `is_error:true` и провал аутентификации — discriminating нюанс для doctor/UI: смотреть `is_error`+`error`-поле assistant-сообщения, а не полагаться на `result.subtype`), `result.total_cost_usd:0`. control-протокольный `initialize`-ответ параллельно даёт `account:{"tokenSource":"none","apiProvider":"firstParty"}` без `email`/`subscriptionType`. «Лимит исчерпан» форма НЕ поймана — residual **R-W0-4**: невоспроизводима по требованию (нужно реально упереться в квоту владельца, намеренно этого не делали), типовая форма `SDKRateLimitInfo.errorCode:"credits_required"` известна из типа ⇒ ждать естественного случая.

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

1. **★★★ `get_usage` — ОПРОВЕРГАЕТ §6.7/§3.8 «честных процентов подписки нет». СНЯТ ЖИВЬЁМ (R2).**
   `control_request{subtype:"get_usage"}` (SDK-метод называется
   `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` — экспериментальный, форма может
   измениться, НО это ОФИЦИАЛЬНЫЙ первостатейный control-канал, НЕ серый
   `api.anthropic.com/api/oauth/usage`-эндпоинт из §3.8). Запрос — голый, ровно как объявляет тип.
   **Живой захват: `fixtures/w0-15-usage.jsonl` L5**, 0 ходов, латентность ~766мс после
   `initialize`-ack (≈1с-класс: дёшево дёргать по требованию, слишком медленно для синхронного
   UI-hot-path).

   Живой payload на подписочной сессии владельца:
   `subscription_type:"max"`, `rate_limits_available:true`, окна `five_hour{utilization:3,resets_at}`
   и `seven_day{utilization:76,…}`, плюс самоописывающийся массив `limits[]`:

   ```json
   {"kind":"session",       "group":"session","percent":3, "severity":"normal",   "scope":null, "is_active":false}
   {"kind":"weekly_all",    "group":"weekly", "percent":76,"severity":"warning",  "scope":null, "is_active":false}
   {"kind":"weekly_scoped", "group":"weekly", "percent":94,"severity":"critical",
    "scope":{"model":{"id":null,"display_name":"Fable"}}, "is_active":true}
   ```

   ⚠ **`limits[]` несёт сигнал, которого нет в плоских окнах** — `severity` и `is_active`. Здесь
   связывающее ограничение — `weekly_scoped` 94% `critical` `is_active:true` (недельное ведро Fable),
   тогда как плоский `seven_day` показывает 76% `warning`. **Чтение только плоских окон занизило бы
   близость аккаунта к реальному лимиту на 18 п.п.** ⇒ читать severity из `limits[]`.

   ⚠⚠ **Живой payload — строгий НАДмножество `SDKControlGetUsageResponse`** (диффано механически, не
   на глаз): объявленных-но-отсутствующих полей **нет ни одного**; сверх типа живьём приходят 11 ключей
   под `rate_limits` (`seven_day_cowork`, `seven_day_omelette`, `tangelo`, `iguana_necktie`,
   `omelette_promotional`, `nimbus_quill`, `cinder_cove`, `amber_ladder`, `limits`, `spend`,
   `member_dashboard_available`), 3 внутри каждого окна (`limit_dollars`/`used_dollars`/
   `remaining_dollars`, все `null`) и 4 внутри `extra_usage`. **Два продуктовых следствия:**
   (а) **никогда не валидировать этот payload закрытой схемой** (`z.object().strict()`, исчерпывающий
   switch по ключам окон) — отвергнет живой трафик уже сегодня, до всякого бампа версии;
   (б) восемь недекларированных вёдер — **кодовые имена нерелизнутых фич**, здесь все `null`; они
   зажгутся без предупреждения. **UI, перечисляющий ключи `rate_limits` и рендерящий каждый как
   подписанный индикатор, однажды покажет владельцу кодовое имя.** Рендерить из allow-list известных
   окон, а не обходом объекта; `limits[]` — более безопасная поверхность (самоописывающаяся, и именно
   на неё завязана раскраска severity в самом TUI).

   **Меняет OG-CC-4 risk-оценку: квоты-UI МОГУТ строиться на честных процентах через официальный путь,
   без серого эндпоинта — теперь это не гипотеза о типе, а снятые байты.**
2. **`rate_limit_event` (top-level message, уже виден в bootstrap) — полная типовая форма из SDK:** `SDKRateLimitInfo = {status:'allowed'|'allowed_warning'|'rejected', resetsAt?, rateLimitType?:'five_hour'|'seven_day'|'seven_day_opus'|'seven_day_sonnet'|'seven_day_overage_included'|'overage', utilization?, overageStatus?, overageResetsAt?, overageDisabledReason?, isUsingOverage?, overageInUse?, surpassedThreshold?, errorCode?:'credits_required', canUserPurchaseCredits?, hasChargeableSavedPaymentMethod?}`. Живьём пойман дважды (`w0-03-interrupt-pending.jsonl`, permmodes-фикстуры) с `status:"allowed", rateLimitType:"five_hour", overageStatus:"allowed", isUsingOverage:false` — сообщение эмитится АВТОМАТИЧЕСКИ на обычных ходах, не нужно ничего просить.
3. **`get_context_usage` control-ответ — СНЯТ ЖИВЬЁМ (R2).** Намного детальнее самодельного расчёта
   из `usage`-полей `result`; то же, что рендерит `/context` в TUI, но структурированно.
   Живой захват: `fixtures/w0-15-usage.jsonl` L8 (+989мс), 0 ходов. Живые ключи:
   `{categories[], totalTokens:28659, maxTokens:1000000, rawMaxTokens, percentage:3, gridRows[][],
   model:"claude-opus-4-8[1m]", memoryFiles[], mcpTools[], agents[], slashCommands{}, skills{},
   autoCompactThreshold:967000, isAutoCompactEnabled:true, messageBreakdown{}, apiUsage:null,
   autocompactSource:"auto"}`.

   Расхождения с `SDKControlGetContextUsageResponse` (диффано механически):
   - **сверх типа:** `autocompactSource` (`"auto"`) — в типе отсутствует вовсе;
   - **объявлено, но не пришло на этом handshake:** `deferredBuiltinTools`, `systemTools`,
     `systemPromptSections` — все три опциональны (`?`) в типе. Их суммарные токены **всё равно
     достижимы** через `categories[]` («System tools», «System tools (deferred)» с `isDeferred:true`),
     т.е. заголовочные числа не теряются — теряется только per-tool разбивка. Появляются ли они после
     реального хода — **НЕ проверено** (нужен оплаченный ход) ⇒ residual R2-a;
   - ⚠ **`apiUsage` — `null`** на свежей handshake-only сессии (тип допускает `… | null`, так что это
     легально по типу). Практическое следствие: **`apiUsage` не может быть источником ctx-метра
     продукта** — он null ровно тогда, когда хода ещё не было.

   **Для продукта:** `totalTokens`/`maxTokens`/`percentage` дают метр контекста напрямую, а
   `autoCompactThreshold` (967000 из 1000000) — точку срабатывания компакции, т.е. именно то, что
   нужно индикатору «сколько осталось до компакта». `memoryFiles[]` присутствует и населён — это тот
   самый канал, на котором R1 доказал кастоди-изоляцию (см. пробу №6).
4. **`SDKAssistantMessageError` enum (доктор/error-UI):** `'authentication_failed'|'oauth_org_not_allowed'|'billing_error'|'rate_limit'|'overloaded'|'invalid_request'|'model_not_found'|'server_error'|'unknown'|'max_output_tokens'` — полный список причин отказа хода, годится как есть для `ClaudeDoctorReport.error`/UI notice enum.
5. **`TerminalReason` enum** (`result.terminal_reason`): `'blocking_limit'|'rapid_refill_breaker'|'prompt_too_long'|'image_error'|'model_error'|'api_error'|'malformed_tool_use_exhausted'|'aborted_streaming'|'aborted_tools'|'stop_hook_prevented'|'hook_stopped'|'tool_deferred'|'max_turns'|'background_requested'|'completed'|'budget_exhausted'|'structured_output_retry_exhausted'|'tool_deferred_unavailable'|'turn_setup_failed'` — точнее чем парсинг `result.subtype`/`stop_reason` строк, стоит завести как каноническую причину «почему ход закончился» в translator'е.
6. **`--max-budget-usd` (упомянут в cut §0.3, не протестирован в W0)** — residual **R-W0-3**: проверка
   срабатывания требует намеренно исчерпать бюджет живыми ходами ($), что вне бюджета W0 ⇒ кандидат на
   CC-C смоук-предохранитель.
7. **`control_cancel_request`** — см. проба №3, новый тип сообщения (CLI отзывает свой pending control_request к нам).
8. **`system/permission_denied`** (`SDKPermissionDeniedMessage`-аналог) — отдельный top-level `system`-подтип, эмитится ПАРАЛЛЕЛЬНО с `tool_result{is_error:true}` при auto-deny (`dontAsk`-режим) — полезный структурированный сигнал для UI-нотиса, не нужно парсить текст `tool_result`.
9. **`ExitPlanMode` ВСЕГДА требует `can_use_tool`**, независимо от режима (кроме уже bypassPermissions, не проверено) — единственный по-настоящему универсальный approval-гейт в системе; хорошая якорная точка для approval-bridge MVP (гарантированно видимое событие).

---

## R5 — version-drift: контракт пинован на 2.1.212, что с 2.1.214

Контракт снимался на 2.1.212, а CC релизится еженедельно — вопрос «переносится ли он на следующую
сборку» решает, можно ли объявлять пин потолком или полом. Прогнан **идентичный handshake-only
`usage-probe` против обоих бинарей** (`--version` проверен на каждом ⇒ это действительно разные
сборки), сравнение — не глазами: из каждого payload извлекался **типизированный набор ключ-путей**
(каждый вложенный путь, массивы обходятся целиком, листья редуцируются до JS-типа), наборы диффались.
Такой метод игнорирует значения, которые законно плавают между прогонами (таймстемпы, utilization,
счётчики запросов), и ловит именно структурный дрейф.

| Control-ответ | 2.1.212 | 2.1.214 | Дрейф |
|---|---|---|---|
| `initialize` | 62 типизированных ключ-пути | 62 | **нет** |
| `get_usage` | 221 | 221 | **нет** |
| `get_context_usage` | 96 | 96 | **нет** |

Ничего не добавлено, ничего не удалено, ни один лист не сменил тип. Точечные сверки стабильных
скаляров совпадают на обеих версиях: топ-ключи `initialize`; `models[].value` = `default | opus[1m] |
claude-fable-5[1m] | sonnet | haiku` (тот же список, тот же порядок); `subscription_type:"max"`;
`rate_limits_available:true`; `get_context_usage.model` `claude-opus-4-8[1m]`, `maxTokens` 1000000,
`autoCompactThreshold` 967000 и те же 7 категорий в том же порядке.
Фикстура: `fixtures/w0-18-version-drift-2.1.214.jsonl`.

**Вердикт: контракт v2.1.212 переносится на 2.1.214 как есть.** Продуктовых изменений под бамп не
нужно; для этих трёх поверхностей пин можно ослабить до **пола** (`>=2.1.212`), а не потолка.

**Два честных предела этого вердикта (оба — в таблицу остатка, не замазывать):**
- ⚠ **`system/init.capabilities` НЕ сравнивались между версиями** — они не наблюдаемы на
  handshake-only прогоне: `system/init` эмитится только после `user`-сообщения (видно по
  `w0-13-authprobe-signedin.jsonl` — 4 строки, ни одного `system`-кадра). Сравнение capabilities стоит
  **по одному оплаченному ходу на версию**, не потрачено ⇒ **R5-a**. Это дыра в утверждении о дрейфе,
  а не покрытый случай — а поскольку capability-гейт (§3 контракта) построен именно на
  `capabilities[]`, дыра лежит ровно под несущей конструкцией.
- ⚠ Дрейф измерен на **трёх read-only control-поверхностях**. Мутирующие (`set_model`,
  `set_permission_mode`, `can_use_tool`) на 2.1.214 не перепроверялись ⇒ **R5-b** (закрывается за $0,
  просто не входило в заданный набор фикстур).
- Совпадение счётчиков `commands` 43 / `agents` 5 на обеих версиях — свидетельство того, что оба
  прогона видели одно окружение, **а не** свидетельство о совместимости бинарей (эти числа отражают
  локальный конфиг).

## $0-подтверждение добивочных R1/R2/R3/R5

Бюджет живых ходов добивочных лейнов был 0, и он соблюдён. Механическое доказательство —
**отсутствие кадра `type:"result"`**: CLI эмитит ровно один такой кадр на завершённый ход, значит
фикстура без него не содержит хода.

| Фикстура | есть `type:"result"` | подтверждение |
|---|---|---|
| `w0-15-usage.jsonl` | **нет** | `get_usage.session.total_cost_usd: 0`, `total_api_duration_ms: 0`, `model_usage: {}` — собственная бухгалтерия CLI согласна, что инференса не было |
| `w0-16-setmodel.jsonl` | **нет** | — (кадра result нет вовсе) |
| `w0-18-version-drift-2.1.214.jsonl` | **нет** | то же, что `w0-15` |
| `w0-17-custody-A/B/C.jsonl` | **нет** | в фикстуре только 2 пары control-запрос/ответ (`initialize`, `get_context_usage`) + служебные строки харнесса; **нет ни `system/init`, ни `user`, ни `assistant`, ни `result`** — CLI ответил из локального состояния, не дойдя до эмиссии init |
| `w0-17-custody-C-project-slashcheck.jsonl` | есть | но это `/context`: `num_turns:0`, `total_cost_usd:0`, `model:"<synthetic>"` — локальный ответ, ноль стоимости (та же форма, что `w0-10-slashcmd.jsonl`) |

Это доказательство сильнее, чем ссылка на поле `total_cost_usd:0`: там, где нет `result`-события,
нет и события, стоимость которого можно было бы предъявить.

## Итог: UNCERTAIN-маркеры research §3/§6.9 — статус

| UNCERTAIN (research) | Статус | Где |
|---|---|---|
| §3.3 control-протокол wire-байты | ✅ СНЯТО (реальные байты) | проба №2 |
| §3.4 `--permission-prompt-tool` жив? | ✅ СНЯТО (скрыт, но жив и ОБЯЗАТЕЛЕН) | проба №2/№11 |
| §3.5 resume ре-эмитит историю? | ✅ СНЯТО (НЕ ре-эмитит) | проба №4 |
| §3.6 список моделей подписки есть? | ✅ СНЯТО (ЕСТЬ, из `initialize`-ответа) | проба №2 |
| §3.6 effort mid-session есть? | ✅ СНЯТО (ЕСТЬ, `apply_flag_settings`) | проба №14 |
| §3.7 VERIFY-1 (Keychain-изоляция) | ✅ СНЯТО (**изолирует**) | проба №7 |
| §3.8/§6.7 честные % подписки недоступны | ✅ **ОПРОВЕРГНУТО и СНЯТО ЖИВЬЁМ** (`get_usage`, `subscription_type:"max"`, окна + `limits[]` с severity) | R2 / «сверх research» №1 |
| §3.11 семантика SIGINT/SIGTERM in-flight | ⚠ residual **R-W0-1** — не тестировано: бюджет ушёл на control-протокол, а `interrupt` control-request покрывает продуктовый сценарий; raw-сигналы нужны только для аварийного teardown ⇒ CC-C | таблица остатка |
| §6.9-№5 буферизация stdout | ✅ СНЯТО (не воспроизвелась в этой конфигурации) | проба №5 |
| §6.9-№13 дешёвый auth-probe | ✅ СНЯТО (handshake-only, $0, конкретный дискриминатор) | проба №13 |
| acceptEdits in-cwd auto-accept | ⚠ residual **R-W0-2** — требует живого хода ($): нужен реальный Write ВНУТРИ cwd, а все снятые ходы писали в `/tmp` | таблица остатка |
| CLAUDE.md/AutoMem изоляция при `--setting-sources project,local` | ✅ **СНЯТО (R1)**: `--setting-sources` НЕ гейтит, но **`CLAUDE_CONFIG_DIR` закрывает утечку контента** (660→0 tok, AutoMem исчезает); остаётся LOW-остаток — путь `CLAUDE.md` перечислим как 0-токенная метаданная | проба №6 / R1 |
| `--max-budget-usd` поведение | ⚠ residual **R-W0-3** — не тестировано: срабатывание требует намеренно исчерпать бюджет живыми ходами ($) ⇒ CC-C смоук | таблица остатка |
| «лимит исчерпан» живая форма | ⚠ residual **R-W0-4** — невоспроизводимо по требованию: нужно реально исчерпать квоту владельца; типовая форма `errorCode:"credits_required"` известна ⇒ ждать естественного случая | таблица остатка |
| project-level `AGENTS.md` pickup при изоляции | ⚠ residual **R-W0-5** — в базлайне нет дискриминирующего сигнала (`AGENTS.md` не появляется отдельной строкой `memoryFiles` НИ в одном плече, включая RED) ⇒ сравнивать не с чем | R1 / проба №6 |
| `system/init.capabilities` дрейф между версиями | ⚠ residual **R5-a** — `system/init` не эмитится на handshake-only; сравнение стоит по оплаченному ходу на версию | R5 |

## Бюджет ходов (метеринг владельца)

Точное число не подсчитывалось построчно, но категории:
- **$0-стоимость (chat не диспетчерился модели):** все control-only handshake'и (init, apply_flag_settings, authprobe×2, isolation-strict), interrupt-early (до диспетча), `/context` слэш-команда, VERIFY-1 signed-out проба, permmodes-денаилы (dontAsk/auto без can_use_tool). Это БОЛЬШИНСТВО проведённых проб.
- **Ненулевая, но малая стоимость:** interrupt-pending (~$0.0006, частичный диспетч), обычные короткие ходы (writeprobe, baseline, resume×3, image×2, permmodes-успешные ветки, persistence×2) — порядка 15-20 полных ходов по несколько центов каждый.
- **⚠ Одна дорогая ошибка:** проба «дешёвого» tривиального хода БЕЗ control-протокола (`w0-13-authprobe-cheap.jsonl`) обошлась в **$0.16** за один word-ответ — задокументирована как антипаттерн, НЕ повторять.
- Итоговый порядок расхода: заметно выше первоначальной оценки «~10-12 ходов» (много больше отдельных живых процессов), но подавляющее большинство — $0 или доли цента благодаря control-only и early-interrupt паттернам.
- **Добивочные лейны R1/R2/R3/R5: ровно 0 ходов** — 7 новых фикстур сняты handshake-only. Доказательство
  не «поле стоимости = 0», а **отсутствие кадра `result`** (см. §«$0-подтверждение добивочных»).

## Таблица остатка — что открыто, почему и куда переносится

Каждый пункт имеет ЯВНУЮ причину незакрытия. Немотивированных residual в этом отчёте не осталось:
все прежние «residual» без причины либо закрыты по снятым фикстурам (R1, R2, R3, R5), либо получили
причину ниже.

| ID | Что открыто | Почему НЕ закрыто | Волна |
|---|---|---|---|
| **R-W0-1** | Raw OS-level SIGINT/SIGTERM семантика in-flight | вне скоупа W0: `control_request interrupt` покрывает продуктовый сценарий отмены; raw-сигналы нужны только аварийному teardown | CC-C |
| **R-W0-2** | `acceptEdits` авто-принимает ли запись **внутри** cwd | требует живого хода ($): все снятые ходы писали в `/tmp`, т.е. ВНЕ cwd, где режим заведомо спрашивает | CC-C (дешёвый ход) |
| **R-W0-3** | `--max-budget-usd` поведение при срабатывании | требует намеренного исчерпания бюджета живыми ходами ($) | CC-C смоук-предохранитель |
| **R-W0-4** | Живая форма «лимит исчерпан» | невоспроизводимо по требованию — нужно реально упереться в квоту владельца; типовая форма (`errorCode:"credits_required"`) известна | ждать естественного случая |
| **R-W0-5** | Подхват project-level `AGENTS.md` при изолированном `CLAUDE_CONFIG_DIR` | дискриминирующего сигнала нет в САМОМ базлайне: `AGENTS.md` не даёт строки `memoryFiles` ни в одном плече, включая RED ⇒ не с чем сравнивать. Закрывается либо временным `CLAUDE.md` в worktree (тронет коммитимый путь), либо живым ходом ($) | CC-B (DoD-проверка изоляции) |
| **R-W0-6** | Путь глобального `CLAUDE.md` перечислим как 0-токенная метаданная даже при изоляции | **BY DESIGN CLI**, флагом не убирается ⇒ не «не проверено», а «проверено и не устранимо на стороне CLI» — лечится редакцией на клиентском слое | CC-B (обязательное требование §5 контракта) |
| **R-W0-7** | Разделить «изоляция убирает категории System prompt/tools» vs «signed-out сессия их не считает» | требует **залогиненного изолированного профиля**; обращение с кредами запрещено в скоупе W0 | owner / CC-A (при заведении первого профиля) |
| **R2-a** | Появляются ли `deferredBuiltinTools`/`systemTools`/`systemPromptSections` после реального хода | требует оплаченного хода ($): отличить «опционально и опущено» от «эмитится только после хода» иначе нельзя. Не блокирует — заголовочные токены достижимы через `categories[]` | CC-E / квоты-UI |
| **R2-b** | Населённая форма `session.model_usage` (`ModelUsage`) | требует оплаченного хода ($) — на handshake-only всегда `{}` | CC-E |
| **R2-c** | Населённая форма 8 кодовых rate-limit окон | все `null` на этом аккаунте; форма зажжётся только когда Anthropic включит фичу — **непроверяемо в принципе** сейчас | наблюдать; защита = allow-list рендера (§6 контракта) |
| **R3-a** | Что следующий инференс реально роутится в новую модель | требует оплаченного хода ($). Доказано косвенно: резолвнутое состояние сессии переключается (`get_context_usage.model`), `maxTokens` не поехал | CC-C |
| **R3-b** | `set_model` с **опущенным** `model` (тип объявляет `model?`, подразумевая reset-to-default) | не входило в заданные два плеча, скоуп не расширялся; **закрывается за $0** | CC-B (дешёвая добивка) |
| **R5-a** | Дрейф `system/init.capabilities` между версиями | `system/init` не эмитится на handshake-only ⇒ нужен оплаченный ход **на каждую версию**. ⚠ Значимо: capability-гейт §3 контракта построен ровно на этом поле | CC-B (перед объявлением пола версии) |
| **R5-b** | Мутирующие control-запросы (`set_model`/`set_permission_mode`/`can_use_tool`) на 2.1.214 | не входило в заданный набор фикстур; **закрывается за $0** (`setmodel-probe` против 2.1.214) | CC-B (дешёвая добивка) |
| **R-W0-8** | ⚠ **Кастоди-несогласованность фикстур:** имя пользователя владельца присутствует в 19 git-трекаемых фикстурах и 2 harness-скриптах (дефолтный `[HOME]`-скраб появился только в поздних лейнах; `w0-08-permmodes2` — 10 вхождений, `w0-08-permmodes`/`w0-10-slashcmd` — по 3-4, остальные по 1-2) | **находка этой финализации, не правилась здесь** — переписывать 19 файлов-доказательств вне скоупа R4 и это решение оркестратора. Severity **LOW**: имя пользователя совпадает с GitHub-хэндлом в URL самого репозитория (`github.com/<handle>/anycode`), т.е. публично по построению; дополнительно утекает раскладка home и факт использования AutoMem. **Прескрайбленный приёмкой греп по `*.md` этого не ловит** — он не покрывает ни фикстуры, ни dash-форму `-Users-<handle>-…` | оркестратор (решение: скрабить или принять) |

**Подытог:** 15 пунктов остатка. Из них требуют оплаченного хода — 7 (R-W0-2/3, R2-a/b, R3-a, R5-a,
частично R-W0-5); закрываются за $0 — 2 (R3-b, R5-b); непроверяемы сейчас в принципе — 2 (R-W0-4,
R2-c); вне скоупа/owner-gated — 2 (R-W0-1, R-W0-7); by-design и лечатся кодом, а не пробой — 1
(R-W0-6); решение оркестратора — 1 (R-W0-8).

---

## Addendum оркестратора (iter-1, session 6bf52dd2) — статус инцидента с кредом

Проверено и выполнено оркестратором ПОСЛЕ завершения lane'а:

- **Blast radius (скан count/filenames-only, значение секрета в контекст оркестратора НЕ читалось):** живой OAuth accessToken+refreshToken владельца обнаружен ТОЛЬКО в транскрипте мёртвого lane-процесса `~/.claude/projects/[HOME-SLUG]-projects-tools-anycode-track-claude-engine/d4cf5863-….jsonl` (вне репозитория, git его не трекает). Лейн-лог `w0-lane.log` = 0. **Все коммитируемые файлы `references/**` = 0** (фикстуры + contract-draft.md + W0-FINDINGS.md чисты по кредовым паттернам). task-output dir = 0.
  - ⚠ **Уточнение R4 (финализация):** формулировка «PII-чисты» была шире, чем проведённый скан. Скан
    покрывал **кредовые** паттерны (`dubov\.e\.v|sk-ant|oauth|bearer|refresh_token|access_token|
    ANTHROPIC_API_KEY`) и по ним результат действительно 0. Он **не покрывал домашний путь/имя
    пользователя**, которые присутствуют в 19 фикстурах и 2 harness-скриптах — см. **R-W0-8** в
    таблице остатка. По кредам вывод addendum'а в силе; «PII-чисто» в широком смысле — нет.
- **Defense-in-depth:** оркестратор отредактировал (redact) токен-образные строки в мёртвом lane-транскрипте (`sk-ant-…`/`eyJ…` → плейсхолдер); повторный скан = 0 нередактированных токенов; NDJSON цел (510/510 строк валидны). Секрет более не лежит в plaintext ни в одном контролируемом on-disk месте.
- **⛔ ТРЕБУЕТСЯ ДЕЙСТВИЕ ВЛАДЕЛЬЦА (redact ≠ ротация):** значение живого токена находилось в plaintext-транскрипте вне Keychain-границы. **Считать accessToken/refreshToken скомпрометированными и ротировать (`claude` → `/login` / повторная авторизация подписки).** Redact — только снижение остаточной экспозиции, НЕ замена ротации.
- **Durable-урок для будущих Keychain-проб:** `security find-generic-password` печатает пароль НЕ только на `-w`, но и на `-g` (в stderr, человекочитаемо). Брифовать: **запрещены и `-g`, и `-w`**; VERIFY-1-класс проб вести ТОЛЬКО метаданными (`-s`/`-a`, атрибуты сервиса/аккаунта) ЛИБО поведенчески (создаётся ли новая запись / просит ли повторный логин); секрет-печатающие пробы — не делегировать.

### Addendum R-W0-8 — скраб домашнего пути выполнен (iter-3, 2026-07-18)

Диспозиция триажа `R-CC-W0-T` №6 (Fable): **скрабить в `references/` до owner-мержа** — репозиторий
публичный, а `cwd`-величина средовая, не протокольная, поэтому доказательная сила фикстур не страдает
(drift-гейт сверяет типы и key-path'ы, не значения).

- **Скоуп исполненного скраба: 21 трекаемый файл** — 19 фикстур (17 в сырой форме `/Users/<user>`,
  2 только в dash-slug форме) + `harness/w0-control-harness.mjs` + `harness/w0-custody-probe.mjs`.
- **Замены (только префикс, хвост пути сохранён):** `/Users/<user>` → `[HOME]`,
  `-Users-<user>` → `[HOME-SLUG]`. JSON-метасимволы не вводились.
- **Четыре проверки после скраба — все пройдены:** (1) обе формы по `git ls-files references/` = 0;
  (2) литеральное имя пользователя в `references/` = 0; (3) экранированная `\/Users` и URL-форма
  `%2FUsers` = 0 (остаточные совпадения `/Users/<user>` в `contract-draft.md` и заголовке харнесса —
  намеренные плейсхолдеры документации, не PII); (4) построчная целостность: число строк в каждом
  `.jsonl` неизменно, все непустые строки — валидный JSON.
- **`w0-bootstrap-stdout.jsonl` НЕ скрабился и остаётся вне трекинга** (`fixtures/.gitignore`): его
  утечка контентная (дефолтный `~/.claude` владельца), а не путевая. Нормативных ссылок на него в cut'е
  после переякорения hazard (з) на `w0-01-persistence.jsonl` больше нет (`R-CC-W0-T` №5).
- **Вне скоупа трека (заведено в BACKLOG):** абсолютный домашний путь встречается ещё в 4 файлах
  `apps/**`, пришедших из других треков и уже лежащих в `next`. Это смежная гигиена публичного репо,
  а не артефакт CC-W0.

Кредовый вывод основного addendum'а в силе и не пересматривается: по кредовым паттернам `references/**`
= 0. **⛔ Ротация OAuth-токена владельцем по-прежнему НЕ выполнена** — скраб путей её не заменяет и к ней
отношения не имеет.
