// 采集一个会话里要分享的内容：提示词、结果文本、生成的文件。
// 首选 Host 的 sessionQuery 服务（活会话优先、免子进程）；不可用时退回 python 解帧脚本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeEvents } from './extract.mjs';
import { collectLogEvents } from './logzstd.mjs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = path.join(HERE, '..', 'share-extract.py');
const HOME = process.env.USERPROFILE ?? os.homedir();

function textOfParts(parts) {
  const out = [];
  for (const p of parts ?? []) {
    if (p && p.type === 'text' && typeof p.text === 'string') out.push(p.text);
  }
  return out.join('\n').trim();
}

function contentOf(data, preferMessage) {
  if (!data || typeof data !== 'object') return '';
  const a = preferMessage ? data.message?.content : data.content ?? data.message?.content;
  const b = preferMessage ? data.content : undefined;
  return textOfParts(a) || textOfParts(b) || '';
}

function pathsFromToolCall(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  if (!['write', 'edit', 'present', 'save', 'ops_write'].includes(data.name)) return out;
  let args = data.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return out;
    }
  }
  if (!args || typeof args !== 'object') return out;
  if (typeof args.file_path === 'string') out.push(args.file_path);
  if (typeof args.path === 'string') out.push(args.path);
  for (const f of args.files ?? []) {
    if (f && typeof f.path === 'string') out.push(f.path);
  }
  return out;
}

export function pythonCandidates() {
  return [
    process.env.RIL_PYTHON,
    process.env.FEISHU_SHARE_PYTHON,
    path.join(HOME, '.dsh', 'asr', 'Scripts', 'python.exe'),
    'D:\\Python312\\python.exe',
    'python',
  ].filter(Boolean);
}

// 只用于打 zip（只用标准库 zipfile），不要求 zstandard。
export function pythonBin() {
  for (const c of pythonCandidates()) {
    if (c === 'python' || fs.existsSync(c)) return c;
  }
  return 'python';
}

function probeZstd(cmd) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, ['-c', 'import zstandard'], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

// 解会话日志必须能 import zstandard；挑第一个可用的解释器并缓存。
export async function pythonForExtract() {
  const G = (globalThis.__rilPy ??= { ready: null });
  if (G.ready) return G.ready;
  G.ready = (async () => {
    const tried = [];
    for (const c of pythonCandidates()) {
      if (c !== 'python' && !fs.existsSync(c)) continue;
      tried.push(c);
      if (await probeZstd(c)) return c;
    }
    const hint = tried[0] || 'python';
    throw new Error(
      `ril/py-missing: 这台机器的 Python 缺少 zstandard 模块（试过：${tried.join('、') || '无'}）。` +
        `修一行就好：${hint} -m pip install zstandard`,
    );
  })();
  G.ready.catch(() => {
    G.ready = null;
  });
  return G.ready;
}

async function runPython(sessionId, maxAnswers, { turn = null, seq = null } = {}, timeoutMs = 20000) {
  const extra = [];
  if (Number.isInteger(turn)) extra.push('--turn', String(turn));
  else if (Number.isInteger(seq)) extra.push('--seq', String(seq));
  const py = await pythonForExtract();
  return new Promise((resolve, reject) => {
    execFile(
      py,
      [PY_SCRIPT, '--session', sessionId, '--max-answers', String(maxAnswers), ...extra],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          let why = null;
          try {
            const j = JSON.parse(String(stdout || '').trim().split('\n').pop());
            if (j && j.error) why = String(j.error);
          } catch {}
          const detail = why || String(stderr || '').trim().slice(0, 400) || err.message;
          return reject(new Error(`share-extract failed: ${detail}`));
        }
        try {
          const j = JSON.parse(String(stdout).trim().split('\n').pop());
          if (j && j.error) return reject(new Error(String(j.error)));
          resolve(j);
        } catch (e) {
          reject(new Error('share-extract returned unparsable JSON'));
        }
      },
    );
  });
}

function sessionQueryOf(ctx) {
  try {
    return (ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null) ?? ctx?.sessionQuery ?? null;
  } catch {
    return null;
  }
}

// 首选路径：sessionQuery.readSession() 直接给完整事件数组（与落盘日志同构），
// 纯 JS 解析，不依赖 Python / zstandard，且活会话拿到的是最新事件。
async function collectViaLog(ctx, sessionId, { maxAnswers = 3, turn = null, seq = null } = {}) {
  const q = sessionQueryOf(ctx);
  if (!q || typeof q.readSession !== 'function') return null;
  const log = await q.readSession(sessionId);
  const events = log?.events;
  if (!Array.isArray(events) || !events.length) return null;
  const data = analyzeEvents(events, { maxAnswers, turn, seq });
  let title = data.title;
  if (!title && typeof q.readTitle === 'function') {
    try {
      const t = await q.readTitle(sessionId);
      if (typeof t === 'string' && t.trim()) title = t.trim();
    } catch {}
  }
  return {
    sessionId,
    title: title ?? null,
    cwd: data.cwd ?? log?.session?.cwd ?? null,
    turn: data.turn ?? null,
    turns: data.turns ?? null,
    lastTurn: data.lastTurn ?? null,
    openTurn: data.openTurn ?? null,
    prompts: data.prompts,
    answers: data.answers,
    files: data.files,
    logFile: null,
    source: 'sessionQuery-log',
  };
}

