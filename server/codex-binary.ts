import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type CodexBinaryRequirement = "app-server" | "queue";

function collectExecutables(directory: string, results: Array<{ path: string; mtime: number }>) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectExecutables(absolute, results);
    if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") {
      results.push({ path: absolute, mtime: statSync(absolute).mtimeMs });
    }
  }
}

export function queueHelpSupportsThread(output: string) {
  return /Usage:\s+codex queue\b/i.test(output) && /--thread\s+<THREAD>/i.test(output);
}

function supportsQueue(binary: string) {
  try {
    const output = execFileSync(binary, ["queue", "--help"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return queueHelpSupportsThread(output);
  } catch {
    return false;
  }
}

export function findCodexBinary(requirement: CodexBinaryRequirement = "app-server"): string {
  if (process.env.CODEX_BIN) {
    if (requirement === "queue" && !supportsQueue(process.env.CODEX_BIN)) {
      throw new Error("CODEX_BIN 指向的 Codex 版本不支持向电脑任务排队消息。请更新 Codex Desktop 后重新启动 OpenCodex Link。");
    }
    return process.env.CODEX_BIN;
  }
  if (process.platform !== "win32") return "codex";

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; set CODEX_BIN explicitly.");

  const root = join(localAppData, "OpenAI", "Codex", "bin");
  const candidates: Array<{ path: string; mtime: number }> = [];
  try {
    collectExecutables(root, candidates);
  } catch (error) {
    throw new Error(`Unable to inspect ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates[0]) throw new Error(`No codex.exe found under ${root}. Set CODEX_BIN explicitly.`);
  if (requirement === "queue") {
    const compatible = candidates.find((candidate) => supportsQueue(candidate.path));
    if (!compatible) {
      throw new Error("电脑上的 Codex 版本不支持向已打开任务排队消息。请更新 Codex Desktop 后重新启动 OpenCodex Link。");
    }
    return compatible.path;
  }
  return candidates[0].path;
}
