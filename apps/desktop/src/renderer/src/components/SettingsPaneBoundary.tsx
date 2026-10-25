/**
 * Error boundary around one Settings pane. Without it a render exception in
 * any pane unmounted the whole renderer (v0.0.38: "Language servers" left a
 * blank window). SettingsScreen keys the pane container by pane id, so
 * switching panes remounts the boundary and clears the error.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface SettingsPaneBoundaryProps {
  paneId: string;
  children: ReactNode;
}

interface SettingsPaneBoundaryState {
  failed: boolean;
}

export class SettingsPaneBoundary extends Component<SettingsPaneBoundaryProps, SettingsPaneBoundaryState> {
  override state: SettingsPaneBoundaryState = { failed: false };

  static getDerivedStateFromError(): SettingsPaneBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[settings] pane "${this.props.paneId}" failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="settings-mcp-empty" role="alert" data-settings-pane-error={this.props.paneId}>
          This section failed to load. Other settings still work — pick another section or reopen Settings.
        </div>
      );
    }
    return this.props.children;
  }
}
