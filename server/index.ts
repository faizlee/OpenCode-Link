import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { CodexAppServer } from "./app-server.js";
import { cleanupExpiredUploads } from "./attachment-upload.js";
import { createBridgeApp } from "./http-app.js";
import { LanDiscovery } from "./lan-discovery.js";
import { listLanAddresses } from "./network.js";
import { PairingStore } from "./pairing.js";
import type { BrowserCommand, BrowserMessage, RpcEvent, ThreadOpenResponse, ThreadPage } from "./protocol.js";
import { queueMessage } from "./queue-message.js";
import { clearRuntimeRecord, createRuntimeIdentity, resolveDataRoot, writeRuntimeRecord } from "./runtime.js";
import { SessionStore } from "./session.js";
import { hydrateThreadFromDesktopLog } from "./thread-log.js";
import { dedupeThreadPage } from "./thread-utils.js";

const host = process.env.CODEX_PWA_HOST ?? "127.0.0.1";
const port = Number(process.env.CODEX_PWA_PORT ?? 8787);
const identity = createRuntimeIdentity({
  dataRoot: resolveDataRoot(),
  port,
});
const sessions = new SessionStore();
const pairing = new PairingStore();
const lanDiscovery = new LanDiscovery(port, process.env.CODEX_PWA_LAN_NAME);
const codex = new CodexAppServer();
const lifecycle = { stop() {} };
const app = createBridgeApp({
  sessions,
  pairing,
  identity,
  lanDiscovery,
  appServerReady: () => Boolean(codex.info),
  onShutdown: () => lifecycle.stop(),
});
const httpServer = createServer(app);
const websocketServer = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();
const pendingServerRequests = new Map<number | string, RpcEvent>();

void cleanupExpiredUploads().catch((error) => console.warn("Unable to clean expired image uploads:", error));
const uploadCleanupTimer = setInterval(() => {
  void cleanupExpiredUploads().catch((error) => console.warn("Unable to clean expired image uploads:", error));
}, 60 * 60 * 1000);
uploadCleanupTimer.unref();

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
        const page = dedupeThreadPage(result);
        // The Desktop list preview can remain bound to an older same-ID rollout.
        // Refresh the most recent (or first searched) card from the persisted log
        // without expanding every list row into a full-history filesystem scan.
        if (page.data[0]) {
          const listed = page.data[0];
          const hydrated = await hydrateThreadFromDesktopLog(listed);
          page.data[0] = {
            ...listed,
            preview: hydrated.preview,
            updatedAt: hydrated.updatedAt,
          };
        }
        succeed(page);
        return;
      }
      case "thread:open": {
        // The phone is a remote for Desktop, never a second writer. thread/read
        // supplies task metadata without taking the writer lock; the persisted
        // Desktop log supplies complete current history after long-task compaction.
        const result = await codex.request("thread/read", {
          threadId: command.threadId,
          includeTurns: true,
        }) as Pick<ThreadOpenResponse, "thread">;
        const thread = await hydrateThreadFromDesktopLog(result.thread);
        succeed({
          ...result,
          thread,
          model: "电脑端 Codex",
          cwd: thread.cwd,
          access: "queued",
          notice: "手机只查看这个电脑任务，不会占用它。发送的消息会进入同一个任务队列，电脑处理后自动同步到这里。",
        });
        return;
      }
      case "thread:read": {
        const result = await codex.request("thread/read", {
          threadId: command.threadId,
          includeTurns: true,
        }) as { thread: ThreadOpenResponse["thread"] };
        succeed({ ...result, thread: await hydrateThreadFromDesktopLog(result.thread) });
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

function shutdown() {
  clearRuntimeRecord(identity);
  codex.stop();
  void lanDiscovery.stop().finally(() => httpServer.close(() => process.exit(0)));
}
lifecycle.stop = shutdown;

httpServer.listen(port, host, () => {
  writeRuntimeRecord(identity);
  console.log(`Codex PWA bridge listening on http://${host}:${port}`);
  void lanDiscovery.start(listLanAddresses(port), host);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, shutdown);
}
