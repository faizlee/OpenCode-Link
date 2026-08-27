import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";
import { CodexAppServer } from "./app-server.js";
import { AttachmentUploadError, cleanupExpiredUploads, parseAttachmentMessage } from "./attachment-upload.js";
import { LanDiscovery } from "./lan-discovery.js";
import { listLanAddresses } from "./network.js";
import { PairingStore } from "./pairing.js";
import { queueMessage } from "./queue-message.js";
import type { BrowserCommand, BrowserMessage, JsonObject, RpcEvent, ThreadOpenResponse, ThreadPage } from "./protocol.js";
import { SessionStore } from "./session.js";
import { dedupeThreadPage } from "./thread-utils.js";
import { hydrateThreadFromDesktopLog } from "./thread-log.js";

const host = process.env.CODEX_PWA_HOST ?? "127.0.0.1";
const port = Number(process.env.CODEX_PWA_PORT ?? 8787);
const app = express();
const httpServer = createServer(app);
const websocketServer = new WebSocketServer({ noServer: true });
const sessions = new SessionStore();
const pairing = new PairingStore();
const lanDiscovery = new LanDiscovery(port, process.env.CODEX_PWA_LAN_NAME);
const codex = new CodexAppServer();
const clients = new Set<WebSocket>();
const pendingServerRequests = new Map<number | string, RpcEvent>();

void cleanupExpiredUploads().catch((error) => console.warn("Unable to clean expired image uploads:", error));
const uploadCleanupTimer = setInterval(() => {
  void cleanupExpiredUploads().catch((error) => console.warn("Unable to clean expired image uploads:", error));
}, 60 * 60 * 1000);
uploadCleanupTimer.unref();

app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  next();
});

function isLoopback(address: string | undefined) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

app.get("/api/session", (request, response) => {
  const authenticated = sessions.isAuthenticated(request);
  if (authenticated && sessions.authRequired) sessions.refresh(request, response, request.secure);
  response.json({ authRequired: sessions.authRequired, authenticated });
});

app.post("/api/session", (request, response) => {
  if (!sessions.authenticate(String(request.body?.password ?? ""))) {
    response.status(401).json({ error: "密码不正确" });
    return;
  }
  sessions.create(request, response, request.secure);
  response.json({ ok: true });
});

app.delete("/api/session", (request, response) => {
  sessions.clear(request, response, request.secure);
  response.json({ ok: true });
});

app.get("/api/health", (_request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, appServer: codex.info ? "ready" : "stopped" });
});

app.post("/api/threads/:threadId/messages", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!sessions.isAuthenticated(request)) {
    response.status(401).json({ error: "需要先完成设备配对" });
    return;
  }

  let upload: Awaited<ReturnType<typeof parseAttachmentMessage>> | null = null;
  try {
    upload = await parseAttachmentMessage(request);
    if (!upload.text.trim() && !upload.attachments.length) throw new AttachmentUploadError("消息和附件不能同时为空");
    const result = await queueMessage(String(request.params.threadId), upload.text, upload.attachments);
    response.json({ ...result, attachmentCount: upload.attachments.length });
  } catch (error) {
    if (upload) await upload.discard();
    const message = error instanceof Error ? error.message : String(error);
    response.status(error instanceof AttachmentUploadError ? 400 : 500).json({ error: message });
  }
});

app.post("/api/stable-link", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!sessions.isAuthenticated(request)) {
    response.status(401).json({ error: "需要先完成设备配对" });
    return;
  }
  const stableAddress = await lanDiscovery.address();
  if (!stableAddress) {
    response.status(404).json({ error: "当前网络不支持固定名称" });
    return;
  }
  const sessionToken = sessions.sessionToken(request);
  if (sessions.authRequired && !sessionToken) {
    response.status(401).json({ error: "当前设备身份已失效，请重新配对" });
    return;
  }
  const ticket = pairing.issue(sessionToken ? { sessionToken } : {});
  response.json({ origin: stableAddress.origin, url: `${stableAddress.origin}/pair/${ticket.token}` });
});

app.get("/api/devices", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!isLoopback(request.socket.remoteAddress)) {
    response.status(403).json({ error: "设备管理只能在这台电脑上打开" });
    return;
  }
  response.json({ devices: sessions.listDevices() });
});

app.delete("/api/devices/:id", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!isLoopback(request.socket.remoteAddress)) {
    response.status(403).json({ error: "设备管理只能在这台电脑上打开" });
    return;
  }
  if (!sessions.revoke(String(request.params.id ?? ""))) {
    response.status(404).json({ error: "设备不存在或已经解除" });
    return;
  }
  response.json({ ok: true });
});

app.post("/api/pairing", async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!isLoopback(request.socket.remoteAddress)) {
    response.status(403).json({ error: "配对页只能在这台电脑上打开" });
    return;
  }

  const ticket = pairing.issue();
  const lanAddresses = listLanAddresses(port);
  const stableAddress = await lanDiscovery.address();
  // The first scan always uses the concrete LAN address because every phone can
  // open it. After authentication the browser silently probes and adopts the
  // stable .local origin when that phone/network combination supports it.
  const addresses = await Promise.all((stableAddress ? [...lanAddresses, stableAddress] : lanAddresses).map(async (entry) => {
    const url = `${entry.origin}/pair/${ticket.token}`;
    return {
      ...entry,
      url,
      qr: await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: 360 }),
    };
  }));
  response.json({ expiresAt: ticket.expiresAt, addresses });
});

app.get("/pair/:token", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const ticket = pairing.consume(String(request.params.token ?? ""));
  if (!ticket) {
    if (sessions.refresh(request, response, request.secure)) {
      response.redirect(303, "/");
      return;
    }
    response.status(410).send("这个二维码已过期，请在电脑端刷新二维码后重试。");
    return;
  }
  if (!sessions.refresh(request, response, request.secure)
    && !(ticket.sessionToken && sessions.adopt(ticket.sessionToken, response, request.secure))) {
    sessions.create(request, response, request.secure);
  }
  response.redirect(303, "/");
});

const webRoot = resolve(process.cwd(), "dist");
if (existsSync(webRoot)) {
  app.use(express.static(webRoot, {
    setHeaders(response, filePath) {
      if (filePath.endsWith("manifest.webmanifest") || filePath.endsWith("sw.js") || filePath.endsWith("index.html")) {
        response.setHeader("Cache-Control", "no-cache");
      }
    },
  }));
  app.get("*path", (_request, response) => {
    response.setHeader("Cache-Control", "no-cache");
    response.sendFile(resolve(webRoot, "index.html"));
  });
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

httpServer.listen(port, host, () => {
  console.log(`Codex PWA bridge listening on http://${host}:${port}`);
  void lanDiscovery.start(listLanAddresses(port), host);
  if (!sessions.authRequired) console.warn("CODEX_PWA_PASSWORD is not set. Keep the bridge bound to localhost.");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    codex.stop();
    void lanDiscovery.stop().finally(() => httpServer.close(() => process.exit(0)));
  });
}
