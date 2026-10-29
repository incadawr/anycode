import type { GitReadPort } from "./git-read.js";
export type { GitReadPort, GitReadOutput } from "./git-read.js";

import type { ExecutionPort } from "./execution.js";
import type { FileSystemPort } from "./file-system.js";
import type { HttpPort } from "./http.js";
import type { TodoStore } from "../tools/todo-store.js";

export type { FileStat, FileSystemPort } from "./file-system.js";
export type {
  ExecRequest,
  ExecResult,
  ExecStatus,
  ExecutionPort,
  PersistentChildHandle,
  PersistentChildRequest,
} from "./execution.js";
export type {
  DiagnosticsOutcome,
  FileDiagnostic,
  LspPort,
  LspServerSpec,
  LspServerState,
  LspServerStatus,
} from "./lsp.js";
export type {
  GitBranchInfo,
  GitChangeKind,
  GitCommitInfo,
  GitDiffResult,
  GitDiffTarget,
  GitFileChange,
  GitHead,
  GitOpResult,
  GitPort,
  GitStatusSummary,
} from "./git.js";
export type { ModelPort, ModelRequest } from "./model.js";
export type { PersistencePort, SessionMeta, SessionMetaPatch, SessionWorktree } from "./persistence.js";
export type { HttpPort, HttpTextRequest, HttpTextResponse } from "./http.js";
export type {
  SubagentOutcome,
  SubagentPort,
  SubagentProgress,
  SubagentRequest,
  SubagentRunOptions,
} from "./subagent.js";
export type {
  SessionSubagentOutcome,
  SessionSubagentPort,
  SessionSubagentRequest,
  SessionSubagentSendResult,
} from "./session-subagent.js";
export type { LoadedSkill, SkillMeta, SkillPort } from "./skills.js";
export type {
  BackgroundTaskNotice,
  BackgroundTaskPort,
  BackgroundTaskSnapshot,
  BackgroundTaskStartRequest,
  BackgroundTaskStartResult,
  BackgroundTaskStatus,
} from "./tasks.js";
export type {
  WorkflowDefinition,
  WorkflowMeta,
  WorkflowPort,
  WorkflowProgress,
  WorkflowRunOptions,
  WorkflowRunOutcome,
  WorkflowStepDefinition,
  WorkflowStepGraphNode,
  WorkflowStepOutcome,
} from "./workflow.js";
export type {
  McpHttpServerSpec,
  McpServerSpec,
  McpServerState,
  McpServerStatus,
  McpStdioServerSpec,
  McpTransportFactory,
  McpWireTransport,
} from "./mcp.js";
export type { MediaCapabilityPort } from "./media.js";
export type {
  ArtifactContext,
  ArtifactRetention,
  ArtifactStorePort,
  ArtifactWriteRequest,
} from "./artifacts.js";
export type {
  PreviewConsoleEntry,
  PreviewControlRequest,
  PreviewControlSuccess,
  PreviewTarget,
  PreviewOpenRequest,
  PreviewOpenSuccess,
  PreviewPort,
  PreviewReadRequest,
  PreviewReadSuccess,
  PreviewResult,
  PreviewScreenshotSuccess,
} from "./preview.js";
export type { ImageAttachment, ImageMediaType } from "../types/images.js";
export type {
  TelemetryEventRecord,
  TelemetryLifecycleRecord,
  TelemetryPort,
  TelemetryRecord,
  TelemetryStatus,
} from "./telemetry.js";

/**
 * Host-provided side-effect ports handed to tool handlers via ToolContext.
 * Base ports are required; optional capabilities fail closed when absent.
 * PersistencePort is intentionally NOT here — history
 * persistence attaches through HistorySink, tools do not see it.
 */
export interface CorePorts {
  gitRead?: GitReadPort;
  fs: FileSystemPort;
  exec: ExecutionPort;
  /** NodeHttpAdapter (global fetch) in adapters/node. */
  http: HttpPort;
  /** In-process session todo state (InMemoryTodoStore). */
  todos: TodoStore;
}
