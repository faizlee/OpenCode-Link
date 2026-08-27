import express, { type Express, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import QRCode from "qrcode";
import { AttachmentUploadError, parseAttachmentMessage } from "./attachment-upload.js";
import type { StableLanAddress } from "./lan-discovery.js";
import { listLanAddresses } from "./network.js";
import type { PairingStore } from "./pairing.js";
import { queueMessage } from "./queue-message.js";
import { publicHealth, publicRuntime, publicSettings, type RuntimeIdentity } from "./runtime.js";
import type { SessionStore } from "./session.js";

export function isLoopback(address: string | undefined) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export interface ConsoleLanDiscovery {
  defaultPortReady: boolean;
  address(): Promise<StableLanAddress | null>;
}

export interface BridgeAppServices {
  sessions: SessionStore;
  pairing: PairingStore;
  identity: RuntimeIdentity;
  lanDiscovery: ConsoleLanDiscovery;
  appServerReady: () => boolean;
  onShutdown?: () => void;
}

function requireLoopback(request: Request, response: Response, message: string) {
  if (isLoopback(request.socket.remoteAddress)) return true;
  response.status(403).json({ error: message });
  return false;
}

function requireDeviceStore(sessions: SessionStore, response: Response) {
  if (!sessions.loadError) return true;
  response.status(500).json({ error: "设备登记表无法读取，未做任何更改" });
  return false;
}

export async function connectionStatus(port: number, lanDiscovery: ConsoleLanDiscovery) {
  const lanAddresses = listLanAddresses(port);
  const stable = await lanDiscovery.address();
  const recommended = stable ?? lanAddresses[0] ?? null;
  return {
    stableName: stable?.address ?? null,
    stableOrigin: stable?.origin ?? null,
    stableAvailable: Boolean(stable),
    lanAddresses,
    recommendedOrigin: recommended?.origin ?? null,
    defaultPortRedirect: lanDiscovery.defaultPortReady,
    appPort: port,
    usingIpFallback: !stable && Boolean(recommended),
  };
}

export function createBridgeApp(services: BridgeAppServices): Express {
  const { sessions, pairing, identity, lanDiscovery, appServerReady } = services;
  const app = express();

  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    next();
  });

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
    response.json(publicHealth(identity, appServerReady()));
  });

  app.get("/api/runtime", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!requireLoopback(request, response, "运行身份只能在这台电脑上查看")) return;
    response.json(publicRuntime(identity));
  });

  app.post("/api/runtime/shutdown", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!requireLoopback(request, response, "只能在这台电脑上停止服务")) return;
    const token = String(request.header("x-opencodexlink-control-token") ?? request.body?.token ?? "");
    if (!token || token !== identity.controlToken) {
      response.status(403).json({ error: "控制令牌无效" });
      return;
    }
    response.json({ ok: true });
    if (services.onShutdown) setImmediate(() => services.onShutdown && services.onShutdown());
  });

  app.get("/api/connection", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!requireLoopback(request, response, "连接状态只能在这台电脑上查看")) return;
    response.json(await connectionStatus(identity.port, lanDiscovery));
  });

  app.get("/api/settings", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!requireLoopback(request, response, "设置只能在这台电脑上查看")) return;
    response.json(publicSettings(identity));
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
    if (!requireLoopback(request, response, "设备管理只能在这台电脑上打开")) return;
    if (!requireDeviceStore(sessions, response)) return;
    response.json({ devices: sessions.listDevices(request) });
  });

  app.post("/api/devices/revoke-batch", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!requireLoopback(request, response, "设备管理只能在这台电脑上打开")) return;
    if (!requireDeviceStore(sessions, response)) return;
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.map((id: unknown) => String(id)) : [];
    response.json({ ok: true, ...sessions.revokeMany(ids) });
  });

  app.patch("/api/devices/:id", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!requireLoopback(request, response, "设备管理只能在这台电脑上打开")) return;
    if (!requireDeviceStore(sessions, response)) return;
    if (!sessions.rename(String(request.params.id ?? ""), String(request.body?.name ?? ""))) {
      response.status(404).json({ error: "设备不存在或名称无效" });
      return;
    }
    response.json({ ok: true });
  });

  app.delete("/api/devices/:id", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!requireLoopback(request, response, "设备管理只能在这台电脑上打开")) return;
    if (!requireDeviceStore(sessions, response)) return;
    if (!sessions.revoke(String(request.params.id ?? ""))) {
      response.status(404).json({ error: "设备不存在或已经解除" });
      return;
    }
    response.json({ ok: true });
  });

  app.post("/api/pairing", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!requireLoopback(request, response, "配对页只能在这台电脑上打开")) return;

    const ticket = pairing.issue();
    const lanAddresses = listLanAddresses(identity.port);
    const stableAddress = await lanDiscovery.address();
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

  return app;
}
