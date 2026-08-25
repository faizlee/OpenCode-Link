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
