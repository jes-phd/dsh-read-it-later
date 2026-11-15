// 冒烟：文字回复 → 选择 → 回填会话（不联网、不连飞书）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ril-ask-'));
process.env.RIL_ASKS_FILE = path.join(dir, 'asks.json');
process.env.RIL_STATE_DIR = dir;

const { recordAsk, matchAsk, recentAsks } = await import('../lib/asks.mjs');
const { answerPending } = await import('../lib/feishu-events.mjs');

recordAsk({
  sessionId: 'session-abc',
  askId: 'call_1',
  questionId: 'q1',
  title: '选择报告格式',
  text: '你想生成哪种格式？',
  options: ['Markdown', 'PDF'],
  at: Date.now(),
});

// 序号
const byNumber = matchAsk('2');
assert.equal(byNumber?.option, 'PDF', '数字 2 应命中第二个选项');
// 原文
const byLabel = matchAsk('markdown');
assert.equal(byLabel?.option, 'Markdown', '原文应命中第一个选项');
// 无关文本
assert.equal(matchAsk('今天天气不错'), null);
assert.equal(recentAsks().length, 1);

// 回填：用假的 sessionController 断言 prompt 的参数形状
const calls = [];
const ctx = {
  get(name) {
    if (name !== 'sessionController') return null;
    return {
      async prompt(request) {
        calls.push(request);
        return { accepted: true };
      },
    };
  },
};

const said = await answerPending(ctx, { ...byNumber.ask, option: byNumber.option });
assert.equal(said.ok, true);
assert.equal(calls.length, 1);
const request = calls[0];
assert.equal(request.sessionId, 'session-abc');
assert.equal(request.mode, 'steer');
const payload = JSON.parse(request.content[0].text);
assert.equal(payload.kind, 'answer_to_pending_question');
assert.equal(payload.callId, 'call_1');
assert.deepEqual(payload.answers, [{ id: 'q1', selected: ['PDF'] }]);
// 答完应被清掉
assert.equal(recentAsks().length, 0);

// 控制器缺失 → 失败但不抛
const said2 = await answerPending({ get: () => null }, { ...byLabel.ask, option: 'Markdown' });
assert.equal(said2.ok, false);

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, said }));
