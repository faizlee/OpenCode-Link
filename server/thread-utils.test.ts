import { describe, expect, it } from "vitest";
import { dedupeThreadPage } from "./thread-utils.js";
import type { CodexThread, ThreadPage } from "./protocol.js";

function thread(id: string, updatedAt: number): CodexThread {
  return {
    id,
    sessionId: id,
    preview: id,
    cwd: "E:\\work",
    name: id,
    source: "vscode",
    status: { type: "notLoaded" },
    createdAt: 1,
    updatedAt,
    recencyAt: null,
    turns: [],
  };
}

describe("dedupeThreadPage", () => {
  it("keeps the newest record for each thread id", () => {
    const page: ThreadPage = {
      data: [thread("a", 2), thread("b", 3), thread("a", 5)],
      nextCursor: null,
      backwardsCursor: null,
    };
    expect(dedupeThreadPage(page).data.map((item) => [item.id, item.updatedAt])).toEqual([
      ["a", 5],
      ["b", 3],
    ]);
  });
});

