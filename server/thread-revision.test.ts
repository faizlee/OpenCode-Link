import { describe, expect, it } from "vitest";
import { createThreadRevision } from "./thread-revision.js";
import type { CodexThread } from "./protocol.js";

const thread: CodexThread = {
  id: "thread-1",
  sessionId: "thread-1",
  preview: "消息",
  cwd: "E:\\work",
  name: "任务",
  source: "vscode",
  status: { type: "idle" },
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
  turns: [],
};

describe("createThreadRevision", () => {
  it("stays stable when the source has not changed", () => {
    expect(createThreadRevision(thread, "rollout:10")).toBe(createThreadRevision({ ...thread }, "rollout:10"));
  });

  it("changes for metadata or persisted-log changes", () => {
    const initial = createThreadRevision(thread, "rollout:10");
    expect(createThreadRevision({ ...thread, updatedAt: 3 }, "rollout:10")).not.toBe(initial);
    expect(createThreadRevision(thread, "rollout:11")).not.toBe(initial);
  });
});
