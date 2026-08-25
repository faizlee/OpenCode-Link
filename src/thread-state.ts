import type { CodexThread, ThreadItem, Turn } from "./types";

function upsertItem(items: ThreadItem[], item: ThreadItem) {
  if (!item.id) return [...items, item];
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = { ...next[index], ...item };
  return next;
}

function upsertTurn(turns: Turn[], turn: Turn) {
  const index = turns.findIndex((candidate) => candidate.id === turn.id);
  if (index < 0) return [...turns, turn];
  const next = [...turns];
  next[index] = { ...next[index], ...turn, items: turn.items.length ? turn.items : next[index].items };
  return next;
}

function ensureTurn(turns: Turn[], turnId: string) {
  if (turns.some((turn) => turn.id === turnId)) return turns;
  return [...turns, {
    id: turnId,
    items: [],
    status: "inProgress",
    error: null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    durationMs: null,
  }];
}

export function applyThreadEvent(thread: CodexThread, method: string, params: Record<string, unknown>): CodexThread {
  if (params.threadId && params.threadId !== thread.id) return thread;
  let turns = thread.turns;

  if (method === "turn/started") {
    const turn = params.turn as Turn;
    turns = upsertTurn(turns, turn);
  } else if (method === "turn/completed") {
    const turn = params.turn as Turn;
    turns = upsertTurn(turns, turn);
  } else if (method === "item/started" || method === "item/completed") {
    const turnId = String(params.turnId);
    const item = params.item as ThreadItem;
    turns = ensureTurn(turns, turnId).map((turn) => turn.id === turnId ? { ...turn, items: upsertItem(turn.items, item) } : turn);
  } else if (method === "item/agentMessage/delta") {
    const turnId = String(params.turnId);
    const itemId = String(params.itemId);
    const delta = String(params.delta ?? "");
    turns = ensureTurn(turns, turnId).map((turn) => {
      if (turn.id !== turnId) return turn;
      const existing = turn.items.find((item) => item.id === itemId);
      const item: ThreadItem = existing
        ? { ...existing, text: `${existing.text ?? ""}${delta}` }
        : { type: "agentMessage", id: itemId, text: delta };
      return { ...turn, items: upsertItem(turn.items, item) };
    });
  }

  return { ...thread, turns };
}

export function activeTurnId(thread: CodexThread | null) {
  if (!thread) return null;
  return [...thread.turns].reverse().find((turn) => turn.status === "inProgress")?.id ?? null;
}

