// 采集一个会话里要分享的内容：提示词、结果文本、生成的文件。
// 首选 Host 的 sessionQuery 服务（活会话优先、免子进程）；不可用时退回 python 解帧脚本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export function pythonBin() {
  const cand = [
    process.env.FEISHU_SHARE_PYTHON,
    path.join(HOME, '.dsh', 'asr', 'Scripts', 'python.exe'),
    'D:\\Python312\\python.exe',
    'python',
  ].filter(Boolean);
  for (const c of cand) {
    if (c === 'python' || fs.existsSync(c)) return c;
  }
  return 'python';
}

function runPython(sessionId, maxAnswers, { turn = null, seq = null } = {}, timeoutMs = 20000) {
  const extra = [];
  if (Number.isInteger(turn)) extra.push('--turn', String(turn));
  else if (Number.isInteger(seq)) extra.push('--seq', String(seq));
  return new Promise((resolve, reject) => {
    execFile(
      pythonBin(),
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
  // withLog：需要 turns / lastTurn / logFile 的场景（如预处理自动回传）必须走 python 解帧，
  // sessionQuery 服务只给 events 快照，没有轮次计数与日志路径。
  if (!scoped && !withLog) {
    try {
      const viaService = await collectViaService(ctx, sessionId, maxAnswers);
      if (viaService) return viaService;
    } catch {}
  }
  const py = await runPython(sessionId, maxAnswers, { turn, seq });
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
