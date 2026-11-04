import { randomUUID } from "node:crypto";
import { formatChildTaskNotification, isRoleRouteName } from "@anycode/core";
import type { RoleRouteResolution, SessionSubagentRequest, SessionSubagentOutcome, SubagentRunOptions } from "@anycode/core";
import type { ChildSessionPort } from "./child-session-port.js";
import { classifyInfraFailure, decideRoutedTerminal, entryLabel, respawnReportId, type RoleHealthCache } from "./role-route.js";

/** A restricted role must never respawn onto a native engine child; say how to fix the route instead. */
function engineFallbackRefusal(role: string, engine: string): string {
  return (
    `Agent: role ${role} cannot fall back to engine ${engine} — native engine children cannot enforce this profile’s tool or permission restrictions. ` +
    "Give the role an available API connection in Settings → Roles, or remove the engine entry."
  );
}

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
    // Defense for chains a restricted role should never fall back onto:
    // a native engine child cannot enforce the role's restrictions, so the
    // respawn is refused with the fix instead of running one.
    if ((req.restrictions !== undefined || req.nativeRestrictionsUnsupported === true) && decision.entry.engine !== undefined) {
      outcome.finalText = engineFallbackRefusal(record!.role, decision.entry.engine);
      return false;
    }
    const respawnId = randomUUID();
    const respawnReq: SessionSubagentRequest = {
      agentType: req.agentType,
      description: `[fallback] ${req.description}`,
      prompt: req.prompt,
      spawnToolCallId: respawnId,
      ...(req.restrictions !== undefined ? { restrictions: req.restrictions } : {}),
      ...(req.nativeRestrictionsUnsupported ? { nativeRestrictionsUnsupported: true } : {}),
      ...(req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}),
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
    childPort.run = async (req: SessionSubagentRequest, opts: SubagentRunOptions) => {
      if (isRoleRouteName(req.agentType) && req.resumeChildSessionId === undefined && req.routeStamped === true) {
        if (!routedSpawns.has(req.spawnToolCallId)) {
          const resolution = options.resolve(req.agentType);
          const head = resolution?.entries[0];
          if (head !== undefined) noteRoutedSpawn(req, head, resolution!.entries.slice(1), resolution!.skipped);
        }
      }
      let current = req;
      try {
        for (;;) {
          const budgeted = options.prepare(current);
          const outcome = await innerRun(budgeted, opts);
          const reason = outcome.admissionRejectReason;
          const facts = routedSpawns.get(req.spawnToolCallId);
          if (facts && !opts.signal?.aborted && (reason === "not_ready" || reason === "spawn_failed")) {
            const classified = classifyInfraFailure(outcome.finalText);
            // Both wire reasons also cover non-infrastructure refusals. Admit
            // only known readiness/start messages, never arbitrary policy text.
            const readiness = reason === "not_ready" && /^Agent: (?:this model is not available on the selected connection|the (?:core engine|"(?:codex|claude)" engine|default Codex account) is not available|(?:connection|provider connection) ".+" (?:declared by this profile is not available|is not available|could not be prepared))/.test(outcome.finalText);
            const startFailed = reason === "spawn_failed" && outcome.finalText === "Agent: the child session failed to start.";
            const kind = readiness ? (classified === "none" ? "unreachable" : classified) : startFailed ? "unreachable" : "none";
            const decision = decideRoutedTerminal(facts, outcome.status, outcome.finalText, options.health, Date.now(), undefined, kind);
            if (decision.action === "respawn") {
              if ((req.restrictions !== undefined || req.nativeRestrictionsUnsupported === true) && decision.entry.engine !== undefined) {
                routedSpawns.delete(req.spawnToolCallId);
                const { admissionRejectReason: _reason, ...refused } = outcome;
                const refusal: SessionSubagentOutcome = {
                  ...refused,
                  status: "error",
                  finalText: engineFallbackRefusal(facts.role, decision.entry.engine),
                  truncated: false,
                  turns: 0,
                  toolCalls: 0,
                  childSessionId: "",
                };
                options.record(refusal, budgeted);
                return refusal;
              }
              routedSpawns.set(req.spawnToolCallId, { ...decision.next, rest: [...decision.next.rest] });
              const { engine: _engine, connectionId: _connection, provider: _provider, model: _model, effort: _effort, ...rest } = current;
              current = { ...rest, ...(decision.entry.engine !== undefined ? { engine: decision.entry.engine } : {}),
                ...(decision.entry.connection !== undefined ? { connectionId: decision.entry.connection } : {}),
                ...(decision.entry.provider !== undefined ? { provider: decision.entry.provider } : {}),
                ...(decision.entry.model !== undefined ? { model: decision.entry.model } : {}),
                ...(decision.entry.effort !== undefined ? { effort: decision.entry.effort } : {}) };
              continue;
            }
            if (decision.action === "deliver_exhausted") outcome.finalText += `\n[role ${facts.role}: all route entries failed]`;
          }
          if (outcome.background === undefined) {
            routedSpawns.delete(req.spawnToolCallId);
            options.record(outcome, budgeted);
          }
          return outcome;
        }
      } catch (error: unknown) {
        routedSpawns.delete(req.spawnToolCallId);
        throw error;
      }
    };
  }
  function onTerminal(outcome: SessionSubagentOutcome, req: SessionSubagentRequest): void {
    options.record(outcome, req);
    const notice = detachedRouteNotice(req);
    if (respawnRoutedRoleChild(outcome, req)) return;
    if (notice !== undefined) outcome.finalText = `${notice}\n${outcome.finalText}`;
    options.deliver(outcome, req);
  }
  /** Record the exact route selected for a request before it reaches the port. */
  function snapshot(req: SessionSubagentRequest, resolution: RoleRouteResolution): void {
    const head = resolution.entries[0];
    if (head !== undefined && req.routeStamped === true && req.resumeChildSessionId === undefined) {
      noteRoutedSpawn(req, head, resolution.entries.slice(1), resolution.skipped);
    }
  }
  return { attach, onTerminal, snapshot };
}
