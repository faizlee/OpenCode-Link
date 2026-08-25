import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "codex_pwa_session";

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

export class SessionStore {
  private readonly sessions = new Set<string>();
  readonly password = process.env.CODEX_PWA_PASSWORD ?? "";

  get authRequired() {
    return this.password.length > 0;
  }

  authenticate(password: string) {
    return !this.authRequired || safeEqual(password, this.password);
  }

  create(response: ServerResponse, secure: boolean) {
    const id = randomBytes(32).toString("base64url");
    this.sessions.add(id);
    const attributes = [`${COOKIE_NAME}=${id}`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"];
    if (secure) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  clear(request: IncomingMessage, response: ServerResponse, secure: boolean) {
    const id = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    if (id) this.sessions.delete(id);
    const attributes = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
    if (secure) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  isAuthenticated(request: IncomingMessage) {
    if (!this.authRequired) return true;
    const id = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    return Boolean(id && this.sessions.has(id));
  }
}

