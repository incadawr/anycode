import { Button } from "../ui/index.js";
import { useEffect, useRef, useState } from "react";
import type { McpConfigOpenFileResult, McpConfigSource } from "../../../shared/mcp-config.js";
import type { ExtensionCategory } from "./useSessionExtensions.js";
import type { SettingsPaneSelection } from "./settings-extensions-navigation.js";

const panes = { mcp: "mcp", plugins: "plugins", skills: "skills", lsp: "language-servers" } as const;
const labels = { mcp: "Manage MCP servers", plugins: "Manage plugins", skills: "Manage skills", lsp: "Manage language servers" };
const failures = {
  invalid: "This configuration source is unavailable.", no_workspace: "Project is no longer available.",
  not_found: "Configuration file does not exist. Use Manage to add entries.",
  unsafe_path: "This configuration file cannot be opened safely.", open_failed: "Could not open configuration file.",
};

export function SessionExtensionsFooter({ tabId, category, projectAvailable, onManage }: {
  tabId: string; category: ExtensionCategory; projectAvailable: boolean;
  onManage: (pane: SettingsPaneSelection["pane"], scope: "project" | "user") => void;
}) {
  const [chooser, setChooser] = useState(false);
  const [source, setSource] = useState<McpConfigSource>("user");
  const [request, setRequest] = useState<{ source: McpConfigSource; action: "open" | "reveal" } | null>(null);
  const [result, setResult] = useState<McpConfigOpenFileResult | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!request) return;
    let active = true;
    const finish = (value: McpConfigOpenFileResult) => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      pending.current = false;
      setResult(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "open_failed" }), 10_000);
    Promise.resolve().then(() => active ? window.anycode.mcpConfig.openFile({ tabId, ...request }) : undefined)
      .then((value) => { if (value) finish(value); }, () => finish({ ok: false, reason: "open_failed" }));
    return () => { active = false; clearTimeout(timer); };
  }, [request, tabId]);
  const run = (action: "open" | "reveal", target = source) => {
    if (pending.current) return;
    pending.current = true;
    setSource(target);
    setResult(null);
    setRequest({ source: target, action });
  };
  const busy = request !== null && result === null;
  return <footer aria-label="Extension management">
    <Button type="button" onClick={() => onManage(panes[category], projectAvailable ? "project" : "user")}>{labels[category]}</Button>
    {category === "mcp" && <>
      <Button type="button" aria-expanded={chooser} onClick={() => setChooser(!chooser)}>Configuration file</Button>
      {chooser && <section aria-label="Configuration source">
        {!projectAvailable && <p>Project and compatibility files require an available project.</p>}
        {(["project", "user", "compat"] as const).map((value) => <Button type="button" key={value}
          disabled={busy || (value !== "user" && !projectAvailable)} onClick={() => run("open", value)}>
          {{ project: "Project", user: "User", compat: "Compatibility file (.mcp.json)" }[value]}</Button>)}
        <div role="status" aria-live="polite">
          {busy ? "Opening configuration file…" : result?.ok ? request?.action === "reveal" ? "Shown in folder." : "Opened in your default application." : result ? failures[result.reason] : ""}
        </div>
        {result && !result.ok && <>
          <Button type="button" onClick={() => run(request!.action)}>Retry</Button>
          {result.reason === "open_failed" && <Button type="button" onClick={() => run("reveal")}>Show in folder</Button>}
          <Button type="button" onClick={() => onManage("mcp", source === "user" ? "user" : "project")}>Manage</Button>
        </>}
      </section>}
    </>}
  </footer>;
}
