import { describe, expect, it } from "vitest";
import { applyThreadEvent } from "./thread-state";
import type { CodexThread } from "./types";

const thread: CodexThread = {
  id: "thread-1",
  preview: "",
  cwd: "E:\\work",
  name: "Test",
  source: "vscode",
  status: { type: "idle" },
  createdAt: 1,
  updatedAt: 1,
  turns: [],
};

describe("applyThreadEvent", () => {
  it("builds a streamed agent message", () => {
    let state = applyThreadEvent(thread, "item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "你好",
    });
    state = applyThreadEvent(state, "item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "，世界",
    });
    expect(state.turns[0].items[0].text).toBe("你好，世界");
  });
});

