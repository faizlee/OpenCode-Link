import type { ThreadResumeResponse } from "./types";

const CACHE_PREFIX = "codex-pwa-thread-cache-v1:";
const MAX_CACHED_TURNS = 30;
const MAX_CACHE_CHARACTERS = 2_000_000;

export interface ThreadCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function cacheKey(threadId: string) {
  return `${CACHE_PREFIX}${threadId}`;
}

export function loadCachedThread(threadId: string, storage: ThreadCacheStorage = window.sessionStorage) {
  try {
    const raw = storage.getItem(cacheKey(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ThreadResumeResponse;
    if (parsed?.thread?.id !== threadId || !Array.isArray(parsed.thread.turns)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedThread(response: ThreadResumeResponse, storage: ThreadCacheStorage = window.sessionStorage) {
  try {
    let turns = response.thread.turns.slice(-MAX_CACHED_TURNS);
    let serialized = "";
    do {
      serialized = JSON.stringify({
        ...response,
        thread: { ...response.thread, turns },
      });
      if (serialized.length <= MAX_CACHE_CHARACTERS || turns.length <= 1) break;
      turns = turns.slice(Math.ceil(turns.length / 2));
    } while (turns.length);
    if (serialized.length <= MAX_CACHE_CHARACTERS) storage.setItem(cacheKey(response.thread.id), serialized);
  } catch {
    // A private browser session or a full storage quota must not block the live view.
  }
}
