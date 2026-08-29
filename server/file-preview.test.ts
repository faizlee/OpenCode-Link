import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePreviewStore } from "./file-preview.js";

const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "opencodexlink-preview-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task file previews", () => {
  it("rewrites only referenced files inside the task or upload roots", async () => {
    const root = await temporaryRoot();
    const project = join(root, "project");
    const uploads = join(root, "uploads");
    const outside = join(root, "private.txt");
    await mkdir(join(project, "reports"), { recursive: true });
    await mkdir(uploads, { recursive: true });
    await writeFile(join(project, "reports", "screen.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(uploads, "notes.md"), "# notes", "utf8");
    await writeFile(outside, "private", "utf8");
    const store = new FilePreviewStore({ uploadRoot: uploads });

    const prepared = await store.prepareMarkdown([
      "[截图](reports/screen.png)",
      `[附件](<${join(uploads, "notes.md").replaceAll("\\", "/")}>)`,
      "[外部](https://example.com/report.pdf)",
      "[越界](../private.txt)",
    ].join("\n"), project);

    expect(prepared.filePreviews.map((item) => item.kind)).toEqual(["image", "text"]);
    expect(prepared.text).toContain("https://example.com/report.pdf");
    expect(prepared.text).toContain("../private.txt");
    for (const item of prepared.filePreviews) expect(store.resolve(item.url.split("/").at(-1) ?? "")).not.toBeNull();
  });

  it("does not inline active or unsupported documents", async () => {
    const root = await temporaryRoot();
    const uploads = join(root, "uploads");
    await mkdir(uploads, { recursive: true });
    await writeFile(join(root, "page.html"), "<script>alert(1)</script>", "utf8");
    await writeFile(join(root, "vector.svg"), "<svg/>", "utf8");
    await writeFile(join(root, "report.docx"), "office", "utf8");
    const store = new FilePreviewStore({ uploadRoot: uploads });
    const prepared = await store.prepareMarkdown("[网页](page.html) [矢量](vector.svg) [文档](report.docx)", root);
    expect(prepared.filePreviews.map((item) => item.kind)).toEqual(["download", "download", "download"]);
  });

  it("expires opaque preview grants", async () => {
    const root = await temporaryRoot();
    const uploads = join(root, "uploads");
    await mkdir(uploads, { recursive: true });
    await writeFile(join(root, "readme.txt"), "hello", "utf8");
    let now = 1_000;
    const store = new FilePreviewStore({ uploadRoot: uploads, ttlMs: 500, now: () => now });
    const prepared = await store.prepareMarkdown("[文本](readme.txt)", root);
    const token = prepared.filePreviews[0].url.split("/").at(-1) ?? "";
    expect(store.resolve(token)?.name).toBe("readme.txt");
    now = 1_501;
    expect(store.resolve(token)).toBeNull();
  });
});
