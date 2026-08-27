import { getResponder, type CiaoService, type Responder } from "@homebridge/ciao";
import { createServer, type Server } from "node:http";
import type { LanAddress } from "./network.js";

export interface StableLanAddress extends LanAddress {
  stable: true;
}

function cleanHostname(value: string) {
  return value.trim().replace(/\.+$/, "").toLowerCase();
}

export function normalizeLanName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\.local\.?$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return normalized || "opencodexlink";
}

export function stableOrigin(hostname: string, appPort: number, defaultPortReady: boolean) {
  return defaultPortReady ? `http://${hostname}` : `http://${hostname}:${appPort}`;
}

async function startDefaultPortRedirect(host: string, appPort: number, hostname: () => string) {
  return await new Promise<Server | null>((resolve) => {
    const server = createServer((request, response) => {
      const path = request.url?.startsWith("/") ? request.url : "/";
      response.statusCode = 307;
      response.setHeader("Location", `http://${hostname()}:${appPort}${path}`);
      response.setHeader("Cache-Control", "no-store");
      response.end();
    });

    let settled = false;
    server.once("error", (error) => {
      if (!settled) {
        settled = true;
        console.warn(`OpenCodex Link could not use http://<name> without a port: ${error.message}`);
        resolve(null);
      }
    });
    server.listen(80, host, () => {
      settled = true;
      resolve(server);
    });
  });
}

export class LanDiscovery {
  private readonly baseName: string;
  private hostname: string;
  private responder?: Responder;
  private service?: CiaoService;
  private redirectServer?: Server;
  private started?: Promise<void>;

  constructor(private readonly appPort: number, name = "opencodexlink") {
    this.baseName = normalizeLanName(name);
    this.hostname = `${this.baseName}.local`;
  }

  start(addresses: LanAddress[], host: string) {
    if (!this.started) this.started = this.startInternal(addresses, host);
    return this.started;
  }

  private async startInternal(addresses: LanAddress[], host: string) {
    if (addresses.length === 0 || host === "127.0.0.1" || host === "::1") return;

    const physicalInterfaces = [...new Set(addresses.map((entry) => entry.name))];
    this.responder = getResponder({ advertiseIpv4: true, advertiseIpv6: false });
    this.service = this.responder.createService({
      name: "OpenCodex Link",
      type: "http",
      port: this.appPort,
      hostname: this.baseName,
      restrictedAddresses: physicalInterfaces,
      disabledIpv6: true,
      txt: { path: "/", role: "codex-phone-link" },
    });
    this.service.on("hostname-change", (hostname) => {
      this.hostname = `${cleanHostname(hostname)}.local`;
    });
    await this.service.advertise();
    this.hostname = cleanHostname(this.service.getHostname());
    this.redirectServer = await startDefaultPortRedirect(host, this.appPort, () => this.hostname) ?? undefined;
    console.log(`OpenCodex Link LAN name: ${stableOrigin(this.hostname, this.appPort, Boolean(this.redirectServer))}`);
  }

  async address(): Promise<StableLanAddress | null> {
    try {
      await this.started;
    } catch (error) {
      console.warn(`OpenCodex Link LAN name is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!this.service) return null;
    return {
      name: "固定名称",
      address: this.hostname,
      origin: stableOrigin(this.hostname, this.appPort, Boolean(this.redirectServer)),
      stable: true,
    };
  }

  async stop() {
    if (this.redirectServer) await new Promise<void>((resolve) => this.redirectServer?.close(() => resolve()));
    if (this.responder) await this.responder.shutdown();
  }
}
