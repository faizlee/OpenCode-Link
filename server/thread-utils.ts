import type { CodexThread, ThreadPage } from "./protocol.js";

export function dedupeThreadPage(page: ThreadPage): ThreadPage {
  const byId = new Map<string, CodexThread>();
  for (const thread of page.data) {
    const existing = byId.get(thread.id);
    if (!existing || thread.updatedAt > existing.updatedAt) byId.set(thread.id, thread);
  }
  return {
    ...page,
    data: [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

