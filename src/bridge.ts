import type { BridgeMessage, RpcEvent } from "./types";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
type MessageListener = (message: BridgeMessage) => void;
type StateListener = (state: ConnectionState) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
}

let requestSequence = 0;

export function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  requestSequence += 1;
  return `${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private retryTimer: number | null = null;
  private retryCount = 0;
  private intentionalClose = false;
  private pending = new Map<string, PendingRequest>();
  private messageListeners = new Set<MessageListener>();
  private stateListeners = new Set<StateListener>();

  connect() {
    this.intentionalClose = false;
    this.open();
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }

  onMessage(listener: MessageListener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: StateListener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("尚未连接到电脑"));
    }
    const requestId = createRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("电脑响应超时"));
      }, 35_000);
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket?.send(JSON.stringify({ type, requestId, ...payload }));
    });
  }

  private open() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.emitState("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.socket.addEventListener("open", () => {
      this.retryCount = 0;
      this.emitState("connected");
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(JSON.parse(event.data) as BridgeMessage));
    this.socket.addEventListener("error", () => this.emitState("error"));
    this.socket.addEventListener("close", () => {
      this.socket = null;
      this.emitState("disconnected");
      if (!this.intentionalClose) this.scheduleReconnect();
    });
  }

  private handleMessage(message: BridgeMessage) {
    if (message.type === "response") {
      const waiter = this.pending.get(message.requestId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        this.pending.delete(message.requestId);
        if (message.ok) waiter.resolve(message.data);
        else waiter.reject(new Error(message.error));
      }
    }
    for (const listener of this.messageListeners) listener(message);
  }

  private scheduleReconnect() {
    const delay = Math.min(10_000, 700 * 2 ** this.retryCount) + Math.random() * 300;
    this.retryCount += 1;
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private emitState(state: ConnectionState) {
    for (const listener of this.stateListeners) listener(state);
  }
}

export function upsertRequest(requests: RpcEvent[], request: RpcEvent) {
  return [...requests.filter((item) => item.id !== request.id), request];
}
