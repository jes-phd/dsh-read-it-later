// 记录「等待你决定」的提问，供飞书里的文字回复 / 按钮点选回填用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = process.env.RIL_STATE_DIR || path.join(os.homedir(), '.dsh', 'read-it-later');
const FILE = process.env.RIL_ASKS_FILE || path.join(DIR, 'asks.json');
const MAX_ASKS = 20;
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const asks = Array.isArray(raw) ? raw : raw?.asks;
    return Array.isArray(asks) ? asks.filter((ask) => ask && ask.sessionId && ask.askId) : [];
  } catch {
    return [];
  }
}

function write(asks) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, asks }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch {
    /* 状态文件写不进去不影响主流程 */
  }
}

/** 记一条等待中的提问（同一会话同一 askId 只保留一条）。 */
export function recordAsk(ask) {
  const entry = {
    sessionId: String(ask.sessionId),
    askId: String(ask.askId),
    questionId: ask.questionId ? String(ask.questionId) : '',
    title: ask.title || '',
    text: ask.text || '',
    kind: ask.kind || 'question',
    options: Array.isArray(ask.options) ? ask.options.map(String) : [],
    at: Number(ask.at) || Date.now(),
  };
  const rest = read().filter((item) => !(item.sessionId === entry.sessionId && item.askId === entry.askId));
  write([...rest, entry].slice(-MAX_ASKS));
}

/** 提问已经答完（或会话推进了）就清掉。 */
export function clearAsk(sessionId, askId) {
  const rest = read().filter((item) => !(item.sessionId === sessionId && (!askId || item.askId === askId)));
  write(rest);
}

/** 最近的若干条等待中的提问（新的在后）。 */
export function recentAsks(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const now = Date.now();
  return read().filter((item) => now - item.at <= maxAgeMs);
}

/**
 * 从一句文字回复里解析出选择。
 * 支持「1」「2」「3」这类序号，也支持直接回选项原文（可带前缀，如「选 1」）。
 */
export function matchAsk(text, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const asks = recentAsks(maxAgeMs);
  if (!asks.length) return null;
  const body = String(text || '').trim();
  if (!body) return null;
  const num = body.match(/^(?:选|选择|answer)?\s*([1-9])\s*(?:\.|、|\)|）)?$/i);
  const lower = body.toLowerCase();
  for (let i = asks.length - 1; i >= 0; i -= 1) {
    const ask = asks[i];
    const options = ask.options;
    if (num) {
      const index = Number(num[1]) - 1;
      if (index >= 0 && index < options.length) return { ask, option: options[index] };
      continue;
    }
    const hit = options.find((option) => option.toLowerCase() === lower);
    if (hit) return { ask, option: hit };
    const loose = options.find((option) => lower.length >= 1 && (option.toLowerCase().includes(lower) || lower.includes(option.toLowerCase())));
    if (loose && loose.length > 1) return { ask, option: loose };
  }
  return null;
}

export const ASKS_FILE = FILE;
