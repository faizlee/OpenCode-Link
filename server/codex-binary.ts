import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function collectExecutables(directory: string, results: Array<{ path: string; mtime: number }>) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectExecutables(absolute, results);
    if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") {
      results.push({ path: absolute, mtime: statSync(absolute).mtimeMs });
    }
  }
}

export function findCodexBinary(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
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
  return candidates[0].path;
}

