export interface GoQuotaWindow {
  usedPercent: number;
  resetsAt?: number;
}

export interface GoQuotaSnapshot {
  observedAt: string;
  windows: { rolling?: GoQuotaWindow; weekly?: GoQuotaWindow; monthly?: GoQuotaWindow };
}
