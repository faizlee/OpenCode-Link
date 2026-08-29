import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePreviewStore } from "./file-preview.js";
import { createBridgeApp } from "./http-app.js";
import { PairingStore } from "./pairing.js";
import { createRuntimeIdentity } from "./runtime.js";
import { SessionStore } from "./session.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authenticated file preview HTTP route", () => {
  it("requires pairing, serves referenced files, supports download, and reports removed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencodexlink-preview-http-"));
    roots.push(root);
    const project = join(root, "project");
    const uploads = join(root, "uploads");
    await mkdir(project, { recursive: true });
    await mkdir(uploads, { recursive: true });
    const documentPath = join(project, "report.txt");
    await writeFile(documentPath, "preview body", "utf8");

    const sessions = new SessionStore(join(root, "trusted-devices.json"));
    const pairing = new PairingStore();
    const filePreviews = new FilePreviewStore({ uploadRoot: uploads });
    const prepared = await filePreviews.prepareMarkdown("[报告](report.txt)", project);
    const descriptor = prepared.filePreviews[0];
    const app = createBridgeApp({
      sessions,
      pairing,
      filePreviews,
      identity: createRuntimeIdentity({ dataRoot: root, port: 18924, installRoot: join(root, "install") }),
      appServerReady: () => true,
      lanDiscovery: { defaultPortReady: false, address: async () => null },
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      expect((await fetch(`${origin}${descriptor.url}`)).status).toBe(401);
      const ticket = pairing.issue();
      const scan = await fetch(`${origin}/pair/${ticket.token}`, { redirect: "manual", headers: { "User-Agent": "test phone" } });
      const cookie = scan.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(cookie).not.toBe("");

      const preview = await fetch(`${origin}${descriptor.url}`, { headers: { Cookie: cookie } });
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toContain("text/plain");
      expect(preview.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(await preview.text()).toBe("preview body");

      const download = await fetch(`${origin}${descriptor.downloadUrl}`, { headers: { Cookie: cookie } });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toContain("attachment");

      await unlink(documentPath);
      const removed = await fetch(`${origin}${descriptor.url}`, { headers: { Cookie: cookie } });
      expect(removed.status).toBe(410);
      expect(await removed.json()).toEqual({ error: "文件已清理、移动或删除" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
