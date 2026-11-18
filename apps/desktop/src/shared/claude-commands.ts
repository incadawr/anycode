export interface ClaudeCommandRow {
  name: string;
  scope: "project" | "personal";
  description: string;
  argumentHint?: string;
}
