// 冒烟：预处理自动回传的「基线」必须来自日志轮次（turns），而不是 undefined。
// 回归点：collect 默认走 sessionQuery 服务，那里没有 turns / logFile，
// 曾导致 auto.arm 的 baseline 恒为 0、tickArm 永远判断不出新一轮。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountRpc } from '../lib/rpc.mjs';
import { collect } from '../lib/collect.mjs';

const HOME = process.env.USERPROFILE ?? os.homedir();

/** 按日志大小从大到小列出会话，优先挑「跑过若干轮」的那个。 */
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
  console.log('smoke-auto: SKIP（没有找到带 turn/end 的会话）');
  process.exit(0);
}

// 1. withLog 必须带回 turns / lastTurn / logFile
assert.ok(Number.isInteger(data.turns) && data.turns > 0, `withLog 应返回正整数 turns，实际 ${data.turns}`);
assert.ok(Number.isInteger(data.lastTurn) || data.lastTurn === null, 'lastTurn 类型异常');
assert.ok(typeof data.logFile === 'string' && fs.existsSync(data.logFile), `logFile 不存在：${data.logFile}`);
console.log('collect(withLog):', { turns: data.turns, lastTurn: data.lastTurn, title: data.title });

// 2. 没有 withLog 时不该误以为有 turns（服务路径）
const plain = await collect({}, sessionId, { maxAnswers: 1 });
if (plain.source === 'sessionQuery') {
  assert.equal(plain.turns, undefined, 'sessionQuery 路径不应该出现 turns');
}

// 3. auto.arm 的 baseline 必须等于当前轮次
let handler = null;
const ctx = {
  connection: {
    fetch: {
      register(spec) {
        handler = spec.fetch;
        return () => {};
      },
    },
  },
};
mountRpc(ctx);

let seq = 0;
async function call(method, payload = {}) {
  const rpcId = `auto-${++seq}`;
  const req = new Request('http://127.0.0.1/api/read-it-later', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'read-it-later', payload: { method, payload } }),
  });
  const json = await (await handler(req)).json();
  return json.result;
}

const bots = (await call('status')).value?.bots ?? [];
if (!bots.length) {
  console.log('smoke-auto: SKIP arm（还没有绑定机器人）');
  console.log('smoke-auto: OK');
  process.exit(0);
}

const armed = await call('auto.arm', { sessionId, botId: bots[0].id });
assert.equal(armed.ok, true, `auto.arm 失败：${JSON.stringify(armed)}`);
assert.equal(armed.value.baseline, data.turns, `baseline 应等于日志轮次 ${data.turns}，实际 ${armed.value.baseline}`);

const status = await call('auto.status', { sessionId });
assert.equal(status.value.armed, true, 'arm 之后 status 应显示 armed');
assert.equal(status.value.baseline, data.turns);

await call('auto.cancel', { sessionId });
console.log('smoke-auto: OK');
