import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Chip,
  ContextRing,
  Drawer,
  EmptyState,
  IconButton,
  Input,
  Modal,
  Popover,
  MenuItem,
  MenuSeparator,
  SearchInput,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
  Toast,
  ToastStack,
  ToolCard,
  IconAccent,
  IconClose,
  IconSearch,
} from "../index.js";
import type { AccessMode } from "../index.js";

const accents = ["current", "gold", "indigo", "teal", "ember"] as const;
type Theme = "dark" | "light";

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
      <span
        style={{
          fontSize: "var(--fs-2xs)",
          color: "var(--text-3)",
          minWidth: 120,
          fontFamily: "var(--font-mono)",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <h2
        style={{
          margin: 0,
          fontSize: "var(--fs-sm)",
          fontWeight: 600,
          color: "var(--text-2)",
          borderTop: "1px solid var(--border)",
          paddingTop: "var(--sp-4)",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Gallery(): React.ReactElement {
  const popTrigger = useRef<HTMLButtonElement>(null);
  const [accent, setAccent] = useState<string>("current");
  const [theme, setTheme] = useState<Theme>("dark");
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");

  const [switchOn, setSwitchOn] = useState(true);
  const [segSingle, setSegSingle] = useState<"all" | "chat" | "code">("all");
  const [segMulti, setSegMulti] = useState<string[]>(["low"]);
  const [mode, setMode] = useState<AccessMode>("edit");
  const [toolOpen, setToolOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [selectValue, setSelectValue] = useState("auto");
  const [textValue, setTextValue] = useState("");

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { if (accent === "current") delete document.documentElement.dataset.accent; else document.documentElement.dataset.accent = accent; }, [accent]);
  useEffect(() => { document.documentElement.dataset.density = density; }, [density]);
  return (
    <div
      className="ak-gallery"
      data-theme={theme}
      data-density={density}
      style={{ height: "100vh", overflow: "auto", boxSizing: "border-box", color: "var(--text-1)", background: "var(--bg-app)", padding: "var(--sp-6)" }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
        <header style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
          <h1 style={{ margin: 0, fontSize: "var(--fs-xl)", fontWeight: 600, letterSpacing: "var(--track-tight)" }}>
            AnyCode UI-kit
          </h1>
          <span style={{ flex: 1 }} />
          <Select label="Accent" value={accent} onChange={e => setAccent(e.target.value)} options={accents.map(value => ({value, label:value}))} />
          <SegmentedControl
            label="Theme"
            options={[
              { value: "dark", label: "dark" },
              { value: "light", label: "light" },
            ]}
            value={theme}
            onChange={(v) => setTheme(v as Theme)}
          />
          <SegmentedControl
            label="Density"
            options={[
              { value: "comfortable", label: "comfortable" },
              { value: "compact", label: "compact" },
            ]}
            value={density}
            onChange={(v) => setDensity(v as "comfortable" | "compact")}
          />
        </header>

        <Section title="Button">
          <Row label="variants">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
          </Row>
          <Row label="sizes">
            <Button variant="primary" size="sm">sm</Button>
            <Button variant="primary" size="md">md</Button>
            <Button variant="primary" size="lg">lg</Button>
          </Row>
          <Row label="states">
            <Button variant="secondary" disabled>disabled</Button>
            <Button variant="primary" loading>loading</Button>
            <Button variant="secondary" disabled={false}>default</Button>
          </Row>
        </Section>

        <Section title="IconButton / Chip">
          <Row label="iconbutton">
            <IconButton label="Search" icon={<IconSearch size={14} />} />
            <IconButton label="Close" icon={<IconClose size={14} />} />
            <IconButton label="Selected" icon={<IconAccent size={14} />} pressed />
            <IconButton label="Disabled" icon={<IconSearch size={14} />} disabled />
          </Row>
          <Row label="modes">
            {(["plan", "build", "edit", "auto", "yolo"] as AccessMode[]).map((m) => (
              <Chip key={m} mode={m} onClick={() => setMode(m)} aria-pressed={mode === m} />
            ))}
            <Chip label="neutral" />
            <Chip label="disabled" disabled />
          </Row>
        </Section>

        <Section title="Badge">
          <Row label="statuses">
            <Badge status="ok" label="Ready" />
            <Badge status="run" label="Running" />
            <Badge status="warn" label="Needs credential" />
            <Badge status="bad" label="Denied" />
            <Badge status="info" label="Information" />
            <Badge status="neutral" label="Idle" />
          </Row>
        </Section>

        <Section title="Input / Select / Textarea / Search">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "var(--sp-4)" }}>
            <Input
              label="Model"
              placeholder="gpt-5-codex"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
            <Input label="With error" error="Key is required" defaultValue="" />
            <Input label="Disabled" disabled defaultValue="locked" />
            <Select
              label="Pricing"
              value={selectValue}
              onChange={(e) => setSelectValue(e.target.value)}
              options={[
                { value: "auto", label: "Auto" },
                { value: "input", label: "Per input token" },
                { value: "output", label: "Per output token" },
              ]}
            />
            <Textarea
              label="Commit message"
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder="Describe the change…"
            />
            <SearchInput label="Search sessions" value={search} onValueChange={setSearch} />
          </div>
        </Section>

        <Section title="Switch / SegmentedControl">
          <Row label="switch">
            <Switch checked={switchOn} onCheckedChange={setSwitchOn} label="Auto-update" />
            <Switch checked={false} onCheckedChange={() => undefined} label="Disabled" disabled />
          </Row>
          <Row label="single">
            <SegmentedControl
              label="Scope"
              options={[
                { value: "all", label: "all" },
                { value: "chat", label: "chat" },
                { value: "code", label: "code" },
              ]}
              value={segSingle}
              onChange={setSegSingle}
            />
          </Row>
          <Row label="multi">
            <SegmentedControl
              label="Effort"
              multiple
              options={[
                { value: "low", label: "low" },
                { value: "med", label: "medium" },
                { value: "high", label: "high" },
              ]}
              value={segMulti}
              onChange={setSegMulti}
            />
          </Row>
        </Section>

        <Section title="ToolCard">
          <ToolCard
            name="read_file"
            summary="src/tokens.css"
            expanded={toolOpen}
            onExpandedChange={setToolOpen}
            aside={<Badge status={toolOpen ? "run" : "ok"} label={toolOpen ? "expanded" : "collapsed"} />}
            body={"Token-backed tool output"}
          />
        </Section>

        <Section title="Banner / EmptyState / ContextRing">
          <Banner tone="info" title="Heads up">Composer popovers use position: fixed.</Banner>
          <Banner tone="warn" title="Credential missing">Provider “acme” needs an API key.</Banner>
          <Banner tone="bad" title="Failed">The session could not be restored.</Banner>
          <Row label="ring">
            <ContextRing value={0.42} label="42% of context used" />
            <ContextRing value={0.78} tone="warn" label="78% of context used" />
            <ContextRing value={0.95} tone="bad" label="95% of context used" />
          </Row>
          <EmptyState
            title="No sessions yet"
            description="Start a session to see your conversations here."
            action={<Button variant="primary">New session</Button>}
          />
        </Section>

        <Section title="Overlays">
          <Row label="open">
            <Button variant="secondary" onClick={() => setModalOpen(true)}>Open modal</Button>
            <Button variant="secondary" onClick={() => setDrawerOpen(true)}>Open drawer</Button>
            <span ref={node => { popTrigger.current = node?.querySelector("button") ?? null; }}><Button variant="secondary" onClick={() => setPopOpen((v) => !v)}>Toggle popover</Button></span>
          </Row>
          {popOpen ? (
            <Popover
              triggerRef={popTrigger}
              open={popOpen}
              onClose={() => setPopOpen(false)}
              position={{ x: 40, y: 200 }}
              heading="Access mode"
            >
              <MenuItem label="plan" description="read only" onSelect={() => setPopOpen(false)} />
              <MenuItem label="build" description="write" checkable selected onSelect={() => setPopOpen(false)} />
              <MenuItem label="auto" description="ask" onSelect={() => setPopOpen(false)} />
              <MenuSeparator />
              <MenuItem label="yolo" description="no prompts" onSelect={() => setPopOpen(false)} />
            </Popover>
          ) : null}
        </Section>

        <Section title="Toast">
          <Row label="toasts">
            <Toast status="ok" message="Saved" onDismiss={() => undefined} />
            <Toast status="warn" message="Key expired" assertive onDismiss={() => undefined} />
            <Toast status="bad" message="Connection lost" onDismiss={() => undefined} />
            <Toast status="info" message="Update available" action={{ label: "Reload", onClick: () => undefined }} />
          </Row>
        </Section>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Confirm run"
        subtitle="The agent will modify files in this workspace."
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setModalOpen(false)}>Run</Button>
          </>
        }
      >
        <Banner tone="warn">Press Esc to close — focus is trapped inside the dialog.</Banner>
      </Modal>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Connection"
        footer={<Button variant="primary" onClick={() => setDrawerOpen(false)}>Done</Button>}
      >
        <Input label="Name" defaultValue="acme" />
        <Select
          label="Kind"
          defaultValue="openai"
          options={[
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
          ]}
        />
      </Drawer>

      <ToastStack>
        <Toast status="ok" message="Session started" onDismiss={() => undefined} />
      </ToastStack>
    </div>
  );
}
