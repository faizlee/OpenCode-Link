import { describe, expect, it } from "vitest";
import { listPath, threadIdFromPath, threadPath } from "./navigation";

describe("PWA navigation", () => {
  it("round-trips a thread id through the URL", () => {
    const id = "task/手机 1";
    expect(threadIdFromPath(threadPath(id))).toBe(id);
  });

  it("does not treat the task list as a thread route", () => {
    expect(threadIdFromPath("/")).toBeNull();
    expect(threadIdFromPath("/settings")).toBeNull();
  });

  it("preserves a task search in the list URL", () => {
    expect(listPath("知识库 查询")).toBe("/?q=%E7%9F%A5%E8%AF%86%E5%BA%93%20%E6%9F%A5%E8%AF%A2");
    expect(listPath("  ")).toBe("/");
  });
});
