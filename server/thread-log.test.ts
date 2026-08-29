import { appendFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexThread } from "./protocol.js";
import {
  clearThreadLogCache,
  currentThreadLogRevision,
  hydrateThreadFromDesktopLog,
  refreshThreadLogRevision,
} from "./thread-log.js";

const threadId = "01a03a0f-379c-7920-8e5a-8189842a777f";

function baseThread(): CodexThread {
  return {
    id: threadId,
    sessionId: threadId,
    preview: "old",
    cwd: "E:\\work",
    name: "Test",
    source: "vscode",
    status: { type: "notLoaded" },
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    turns: [],
  };
}

function record(timestamp: string, role: "user" | "assistant", turnId: string, text: string, id: string) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      id,
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  });
}

afterEach(() => clearThreadLogCache());

describe("hydrateThreadFromDesktopLog", () => {
  it("uses the newest valid rollout when a resumed thread has multiple files", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-link-log-"));
    const oldDirectory = join(root, "sessions", "2026", "08", "27");
    const newDirectory = join(root, "sessions", "2026", "08", "28");
    await mkdir(oldDirectory, { recursive: true });
    await mkdir(newDirectory, { recursive: true });
    const oldPath = join(oldDirectory, `rollout-old-${threadId}.jsonl`);
    const newPath = join(newDirectory, `rollout-new-${threadId}.jsonl`);
    const sessionMeta = JSON.stringify({ type: "session_meta", payload: { id: threadId } });
    await writeFile(oldPath, [
      sessionMeta,
      record("2026-08-27T08:00:00Z", "user", "turn-old", "旧文件内容", "user-old"),
    ].join("\n") + "\n", "utf8");
    await writeFile(newPath, [
      sessionMeta,
      record("2026-08-28T08:00:00Z", "user", "turn-new", "最新文件内容", "user-new"),
    ].join("\n") + "\n", "utf8");
    await utimes(oldPath, new Date("2026-08-27T08:00:00Z"), new Date("2026-08-27T08:00:00Z"));
    await utimes(newPath, new Date("2026-08-28T08:00:00Z"), new Date("2026-08-28T08:00:00Z"));

    const result = await hydrateThreadFromDesktopLog(baseThread(), { codexHome: root });

    expect(result.preview).toBe("最新文件内容");
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].items[0].content).toEqual([{ type: "text", text: "最新文件内容" }]);
  });

  it("switches a cached thread to a newer rollout after rediscovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-link-log-"));
    const directory = join(root, "sessions");
    await mkdir(directory, { recursive: true });
    const oldPath = join(directory, `rollout-old-${threadId}.jsonl`);
    const newPath = join(directory, `rollout-new-${threadId}.jsonl`);
    const sessionMeta = JSON.stringify({ type: "session_meta", payload: { id: threadId } });
    await writeFile(oldPath, [
      sessionMeta,
      record("2026-08-27T08:00:00Z", "user", "turn-old", "缓存的旧内容", "user-old"),
    ].join("\n") + "\n", "utf8");
    await utimes(oldPath, new Date("2026-08-27T08:00:00Z"), new Date("2026-08-27T08:00:00Z"));
    let now = 1_000;

    const first = await hydrateThreadFromDesktopLog(baseThread(), {
      codexHome: root,
      now: () => now,
      rediscoveryIntervalMs: 100,
    });
    expect(first.turns[0].items[0].content).toEqual([{ type: "text", text: "缓存的旧内容" }]);

    await writeFile(newPath, [
      sessionMeta,
      record("2026-08-28T08:00:00Z", "user", "turn-new", "切换后的最新内容", "user-new"),
    ].join("\n") + "\n", "utf8");
    await utimes(newPath, new Date("2026-08-28T08:00:00Z"), new Date("2026-08-28T08:00:00Z"));
    now += 101;

    const second = await hydrateThreadFromDesktopLog(baseThread(), {
      codexHome: root,
      now: () => now,
      rediscoveryIntervalMs: 100,
    });
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0].items[0].content).toEqual([{ type: "text", text: "切换后的最新内容" }]);
  });

  it("reads current desktop messages and then follows appended records", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-link-log-"));
    const directory = join(root, "sessions", "2026", "08", "26");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-${threadId}.jsonl`);
    await writeFile(path, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      record("2026-08-26T08:00:00Z", "user", "turn-1", "## My request:\n最新问题", "user-1"),
      record("2026-08-26T08:00:01Z", "assistant", "turn-1", "最新回答", "agent-1"),
    ].join("\n") + "\n", "utf8");

    const first = await hydrateThreadFromDesktopLog(baseThread(), { codexHome: root });
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0].items).toEqual([
      { type: "userMessage", id: "user-1", content: [{ type: "text", text: "最新问题" }] },
      { type: "agentMessage", id: "agent-1", text: "最新回答", phase: null },
    ]);

    await appendFile(path, record("2026-08-26T08:01:00Z", "assistant", "turn-1", "追加进展", "agent-2") + "\n", "utf8");
    const second = await hydrateThreadFromDesktopLog(baseThread(), { codexHome: root });
    expect(second.turns[0].items.at(-1)?.text).toBe("追加进展");
    expect(second.updatedAt).toBe(Date.parse("2026-08-26T08:01:00Z") / 1000);
  });

  it("keeps a stable lightweight revision until the persisted log changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-link-log-"));
    const directory = join(root, "sessions");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-${threadId}.jsonl`);
    await writeFile(path, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      record("2026-08-26T08:00:00Z", "user", "turn-1", "初始消息", "user-1"),
    ].join("\n") + "\n", "utf8");

    await hydrateThreadFromDesktopLog(baseThread(), { codexHome: root });
    const initial = currentThreadLogRevision(threadId, { codexHome: root });
    expect(await refreshThreadLogRevision(threadId, { codexHome: root })).toBe(initial);

    await appendFile(path, record("2026-08-26T08:01:00Z", "assistant", "turn-1", "新消息", "agent-1") + "\n", "utf8");
    expect(await refreshThreadLogRevision(threadId, { codexHome: root })).not.toBe(initial);
  });

  it("hides injected plugin, instruction, and environment context records", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-link-log-"));
    const directory = join(root, "sessions");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-${threadId}.jsonl`);
    const injectedContext = [
      "<recommended_plugins>plugin inventory</recommended_plugins>",
      "# AGENTS.md instructions",
      "<INSTRUCTIONS>private project instructions</INSTRUCTIONS>",
      "<environment_context><cwd>E:\\\\work</cwd></environment_context>",
    ].join("\n");
    await writeFile(path, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      record("2026-08-26T08:00:00Z", "user", "turn-1", injectedContext, "context-1"),
      record("2026-08-26T08:00:00Z", "user", "turn-1", "真正的用户消息", "user-1"),
    ].join("\n") + "\n", "utf8");

    const result = await hydrateThreadFromDesktopLog(baseThread(), { codexHome: root });
    expect(result.turns[0].items).toEqual([
      { type: "userMessage", id: "user-1", content: [{ type: "text", text: "真正的用户消息" }] },
    ]);
    expect(JSON.stringify(result)).not.toContain("private project instructions");
  });

  it("does not send persisted image data URLs to the browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-link-log-"));
    const directory = join(root, "sessions");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-${threadId}.jsonl`);
    await writeFile(path, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      JSON.stringify({
        timestamp: "2026-08-26T08:00:00Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "user-image",
          role: "user",
          content: [{ type: "input_text", text: "看图" }, { type: "input_image", image_url: "data:image/jpeg;base64,AAAA" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-image" },
        },
      }),
    ].join("\n") + "\n", "utf8");

    const result = await hydrateThreadFromDesktopLog(baseThread(), { codexHome: root });
    expect(result.turns[0].items[0].content).toEqual([{ type: "text", text: "看图" }, { type: "image" }]);
    expect(JSON.stringify(result)).not.toContain("AAAA");
  });
});
