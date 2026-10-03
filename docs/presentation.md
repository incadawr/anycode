---
marp: true
theme: default
paginate: true
size: 16:9
header: AnyCode
footer: One desktop workspace over several AI coding agents
style: |
  :root {
    --bg: #0b0c0f;
    --panel: #15171c;
    --line: rgba(255, 255, 255, 0.14);
    --text: #f4f5f7;
    --muted: #a2a8b3;
    --blue: #5aa9ff;
    --mint: #75e0b8;
  }

  section {
    background:
      radial-gradient(circle at 85% 8%, rgba(90, 169, 255, 0.10), transparent 34%),
      var(--bg);
    color: var(--text);
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 64px 72px;
  }

  section::after {
    color: var(--muted);
    font-size: 15px;
  }

  header,
  footer {
    color: #737a87;
    font-size: 13px;
  }

  h1,
  h2 {
    color: var(--text);
    letter-spacing: -0.045em;
    line-height: 1;
  }

  h1 { font-size: 68px; }
  h2 { font-size: 50px; }
  h3 { color: var(--text); }

  p,
  li {
    color: var(--muted);
    font-size: 24px;
    line-height: 1.45;
  }

  strong { color: var(--text); }
  .accent { color: var(--blue); }
  .mint { color: var(--mint); }
  .small { font-size: 18px; }

  section.lead {
    justify-content: center;
  }

  section.lead h1 {
    max-width: 920px;
    font-size: 88px;
  }

  section.lead p {
    max-width: 820px;
    font-size: 29px;
  }

  table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 12px;
    margin-left: -12px;
  }

  th,
  td {
    border: 1px solid var(--line) !important;
    background: var(--panel);
    color: var(--muted);
    padding: 18px 20px;
    vertical-align: top;
  }

  th {
    color: var(--text);
    font-size: 22px;
  }

  td { font-size: 19px; }

  code {
    background: #15171c;
    color: var(--mint);
  }

  pre {
    border: 1px solid var(--line);
    border-radius: 18px;
    background: #111318;
    padding: 26px 30px;
  }

  pre code {
    color: var(--text);
    font-size: 22px;
    line-height: 1.55;
  }

  blockquote {
    border-left: 4px solid var(--blue);
    background: rgba(90, 169, 255, 0.08);
    padding: 12px 24px;
  }

  blockquote p { color: var(--text); }

  section.product img {
    display: block;
    width: 91%;
    margin: 18px auto 0;
    border: 1px solid var(--line);
    border-radius: 18px;
    box-shadow: 0 26px 80px rgba(0, 0, 0, 0.45);
  }
---

<!-- _class: lead -->

# Один интерфейс. <span class="accent">Любой агент.</span>

**AnyCode** объединяет Claude Code, Codex и собственный multi-provider runtime в одном desktop-пространстве.

`v0.0.8 · alpha`

---

## Агентов стало много. <span class="accent">Рабочее место всё ещё одно.</span>

| Разные окна | Разные правила | Разорванный поток |
|---|---|---|
| У каждого агента — свой интерфейс, история и способ показывать работу. | Права, режимы, контекст и подтверждения приходится изучать заново. | Переключение движка означает потерю привычного workspace и контроля. |

> AnyCode — не ещё один агент. Это оболочка вокруг агентов, которыми вы уже пользуетесь.

---

## Выбирайте <span class="accent">движок</span> под задачу

| Native | Codex | Claude Code |
|---|---|---|
| Собственный agent loop | Официальный Codex CLI | Официальный Claude Code CLI |
| Anthropic, Z.AI, OpenAI, OpenRouter, DeepSeek, Moonshot, Kimi и совместимые endpoints | Аккаунты, квоты, plan, import и managed binary | Reasoning, tools, images, permissions и resume |
| **Multi-provider + local models** | **Bring your own account** | **Bring your own account · early** |

Интерфейс, проект и прозрачность работы остаются прежними.

---

<!-- _class: product -->

## Вся работа агента — <span class="accent">в одном потоке</span>

![Интерфейс AnyCode: список задач, вызовы инструментов, reasoning и composer](assets/anycode-demo.png)

---

## Тонкая оболочка. <span class="accent">Сменные движки.</span>

```text
┌──────────────────────┐       ┌──────────────────────┐       ┌──────────────────────┐
│      RENDERER        │       │    HOST PER TAB      │       │       ENGINE         │
│                      │       │                      │       │                      │
│ transcript · tools   │ ───▶  │ utilityProcess       │ ───▶  │ Native runtime       │
│ permissions · ctx    │       │ MessagePort stream   │       │ Codex CLI            │
│ terminal · Git       │       │ crash boundary       │       │ Claude Code CLI      │
└──────────────────────┘       └──────────────────────┘       └──────────────────────┘
```

**UI не зависит от того, какой backend произвёл событие.** Возможности включаются честно — только если движок их поддерживает.

---

## Один workspace. <span class="accent">Одинаковый контроль.</span>

| Поверхность | Что получает пользователь |
|---|---|
| **Transcript + tools** | Ответ, reasoning и действия в одной читаемой истории |
| **Permissions + context** | Явные подтверждения, режимы доступа, context meter и квоты |
| **Terminal + Git review** | Команды, файлы и diff рядом с диалогом |
| **MCP + skills** | Расширение среды без привязки к одному вендору |
| **Subagents** | Дочерний агент может работать на другом движке и модели |
| **Artifacts** | Изображения и созданные файлы прямо в сессии |

---

## Безопасность — <span class="mint">архитектура, не настройка</span>

- **Credentials остаются локально.** CLI-профили работают под вашим аккаунтом; AnyCode не проксирует их токены.
- **Renderer отделён от Node и секретов.** У каждой вкладки — собственный host-процесс.
- **Capabilities не симулируются.** Неподдерживаемое действие отключено, а не показано как рабочее.
- **CLI-адаптеры проверяются fixtures.** Изменение протокола не должно тихо терять или придумывать события.
- **Permission flow видим.** Рискованные действия требуют осознанного режима или подтверждения.

> Агент работает рядом с кодом. Контроль над машиной остаётся у пользователя.

---

<!-- _class: lead -->

# Alpha уже работает. <span class="accent">Следующий шаг — экосистема.</span>

- Universal preview для Markdown, изображений, diff и локальных web-приложений
- First-class MCP: статусы, OAuth, tool discovery и управление серверами
- Переключение движка внутри живой сессии
- Multi-agent orchestration и checkpoints

**3 движка · macOS / Windows / Linux · Apache-2.0**

<span class="small">github.com/incadawr/anycode · github.com/incadawr/anycode/releases</span>
