import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexThread, ThreadItem } from "./protocol.js";

export type FilePreviewKind = "image" | "pdf" | "text" | "download";

export interface FilePreviewDescriptor {
  url: string;
  downloadUrl: string;
  name: string;
  kind: FilePreviewKind;
  size: number;
}

export interface FilePreviewGrant extends FilePreviewDescriptor {
  path: string;
  expiresAt: number;
}

interface FilePreviewStoreOptions {
  uploadRoot: string;
  ttlMs?: number;
  now?: () => number;
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;
const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
const MARKDOWN_FILE_LINK = /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^\s)\n]+)(\))/g;

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".csv", ".diff", ".env", ".go", ".h", ".hpp",
  ".ini", ".java", ".js", ".json", ".jsx", ".log", ".md", ".mjs", ".ps1", ".py", ".rb", ".rs",
  ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

function kindFor(path: string, size: number): FilePreviewKind {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(extension) && size <= MAX_INLINE_TEXT_BYTES) return "text";
  return "download";
}

function normalizeMarkdownTarget(target: string) {
  const unwrapped = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
  try {
    return decodeURIComponent(unwrapped);
  } catch {
    return unwrapped;
  }
}

function localPathFromTarget(target: string, cwd: string) {
  const normalized = normalizeMarkdownTarget(target);
  if (!normalized || normalized.startsWith("#") || normalized.startsWith("data:") || normalized.startsWith("blob:")) return null;
  if (/^https?:\/\//i.test(normalized) || normalized.startsWith("/api/")) return null;
  if (/^file:\/\//i.test(normalized)) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return null;
    }
  }

  const windowsAbsolute = normalized.match(/^\/?([a-zA-Z]:[\\/].*)$/)?.[1];
  if (windowsAbsolute) return windowsAbsolute;
  if (isAbsolute(normalized)) return normalized;
  return resolve(cwd, normalized.replace(/^\.\//, ""));
}

function inside(root: string, target: string) {
  const difference = relative(root, target);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

async function existingFile(path: string) {
  const candidates = [path];
  const lineSuffix = path.match(/^(.*):(\d+)(?::\d+)?$/);
  if (lineSuffix) candidates.push(lineSuffix[1]);
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return { path: await realpath(candidate), size: info.size };
    } catch {
      // Try the optional line-number-free candidate.
    }
  }
  return null;
}

export class FilePreviewStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly uploadRoot: string;
  private readonly grants = new Map<string, FilePreviewGrant>();
  private readonly tokensByPath = new Map<string, string>();

  constructor(options: FilePreviewStoreOptions) {
    this.uploadRoot = resolve(options.uploadRoot);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private prune() {
    const now = this.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt > now) continue;
      this.grants.delete(token);
      if (this.tokensByPath.get(grant.path) === token) this.tokensByPath.delete(grant.path);
    }
    while (this.grants.size > this.maxEntries) {
      const oldest = [...this.grants.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (!oldest) break;
      this.grants.delete(oldest[0]);
      if (this.tokensByPath.get(oldest[1].path) === oldest[0]) this.tokensByPath.delete(oldest[1].path);
    }
  }

  private async allowedRoots(cwd: string) {
    const roots: string[] = [];
    for (const path of [cwd, this.uploadRoot]) {
      try {
        roots.push(await realpath(resolve(path)));
      } catch {
        // A missing cwd or upload root cannot authorize a file.
      }
    }
    return roots;
  }

  private register(path: string, size: number): FilePreviewGrant {
    this.prune();
    const existingToken = this.tokensByPath.get(path);
    const token = existingToken && this.grants.has(existingToken) ? existingToken : randomBytes(24).toString("base64url");
    const url = `/api/files/${token}`;
    const grant: FilePreviewGrant = {
      path,
      url,
      downloadUrl: `${url}?download=1`,
      name: basename(path),
      kind: kindFor(path, size),
      size,
      expiresAt: this.now() + this.ttlMs,
    };
    this.grants.set(token, grant);
    this.tokensByPath.set(path, token);
    this.prune();
    return grant;
  }

  resolve(token: string) {
    this.prune();
    const grant = this.grants.get(token);
    if (!grant || grant.expiresAt <= this.now()) return null;
    return grant;
  }

  async prepareMarkdown(text: string, cwd: string) {
    const roots = await this.allowedRoots(cwd);
    if (!roots.length || !text.includes("](")) return { text, filePreviews: [] as FilePreviewDescriptor[] };

    const matches = [...text.matchAll(MARKDOWN_FILE_LINK)];
    if (!matches.length) return { text, filePreviews: [] as FilePreviewDescriptor[] };

    let offset = 0;
    let rewritten = text;
    const filePreviews: FilePreviewDescriptor[] = [];
    for (const match of matches) {
      if (match.index === undefined) continue;
      const candidate = localPathFromTarget(match[2], cwd);
      if (!candidate) continue;
      const file = await existingFile(candidate);
      if (!file || !roots.some((root) => inside(root, file.path))) continue;
      const grant = this.register(file.path, file.size);
      const replacement = `${match[1]}${grant.url}${match[3]}`;
      const start = match.index + offset;
      rewritten = `${rewritten.slice(0, start)}${replacement}${rewritten.slice(start + match[0].length)}`;
      offset += replacement.length - match[0].length;
      filePreviews.push({ url: grant.url, downloadUrl: grant.downloadUrl, name: grant.name, kind: grant.kind, size: grant.size });
    }
    return { text: rewritten, filePreviews };
  }

  async prepareThread(thread: CodexThread): Promise<CodexThread> {
    const turns = await Promise.all(thread.turns.map(async (turn) => ({
      ...turn,
      items: await Promise.all(turn.items.map(async (item): Promise<ThreadItem> => {
        if (item.type !== "agentMessage" || typeof item.text !== "string") return item;
        const prepared = await this.prepareMarkdown(item.text, thread.cwd);
        if (!prepared.filePreviews.length) return item;
        return { ...item, text: prepared.text, filePreviews: prepared.filePreviews };
      })),
    })));
    return { ...thread, turns };
  }
}

export function fileStillExists(grant: FilePreviewGrant) {
  return existsSync(grant.path);
}
