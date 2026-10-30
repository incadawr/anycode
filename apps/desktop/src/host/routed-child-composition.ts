import { randomUUID } from "node:crypto";
import { formatChildTaskNotification, isRoleRouteName } from "@anycode/core";
import type { RoleRouteResolution, SessionSubagentRequest, SessionSubagentOutcome, SubagentRunOptions } from "@anycode/core";
import type { ChildSessionPort } from "./child-session-port.js";
import { decideRoutedTerminal, entryLabel, respawnReportId, type RoleHealthCache } from "./role-route.js";

export function createRoutedChildComposition(options: {
  health: RoleHealthCache;
  describeError: (error: unknown) => string;
  resolve: (role: string) => RoleRouteResolution | null;
  prepare: (req: SessionSubagentRequest) => SessionSubagentRequest;
  record: (outcome: SessionSubagentOutcome, req: SessionSubagentRequest) => void;
  deliver: (outcome: SessionSubagentOutcome, req: SessionSubagentRequest) => void;
  report: (id: string, text: string, meta: { status: "error" | "completed"; durationMs: number }) => void;
}) {
  interface RoutedSpawnRecord {
    role: string;
    entry: import("@anycode/core").RoleRouteEntry;
    rest: import("@anycode/core").RoleRouteEntry[];
    usedFallback: boolean;

    skipReason?: string;
  }
  const routedSpawns = new Map<string, RoutedSpawnRecord>();

  function noteRoutedSpawn(
    req: SessionSubagentRequest,
    actualEntry: import("@anycode/core").RoleRouteEntry,
    rest: import("@anycode/core").RoleRouteEntry[],
    skipped: readonly { entry: import("@anycode/core").RoleRouteEntry; reason: string }[],
  ): void {
    if (!isRoleRouteName(req.agentType)) return;
    routedSpawns.set(req.spawnToolCallId, {
      role: req.agentType,
      entry: { ...actualEntry },
      rest: rest.map((entry) => ({ ...entry })),
      usedFallback: skipped.length > 0,
      ...(skipped.length > 0 ? { skipReason: skipped[0]!.reason } : {}),
    });
  }

  function detachedRouteNotice(req: SessionSubagentRequest): string | undefined {
    const record = routedSpawns.get(req.spawnToolCallId);
    if (record === undefined || !record.usedFallback || record.skipReason === undefined) {
      return undefined;
    }
    return `Role ${record.role} ran on ${entryLabel(record.entry)} because ${record.skipReason}.`;
  }

  function respawnRoutedRoleChild(outcome: SessionSubagentOutcome, req: SessionSubagentRequest): boolean {
    const record = routedSpawns.get(req.spawnToolCallId);
    routedSpawns.delete(req.spawnToolCallId);
    const decision = decideRoutedTerminal(record, outcome.status, outcome.finalText, options.health, Date.now(), outcome.errorDescriptor);
    if (decision.action === "deliver") {
      return false;
    }
    if (decision.action === "deliver_exhausted") {
      outcome.finalText = `${outcome.finalText}\n[role ${record!.role}: all route entries failed]`;
      return false;
    }
    const respawnId = randomUUID();
    const respawnReq: SessionSubagentRequest = {
      agentType: req.agentType,
      description: `[fallback] ${req.description}`,
      prompt: req.prompt,
      spawnToolCallId: respawnId,
      ...(decision.entry.engine !== undefined ? { engine: decision.entry.engine } : {}),
      ...(decision.entry.connection !== undefined ? { connectionId: decision.entry.connection } : {}),
      ...(decision.entry.provider !== undefined ? { provider: decision.entry.provider } : {}),
      ...(decision.entry.model !== undefined ? { model: decision.entry.model } : {}),
      ...(decision.entry.effort !== undefined ? { effort: decision.entry.effort } : {}),
      detach: true,
    };
    routedSpawns.set(respawnId, { ...decision.next, rest: [...decision.next.rest] });
    void port
      ?.run(respawnReq, {})
      .then((admit) => {
        if (admit.status === "error") {
          routedSpawns.delete(respawnId);
          options.report(
            respawnReportId(req.spawnToolCallId, "refused"),
            formatChildTaskNotification({
              taskId: req.spawnToolCallId,
              toolUseId: req.spawnToolCallId,
              agentId: "",
              subagentType: req.agentType,
              status: "failed",
              summary: `Role ${record!.role} failed (${decision.reason}) and the fallback respawn on ${entryLabel(decision.entry)} was refused: ${admit.finalText}`,
            }),
            { status: "error", durationMs: outcome.durationMs },
          );
        }
      })
      .catch((runError: unknown) => {
        routedSpawns.delete(respawnId);
        console.error(`[host] routed role respawn failed: ${options.describeError(runError)}`);
        options.report(
          respawnReportId(req.spawnToolCallId, "failed"),
          formatChildTaskNotification({
            taskId: req.spawnToolCallId,
            toolUseId: req.spawnToolCallId,
            agentId: "",
            subagentType: req.agentType,
            status: "failed",
            summary: `Role ${record!.role} failed (${decision.reason}) and the fallback respawn on ${entryLabel(decision.entry)} could not start.`,
          }),
          { status: "error", durationMs: outcome.durationMs },
        );
      });
    options.report(req.spawnToolCallId, decision.notice, { status: "completed", durationMs: 0 });
    return true;
  }

  let port: ChildSessionPort | undefined;

  // Snapshot routing at dispatch; a handoff keeps these facts until the real terminal.
  function attach(childPort: ChildSessionPort): void {
    port = childPort;
    const innerRun = childPort.run.bind(childPort);
    childPort.run = (req: SessionSubagentRequest, opts: SubagentRunOptions) => {
      if ((req.detach === true || req.allowBackgroundHandoff === true) &&
          isRoleRouteName(req.agentType) && req.resumeChildSessionId === undefined && req.routeStamped === true) {
        const resolution = options.resolve(req.agentType);
        const head = resolution?.entries[0];
        if (head !== undefined) noteRoutedSpawn(req, head, resolution!.entries.slice(1), resolution!.skipped);
      }
      const budgeted = options.prepare(req);
      return innerRun(budgeted, opts).then((outcome) => {
        if (outcome.background === undefined) {
          routedSpawns.delete(req.spawnToolCallId);
          options.record(outcome, budgeted);
        }
        return outcome;
      });
    };
  }
  function onTerminal(outcome: SessionSubagentOutcome, req: SessionSubagentRequest): void {
    options.record(outcome, req);
    const notice = detachedRouteNotice(req);
    if (respawnRoutedRoleChild(outcome, req)) return;
    if (notice !== undefined) outcome.finalText = `${notice}\n${outcome.finalText}`;
    options.deliver(outcome, req);
  }
  return { attach, onTerminal };
}
