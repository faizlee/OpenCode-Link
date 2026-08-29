import { describe, expect, it } from "vitest";
import { loadCachedThread, saveCachedThread, type ThreadCacheStorage } from "./thread-cache";
import type { ThreadResumeResponse, Turn } from "./types";

function memoryStorage(): ThreadCacheStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function response(turns: Turn[]): ThreadResumeResponse {
  return {
    thread: {
      id: "thread-1",
      preview: "",
      cwd: "E:\\work",
      name: "任务",
      source: "vscode",
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 2,
      turns,
    },
    revision: "revision-1",
    model: "电脑端 Codex",
    cwd: "E:\\work",
    approvalPolicy: "",
    reasoningEffort: null,
    access: "queued",
  };
}

describe("thread session cache", () => {
  it("restores the current task without waiting for the network", () => {
    const storage = memoryStorage();
    saveCachedThread(response([]), storage);
    expect(loadCachedThread("thread-1", storage)?.revision).toBe("revision-1");
  });

  it("keeps only the newest turns", () => {
    const storage = memoryStorage();
    const turns = Array.from({ length: 35 }, (_, index): Turn => ({
      id: `turn-${index}`,
      items: [],
      status: "completed",
      error: null,
      startedAt: index,
      completedAt: index,
      durationMs: 0,
    }));
    saveCachedThread(response(turns), storage);
    const cached = loadCachedThread("thread-1", storage);
    expect(cached?.thread.turns).toHaveLength(30);
    expect(cached?.thread.turns[0].id).toBe("turn-5");
  });
});
