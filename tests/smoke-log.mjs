// 冒烟：纯 JS 解多帧 zstd 会话日志（不依赖 Python / zstandard）。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const root = mkdtempSync(join(tmpdir(), 'ril-log-'));
process.env.RIL_SESSIONS_ROOT = root;

const { decompressFrames, findSessionLog, readLogEvents, collectLogEvents } = await import('../lib/logzstd.mjs');

// 造三帧，模拟 DSH 的「一个 turn 一帧」
const sid = '5f1c2a3b-0000-4c4d-8e8f-1234567890ab';
const frames = [
  [{ type: 'session', data: { cwd: 'E:\\work' } }, { type: 'session/title', data: { title: '测试会话' } }],
  [{ type: 'turn/start', seq: 1, data: { turn: 1 } }, { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } }],
  [{ type: 'turn/start', seq: 4, data: { turn: 2 } },
    { type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二问' }] } },
    { type: 'assistant/message', seq: 6, data: { turn: 2, message: { content: [{ type: 'text', text: '第二答' }] } } },
    { type: 'turn/end', seq: 7, data: { turn: 2 } }],
];
const buf = Buffer.concat(frames.map((f) => zlib.zstdCompressSync(Buffer.from(f.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))));

const joined = decompressFrames(buf);
assert.match(joined, /第一问/);
assert.match(joined, /第二答/);
assert.equal(joined.split("\n").filter(Boolean).length, 9, '三帧共 9 条记录');

// 目录结构：<root>/<workspace>/session-<uuid>/session.v4.jsonl.zstd
const dir = join(root, '--E-work--', `session-${sid}`);
mkdirSync(dir, { recursive: true });
const file = join(dir, 'session.v4.jsonl.zstd');
writeFileSync(file, buf);

assert.equal(findSessionLog(sid), file, '应能按 sessionId 找到日志');
assert.equal(findSessionLog(`session-${sid}`), file, '带 session- 前缀也应能找');
assert.equal(findSessionLog('does-not-exist'), null);

const events = readLogEvents(file);
assert.equal(events.length, 9);
assert.equal(events[7].type, 'assistant/message');

const { analyzeEvents } = await import('../lib/extract.mjs');
const data = analyzeEvents(collectLogEvents(sid).events, { maxAnswers: 3 });
assert.equal(data.title, '测试会话');
assert.equal(data.prompts.length, 2);
assert.equal(data.answers.length, 1);
assert.equal(data.turns, 2);
assert.equal(data.lastTurn, 2);

const turn2 = analyzeEvents(collectLogEvents(sid).events, { turn: 2 });
assert.equal(turn2.prompts.length, 1);
assert.equal(turn2.answers.length, 1);

rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, events: events.length, prompts: data.prompts.length, answers: data.answers.length }));
