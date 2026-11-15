import crypto from 'node:crypto';

/**
 * 钉钉群自定义机器人：只需要 webhook 地址（含 access_token），可选加签密钥。
 * 注意：自定义机器人只能发文本 / markdown，不能发文件；文件只会以清单形式出现在正文里。
 */
function sign(secret, timestamp) {
  const text = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', secret).update(text, 'utf8').digest('base64');
}

export function parseWebhook(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请粘贴钉钉机器人的 Webhook 地址');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Webhook 地址格式不对，应该以 https://oapi.dingtalk.com/robot/send?access_token= 开头');
  }
  if (!/dingtalk\.com$/.test(url.hostname) && !/dingtalk\.com$/.test(url.hostname.replace(/^.*\./, 'dingtalk.com'))) {
    throw new Error('这不像钉钉的 Webhook 地址（域名应为 oapi.dingtalk.com）');
  }
  const token = url.searchParams.get('access_token');
  if (!token) throw new Error('地址里缺少 access_token');
  return { webhook: url.toString(), token, secret: '' };
}

export async function verify({ webhook, secret }) {
  const body = { msgtype: 'text', text: { content: 'DSH Read it later 已连接 ✅' } };
  if (secret) {
    const ts = Date.now();
    body.timestamp = String(ts);
    body.sign = sign(secret, ts);
  }
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (json?.errcode !== 0) {
    const err = new Error(json?.errmsg ? `钉钉拒绝：${json.errmsg}` : `钉钉请求失败（HTTP ${res.status}）`);
    err.providerCode = String(json?.errcode ?? res.status);
    throw err;
  }
  return { name: '钉钉群机器人' };
}

export async function sendText(bot, text) {
  const content = String(text ?? '').trim();
  if (!content) throw new Error('消息为空');
  const MAX = 3800;
  const chunks = [];
  let rest = content;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX);
    if (cut < MAX / 2) cut = MAX;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  const ids = [];
  for (const chunk of chunks) {
    const body = { msgtype: 'text', text: { content: chunk } };
    if (bot.secret) {
      const ts = Date.now();
      body.timestamp = String(ts);
      body.sign = sign(bot.secret, ts);
    }
    const res = await fetch(bot.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => null);
    if (json?.errcode !== 0) {
      const err = new Error(json?.errmsg ? `钉钉拒绝：${json.errmsg}` : `钉钉请求失败（HTTP ${res.status}）`);
      err.providerCode = String(json?.errcode ?? res.status);
      throw err;
    }
    ids.push(json?.errcode === 0 ? Date.now() : null);
  }
  return { format: 'text', parts: chunks.length, ids };
}

/** 钉钉自定义机器人不能传文件：把文件清单塞回文本里，返回 null 表示不单独发。 */
export async function sendFile() {
  return null;
}
