// 机器人绑定与凭据存储：~/.dsh/read-it-later/bots.json（权限 0600，只在本机）。
// 凭据只在本机 Host 内使用，RPC 一律返回 publicBot()（不含 secret/token）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const HOME = process.env.USERPROFILE ?? os.homedir();
const DIR = path.join(HOME, '.dsh', 'read-it-later');
const FILE = path.join(DIR, 'bots.json');

function emptyState() {
  return { version: 1, bots: [], defaultBotId: null };
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.bots)) return emptyState();
    return { version: 1, bots: raw.bots.filter((b) => b && typeof b.id === 'string'), defaultBotId: raw.defaultBotId ?? null };
  } catch {
    return emptyState();
  }
}

function writeState(state) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {}
}

export function newId(platform) {
  return `${platform}-${randomBytes(5).toString('hex')}`;
}

export function listBots() {
  return readState().bots;
}

export function getBot(id) {
  return listBots().find((b) => b.id === id) ?? null;
}

export function addBot(bot) {
  const state = readState();
  state.bots.push(bot);
  if (!state.defaultBotId) state.defaultBotId = bot.id;
  writeState(state);
  return bot;
}

export function updateBot(id, patch) {
  const state = readState();
  const bot = state.bots.find((b) => b.id === id);
  if (!bot) return null;
  Object.assign(bot, patch);
  writeState(state);
  return bot;
}

export function removeBot(id) {
  const state = readState();
  const before = state.bots.length;
  state.bots = state.bots.filter((b) => b.id !== id);
  if (state.defaultBotId === id) state.defaultBotId = state.bots[0]?.id ?? null;
  if (state.bots.length === before) return false;
  writeState(state);
  return true;
}

export function defaultBotId() {
  const state = readState();
  if (state.defaultBotId && state.bots.some((b) => b.id === state.defaultBotId)) return state.defaultBotId;
  return state.bots[0]?.id ?? null;
}

export function setDefaultBot(id) {
  const state = readState();
  if (!state.bots.some((b) => b.id === id)) return false;
  state.defaultBotId = id;
  writeState(state);
  return true;
}

/** 不给前端看凭据。 */
export function publicBot(bot) {
  if (!bot) return null;
  return {
    id: bot.id,
    platform: bot.platform,
    name: bot.name ?? '',
    detail: bot.platform === 'feishu'
      ? (bot.openId ? `open_id ${String(bot.openId).slice(0, 8)}…` : bot.appId ?? '')
      : (bot.ownerUserId ? `iLink ${String(bot.ownerUserId).slice(0, 8)}…` : ''),
    createdAt: bot.createdAt ?? null,
    lastSendAt: bot.lastSendAt ?? null,
    lastError: bot.lastError ?? null,
  };
}

export function markSend(id, error) {
  const patch = error
    ? { lastError: String(error).slice(0, 300) }
    : { lastSendAt: Date.now(), lastError: null };
  return updateBot(id, patch);
}

export function storeFile() {
  return FILE;
}
