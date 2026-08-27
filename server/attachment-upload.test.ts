import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectImageExtension, parseAttachmentMessage } from "./attachment-upload.js";

const originalUploadDirectory = process.env.CODEX_PWA_UPLOAD_DIR;

afterEach(() => {
  if (originalUploadDirectory === undefined) delete process.env.CODEX_PWA_UPLOAD_DIR;
  else process.env.CODEX_PWA_UPLOAD_DIR = originalUploadDirectory;
});

describe("attachment uploads", () => {
  it("recognizes image signatures without trusting the filename", () => {
    expect(detectImageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(".png");
    expect(detectImageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(".jpg");
    expect(detectImageExtension(Buffer.from("RIFF1234WEBP", "ascii"))).toBe(".webp");
    expect(detectImageExtension(Buffer.from("not an image", "utf8"))).toBeNull();
  });

  it("accepts images and general files in one multipart message", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencodexlink-attachments-"));
    process.env.CODEX_PWA_UPLOAD_DIR = join(root, "uploads");
    const received: { text?: string; files?: Array<{ path: string; originalName: string; image: boolean }> } = {};
    const server = createServer(async (request, response) => {
      const upload = await parseAttachmentMessage(request);
      received.text = upload.text;
      received.files = upload.attachments;
      await Promise.all(upload.attachments.map((attachment) => stat(attachment.path)));
      await upload.discard();
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
      const form = new FormData();
      form.append("text", "比较图片并总结文档");
      form.append("attachments", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }), "photo.jpg");
      form.append("attachments", new Blob([Buffer.from("document body")], { type: "text/plain" }), "notes.txt");
      const response = await fetch(`http://127.0.0.1:${address.port}`, { method: "POST", body: form });
      expect(response.status).toBe(200);
      expect(received.text).toBe("比较图片并总结文档");
      expect(received.files).toHaveLength(2);
      expect(received.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ originalName: "photo.jpg", image: true }),
        expect.objectContaining({ originalName: "notes.txt", image: false }),
      ]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
