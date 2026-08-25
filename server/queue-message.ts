import { execFile } from "node:child_process";
import { findCodexBinary } from "./codex-binary.js";

export interface QueuedMessageResult {
  delivery: "queued";
  queueItemId: string | null;
  notice: string;
}

export function parseQueuedMessageId(output: string) {
  return output.match(/Queued message\s+([^\s]+)\s+for thread/i)?.[1] ?? null;
}

export function queueMessage(threadId: string, text: string): Promise<QueuedMessageResult> {
  const binary = findCodexBinary();

  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["queue", "--thread", threadId, "--message", text],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(detail || "无法把消息发送到电脑端 Codex"));
          return;
        }

        resolve({
          delivery: "queued",
          queueItemId: parseQueuedMessageId(stdout),
          notice: "已发送到电脑端 Codex；它会在这个任务中继续处理。",
        });
      },
    );
  });
}
