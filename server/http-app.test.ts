import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { uploadRoot } from "./attachment-upload.js";
import { createBridgeApp } from "./http-app.js";
import { PairingStore } from "./pairing.js";
import { createRuntimeIdentity, writeRuntimeRecord } from "./runtime.js";
import { SessionStore } from "./session.js";

const temporaryRoots: string[] = [];
const liveDataRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "OpenCodexLink")
  : "";

function tempDataRoot() {
  const root = mkdtempSync(join(tmpdir(), "codex-link-http-"));
  temporaryRoots.push(root);
  expect(root).not.toBe(liveDataRoot);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listenApp(app: ReturnType<typeof createBridgeApp>) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  expect(address.port).not.toBe(8787);
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function deviceRequest(userAgent: string) {
  return {
    headers: { "user-agent": userAgent },
    socket: { remoteAddress: "127.0.0.1" },
  } as never;
}

describe("bridge HTTP console APIs", () => {
  it("reuses the same trusted-device row when the phone scans again", async () => {
    const dataRoot = tempDataRoot();
    const sessions = new SessionStore(join(dataRoot, "trusted-devices.json"));
    const pairing = new PairingStore();
    const identity = createRuntimeIdentity({ dataRoot, port: 18922, installRoot: join(dataRoot, "install") });
    const app = createBridgeApp({
      sessions,
      pairing,
      identity,
      appServerReady: () => true,
      lanDiscovery: {
        defaultPortReady: false,
        address: async () => ({
          name: "固定名称",
          address: "opencodexlink.local",
          origin: "http://opencodexlink.local:18922",
          stable: true as const,
        }),
      },
    });
    const listener = await listenApp(app);

    try {
      const unpairedSession = await (await fetch(`${listener.origin}/api/session`)).json() as Record<string, unknown>;
      expect(unpairedSession).toMatchObject({ authRequired: true, authenticated: false, pairingOnly: true });
      const passwordLogin = await fetch(`${listener.origin}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "test-password" }),
      });
      expect(passwordLogin.status).toBe(403);
      expect(sessions.listDevices()).toHaveLength(0);

      const firstTicket = pairing.issue();
      const firstScan = await fetch(`${listener.origin}/pair/${firstTicket.token}`, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S9280 Build/UP1A.231005.007) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36",
        },
      });
      const setCookie = firstScan.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";", 1)[0];
      const [firstDevice] = sessions.listDevices();

      expect(firstScan.status).toBe(303);
      expect(firstScan.headers.get("accept-ch")).toBe("Sec-CH-UA-Model");
      expect(setCookie).toContain("SameSite=Lax");
      expect(sessions.listDevices()).toHaveLength(1);
      expect(firstDevice.name).toBe("SM-S9280");

      const secondTicket = pairing.issue();
      const secondScan = await fetch(`${listener.origin}/pair/${secondTicket.token}`, {
        redirect: "manual",
        headers: { Cookie: cookie, "User-Agent": "Android Test" },
      });

      expect(secondScan.status).toBe(303);
      expect(sessions.listDevices()).toHaveLength(1);
      expect(sessions.listDevices()[0].id).toBe(firstDevice.id);

      const pairedSession = await (await fetch(`${listener.origin}/api/session`, { headers: { Cookie: cookie } })).json() as Record<string, unknown>;
      expect(pairedSession).toMatchObject({ authRequired: true, authenticated: true, pairingOnly: true });

      const preferred = await fetch(`${listener.origin}/api/preferred-links`, { method: "POST", headers: { Cookie: cookie } });
      expect(preferred.status).toBe(200);
      const preferredBody = await preferred.json() as { links: Array<{ url: string; stable: boolean }> };
      const stableLink = preferredBody.links.find((link) => link.stable);
      expect(stableLink).toBeTruthy();
      const adopted = await fetch(`${listener.origin}${new URL(stableLink?.url ?? "").pathname}`, { redirect: "manual" });
      expect(adopted.status).toBe(303);
      expect(sessions.listDevices()).toHaveLength(1);
      expect(sessions.listDevices()[0].id).toBe(firstDevice.id);
    } finally {
      await listener.close();
    }
  });

  it("exposes identity, connection without tickets, device edits, and settings on a temp port", async () => {
    const dataRoot = tempDataRoot();
    const identity = createRuntimeIdentity({ dataRoot, port: 18921, installRoot: join(dataRoot, "install") });
    writeRuntimeRecord(identity);
    writeFileSync(join(dataRoot, "settings.json"), JSON.stringify({
      schema: 1,
      autoStart: true,
      openConsoleOnStart: false,
      keepRunningWhenBrowserCloses: true,
    }), "utf8");

    const sessions = new SessionStore(join(dataRoot, "trusted-devices.json"));
    const pairing = new PairingStore();
    const existingTicket = pairing.issue({ now: 1_000, ttlMs: 60_000 });
    const created = {
      setHeader() { return created; },
    } as never;
    sessions.create(deviceRequest("iPhone"), created, false);
    sessions.create(deviceRequest("Android"), created, false);
    const [latest, earlier] = sessions.listDevices();

    let shutdownCalls = 0;
    const app = createBridgeApp({
      sessions,
      pairing,
      identity,
      appServerReady: () => false,
      onShutdown: () => {
        shutdownCalls += 1;
      },
      lanDiscovery: {
        defaultPortReady: true,
        address: async () => ({
          name: "固定名称",
          address: "opencodexlink.local",
          origin: "http://opencodexlink.local",
          stable: true as const,
        }),
      },
    });
    const listener = await listenApp(app);

    try {
      const health = await (await fetch(`${listener.origin}/api/health`)).json() as Record<string, string>;
      expect(health).toMatchObject({
        ok: true,
        appServer: "stopped",
        productId: "OpenCodexLink",
        version: identity.version,
        buildId: identity.buildId,
        instanceId: identity.instanceId,
      });

      const runtime = await fetch(`${listener.origin}/api/runtime`);
      expect(runtime.status).toBe(200);
      const runtimeBody = await runtime.json() as Record<string, unknown>;
      expect(runtimeBody).not.toHaveProperty("controlToken");
      expect(runtimeBody).toMatchObject({
        ok: true,
        productId: "OpenCodexLink",
        instanceId: identity.instanceId,
        dataRoot,
        port: identity.port,
      });

      const connection = await (await fetch(`${listener.origin}/api/connection`)).json() as {
        recommendedOrigin: string;
        stableAvailable: boolean;
      };
      expect(connection.recommendedOrigin).toBe("http://opencodexlink.local");
      expect(connection.stableAvailable).toBe(true);
      expect(pairing.consume(existingTicket.token, 1_001)).toEqual(existingTicket);

      const renamed = await fetch(`${listener.origin}/api/devices/${encodeURIComponent(earlier.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "厨房平板" }),
      });
      expect(renamed.status).toBe(200);
      expect(sessions.listDevices().find((device) => device.id === earlier.id)?.name).toBe("厨房平板");

      const batch = await fetch(`${listener.origin}/api/devices/revoke-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [latest.id] }),
      });
      expect(batch.status).toBe(200);
      expect(await batch.json()).toEqual({ ok: true, revoked: [latest.id] });
      expect(sessions.listDevices()).toHaveLength(1);

      const settings = await (await fetch(`${listener.origin}/api/settings`)).json() as Record<string, unknown>;
      expect(settings).toMatchObject({
        autoStart: true,
        openConsoleOnStart: false,
        keepRunningWhenBrowserCloses: true,
        dataRoot,
        uploadDir: uploadRoot(),
      });

      const denied = await fetch(`${listener.origin}/api/runtime/shutdown`, { method: "POST" });
      expect(denied.status).toBe(403);
      const allowed = await fetch(`${listener.origin}/api/runtime/shutdown`, {
        method: "POST",
        headers: { "X-OpenCodexLink-Control-Token": identity.controlToken },
      });
      expect(allowed.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(shutdownCalls).toBe(1);
    } finally {
      await listener.close();
    }
  });
});
