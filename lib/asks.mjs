// 记录「等待你决定」的提问，供飞书里的文字回复回填用。
//
// 同一时刻**只有一条**待选：第一张卡发出去以后，后面检测到的提问都进 queue，
// 等上一条答完再自动发下一条，避免一次涌好几张卡片让人挑花眼。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = process.env.RIL_STATE_DIR || path.join(os.homedir(), '.dsh', 'read-it-later');
const FILE = process.env.RIL_ASKS_FILE || path.join(DIR, 'asks.json');
const MAX_QUEUE = 20;
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function normalize(ask) {
  if (!ask || !ask.sessionId || !ask.askId) return null;
  return {
    sessionId: String(ask.sessionId),
    askId: String(ask.askId),
    questionId: ask.questionId ? String(ask.questionId) : '',
    title: ask.title || '',
    text: ask.text || '',
    kind: ask.kind || 'question',
    options: Array.isArray(ask.options) ? ask.options.map(String) : [],
    at: Number(ask.at) || Date.now(),
    // 轮到它时用来重画卡片（会话标题/轮次/工作区/问题）
    card: ask.card && typeof ask.card === 'object' ? ask.card : null,
  };
}

function readState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { active: null, queue: [] };
  }
  // 兼容旧格式 { asks: [...] }：把最后一条当 active，其余进 queue
  if (Array.isArray(raw?.asks)) {
    const list = raw.asks.map(normalize).filter(Boolean);
    return { active: list.at(-1) ?? null, queue: list.slice(0, -1).slice(-MAX_QUEUE) };
  }
  const active = normalize(raw?.active);
  const queue = Array.isArray(raw?.queue) ? raw.queue.map(normalize).filter(Boolean).slice(-MAX_QUEUE) : [];
  return { active, queue };
}

function write(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, active: state.active, queue: state.queue }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch {
    /* 状态文件写不进去不影响主流程 */
  }
}

const sameAs = (a, b) => a && b && a.sessionId === b.sessionId && a.askId === b.askId;

/**
 * 收到一个待决定事项：
 * - 当前没有待选 → 立刻成为 active（调用方应当发卡片）
 * - 已经有待选 → 排队，等前一条答完再发
 * 返回 { active: boolean, position: number, duplicate: boolean }
 */
export function enqueueAsk(ask) {
  const entry = normalize(ask);
  if (!entry) return { active: false, position: 0, duplicate: true };
  const state = readState();
  if (sameAs(state.active, entry)) return { active: false, position: 0, duplicate: true };
  if (state.queue.some((item) => sameAs(item, entry))) {
    return { active: false, position: state.queue.findIndex((item) => sameAs(item, entry)) + 1, duplicate: true };
  }
  if (!state.active) {
    write({ active: entry, queue: state.queue });
    return { active: true, position: 0, duplicate: false };
  }
  const queue = [...state.queue, entry].slice(-MAX_QUEUE);
  write({ active: state.active, queue });
  return { active: false, position: queue.length, duplicate: false };
}

/** 当前唯一的待选（没有则 null）。 */
export function activeAsk() {
  return readState().active;
}

/**
 * 一条待选已经答完（或作废）：把它从 active/queue 移除，并晋升下一条。
 * 返回刚被晋升的题干（调用方负责发卡片），没有就返回 null。
 */
export function completeAsk(sessionId, askId) {
  const state = readState();
  let { active, queue } = state;
  if (sameAs(active, { sessionId, askId })) active = null;
  queue = queue.filter((item) => !sameAs(item, { sessionId, askId }));
  let promoted = null;
  if (!active && queue.length) {
    promoted = queue.shift();
    active = promoted;
  }
  write({ active, queue });
  return promoted;
}

/** 兼容旧接口：recordAsk 等价于 enqueueAsk（返回是否成为当前待选）。 */
export const recordAsk = (ask) => enqueueAsk(ask);

/** 兼容旧接口：清掉某条待选（内部转调 completeAsk）。 */
export function clearAsk(sessionId, askId) {
  completeAsk(sessionId, askId);
}

/** 全部待选（active 在最前，其后是排队）。 */
export function recentAsks(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const now = Date.now();
  const state = readState();
  const all = [state.active, ...state.queue].filter(Boolean);
  return all.filter((item) => now - item.at <= maxAgeMs);
}

/** 排队里还有几条（不含 active）。 */
export function queuedCount() {
  return readState().queue.length;
}

/**
 * 从一句文字回复里解析出选择。
 * 只和**当前 active 那一条**比对，避免好几张卡片同时在等时匹配错卡。
 * 支持「1」「2」「3」这类序号，也支持直接回选项原文（可带前缀，如「选 1」）。
 */
export function matchAsk(text, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const ask = activeAsk();
  if (!ask) return null;
  if (Date.now() - ask.at > maxAgeMs) return null;
  const body = String(text || '').trim();
  if (!body) return null;
  const num = body.match(/^(?:选|选择|answer)?\s*([1-9])\s*(?:\.|、|\)|）)?$/i);
  const lower = body.toLowerCase();
  if (num) {
    const index = Number(num[1]) - 1;
    if (index >= 0 && index < ask.options.length) return { ask, option: ask.options[index] };
    return null;
  }
  const exact = ask.options.find((option) => option.toLowerCase() === lower);
  if (exact) return { ask, option: exact };
  const loose = ask.options.find(
    (option) => lower.length >= 1 && (option.toLowerCase().includes(lower) || lower.includes(option.toLowerCase())),
  );
  if (loose && loose.length > 1) return { ask, option: loose };
  return null;
}

export const ASKS_FILE = FILE;
