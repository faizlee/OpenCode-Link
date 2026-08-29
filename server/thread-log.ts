import { createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CodexThread, ThreadItem, Turn } from "./protocol.js";

const THREAD_ID = /^[0-9a-f-]{20,}$/i;
const MAX_VISIBLE_TURNS = 200;

interface CachedHistory {
  path: string;
  offset: number;
  remainder: string;
  turns: Map<string, Turn>;
  turnOrder: string[];
  updatedAt: number;
  lastDiscoveryAt: number;
}

interface ReadOptions {
  codexHome?: string;
  now?: () => number;
  rediscoveryIntervalMs?: number;
}

const cache = new Map<string, CachedHistory>();
const inflight = new Map<string, Promise<CachedHistory | null>>();
const ROLLOUT_REDISCOVERY_INTERVAL_MS = 15_000;

function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function historyKey(threadId: string, codexHome: string) {
  return `${codexHome}\0${threadId}`;
}

function historyRevision(history: CachedHistory | null) {
  return history ? `${history.path}\0${history.offset}\0${history.remainder.length}` : null;
}

async function firstJsonLine(path: string) {
  // session_meta can be larger than 32KB because it contains the task's
  // instruction snapshot. Read through its real newline instead of assuming a
  // fixed header size.
  const stream = createReadStream(path, { encoding: "utf8", start: 0 });
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(0, newline).trim();
  }
  return text.trim();
}

async function findRollout(root: string, threadId: string): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (directory: string) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
        matches.push(absolute);
      }
    }));
  };
  await visit(root);
  return matches;
}

async function locateRollout(threadId: string, codexHome: string) {
  if (!THREAD_ID.test(threadId)) return null;
  const candidates = [
    ...await findRollout(join(codexHome, "sessions"), threadId),
    ...await findRollout(join(codexHome, "archived_sessions"), threadId),
  ];

  const matches = await Promise.all(candidates.map(async (path) => {
    try {
      const first = JSON.parse(await firstJsonLine(path)) as { type?: string; payload?: { id?: string } };
      if (first.type !== "session_meta" || first.payload?.id !== threadId) return null;
      return { path, modifiedAt: (await stat(path)).mtimeMs };
    } catch {
      // Ignore unrelated or partially-written candidates.
      return null;
    }
  }));

  return matches
    .filter((match): match is { path: string; modifiedAt: number } => Boolean(match))
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path))[0]?.path ?? null;
}

function cleanUserText(input: string) {
  let text = input.replace(/<in-app-browser-context\b[\s\S]*?<\/in-app-browser-context>/gi, "").trim();
  text = text
    .replace(/^<recommended_plugins>[\s\S]*?<\/recommended_plugins>\s*/i, "")
    .replace(/^# AGENTS\.md instructions\s*[\s\S]*?<\/environment_context>\s*/i, "")
    .trim();
  const requestMarker = "## My request:";
  const markerIndex = text.lastIndexOf(requestMarker);
  if (markerIndex >= 0) {
    const request = text.slice(markerIndex + requestMarker.length).trim();
    if (request) text = request;
  }
  text = text
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "")
    .replace(/^# Files mentioned by the user:[\s\S]*?(?=\n## |$)/gim, "")
    .trim();
  return text;
}

function textParts(content: unknown, role: "user" | "assistant") {
  if (!Array.isArray(content)) return [];
  const wanted = role === "user" ? "input_text" : "output_text";
  return content
    .filter((part): part is { type: string; text: string } => Boolean(part && typeof part === "object" && (part as { type?: string }).type === wanted && typeof (part as { text?: unknown }).text === "string"))
    .map((part) => part.text);
}

function imageCount(content: unknown) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part && typeof part === "object" && ["input_image", "image", "local_image"].includes(String((part as { type?: string }).type))).length;
}

function turnFor(history: CachedHistory, turnId: string, timestamp: number) {
  let turn = history.turns.get(turnId);
  if (!turn) {
    turn = {
      id: turnId,
      items: [],
      status: "completed",
      error: null,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: null,
    };
    history.turns.set(turnId, turn);
    history.turnOrder.push(turnId);
  } else {
    turn.completedAt = Math.max(turn.completedAt ?? timestamp, timestamp);
  }
  return turn;
}

function upsertItem(turn: Turn, item: ThreadItem) {
  const index = item.id ? turn.items.findIndex((candidate) => candidate.id === item.id) : -1;
  if (index >= 0) turn.items[index] = item;
  else turn.items.push(item);
}

function latestUserPreview(turns: Turn[]) {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex].items;
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item.type !== "userMessage") continue;
      const text = item.content?.find((part) => part.type === "text")?.text;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  return null;
}

