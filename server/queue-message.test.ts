import { describe, expect, it } from "vitest";
import {
  imageAttachmentsUnsupported,
  localPathQueueArguments,
  messageWithFilePaths,
  parseQueuedMessageId,
  queueArguments,
  queueMessageWithExecutor,
} from "./queue-message.js";

describe("parseQueuedMessageId", () => {
  it("reads the queue item id returned by Codex", () => {
    expect(parseQueuedMessageId("Queued message 01a03a93-ddf6 for thread thread-1.\n"))
      .toBe("01a03a93-ddf6");
  });

  it("returns null when an older Codex build omits the id", () => {
    expect(parseQueuedMessageId("Message queued.\n")).toBeNull();
  });

  it("attaches a batch of local images to the queued message", () => {
    expect(queueArguments("thread-1", "分析这些图片", [
      { path: "C:\\one.png", originalName: "one.png", image: true },
      { path: "C:\\two.jpg", originalName: "two.jpg", image: true },
    ]))
      .toEqual(["queue", "--thread", "thread-1", "--message", "分析这些图片", "--image", "C:\\one.png", "C:\\two.jpg"]);
  });

  it("makes non-image attachments available to Codex by local path", () => {
    const message = messageWithFilePaths("总结附件", [
      { path: "C:\\uploads\\report.pdf", originalName: "报告.pdf", image: false },
    ]);
    expect(message).toContain("总结附件");
    expect(message).toContain("报告.pdf");
    expect(message).toContain("C:\\uploads\\report.pdf");
  });

  it("can represent images as computer-local attachments when native queue images are unavailable", () => {
    const args = localPathQueueArguments("thread-1", "判断这张图", [
      { path: "C:\\uploads\\photo.jpg", originalName: "照片.jpg", image: true },
    ]);
    expect(args).not.toContain("--image");
    expect(args.at(-1)).toContain("图片：照片.jpg");
    expect(args.at(-1)).toContain("C:\\uploads\\photo.jpg");
  });

  it("recognizes the verified Codex queue image limitation", () => {
    expect(imageAttachmentsUnsupported("Error: `codex queue` does not support image attachments")).toBe(true);
    expect(imageAttachmentsUnsupported("thread is busy")).toBe(false);
  });

  it("automatically retries images as local paths without asking the phone user", async () => {
    const calls: string[][] = [];
    const result = await queueMessageWithExecutor("codex.exe", "thread-1", "看图", [
      { path: "C:\\uploads\\photo.jpg", originalName: "照片.jpg", image: true },
    ], async (_binary, args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error("Error: `codex queue` does not support image attachments");
      return "Queued message queue-2 for thread thread-1.\n";
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--image");
    expect(calls[1]).not.toContain("--image");
    expect(calls[1].at(-1)).toContain("C:\\uploads\\photo.jpg");
    expect(result).toMatchObject({ delivery: "queued", queueItemId: "queue-2", attachmentDelivery: "local-path" });
  });
});
