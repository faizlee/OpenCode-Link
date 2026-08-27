import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

const COOKIE_NAME = "codex_pwa_session";
const SESSION_VERSION = "v2";
// Browsers may cap long cookie lifetimes. Refreshing this rolling cookie on
// every visit keeps a regularly used trusted device signed in indefinitely.
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

interface StoredDevice {
  id: string;
  tokenHash: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  remoteAddress: string;
}

export interface TrustedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  remoteAddress: string;
}

interface DeviceFile {
  schemaVersion: 1;
  devices: StoredDevice[];
}

function parseCookies(header: string | undefined) {
  const result = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return result;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function defaultDevicePath() {
  const root = process.env.CODEX_PWA_DATA_DIR
    ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "OpenCodexLink") : join(process.cwd(), "work", "data"));
  return join(root, "trusted-devices.json");
}

function deviceName(userAgent = "") {
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Android/i.test(userAgent)) return "Android 手机";
  if (/Windows/i.test(userAgent)) return "Windows 浏览器";
  if (/Macintosh|Mac OS/i.test(userAgent)) return "Mac 浏览器";
  return "已配对设备";
}

function publicDevice(device: StoredDevice): TrustedDevice {
  const { tokenHash: _tokenHash, ...visible } = device;
  return visible;
}

export class SessionStore {
  private devices: StoredDevice[] = [];

  constructor(
    readonly password = process.env.CODEX_PWA_PASSWORD ?? "",
    readonly storagePath: string | null = defaultDevicePath(),
  ) {
    this.load();
  }

  get authRequired() {
    return this.password.length > 0;
  }

  authenticate(password: string) {
    return !this.authRequired || safeEqual(password, this.password);
  }

  create(request: IncomingMessage, response: ServerResponse, secure: boolean, name?: string) {
    const id = randomBytes(12).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.devices.push({
      id,
      tokenHash: tokenHash(secret),
      name: name ?? deviceName(request.headers["user-agent"]),
      createdAt: now,
      lastSeenAt: now,
      remoteAddress: request.socket?.remoteAddress ?? "",
    });
    this.save();
    this.setCookie(response, `${SESSION_VERSION}.${id}.${secret}`, secure);
    return id;
  }

  refresh(request: IncomingMessage, response: ServerResponse, secure: boolean) {
    const token = this.validToken(request);
    if (!token) return false;
    this.refreshToken(token, response, secure);
    return true;
  }

  sessionToken(request: IncomingMessage) {
    return this.validToken(request)?.raw ?? null;
  }

  adopt(raw: string, response: ServerResponse, secure: boolean) {
    const token = this.validRawToken(raw);
    if (!token) return false;
    this.refreshToken(token, response, secure);
    return true;
  }

  clear(request: IncomingMessage, response: ServerResponse, secure: boolean) {
    const token = this.validToken(request);
    if (token) this.revoke(token.device.id);
    const attributes = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
    if (secure) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  isAuthenticated(request: IncomingMessage) {
    if (!this.authRequired) return true;
    return Boolean(this.validToken(request));
  }

  listDevices() {
    return [...this.devices]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map(publicDevice);
  }

  revoke(id: string) {
    const next = this.devices.filter((device) => device.id !== id);
    if (next.length === this.devices.length) return false;
    this.devices = next;
    this.save();
    return true;
  }

  private validToken(request: IncomingMessage) {
    const raw = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    return this.validRawToken(raw);
  }

  private validRawToken(raw: string | undefined) {
    if (!raw) return null;
    const parts = raw.split(".");
    if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return null;
    const device = this.devices.find((entry) => entry.id === parts[1]);
    if (!device || !safeEqual(device.tokenHash, tokenHash(parts[2]))) return null;
    return { raw, device };
  }

  private refreshToken(token: { raw: string; device: StoredDevice }, response: ServerResponse, secure: boolean) {
    token.device.lastSeenAt = Date.now();
    this.save();
    this.setCookie(response, token.raw, secure);
  }

  private setCookie(response: ServerResponse, token: string, secure: boolean) {
    const attributes = [
      `${COOKIE_NAME}=${token}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    ];
    if (secure) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  private load() {
    if (!this.storagePath || !existsSync(this.storagePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as DeviceFile;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.devices)) this.devices = parsed.devices;
    } catch {
      this.devices = [];
    }
  }

  private save() {
    if (!this.storagePath) return;
    mkdirSync(dirname(this.storagePath), { recursive: true });
    writeFileSync(this.storagePath, JSON.stringify({ schemaVersion: 1, devices: this.devices } satisfies DeviceFile, null, 2), "utf8");
  }
}
