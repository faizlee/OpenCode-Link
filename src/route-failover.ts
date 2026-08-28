export const ROUTE_STATE_KEY = "opencodexlink-route-state-v1";
export const ROUTE_HASH_KEY = "ocl-route";
export const ROUTE_RELAY_KEY = "ocl-relay";
export const ROUTE_PROBE_MESSAGE = "opencodexlink-route-probe";

export interface RouteLink {
  origin: string;
  tailscale?: boolean;
  stable?: boolean;
}

export interface RouteState {
  schemaVersion: 1;
  credential: string;
  links: RouteLink[];
  preparedOrigins: string[];
  savedAt: number;
}

export interface RouteRelay {
  returnOrigin: string;
  returnPath: string;
  preparedOrigins: string[];
  links: RouteLink[];
  returning: boolean;
}

function isIpv4(hostname: string, matcher: (parts: number[]) => boolean) {
  const parts = hostname.split(".").map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && matcher(parts);
}

export function isTailscaleHost(hostname: string) {
  return isIpv4(hostname, (parts) => parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || hostname.toLowerCase().endsWith(".ts.net");
}

export function isStableHost(hostname: string) {
  return hostname.toLowerCase() === "opencodexlink.local";
}

export function isTrustedRouteOrigin(raw: string) {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || isStableHost(hostname)
      || isTailscaleHost(hostname)
      || isIpv4(hostname, (parts) => parts[0] === 10
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168));
  } catch {
    return false;
  }
}

export function credentialFromHash(hash: string) {
  if (!hash.startsWith("#")) return "";
  return new URLSearchParams(hash.slice(1)).get(ROUTE_HASH_KEY)?.trim() ?? "";
}

export function routeRelayFromHash(hash: string): RouteRelay | null {
  if (!hash.startsWith("#")) return null;
  const encoded = new URLSearchParams(hash.slice(1)).get(ROUTE_RELAY_KEY);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(encoded) as Partial<RouteRelay>;
    const returnOrigin = typeof parsed.returnOrigin === "string" && isTrustedRouteOrigin(parsed.returnOrigin)
      ? parsed.returnOrigin
      : "";
    const returnPath = typeof parsed.returnPath === "string"
      && parsed.returnPath.startsWith("/")
      && !parsed.returnPath.startsWith("//")
      ? parsed.returnPath
      : "/";
    if (!returnOrigin) return null;
    return {
      returnOrigin,
      returnPath,
      preparedOrigins: sanitizeOrigins(Array.isArray(parsed.preparedOrigins) ? parsed.preparedOrigins : []),
      links: sanitizeRouteLinks(Array.isArray(parsed.links) ? parsed.links : []),
      returning: parsed.returning === true,
    };
  } catch {
    return null;
  }
}

export function routeHash(credential: string, relay?: RouteRelay) {
  const params = new URLSearchParams({ [ROUTE_HASH_KEY]: credential });
  if (relay) params.set(ROUTE_RELAY_KEY, JSON.stringify(relay));
  return `#${params.toString()}`;
}

export function isRouteProbeMessage(origin: string, expectedOrigin: string, data: unknown) {
  if (origin !== expectedOrigin || !data || typeof data !== "object") return false;
  const message = data as { type?: unknown; productId?: unknown };
  return message.type === ROUTE_PROBE_MESSAGE && message.productId === "OpenCodexLink";
}

export function probeRouteOrigin(origin: string, timeoutMs = 2_500) {
  return new Promise<boolean>((resolve) => {
    const frame = document.createElement("iframe");
    let settled = false;
    let timer = 0;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (isRouteProbeMessage(event.origin, origin, event.data)) finish(true);
    };
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(result);
    };
    timer = window.setTimeout(() => finish(false), timeoutMs);
    window.addEventListener("message", onMessage);
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.src = `${origin}/api/route-probe?ts=${Date.now()}`;
    frame.addEventListener("error", () => finish(false), { once: true });
    document.body.append(frame);
  });
}

export function sanitizeRouteLinks(links: RouteLink[]) {
  return links
    .filter((link) => isTrustedRouteOrigin(link.origin))
    .filter((link, index, all) => all.findIndex((candidate) => candidate.origin === link.origin) === index);
}

export function sanitizeOrigins(origins: string[]) {
  return origins
    .filter((origin) => typeof origin === "string" && isTrustedRouteOrigin(origin))
    .filter((origin, index, all) => all.indexOf(origin) === index);
}

export function loadRouteState(): RouteState | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ROUTE_STATE_KEY) ?? "null") as Partial<RouteState> | null;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.credential !== "string" || !parsed.credential) return null;
    return {
      schemaVersion: 1,
      credential: parsed.credential,
      links: sanitizeRouteLinks(Array.isArray(parsed.links) ? parsed.links : []),
      preparedOrigins: sanitizeOrigins(Array.isArray(parsed.preparedOrigins) ? parsed.preparedOrigins : []),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveRouteState(credential: string, links: RouteLink[], preparedOrigins: string[] = []) {
  const state: RouteState = {
    schemaVersion: 1,
    credential,
    links: sanitizeRouteLinks(links),
    preparedOrigins: sanitizeOrigins(preparedOrigins),
    savedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(ROUTE_STATE_KEY, JSON.stringify(state));
  } catch {
    // A private browsing policy may block persistent storage. The current
    // origin still works through its HttpOnly session cookie.
  }
  return state;
}

export function clearRouteState() {
  try {
    window.localStorage.removeItem(ROUTE_STATE_KEY);
  } catch {
    // The server-side device revocation remains authoritative.
  }
}
