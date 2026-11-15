// 冒烟：状态监控的扫描器 + RPC 状态。
//
// 用一份合成的会话日志（临时 USERPROFILE，不碰真实会话）验证三件事：
//   1. 「提问卡住」能被识别，并带回选项；
//   2. 提问被回答（tool/result）之后不再算卡住；
//   3. 关着监控时 monitor.status 明确说 enabled:false。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PY = process.env.RIL_PYTHON
  || path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'asr', 'Scripts', 'python.exe');
const ROOT = path.join(process.cwd(), '.tmp', 'monitor-test');
const HOME = path.join(ROOT, 'home');
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOG_DIR = path.join(HOME, '.dsh', 'sessions', '--test--', `session-${SID}`);

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const records = [
  { type: 'session', data: { cwd: 'E:/demo' } },
  { type: 'session/title', data: { title: '监控冒烟' } },
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'tool/call',
    data: {
      turn: 1,
      callId: 'call_ask_1',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [{
          id: 'q1',
          header: '选一个方向',
          question: '先做稳定性还是先做体验？',
          options: [{ label: '稳定性' }, { label: '体验' }],
        }],
      }),
    },
  },
];

const src = path.join(ROOT, 'session.v4.jsonl');
const dst = path.join(LOG_DIR, 'session.v4.jsonl.zstd');
fs.writeFileSync(src, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
const packed = spawnSync(PY, ['-c', [
  'import sys,zstandard',
  'data=open(sys.argv[1],"rb").read()',
  'open(sys.argv[2],"wb").write(zstandard.ZstdCompressor().compress(data))',
].join('\n'), src, dst], { encoding: 'utf8' });
assert.equal(packed.status, 0, `压缩失败：${packed.stderr}`);

function scan() {
  const out = spawnSync(PY, ['monitor-scan.py', '--session', SID], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: HOME, HOME },
  });
  assert.equal(out.status, 0, `scan 失败：${out.stderr}`);
  return JSON.parse(out.stdout);
}

// 1. 卡在提问：应识别出 question + 选项
const first = scan();
assert.equal(first.turns, 0, `还没 turn/end，turns 应为 0，实际 ${first.turns}`);
assert.equal(first.openTurn, true, '这一轮还在跑，openTurn 应为 true');
assert.ok(first.pending, '应当识别出「等你决定」');
assert.equal(first.pending.kind, 'question');
assert.equal(first.pending.title, '选一个方向');
assert.match(first.pending.text, /稳定性还是先做体验/);
assert.deepEqual(first.pending.options, ['稳定性', '体验']);
assert.equal(first.title, '监控冒烟');
console.log('scan/pending:', { kind: first.pending.kind, options: first.pending.options.length });

// 2. 回答之后（tool/result 带上 callId）不再算卡住，且这一轮已结束
fs.appendFileSync(src, `${JSON.stringify({
  type: 'tool/result',
  data: { turn: 1, message: {}, meta: { toolCallId: 'call_ask_1' } },
})}\n${JSON.stringify({ type: 'turn/end', data: { turn: 1 } })}\n`);
const again = spawnSync(PY, ['-c', [
  'import sys,zstandard',
  'data=open(sys.argv[1],"rb").read()',
  'open(sys.argv[2],"wb").write(zstandard.ZstdCompressor().compress(data))',
].join('\n'), src, dst], { encoding: 'utf8' });
assert.equal(again.status, 0, `二次压缩失败：${again.stderr}`);

const second = scan();
assert.equal(second.pending, null, `回答后不应再报卡住，实际 ${JSON.stringify(second.pending)}`);
assert.equal(second.turns, 1, `turn/end 计入后应为 1，实际 ${second.turns}`);
assert.equal(second.openTurn, false, '这一轮已结束，openTurn 应为 false');
console.log('scan/answered:', { turns: second.turns, openTurn: second.openTurn });

// 3. 关闭监控时状态要诚实
const { mountRpc } = await import('../lib/rpc.mjs');
let handler = null;
const ctx = {
  connection: { fetch: { register(spec) { handler = spec.fetch; return () => {}; } } },
};
mountRpc(ctx);
let seq = 0;
const rpcId = () => `mon-${++seq}`;
const res = await (await handler(new Request('http://127.0.0.1/api/read-it-later', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method: 'read-it-later', payload: { method: 'monitor.status', payload: {} } }),
}))).json();
const status = res.result?.value ?? {};
assert.equal(typeof status.running, 'boolean', 'monitor.status 应返回 running');
assert.equal(typeof status.tickMs, 'number', 'monitor.status 应返回 tickMs');
assert.ok('monitorTurns' in status && 'monitorAsk' in status, 'monitor.status 应带回两个开关');
console.log('monitor.status:', { enabled: status.enabled, tickMs: status.tickMs, turns: status.monitorTurns, ask: status.monitorAsk });

fs.rmSync(ROOT, { recursive: true, force: true });
console.log('smoke-monitor: OK');
