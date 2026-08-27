export function threadIdFromPath(pathname: string) {
  const match = /^\/thread\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function threadPath(threadId: string) {
  return `/thread/${encodeURIComponent(threadId)}`;
}

export function listPath(search = "") {
  const query = search.trim();
  return query ? `/?q=${encodeURIComponent(query)}` : "/";
}

export const CONSOLE_SECTIONS = ["overview", "devices", "connection", "settings", "about"] as const;
export type ConsoleSection = (typeof CONSOLE_SECTIONS)[number];

export function isDesktopConsolePath(pathname: string) {
  return pathname === "/setup" || pathname.startsWith("/setup/");
}

export function consoleSection(pathname: string): ConsoleSection | null {
  if (!isDesktopConsolePath(pathname)) return null;
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/setup/devices") return "devices";
  if (normalized === "/setup/connection") return "connection";
  if (normalized === "/setup/settings") return "settings";
  if (normalized === "/setup/about") return "about";
  return "overview";
}

export function consolePath(section: ConsoleSection) {
  return section === "overview" ? "/setup" : `/setup/${section}`;
}
