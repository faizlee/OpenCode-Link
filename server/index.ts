import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { CodexAppServer } from "./app-server.js";
import { queueMessage } from "./queue-message.js";
import type { BrowserCommand, BrowserMessage, JsonObject, RpcEvent, ThreadOpenResponse, ThreadPage } from "./protocol.js";
import { SessionStore } from "./session.js";
import { dedupeThreadPage } from "./thread-utils.js";

const host = process.env.CODEX_PWA_HOST ?? "127.0.0.1";
const port = Number(process.env.CODEX_PWA_PORT ?? 8787);
const app = express();
const httpServer = createServer(app);
const websocketServer = new WebSocketServer({ noServer: true });
const sessions = new SessionStore();
const codex = new CodexAppServer();
const clients = new Set<WebSocket>();
const pendingServerRequests = new Map<number | string, RpcEvent>();

app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  next();
});

app.get("/api/session", (request, response) => {
  response.json({ authRequired: sessions.authRequired, authenticated: sessions.isAuthenticated(request) });
});

app.post("/api/session", (request, response) => {
  if (!sessions.authenticate(String(request.body?.password ?? ""))) {
    response.status(401).json({ error: "密码不正确" });
    return;
  }
  sessions.create(response, request.secure);
  response.json({ ok: true });
});

app.delete("/api/session", (request, response) => {
  sessions.clear(request, response, request.secure);
  response.json({ ok: true });
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, appServer: codex.info ? "ready" : "stopped" });
});

const webRoot = resolve(process.cwd(), "dist");
if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.get("*path", (_request, response) => response.sendFile(resolve(webRoot, "index.html")));
}

function send(socket: WebSocket, message: BrowserMessage) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message: BrowserMessage) {
  for (const client of clients) send(client, message);
}

codex.on("notification", (event: RpcEvent) => {
  broadcast({ type: "event", method: event.method, params: event.params });
});
codex.on("serverRequest", (request: RpcEvent) => {
  if (request.id === undefined) return;
  pendingServerRequests.set(request.id, request);
  broadcast({ type: "serverRequest", request });
});
codex.on("state", (state: { state: BrowserMessage extends { type: "bridgeState"; state: infer T } ? T : never; detail?: string }) => {
  broadcast({ type: "bridgeState", ...state });
});
codex.on("log", (line: string) => process.stderr.write(line));

async function handleCommand(socket: WebSocket, command: BrowserCommand) {
  const succeed = (data: unknown) => send(socket, { type: "response", requestId: command.requestId, ok: true, data });
  const fail = (error: unknown) => send(socket, {
    type: "response",
    requestId: command.requestId,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });

  try {
    switch (command.type) {
      case "threads:list": {
        const result = await codex.request("thread/list", {
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          searchTerm: command.searchTerm?.trim() || null,
        }) as ThreadPage;
        succeed(dedupeThreadPage(result));
        return;
      }
      case "thread:open": {
        // The phone is a remote for Desktop, never a second writer. thread/read
        // deliberately avoids loading the task or acquiring its writer lock.
        const result = await codex.request("thread/read", {
          threadId: command.threadId,
          includeTurns: true,
        }) as Pick<ThreadOpenResponse, "thread">;
        succeed({
          ...result,
          model: "电脑端 Codex",
          cwd: result.thread.cwd,
          access: "queued",
          notice: "手机只查看这个电脑任务，不会占用它。发送的消息会进入同一个任务队列，电脑处理后自动同步到这里。",
        });
        return;
      }
      case "thread:read": {
        succeed(await codex.request("thread/read", {
          threadId: command.threadId,
          includeTurns: true,
        }));
        return;
      }
      case "turn:start": {
        const text = command.text.trim();
        if (!text) throw new Error("消息不能为空");
        succeed(await queueMessage(command.threadId, text));
        return;
      }
      case "turn:interrupt": {
        succeed(await codex.request("turn/interrupt", { threadId: command.threadId, turnId: command.turnId }));
        return;
      }
      case "server-request:respond": {
        if (!pendingServerRequests.has(command.serverRequestId)) throw new Error("这个请求已经被处理或失效");
        codex.respond(command.serverRequestId, command.result);
        pendingServerRequests.delete(command.serverRequestId);
        succeed({ ok: true });
        return;
      }
    }
  } catch (error) {
    fail(error);
  }
}

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws" || !sessions.isAuthenticated(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit("connection", websocket, request));
});

websocketServer.on("connection", async (socket) => {
  clients.add(socket);
  try {
    const server = await codex.start();
    send(socket, { type: "ready", server, pendingRequests: [...pendingServerRequests.values()] });
  } catch (error) {
    send(socket, { type: "bridgeState", state: "error", detail: error instanceof Error ? error.message : String(error) });
  }

  socket.on("message", (raw) => {
    try {
      const command = JSON.parse(raw.toString()) as BrowserCommand;
      if (!command || typeof command.type !== "string" || typeof command.requestId !== "string") {
        throw new Error("Invalid message");
      }
      void handleCommand(socket, command);
    } catch (error) {
      send(socket, { type: "bridgeState", state: "error", detail: error instanceof Error ? error.message : String(error) });
    }
  });
  socket.on("close", () => clients.delete(socket));
});

httpServer.listen(port, host, () => {
  console.log(`Codex PWA bridge listening on http://${host}:${port}`);
  if (!sessions.authRequired) console.warn("CODEX_PWA_PASSWORD is not set. Keep the bridge bound to localhost.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    codex.stop();
    httpServer.close(() => process.exit(0));
  });
}
