import { createHash } from "node:crypto";
import type { CodexThread } from "./protocol.js";

export function createThreadRevision(thread: CodexThread, logRevision: string | null) {
  const source = JSON.stringify({
    id: thread.id,
    name: thread.name,
    cwd: thread.cwd,
    preview: thread.preview,
    updatedAt: thread.updatedAt,
    status: thread.status,
    logRevision,
  });
  return createHash("sha256").update(source).digest("base64url");
}