// 兜底路径：直接读落盘日志，自己按帧魔数解多帧 zstd（纯 JS）。
// 这样即使 sessionQuery 不可用、机器上也没有 Python / zstandard，照样能发。
function collectViaRawLog(sessionId, { maxAnswers = 3, turn = null, seq = null } = {}) {
  const { file, events } = collectLogEvents(sessionId);
  const data = analyzeEvents(events, { maxAnswers, turn, seq });
  return {
    sessionId,
    title: data.title ?? null,
    cwd: data.cwd ?? null,
    turn: data.turn ?? null,
    turns: data.turns ?? null,
    lastTurn: data.lastTurn ?? null,
    openTurn: data.openTurn ?? null,
    prompts: data.prompts,
    answers: data.answers,
    files: data.files,
    logFile: file,
    source: 'raw-log',
  };
}

async function collectViaService(ctx, sessionId, maxAnswers) {
  let q = null;
  try {
    q = (ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null) ?? ctx?.sessionQuery ?? null;
  } catch {
    q = null;
  }
  if (!q || typeof q.readSurface !== 'function') return null;

  const surface = await q.readSurface(sessionId);
  const events = surface?.events ?? [];

  let title = null;
  try {
    title = typeof q.readTitle === 'function' ? await q.readTitle(sessionId) : null;
  } catch {}

  const prompts = [];
  const answers = [];
  for (const ev of events) {
    if (ev.type === 'user/message') {
      const t = contentOf(ev.data, false);
      if (t && prompts[prompts.length - 1] !== t) prompts.push(t);
    } else if (ev.type === 'assistant/message') {
      const t = contentOf(ev.data, true);
      if (t) answers.push(t);
    }
  }

  const files = [];
  const seen = new Set();
  const push = (p) => {
    if (typeof p === 'string' && p && !seen.has(p)) {
      seen.add(p);
      files.push(p);
    }
  };
  try {
    const log = typeof q.readSession === 'function' ? await q.readSession(sessionId) : null;
    for (const ev of log?.events ?? []) {
      if (ev.type === 'deliverables/presented') {
        for (const f of ev.data?.files ?? []) if (f && typeof f.path === 'string') push(f.path);
      } else if (ev.type === 'tool/call') {
        for (const p of pathsFromToolCall(ev.data)) push(p);
      }
    }
  } catch {}

  return {
    sessionId,
    title,
    cwd: surface?.session?.cwd ?? null,
    prompts,
    answers: answers.slice(-Math.max(1, maxAnswers)),
    files,
    source: 'sessionQuery',
  };
}

/**
 * 采集会话分享内容。
 * @returns {Promise<{sessionId:string,title:string|null,cwd:string|null,prompts:string[],answers:string[],files:string[],source:string}>}
 */
export async function collect(ctx, sessionId, { maxAnswers = 3, turn = null, seq = null, withLog = false } = {}) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('missing sessionId');
  // DOM 上的 data-conversation-session 形如 "session-<uuid>"，日志目录只认 <uuid>
  const sid = sessionId.replace(/^session-/, '');
  sessionId = sid;
  const scoped = Number.isInteger(turn) || Number.isInteger(seq);
  const reasons = [];
  try {
    const viaLog = await collectViaLog(ctx, sessionId, { maxAnswers, turn, seq });
    if (viaLog) return viaLog;
    reasons.push('sessionQuery 没有返回事件');
  } catch (err) {
    reasons.push(`sessionQuery 不可用：${err?.message ?? err}`);
  }
  // 落盘日志兜底：纯 JS 解多帧 zstd，不需要 Python。
  try {
    return collectViaRawLog(sessionId, { maxAnswers, turn, seq });
  } catch (err) {
    reasons.push(`读会话日志失败：${err?.message ?? err}`);
  }
  // withLog：需要 turns / lastTurn / logFile 的场景（如预处理自动回传）必须走 python 解帧，
  // sessionQuery 服务只给 events 快照，没有轮次计数与日志路径。
  if (!scoped && !withLog) {
    try {
      const viaService = await collectViaService(ctx, sessionId, maxAnswers);
      if (viaService) return viaService;
    } catch {}
  }
  let py;
  try {
    py = await runPython(sessionId, maxAnswers, { turn, seq });
  } catch (err) {
    const message = String(err?.message ?? err);
    const detail = reasons.length ? `（${reasons.join('；')}）` : '';
    const wrapped = new Error(message.includes(detail) ? message : message + detail);
    wrapped.code = err?.code;
    throw wrapped;
  }
  return {
    sessionId: py.sessionId,
    title: py.title ?? null,
    cwd: py.cwd ?? null,
    turn: py.turn ?? null,
    turns: py.turns ?? null,
    lastTurn: py.lastTurn ?? null,
    logFile: py.logFile ?? null,
    prompts: py.prompts ?? [],
    answers: py.answers ?? [],
    files: py.files ?? [],
    source: 'python',
  };
}
