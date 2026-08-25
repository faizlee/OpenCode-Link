import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "codex_pwa_session";
const SESSION_VERSION = "v1";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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

function sign(value: string, password: string) {
  return createHmac("sha256", `codex-pwa-session:${password}`).update(value).digest("base64url");
}

function createToken(password: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const unsigned = `${SESSION_VERSION}.${nowSeconds}.${randomBytes(24).toString("base64url")}`;
  return `${unsigned}.${sign(unsigned, password)}`;
}

function verifyToken(token: string, password: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return false;

  const issuedAt = Number(parts[1]);
  if (!Number.isInteger(issuedAt) || issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > SESSION_MAX_AGE_SECONDS) return false;

  const unsigned = parts.slice(0, 3).join(".");
  return safeEqual(parts[3], sign(unsigned, password));
}

export class SessionStore {
  constructor(readonly password = process.env.CODEX_PWA_PASSWORD ?? "") {}

  get authRequired() {
    return this.password.length > 0;
  }

  authenticate(password: string) {
    return !this.authRequired || safeEqual(password, this.password);
  }

  create(response: ServerResponse, secure: boolean) {
    const token = createToken(this.password);
    const attributes = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_MAX_AGE_SECONDS}`];
    if (secure) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  clear(_request: IncomingMessage, response: ServerResponse, secure: boolean) {
    const attributes = [`${COOKIE_NAME}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
    if (secure) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  isAuthenticated(request: IncomingMessage) {
    if (!this.authRequired) return true;
    const token = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    return Boolean(token && verifyToken(token, this.password));
  }
}
