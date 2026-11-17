// 纯 JS 读会话日志：DSH 把会话写成「多帧 zstd」的 jsonl（一个 turn 一帧）。
// Node 的 zlib.zstdDecompressSync 只吃单帧，所以这里自己按帧魔数切开、逐帧解压再拼起来，
// 这样即使机器上没有 Python / zstandard，也能读到会话记录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HOME = process.env.USERPROFILE ?? os.homedir();
const SESSIONS_ROOT = process.env.RIL_SESSIONS_ROOT ?? path.join(HOME, '.dsh', 'sessions');

function magicOffsets(buf) {
  const offsets = [];
  let at = buf.indexOf(MAGIC);
  while (at !== -1) {
    offsets.push(at);
    at = buf.indexOf(MAGIC, at + MAGIC.length);
  }
  return offsets;
}

// 从 s 开始的这一帧可能被内部假魔数切断，所以失败时把结束点往后挪到下一个魔数再试。
function decodeFrameAt(buf, offsets, index) {
  const start = offsets[index];
  const limit = Math.min(offsets.length, index + 6);
  for (let j = index + 1; j <= limit; j += 1) {
    const end = j < offsets.length ? offsets[j] : buf.length;
    try {
      return { text: zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'), next: j };
    } catch {
      // 继续试下一个切分点
    }
  }
  return null;
}

export function decompressFrames(buf) {
  const offsets = magicOffsets(buf);
  if (!offsets.length) throw new Error('not a zstd stream');
  const chunks = [];
  let i = 0;
  while (i < offsets.length) {
    const frame = decodeFrameAt(buf, offsets, i);
    if (!frame) {
      // 这一段彻底解不开：跳到下一个魔数继续，宁可少一点也不要整份失败。
      i += 1;
      continue;
    }
    chunks.push(frame.text);
    i = frame.next;
  }
  return chunks.join('');
}

// 会话日志路径：<sessions>/<workspace>/session-<uuid>/session.v<N>.jsonl.zstd
export function findSessionLog(sessionId) {
  const sid = String(sessionId ?? '').replace(/^session-/, '');
  if (!sid) return null;
  const wanted = `session-${sid}`;
  let best = null;
  const stack = [SESSIONS_ROOT];
  let guard = 0;
  while (stack.length && guard < 20000) {
    guard += 1;
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === wanted) {
        let files;
        try {
          files = fs.readdirSync(full).filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f) || f.endsWith('.jsonl.zstd'));
        } catch {
          continue;
        }
        for (const f of files) {
          const file = path.join(full, f);
          let size = 0;
          try {
            size = fs.statSync(file).size;
          } catch {
            continue;
          }
          if (!best || size > best.size) best = { file, size };
        }
        continue;
      }
      stack.push(full);
    }
  }
  return best ? best.file : null;
}

export function readLogEvents(file) {
  const buf = fs.readFileSync(file);
  const text = decompressFrames(buf);
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 半行（进程被杀时可能出现）直接跳过
    }
  }
  return events;
}

// 只要有日志文件就能读，不依赖 Python。
export function collectLogEvents(sessionId) {
  const file = findSessionLog(sessionId);
  if (!file) throw new Error(`session-log-not-found: ${sessionId}`);
  return { file, events: readLogEvents(file) };
}
