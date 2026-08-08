# TASK.102 Child-Session Subagents — Track Plan

> **For agentic workers:** этот план исполняется bg-оркестратором трека по
> `working-docs/task102-track/BOOTSTRAP-PROMPT.md`, НЕ напрямую через
> subagent-driven-development. **Owner-override гранулярности (08.08):**
> код-уровневые каты по слайсам производят архитекторы трека (Fable +
> GPT-5.6-sol high) в `working-docs/task102-track/CUT-S*.md` — этот план
> фиксирует слайсы, роли, гейты и границы, не построчные степы.

**Goal:** сабагент как дочерняя сессия-таб — зайти внутрь, стирить,
персистентный транскрипт, кросс-провайдерные дети, permission-гейт для
engine-детей. Спека: `docs/superpowers/specs/2026-08-08-subagent-child-sessions-design.md`.

**Architecture:** ребёнок = программно созданный таб TabHostManager с
`parentSessionId`, скрытый из списков сессий, хранящийся в неймспейсе
родителя; спавн движко-агностичен на уровне host/main; v1 sync (тул
блокируется до терминального события ребёнка); один UI-примитив
«поверхность ребёнка», две раскладки (B single-pane → C/D сплит).

**Tech Stack:** Electron (main/utilityProcess), TypeScript, vitest, pnpm
monorepo (`apps/desktop`, `packages/core`), smoke-channel
(`apps/desktop/src/main/automation/`, dev-only HTTP-loopback).

## Global Constraints

- Фоновый join (спека §8 п.5) — ВНЕ трека, отдельный дизайн потом.
- XSS-закон рендерера: никакого `dangerouslySetInnerHTML`/HTML-строк.
- Renderer-тесты: только `*.test.ts` чистыми функциями (vitest не собирает
  `.test.tsx`, env node, jsdom нет).
- Зону `packages/core/src/permissions/` (always-allow matching) НЕ трогать:
  в основном чекауте несмержен фикс TASK.104. Конфликт → STATE.md, не чинить.
- Инвариант TabHostManager «один таб — один utilityProcess» сохраняется.
- Дефолты спеки §2 п.5 (каскадная отмена, ошибка в карточку, permission в
  поверхности ребёнка + бейдж, наследование режима) — решения владельца,
  не пересматриваются катами.
- Лимиты v1: 3 бегущих ребёнка-сессии на мастера, 8 на приложение,
  превышение = ошибка тула, не очередь; рекурсия сессий-детей запрещена.
- Нативные Task-дети Claude-родителя не трогаются; one-shot `engine:`-маршрут
  живёт до S4.
- Git: коммиты в ворктри трека — да (`feat|fix(scope): TASK.102 …`, без
  Co-Authored-By); push/merge/destructive — НИКОГДА.
- Env-барьер свежего ворктри: `pnpm install --frozen-lockfile`,
  `pnpm --filter @anycode/desktop rebuild electron`.
- Полная `pnpm test` авторитетна; известные флэйки: cli/main empty-world,
  node-execution/node-git orphan-timeout.

---

### Slice S1: дешёвый выигрыш — персистенс ленты + read-only просмотр

**Files (зоны, кат уточнит):**
- Modify: `apps/desktop/src/renderer/src/store.ts:1038-1040` (сейчас при
  перезагрузке `subagent: null` — лента теряется)
- Modify: `apps/desktop/src/renderer/src/components/ToolCallCard.tsx:272-441`
  (живая карточка сабагента)
- Modify: персистенс-слой транскрипта main-side (кат назовёт точку — где
  сериализуется тул-колл)
- Test: чистые функции сериализации/гидрации ленты, `*.test.ts`

**Interfaces:**
- Produces: персистентная схема ленты активности карточки (версионированная),
  на которую S2 навесит «Open» и бейджи.

**Steps:** дизайн-мемо Sol → Fable-кат `CUT-S1.md` → TDD-стройка (sonnet)
→ полная `pnpm test` → ревью-волна (свой ревьюер + Luna xhigh) → коммит.
Авто-смоука нет (нет нового интерактивного UI), PNG-проверка карточки после
перезагрузки сессии — есть.

### Slice S2: ядро — ребёнок-сессия sync + раскладка B (кат, вероятно, разрежет на S2a/S2b/S2c)

**Files (зоны):**
- Modify: `apps/desktop/src/main/tabs.ts` (TabHostManager: спавн
  programmatic-таба с `parentSessionId`+`spawnToolCallId`, каскадная отмена
  при закрытии родителя, лимиты 3/8)
