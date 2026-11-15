import assert from 'node:assert/strict';
import { parseWebhook } from '../lib/dingtalk.mjs';
import { verifyToken as tgVerify } from '../lib/telegram.mjs';

// 钉钉：只接受 oapi.dingtalk.com 且必须带 access_token
const parsed = parseWebhook('https://oapi.dingtalk.com/robot/send?access_token=abc123');
assert.equal(parsed.token, 'abc123');
assert.throws(() => parseWebhook('not-a-url'), /Webhook/);
assert.throws(() => parseWebhook('https://example.com/robot/send?access_token=x'), /钉钉/);
assert.throws(() => parseWebhook('https://oapi.dingtalk.com/robot/send'), /access_token/);

// Telegram：Token 格式先本地校验，不命中就不该发网络请求
await assert.rejects(() => tgVerify('bad-token'), /Bot Token/);
await assert.rejects(() => tgVerify(''), /Bot Token/);

console.log(JSON.stringify({ ok: true, cases: 6 }));
