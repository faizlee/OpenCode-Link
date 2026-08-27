import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_ATTACHMENT_COUNT = 20;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_BATCH_BYTES = 200 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export class AttachmentUploadError extends Error {}

export interface UploadedAttachment {
  path: string;
  originalName: string;
  image: boolean;
}

export interface UploadedAttachmentMessage {
  text: string;
  attachments: UploadedAttachment[];
  discard: () => Promise<void>;
}

export function uploadRoot() {
  return process.env.CODEX_PWA_UPLOAD_DIR
    ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "OpenCodexLink", "uploads");
}

export function detectImageExtension(header: Buffer) {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return ".jpg";
  if (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return null;
}

function safeOriginalName(name: string) {
  return name.replace(/[\r\n\0]/g, " ").trim().slice(0, 180) || "未命名文件";
}

function safeExtension(name: string) {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ".bin";
}

async function removeDirectory(path: string) {
  await rm(path, { recursive: true, force: true });
}

export async function cleanupExpiredUploads(now = Date.now()) {
  const root = uploadRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join(root, entry.name);
    const details = await stat(path);
    if (now - details.mtimeMs >= UPLOAD_TTL_MS) await removeDirectory(path);
  }));
}

export async function parseAttachmentMessage(request: IncomingMessage): Promise<UploadedAttachmentMessage> {
  const batchDirectory = join(uploadRoot(), `${Date.now()}-${randomUUID()}`);
  await mkdir(batchDirectory, { recursive: true });

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      defParamCharset: "utf8",
      limits: {
        files: MAX_ATTACHMENT_COUNT,
        fileSize: MAX_ATTACHMENT_BYTES,
        fields: 2,
        fieldSize: 64 * 1024,
        parts: MAX_ATTACHMENT_COUNT + 2,
      },
    });
  } catch {
    await removeDirectory(batchDirectory);
    throw new AttachmentUploadError("附件上传格式不正确");
  }

  return new Promise((resolve, reject) => {
    let text = "";
    let totalBytes = 0;
    let uploadError: Error | null = null;
    const attachments: UploadedAttachment[] = [];
    const writes: Promise<void>[] = [];

    const fail = (message: string | Error) => {
      if (!uploadError) uploadError = typeof message === "string" ? new AttachmentUploadError(message) : message;
    };

    parser.on("field", (name, value, info) => {
      if (name !== "text") {
        fail("上传中包含不支持的字段");
        return;
      }
      if (info.valueTruncated) fail("消息文字过长");
      text = value;
    });

    parser.on("file", (name, stream, info) => {
      if (name !== "attachments") {
        fail("上传中包含不支持的文件字段");
        stream.resume();
        return;
      }

      const originalName = safeOriginalName(info.filename);
      const temporaryPath = join(batchDirectory, `${randomUUID()}.part`);
      const output = createWriteStream(temporaryPath, { flags: "wx" });
      let header = Buffer.alloc(0);
      let fileBytes = 0;

      stream.on("data", (chunk: Buffer) => {
        fileBytes += chunk.length;
        totalBytes += chunk.length;
        if (header.length < 12) header = Buffer.concat([header, chunk]).subarray(0, 12);
        if (totalBytes > MAX_BATCH_BYTES) fail("一次发送的附件总大小不能超过 200MB");
      });
      stream.on("limit", () => fail("单个附件不能超过 50MB"));

      const write = new Promise<void>((resolveWrite) => {
        const finish = async () => {
          try {
            if (fileBytes === 0) fail("不能发送空文件");
            const imageExtension = detectImageExtension(header);
            if (!uploadError) {
              const finalPath = temporaryPath.replace(/\.part$/, imageExtension ?? safeExtension(originalName));
              await rename(temporaryPath, finalPath);
              attachments.push({ path: finalPath, originalName, image: Boolean(imageExtension) });
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          } finally {
            resolveWrite();
          }
        };
        output.on("finish", () => void finish());
        output.on("error", (error) => {
          fail(error);
          resolveWrite();
        });
        stream.on("error", fail);
      });
      writes.push(write);
      stream.pipe(output);
    });

    parser.on("filesLimit", () => fail(`一次最多发送 ${MAX_ATTACHMENT_COUNT} 个附件`));
    parser.on("fieldsLimit", () => fail("上传字段过多"));
    parser.on("partsLimit", () => fail("上传内容过多"));
    parser.on("error", (error: Error) => fail(error));
    request.on("aborted", () => fail("附件上传已中断"));

    parser.on("close", () => {
      void Promise.all(writes).then(async () => {
        if (uploadError) {
          await removeDirectory(batchDirectory);
          reject(uploadError);
          return;
        }
        resolve({ text, attachments, discard: () => removeDirectory(batchDirectory) });
      }).catch(async (error) => {
        await removeDirectory(batchDirectory);
        reject(error);
      });
    });

    request.pipe(parser);
  });
}
