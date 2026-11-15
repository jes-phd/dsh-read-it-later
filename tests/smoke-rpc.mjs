// 冒烟：预存提示词（preset.*）与自动回传（auto.*）走真实 RPC 协议。
// 会话读取依赖 python + 日志，若本机没有对应会话会跳过 share/auto 的用例。
import assert from 'node:assert/strict';
import { mountRpc } from '../lib/rpc.mjs';

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
assert.ok(handler, 'rpc handler not registered');

let seq = 0;
async function call(method, payload = {}) {
  const rpcId = `smoke-${++seq}`;
  const req = new Request('http://127.0.0.1/api/read-it-later', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'read-it-later', payload: { method, payload } }),
  });
  const json = await (await handler(req)).json();
  assert.equal(json.rpcId, rpcId, 'rpcId mismatch');
  return json.result;
}

// 1. 预设：默认 3 条 → 新增 → 修改 → 删除
const list0 = await call('preset.list');
assert.equal(list0.ok, true);
assert.ok(list0.value.presets.length >= 3, `默认应至少 3 条，实际 ${list0.value.presets.length}`);
console.log('preset.list:', list0.value.presets.map((p) => p.text.slice(0, 14)));

const saved = await call('preset.save', { text: '冒烟测试用的临时提示词' });
assert.equal(saved.ok, true);
const added = saved.value.presets.find((p) => p.text === '冒烟测试用的临时提示词');
assert.ok(added, '新增的预设没出现在列表里');

const renamed = await call('preset.save', { id: added.id, text: '冒烟测试用的临时提示词（已改）' });
assert.ok(renamed.value.presets.some((p) => p.id === added.id && p.text.endsWith('（已改）')), '更新预设失败');

const removed = await call('preset.delete', { id: added.id });
assert.ok(!removed.value.presets.some((p) => p.id === added.id), '删除预设失败');

const empty = await call('preset.save', { text: '   ' });
assert.equal(empty.ok, false);
assert.equal(empty.error.code, 'ril/bad-preset');

// 2. 自动回传：未绑定机器人时给出明确错误；没有任何 arm 时 status 是 idle
const status = await call('auto.status', { sessionId: 'session-00000000-0000-0000-0000-000000000000' });
assert.deepEqual(status, { ok: true, value: { armed: false, state: 'idle' } });

const armNoBot = await call('auto.arm', { sessionId: 'session-x' });
assert.equal(armNoBot.ok, false);
assert.ok(['ril/no-bot', 'ril/collect-failed'].includes(armNoBot.error.code), `意外错误 ${armNoBot.error.code}`);

const cancel = await call('auto.cancel', { sessionId: 'session-x' });
assert.equal(cancel.ok, true);

console.log('smoke-rpc: OK');
