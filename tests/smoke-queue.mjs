// 排队回归：同一时刻只放一条待选，答完自动晋升下一条。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ril-queue-'));
process.env.RIL_STATE_DIR = dir;
process.env.RIL_ASKS_FILE = path.join(dir, 'asks.json');

const asks = await import('../lib/asks.mjs');
const assert = (cond, message) => {
  if (!cond) {
    console.error('FAIL:', message);
    process.exit(1);
  }
};

const card = (n) => ({ sessionId: `s${n}`, title: `卡${n}`, turns: n, cwd: 'x', pending: { id: `a${n}`, questionId: `q${n}`, options: ['甲', '乙'] } });
const mk = (n) => ({ sessionId: `s${n}`, askId: `a${n}`, questionId: `q${n}`, title: `卡${n}`, options: ['甲', '乙'], at: Date.now(), card: card(n) });

const r1 = asks.enqueueAsk(mk(1));
assert(r1.active === true, '第一条应立刻成为待选');
const r2 = asks.enqueueAsk(mk(2));
assert(r2.active === false && r2.position === 1, '第二条应排队');
const r3 = asks.enqueueAsk(mk(3));
assert(r3.active === false && r3.position === 2, '第三条应排在第 2 位');
const dup = asks.enqueueAsk(mk(2));
assert(dup.duplicate === true, '重复入队应去重');

assert(asks.queuedCount() === 2, `排队数应为 2，实际 ${asks.queuedCount()}`);
assert(asks.matchAsk('2')?.ask.askId === 'a1', '只有当前 active 能匹配');
assert(asks.matchAsk('2')?.option === '乙', '序号 2 应对应「乙」');

const next1 = asks.completeAsk('s1', 'a1');
assert(next1?.askId === 'a2', '答完第一条后应晋升第二条');
assert(asks.activeAsk()?.askId === 'a2', 'active 应变成第二条');
assert(next1?.card?.title === '卡2', '晋升时要带上卡片信息');

const next2 = asks.completeAsk('s2', 'a2');
assert(next2?.askId === 'a3', '答完第二条后应晋升第三条');
const next3 = asks.completeAsk('s3', 'a3');
assert(next3 === null, '最后一条答完后不应再有下一条');
assert(asks.activeAsk() === null, '队列应清空');

const stale = asks.matchAsk('1');
assert(stale === null, '没有待选时不应匹配');

fs.rmSync(dir, { recursive: true, force: true });
console.log('smoke-queue: OK');
