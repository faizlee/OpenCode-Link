import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

const COOKIE_NAME = "codex_pwa_session";
const SESSION_VERSION = "v2";
const ROUTE_CREDENTIAL_VERSION = "r1";
const MAX_ORIGIN_SESSIONS = 16;
// Browsers may cap long cookie lifetimes. Refreshing this rolling cookie on
// every visit keeps a regularly used trusted device signed in indefinitely.
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

interface StoredDevice {
  id: string;
  tokenHash: string;
  sessionTokenHashes?: string[];
  name: string;
  createdAt: number;
  lastSeenAt: number;
  remoteAddress: string;
}

export interface TrustedDevice {
  id: string;
  name: string;
  kind: string;
  createdAt: number;
  lastSeenAt: number;
  remoteAddress: string;
  current?: boolean;
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

function routeCredential(device: StoredDevice) {
  const signature = createHmac("sha256", device.tokenHash)
    .update(`${ROUTE_CREDENTIAL_VERSION}.${device.id}`)
    .digest("base64url");
  return `${ROUTE_CREDENTIAL_VERSION}.${device.id}.${signature}`;
}

function defaultDevicePath() {
  const root = process.env.CODEX_PWA_DATA_DIR
    ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "OpenCodexLink") : join(process.cwd(), "work", "data"));
  return join(root, "trusted-devices.json");
}

const GENERIC_DEVICE_NAMES = new Set(["iPad", "iPhone", "Android 手机", "Windows 浏览器", "Mac 浏览器", "已配对设备"]);

function headerText(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function cleanDeviceModel(value: string) {
  const cleaned = value
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!cleaned || cleaned.length > 80) return "";
  if (/^(?:K|Unknown|Android|Not[ _-]?A[ _-]?Brand)$/i.test(cleaned)) return "";
  return cleaned;
}

function androidModelFromUserAgent(userAgent: string) {
  for (const match of userAgent.matchAll(/\(([^)]*Android[^)]*)\)/gi)) {
    const segments = match[1].split(";").map((segment) => segment.trim()).filter(Boolean);
    const buildSegment = segments.find((segment) => /\bBuild\//i.test(segment));
    if (buildSegment) {
      const model = cleanDeviceModel(buildSegment.replace(/\s+Build\/.*$/i, ""));
      if (model) return model;
    }
  }
  return "";
}

export function defaultDeviceName(headers: IncomingHttpHeaders = {}) {
  const userAgent = headerText(headers["user-agent"]);
  const hintedModel = cleanDeviceModel(headerText(headers["sec-ch-ua-model"]));
  if (hintedModel) return hintedModel;
  if (/Android/i.test(userAgent)) return androidModelFromUserAgent(userAgent) || "Android 手机";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Windows/i.test(userAgent)) return "Windows 浏览器";
  if (/Macintosh|Mac OS/i.test(userAgent)) return "Mac 浏览器";
  return "已配对设备";
}

export function deviceKind(name: string) {
  if (/iPad/i.test(name)) return "iPad";
  if (/iPhone/i.test(name)) return "iPhone";
  if (/Android/i.test(name)) return "Android 手机";
  if (/Windows/i.test(name)) return "Windows 浏览器";
  if (/Macintosh|Mac OS|Mac 浏览器/i.test(name)) return "Mac 浏览器";
  return "已配对设备";
}

function publicDevice(device: StoredDevice, currentId?: string): TrustedDevice {
  const { tokenHash: _tokenHash, ...visible } = device;
  return {
    ...visible,
    kind: deviceKind(device.name),
    ...(currentId === device.id ? { current: true } : {}),
  };
}

export class SessionStore {
  private devices: StoredDevice[] = [];
  loadError = false;

  constructor(readonly storagePath: string | null = defaultDevicePath()) {
    this.load();
  }

  get authRequired() {
    return true;
  }

  create(request: IncomingMessage, response: ServerResponse, secure: boolean, name?: string) {
    const id = randomBytes(12).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.devices.push({
      id,
      tokenHash: tokenHash(secret),
      name: name ?? defaultDeviceName(request.headers),
      createdAt: now,
      lastSeenAt: now,
      remoteAddress: request.socket?.remoteAddress ?? "",
    });
    this.save();
    const raw = `${SESSION_VERSION}.${id}.${secret}`;
    this.setCookie(response, raw, secure);
    return { id, token: raw };
  }

  refresh(request: IncomingMessage, response: ServerResponse, secure: boolean) {
    const token = this.validToken(request);
    if (!token) return false;
    this.refreshToken(token, response, secure, request.headers);
    return true;
  }