- Modify: `apps/desktop/src/main/tab-ipc.ts:284-288` (создание сессии:
  наследование `connectionId` родителя / явный из параметра спавна)
- Modify: персистенс сессий (метка родителя, фильтрация из списков,
  каскадное удаление на persistence-слое)
- Modify: `packages/core/src/tools/agent.ts:53-133` (`tier: "inline"|"session"`,
  опциональные `provider`/`model` для session; блокировка до терминального
  события дочерней сессии)
- Modify: `apps/desktop/src/host/index.ts:872-887` (провод спавна host-side)
- Modify: renderer — поверхность ребёнка (транскрипт+композер+статус),
  раскладка B (breadcrumb «Мастер › ребёнок»), «Open» и бейджи
  (running / ждёт разрешения / error / done) на карточке
- Test: фильтрация списков, каскады, наследование connectionId/режима,
  лимиты, терминальные события/ошибки/таймауты — `*.test.ts`

**Interfaces:**
- Consumes: персистентная схема ленты из S1.
- Produces: примитив «поверхность ребёнка» (компонент, принимающий
  sessionId, рендерящий транскрипт+композер) — S3 раскладывает его в сплит,
  не меняя; контракт спавна ребёнка на host/main — S4 мигрирует на него
  engine-детей.

**Steps:** дизайн-мемо Sol → Fable-кат `CUT-S2.md` (включая нарезку
S2a main/persistence → S2b core-тул+host → S2c renderer-B) → TDD-стройка
(sonnet, послойно) → полная `pnpm test` → ревью-волна (свой ревьюер +
**opus adversarial** — это ядро и permission-мост — + Luna xhigh) →
авто-смоук (sonnet, smoke-channel: спавн/каскад/скрытие/наследование/бейдж/
Open; геометрия `getBoundingClientRect`, PNG глазами — DOM-presence ≠
видимость) → коммит(ы) → чеклист живого смоука владельцу в STATE.md,
цепь продолжается.

### Slice S3: сплит-раскладки C/D (renderer-only)

**Files (зоны):**
- Modify: renderer — лэйаут-состояние (single-pane ↔ сплит без потери),
  сплит мастер|ребёнок (C), аккордеон N детей (D). Ядро не трогается.
- Test: чистые функции лэйаут-состояния, `*.test.ts`

**Interfaces:**
- Consumes: примитив «поверхность ребёнка» из S2 as-is.

**Steps:** Fable-кат `CUT-S3.md` (Sol-мемо опционален — зона узкая) →
стройка (sonnet) → `pnpm test` → ревью-волна → авто-смоук с обязательной
PNG-проверкой обеих раскладок и переключения → коммит → чеклист владельцу
(D — целевая картинка, визуальная приёмка глазами).

### Slice S4: миграция engine-детей на детей-сессий

**Files (зоны):**
- Modify: `apps/desktop/src/host/engine-children.ts:90-403` (маршрут
  `engine:`-профилей → спавн ребёнка-сессии на соответствующем движке через
  интерактивный рантайм с approval-бриджем вместо бесгейтового one-shot)
- Test: engine-ребёнок получает permission-гейт; старые контракты профилей
  (`engine`+`tools` refusал, TASK.97 R4) не ломаются

**Interfaces:**
- Consumes: контракт спавна из S2.
- **Развилка ката:** MCP-дверь для ЧУЖИХ движков-мастеров (спека §6,
  поглощает TASK.97 R2) — в скоупе S4 только если Fable-кат признает
  дешёвой; иначе явно зафиксировать в STATE.md как next-track остаток.

**Steps:** дизайн-мемо Sol → Fable-кат `CUT-S4.md` → стройка (sonnet) →
`pnpm test` → ревью-волна (+ opus adversarial: это снятие security-дыры) →
авто-смоук → коммит. One-shot маршрут остаётся deprecated-живым — снятие
отдельным owner-решением (спека §10).

---

## Self-review (по чеклисту writing-plans)

- Покрытие спеки: §3.1→S2, §3.2→S2, §3.3→S2, §3.4→S2/S4, §4→S2/S3,
  §5→S2/S4, §6 core-часть→S2 (схема Agent-тула), §6 MCP-дверь→S4-развилка,
  §7 лимиты/глубина→S2, §8 п.1-4→S1-S4, §8 п.5 вне трека, §9→гейты.
  Гэпов нет.
- Порядок S1↔S2 кат вправе поменять (спека §8) — интерфейс S1 сформулирован
  так, что S2 может стартовать первым с временной in-memory схемой.
- Типы/сигнатуры между слайсами — фиксируются катами; контрактные точки
  названы в Interfaces.
