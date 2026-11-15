// 冒烟：Host 重启后把没等完的「预处理发送」接回来。
// 回归点：等待记录曾只存在内存 Map，DSH 一重启就丢 —— 用户点了「预处理发送」，
// 回来什么都没收到，状态还停在「等待中」。
//
// 这里不碰用户真实的 arms.json（用 RIL_ARMS_FILE 指到临时文件），也不发真消息：
//   - 一条「窗口内、但机器人已被删」→ 第一拍就该收尾成 error，证明真的重新盯上了；
//   - 一条「已过期」→ 直接标 timeout，而不是永远等待。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect } from '../lib/collect.mjs';

const HOME = process.env.USERPROFILE ?? os.homedir();
const TMP = path.join(process.cwd(), '.tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
const ARMS = path.join(TMP, 'arms-test.json');
process.env.RIL_ARMS_FILE = ARMS;

function listSessions() {
  const root = path.join(HOME, '.dsh', 'sessions');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ws of fs.readdirSync(root)) {
    const dir = path.join(root, ws);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('session-')) continue;
      const base = path.join(dir, name);
      const files = fs.readdirSync(base).filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f));
      for (const f of files) out.push({ id: name.replace(/^session-/, ''), size: fs.statSync(path.join(base, f)).size });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

let sessionId = null;
let data = null;
for (const cand of listSessions().slice(0, 40)) {
  const got = await collect({}, cand.id, { maxAnswers: 1, withLog: true });
  if (Number.isInteger(got.turns) && got.turns > 0) {
    sessionId = cand.id;
    data = got;
    break;
  }
}
if (!sessionId) {
  console.log('smoke-restore: SKIP（没有找到带 turn/end 的会话）');
  process.exit(0);
}

const now = Date.now();
fs.writeFileSync(ARMS, JSON.stringify({
  version: 1,
  arms: {
    [sessionId]: {
      sessionId,
      botId: 'bot-does-not-exist',
      include: { prompts: true, answers: true, files: true },
      baseline: data.turns - 1, // 比当前轮次少 1 → 第一拍就判定「有新的一轮」
      armLog: data.logFile,
      logSize: 0,
      startedAt: now,
      state: 'waiting',
      error: null,
      result: null,
    },
    'stale-session': {
      sessionId: 'stale-session',
      botId: 'bot-does-not-exist',
      include: { prompts: true, answers: true, files: true },
      baseline: 0,
      armLog: data.logFile,
      logSize: 0,
      startedAt: now - 3 * 60 * 60 * 1000, // 3 小时前，早已过期
      state: 'waiting',
      error: null,
      result: null,
    },
  },
}, null, 1));

const { restoreArms } = await import('../lib/rpc.mjs');
const result = await restoreArms({});
assert.equal(result.restored, 1, `应只接回 1 条窗口内的记录，实际 ${result.restored}`);

const saved = JSON.parse(fs.readFileSync(ARMS, 'utf8')).arms;
assert.equal(saved[sessionId]?.state, 'error', `窗口内那条应收尾成 error，实际 ${saved[sessionId]?.state}`);
assert.match(String(saved[sessionId]?.error || ''), /机器人已被移除/, `错误文案不对：${saved[sessionId]?.error}`);
assert.equal(saved['stale-session']?.state, 'timeout', `过期那条应标 timeout，实际 ${saved['stale-session']?.state}`);
assert.match(String(saved['stale-session']?.error || ''), /超时/, `超时文案不对：${saved['stale-session']?.error}`);

fs.rmSync(ARMS, { force: true });
console.log('smoke-restore:', { restored: result.restored, fresh: saved[sessionId]?.state, stale: saved['stale-session']?.state });
console.log('smoke-restore: OK');
