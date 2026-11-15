// 冒烟：用假 ctx 跑真实 RPC 协议，验证 status / bind.begin 能拿到二维码。
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
if (!handler) throw new Error('rpc handler not registered');

let seq = 0;
async function call(method, payload = {}) {
  const rpcId = `smoke-${++seq}`;
  const req = new Request('http://127.0.0.1/api/read-it-later', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'read-it-later', payload: { method, payload } }),
  });
  const res = await handler(req);
  const json = await res.json();
  if (json.rpcId !== rpcId) throw new Error('rpcId mismatch');
  return json.result;
}

const status = await call('status');
console.log('status:', JSON.stringify(status).slice(0, 300));

const feishu = await call('bind.begin', { platform: 'feishu' });
console.log('feishu begin:', feishu.ok, feishu.ok ? {
  state: feishu.value.state,
  qr: feishu.value.qrImage.slice(0, 30),
  qrLen: feishu.value.qrImage.length,
  url: feishu.value.qrUrl.slice(0, 90),
} : feishu.error);
if (feishu.ok) {
  const poll = await call('bind.poll', { attemptId: feishu.value.attemptId });
  console.log('feishu poll:', JSON.stringify(poll).slice(0, 200));
  await call('bind.cancel', { attemptId: feishu.value.attemptId });
}

const wx = await call('bind.begin', { platform: 'weixin' });
console.log('weixin begin:', wx.ok, wx.ok ? {
  state: wx.value.state,
  qr: wx.value.qrImage.slice(0, 40),
  qrLen: wx.value.qrImage.length,
} : wx.error);
if (wx.ok) {
  const poll = await call('bind.poll', { attemptId: wx.value.attemptId });
  console.log('weixin poll:', JSON.stringify(poll).slice(0, 200));
  await call('bind.cancel', { attemptId: wx.value.attemptId });
}

// 没有绑定机器人时，发送应给出可读错误而不是崩溃。
const send = await call('share.send', {
  sessionId: 'session-00000000-0000-0000-0000-000000000000',
  turn: 1,
  include: { prompts: true, answers: true, files: true },
});
console.log('share.send without bot:', send.ok, send.ok ? send.value : `${send.error.code}: ${send.error.message}`);

const manual = await call('bind.manual', { platform: 'feishu', appId: '', appSecret: '', openId: '' });
console.log('bind.manual empty:', manual.ok, manual.ok ? manual.value : `${manual.error.code}: ${manual.error.message}`);

process.exit(0);
