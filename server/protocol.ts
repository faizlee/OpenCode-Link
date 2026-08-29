export type JsonObject = Record<string, unknown>;

export interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface RpcEvent {
  method: string;
  params?: JsonObject;
  id?: number | string;
}

export interface ThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: Array<"waitingOnApproval" | "waitingOnUserInput">;
}

export interface ThreadItem {
  type: string;
  id?: string;
  clientId?: string | null;
  content?: Array<Record<string, unknown>>;
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
  error: unknown;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface CodexThread {
  id: string;
  sessionId: string;
  preview: string;
  cwd: string;
  name: string | null;
  source: string | Record<string, unknown>;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  turns: Turn[];
  [key: string]: unknown;
}

export interface ThreadPage {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadOpenResponse {
  thread: CodexThread;
  revision: string;
  model: string;
  cwd: string;
  access: "control" | "queued";
  notice?: string;
  [key: string]: unknown;
}

export type BrowserCommand =
  | { type: "threads:list"; requestId: string; searchTerm?: string }
  | { type: "thread:open"; requestId: string; threadId: string }
  | { type: "thread:read"; requestId: string; threadId: string }
  | { type: "thread:check"; requestId: string; threadId: string }
  | { type: "turn:start"; requestId: string; threadId: string; text: string }
  | { type: "turn:interrupt"; requestId: string; threadId: string; turnId: string }
  | { type: "server-request:respond"; requestId: string; serverRequestId: number | string; result: unknown };

export type BrowserMessage =
  | { type: "ready"; server: Record<string, unknown>; pendingRequests: RpcEvent[] }
  | { type: "response"; requestId: string; ok: true; data: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  | { type: "event"; method: string; params?: JsonObject }
  | { type: "serverRequest"; request: RpcEvent }
  | { type: "bridgeState"; state: "starting" | "ready" | "stopped" | "error"; detail?: string };
