import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { findCodexBinary } from "./codex-binary.js";
import type { JsonObject, RpcEvent, RpcResponse } from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private starting: Promise<Record<string, unknown>> | null = null;
  private initialized: Record<string, unknown> | null = null;

  get info() {
    return this.initialized;
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.initialized) return this.initialized;
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(): Promise<Record<string, unknown>> {
    this.emit("state", { state: "starting" });
    const binary = findCodexBinary();
    this.child = spawn(binary, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.emit("log", chunk));
    this.child.on("error", (error) => this.onExit(error));
    this.child.on("exit", (code, signal) => this.onExit(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`)));

    const result = await this.request("initialize", {
      clientInfo: { name: "codex_pwa", title: "Codex PWA", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }) as Record<string, unknown>;
    this.notify("initialized");
    this.initialized = { ...result, binary };
    this.emit("state", { state: "ready" });
    return this.initialized;
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    if (method !== "initialize") await this.start();
    if (!this.child || this.child.killed) throw new Error("Codex App Server is not running.");
    const id = this.nextId++;
    const payload = JSON.stringify({ method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${payload}\n`);
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.child || this.child.killed) return;
    const payload = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  respond(id: number | string, result: unknown) {
    if (!this.child || this.child.killed) throw new Error("Codex App Server is not running.");
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  respondError(id: number | string, message: string) {
    if (!this.child || this.child.killed) throw new Error("Codex App Server is not running.");
    this.child.stdin.write(`${JSON.stringify({ id, error: { code: -32603, message } })}\n`);
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.initialized = null;
  }

  private onStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as RpcResponse | RpcEvent);
      } catch (error) {
        this.emit("log", `Could not parse app-server output: ${String(error)}\n`);
      }
    }
  }

  private onMessage(message: RpcResponse | RpcEvent) {
    if ("method" in message && message.method) {
      if (message.id !== undefined) this.emit("serverRequest", message);
      else this.emit("notification", message);
      return;
    }

    const response = message as RpcResponse;
    if (typeof response.id !== "number") return;
    const waiter = this.pending.get(response.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(response.id);
    if (response.error) waiter.reject(new Error(response.error.message ?? JSON.stringify(response.error)));
    else waiter.resolve(response.result);
  }

  private onExit(error: Error) {
    if (!this.child && !this.initialized && !this.starting) return;
    this.child = null;
    this.initialized = null;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.emit("state", { state: "error", detail: error.message });
  }
}

