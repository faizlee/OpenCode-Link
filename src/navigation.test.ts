import { describe, expect, it } from "vitest";
import {
  consolePath,
  consoleSection,
  isDesktopConsolePath,
  listPath,
  threadIdFromPath,
  threadPath,
} from "./navigation";

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

describe("desktop console navigation", () => {
  it("keeps every /setup path inside the desktop console", () => {
    expect(isDesktopConsolePath("/setup")).toBe(true);
    expect(isDesktopConsolePath("/setup/devices")).toBe(true);
    expect(isDesktopConsolePath("/setup/connection")).toBe(true);
    expect(isDesktopConsolePath("/setup/settings")).toBe(true);
    expect(isDesktopConsolePath("/setup/about")).toBe(true);
    expect(isDesktopConsolePath("/setup/unknown")).toBe(true);
    expect(isDesktopConsolePath("/")).toBe(false);
    expect(isDesktopConsolePath("/thread/abc")).toBe(false);
    expect(isDesktopConsolePath("/settings")).toBe(false);
  });

  it("maps five console sections and still treats unknown setup paths as overview", () => {
    expect(consoleSection("/setup")).toBe("overview");
    expect(consoleSection("/setup/devices")).toBe("devices");
    expect(consoleSection("/setup/connection")).toBe("connection");
    expect(consoleSection("/setup/settings")).toBe("settings");
    expect(consoleSection("/setup/about")).toBe("about");
    expect(consoleSection("/setup/unknown")).toBe("overview");
    expect(consoleSection("/")).toBeNull();
    expect(consolePath("devices")).toBe("/setup/devices");
    expect(consolePath("overview")).toBe("/setup");
  });
});