  sessionToken(request: IncomingMessage) {
    return this.validToken(request)?.raw ?? null;
  }

  routeCredential(request: IncomingMessage) {
    const token = this.validToken(request);
    return token ? routeCredential(token.device) : null;
  }

  adoptRouteCredential(raw: string, response: ServerResponse, secure: boolean, headers?: IncomingHttpHeaders) {
    const parts = raw.split(".");
    if (parts.length !== 3 || parts[0] !== ROUTE_CREDENTIAL_VERSION) return false;
    const device = this.devices.find((entry) => entry.id === parts[1]);
    if (!device || !safeEqual(routeCredential(device), raw)) return false;

    const secret = randomBytes(32).toString("base64url");
    const sessionToken = `${SESSION_VERSION}.${device.id}.${secret}`;
    const nextHash = tokenHash(secret);
    device.sessionTokenHashes = [
      ...(device.sessionTokenHashes ?? []).filter((hash) => hash !== nextHash),
      nextHash,
    ].slice(-MAX_ORIGIN_SESSIONS);
    this.refreshToken({ raw: sessionToken, device }, response, secure, headers);
    return true;
  }

  adopt(raw: string, response: ServerResponse, secure: boolean, headers?: IncomingHttpHeaders) {
    const token = this.validRawToken(raw);
    if (!token) return false;
    this.refreshToken(token, response, secure, headers);
    return true;
  }

  clear(request: IncomingMessage, response: ServerResponse, secure: boolean) {
    const token = this.validToken(request);
    if (token) this.revoke(token.device.id);
    const attributes = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
    if (secure) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  isAuthenticated(request: IncomingMessage) {
    return Boolean(this.validToken(request));
  }

  listDevices(request?: IncomingMessage) {
    const currentId = request ? this.validToken(request)?.device.id : undefined;
    return [...this.devices]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((device) => publicDevice(device, currentId));
  }

  rename(id: string, name: string) {
    if (this.loadError) return false;
    const device = this.devices.find((entry) => entry.id === id);
    const trimmed = name.trim();
    if (!device || !trimmed) return false;
    device.name = trimmed;
    this.save();
    return true;
  }

  revoke(id: string) {
    if (this.loadError) return false;
    const next = this.devices.filter((device) => device.id !== id);
    if (next.length === this.devices.length) return false;
    this.devices = next;
    this.save();
    return true;
  }

  revokeMany(ids: string[]) {
    if (this.loadError) return { revoked: [] as string[] };
    const selected = new Set(ids.filter(Boolean));
    const revoked = ids.filter((id) => this.devices.some((device) => device.id === id) && selected.delete(id));
    if (!revoked.length) return { revoked };
    const remove = new Set(revoked);
    this.devices = this.devices.filter((device) => !remove.has(device.id));
    this.save();
    return { revoked };
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
    const candidateHash = tokenHash(parts[2]);
    const acceptedHashes = device ? [device.tokenHash, ...(device.sessionTokenHashes ?? [])] : [];
    if (!device || !acceptedHashes.some((hash) => safeEqual(hash, candidateHash))) return null;
    return { raw, device };
  }

  private refreshToken(
    token: { raw: string; device: StoredDevice },
    response: ServerResponse,
    secure: boolean,
    headers?: IncomingHttpHeaders,
  ) {
    if (headers && GENERIC_DEVICE_NAMES.has(token.device.name)) {
      const detectedName = defaultDeviceName(headers);
      if (!GENERIC_DEVICE_NAMES.has(detectedName)) token.device.name = detectedName;
    }
    token.device.lastSeenAt = Date.now();
    this.save();
    this.setCookie(response, token.raw, secure);
  }

  private setCookie(response: ServerResponse, token: string, secure: boolean) {
    const attributes = [
      `${COOKIE_NAME}=${token}`,
      "HttpOnly",
      // A QR scan is a top-level navigation from the phone's scanner app.
      // Lax lets that GET carry the existing device cookie, so rescanning the
      // same origin refreshes the trusted row instead of creating a duplicate.
      "SameSite=Lax",
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
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.devices)) {
        this.devices = parsed.devices;
        return;
      }
      this.loadError = true;
    } catch {
      this.loadError = true;
    }
  }

  private save() {
    if (!this.storagePath || this.loadError) return;
    mkdirSync(dirname(this.storagePath), { recursive: true });
    writeFileSync(this.storagePath, JSON.stringify({ schemaVersion: 1, devices: this.devices } satisfies DeviceFile, null, 2), "utf8");
  }
}
