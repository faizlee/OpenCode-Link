export interface ThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: Array<"waitingOnApproval" | "waitingOnUserInput">;
}

export interface ThreadItem {
  type: string;
  id?: string;
  clientId?: string | null;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  text?: string;
  phase?: string | null;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: Array<Record<string, unknown>>;
  server?: string;
  tool?: string;
  [key: string]: unknown;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: string;
  error: { message?: string } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface CodexThread {
  id: string;
  preview: string;
  cwd: string;
  name: string | null;
  source: string | Record<string, unknown>;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
}

export interface ThreadPage {
  data: CodexThread[];
  nextCursor: string | null;
}

export interface ThreadResumeResponse {
  thread: CodexThread;
  model: string;
  cwd: string;
  approvalPolicy: string;
  reasoningEffort: string | null;
  access: "control" | "queued";
  notice?: string;
}

export interface RpcEvent {
  method: string;
  params?: Record<string, unknown>;
  id?: number | string;
}

export type BridgeMessage =
  | { type: "ready"; server: Record<string, unknown>; pendingRequests: RpcEvent[] }
  | { type: "response"; requestId: string; ok: true; data: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  | { type: "event"; method: string; params?: Record<string, unknown> }
  | { type: "serverRequest"; request: RpcEvent }
  | { type: "bridgeState"; state: "starting" | "ready" | "stopped" | "error"; detail?: string };
