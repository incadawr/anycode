function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

export function projectConfigPath(workspace: string): string {
  return `${stripTrailingSep(workspace)}/.anycode/config.json`;
}

export function userConfigPath(home: string): string {
  return `${stripTrailingSep(home)}/.anycode/config.json`;
}

export function compatConfigPath(workspace: string): string {
  return `${stripTrailingSep(workspace)}/.mcp.json`;
}