function consumeLine(history: CachedHistory, rawLine: string) {
  if (!rawLine.includes('"type":"response_item"') || !rawLine.includes('"type":"message"')) return;
  try {
    // Desktop may persist image data URLs in the same JSONL line as the text.
    // The phone only needs an image count, so discard the binary payload before parsing.
    const line = rawLine.replace(/"image_url":"data:[^"]*"/g, '"image_url":"data:omitted"');
    const record = JSON.parse(line) as {
      timestamp?: string;
      payload?: {
        type?: string;
        id?: string;
        role?: string;
        phase?: string;
        content?: unknown;
        internal_chat_message_metadata_passthrough?: { turn_id?: string };
      };
    };
    const payload = record.payload;
    if (record.payload?.type !== "message" || (payload?.role !== "user" && payload?.role !== "assistant")) return;
    const timestamp = Math.floor((Date.parse(record.timestamp ?? "") || Date.now()) / 1000);
    const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id || `turn-${timestamp}`;
    const turn = turnFor(history, turnId, timestamp);

    if (payload.role === "user") {
      const text = cleanUserText(textParts(payload.content, "user").join("\n"));
      const images = imageCount(payload.content);
      if (!text && !images) return;
      const content: Array<Record<string, unknown>> = text ? [{ type: "text", text }] : [];
      for (let index = 0; index < images; index += 1) content.push({ type: "image" });
      upsertItem(turn, { type: "userMessage", id: payload.id, content });
    } else {
      const text = textParts(payload.content, "assistant").join("\n").trim();
      if (!text) return;
      upsertItem(turn, { type: "agentMessage", id: payload.id, text, phase: payload.phase ?? null });
    }
    history.updatedAt = Math.max(history.updatedAt, timestamp);
  } catch {
    // A concurrently-written or unknown record is ignored and retried once its
    // terminating newline arrives on the next incremental read.
  }
}

async function readNewBytes(history: CachedHistory) {
  const info = await stat(history.path);
  if (info.size < history.offset) {
    history.offset = 0;
    history.remainder = "";
    history.turns.clear();
    history.turnOrder = [];
    history.updatedAt = 0;
  }
  if (info.size === history.offset) return history;

  const decoder = new StringDecoder("utf8");
  const stream = createReadStream(history.path, { start: history.offset, end: info.size - 1 });
  let pending = history.remainder;
  for await (const chunk of stream) {
    pending += decoder.write(chunk as Buffer);
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) consumeLine(history, line);
    }
  }
  pending += decoder.end();
  history.remainder = pending;
  history.offset = info.size;
  return history;
}

function emptyHistory(path: string, discoveredAt: number): CachedHistory {
  return {
    path,
    offset: 0,
    remainder: "",
    turns: new Map(),
    turnOrder: [],
    updatedAt: 0,
    lastDiscoveryAt: discoveredAt,
  };
}

async function loadHistory(threadId: string, codexHome: string, options: ReadOptions) {
  const now = options.now?.() ?? Date.now();
  const rediscoveryIntervalMs = options.rediscoveryIntervalMs ?? ROLLOUT_REDISCOVERY_INTERVAL_MS;
  const key = historyKey(threadId, codexHome);
  let history = cache.get(key);
  if (history) {
    try {
      await access(history.path);
    } catch {
      cache.delete(key);
      history = undefined;
    }
  }
  if (history && now - history.lastDiscoveryAt >= rediscoveryIntervalMs) {
    const latestPath = await locateRollout(threadId, codexHome);
    if (latestPath && latestPath !== history.path) {
      history = emptyHistory(latestPath, now);
      cache.set(key, history);
    } else {
      history.lastDiscoveryAt = now;
    }
  }
  if (!history) {
    const path = await locateRollout(threadId, codexHome);
    if (!path) return null;
    history = emptyHistory(path, now);
    cache.set(key, history);
  }
  return readNewBytes(history);
}

async function readHistory(threadId: string, codexHome: string, options: ReadOptions) {
  const key = historyKey(threadId, codexHome);
  let pending = inflight.get(key);
  if (!pending) {
    pending = loadHistory(threadId, codexHome, options).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

export async function hydrateThreadFromDesktopLog(thread: CodexThread, options: ReadOptions = {}): Promise<CodexThread> {
  const codexHome = options.codexHome ?? defaultCodexHome();
  const history = await readHistory(thread.id, codexHome, options);
  if (!history?.turnOrder.length) return thread;

  const turns = history.turnOrder
    .slice(-MAX_VISIBLE_TURNS)
    .map((turnId) => history.turns.get(turnId))
    .filter((turn): turn is Turn => Boolean(turn));
  const last = turns.at(-1);
  if (last && thread.status.type === "active") {
    last.status = "inProgress";
    last.completedAt = null;
  }
  return {
    ...thread,
    preview: latestUserPreview(turns) ?? thread.preview,
    updatedAt: Math.max(thread.updatedAt, history.updatedAt),
    turns,
  };
}

export async function refreshThreadLogRevision(threadId: string, options: ReadOptions = {}) {
  const codexHome = options.codexHome ?? defaultCodexHome();
  return historyRevision(await readHistory(threadId, codexHome, options));
}

export function currentThreadLogRevision(threadId: string, options: Pick<ReadOptions, "codexHome"> = {}) {
  const codexHome = options.codexHome ?? defaultCodexHome();
  return historyRevision(cache.get(historyKey(threadId, codexHome)) ?? null);
}

export function clearThreadLogCache() {
  cache.clear();
}
