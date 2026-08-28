export const ROUTE_STATE_KEY = "opencodexlink-route-state-v1";
export const ROUTE_HASH_KEY = "ocl-route";

export interface RouteLink {
  origin: string;
  tailscale?: boolean;
  stable?: boolean;
}

export interface RouteState {
  schemaVersion: 1;
  credential: string;
  links: RouteLink[];
  savedAt: number;
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

export function routeHash(credential: string) {
  return `#${ROUTE_HASH_KEY}=${encodeURIComponent(credential)}`;
}

export function sanitizeRouteLinks(links: RouteLink[]) {
  return links
    .filter((link) => isTrustedRouteOrigin(link.origin))
    .filter((link, index, all) => all.findIndex((candidate) => candidate.origin === link.origin) === index);
}

export function loadRouteState(): RouteState | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ROUTE_STATE_KEY) ?? "null") as Partial<RouteState> | null;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.credential !== "string" || !parsed.credential) return null;
    return {
      schemaVersion: 1,
      credential: parsed.credential,
      links: sanitizeRouteLinks(Array.isArray(parsed.links) ? parsed.links : []),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveRouteState(credential: string, links: RouteLink[]) {
  const state: RouteState = {
    schemaVersion: 1,
    credential,
    links: sanitizeRouteLinks(links),
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
