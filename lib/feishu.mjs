// 飞书通道：扫码创建应用（官方 device registration 流程）+ 发送文本/卡片/文件。
// 与 dsh-im 无关：只用飞书开放平台公开接口，凭据存在本插件的 bots.json 里。
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

const API = 'https://open.feishu.cn/open-apis';
const ACCOUNTS = 'https://accounts.feishu.cn';
const ACCOUNTS_LARK = 'https://accounts.larksuite.com';
const REG_PATH = '/oauth/v1/app/registration';

// 只读/收消息不需要，发消息 + 上传文件需要这两个。
const SCOPES = ['im:message:send_as_bot', 'im:resource'];

function addonsParam() {
  const addons = { preset: false, scopes: { tenant: [...SCOPES] } };
  return Buffer.from(JSON.stringify(addons), 'utf8').toString('base64url');
}

async function form(base, fields) {
  const res = await fetch(`${base}${REG_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'invalid_response', error_description: text.slice(0, 200) };
  }
}

function qrPageUrl(base, response) {
  const url = new URL(response.verification_uri_complete);
  url.searchParams.set('from', 'sdk');
  url.searchParams.set('source', 'dsh-read-it-later');
  url.searchParams.set('tp', 'sdk');
  url.searchParams.set('addons', addonsParam());
  return url.toString();
}

/** 第一步：拿到 device_code 与扫码链接。 */
export async function beginRegistration({ domain = 'feishu' } = {}) {
  const base = domain === 'lark' ? ACCOUNTS_LARK : ACCOUNTS;
  const response = await form(base, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });
  if (!response.device_code || !response.verification_uri_complete) {
    throw new Error(response.error_description || response.error || '飞书没有返回扫码链接');
  }
  return {
    base,
    domain,
    deviceCode: response.device_code,
    qrUrl: qrPageUrl(base, response),
    expiresIn: Number(response.expires_in) || 600,
    intervalMs: (Number(response.interval) || 5) * 1000,
  };
}

/**
 * 轮询一次。返回：
 *  {state:'pending'} | {state:'slow_down', intervalMs} | {state:'expired'|'denied', message}
 *  | {state:'ready', appId, appSecret, openId, name, domain}
 */
export async function pollRegistrationOnce({ base, deviceCode }) {
  const response = await form(base, { action: 'poll', device_code: deviceCode });
  if (response.client_id && response.client_secret) {
    return {
      state: 'ready',
      appId: response.client_id,
      appSecret: response.client_secret,
      openId: response.user_info?.open_id ?? response.user_info?.open_id?.open_id ?? '',
      name: response.user_info?.name ?? response.user_info?.tenant_name ?? '飞书机器人',
      domain: response.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu',
    };
  }
  switch (response.error) {
    case undefined:
    case 'authorization_pending':
      return { state: 'pending' };
    case 'slow_down':
      return { state: 'slow_down', intervalMs: 5000 };
    case 'access_denied':
      return { state: 'denied', message: '扫码创建被拒绝' };
    case 'expired_token':
      return { state: 'expired', message: '二维码已过期' };
    default:
      return { state: 'error', message: response.error_description || response.error || '授权失败' };
  }
}

/** 把扫码链接画成 PNG data URL，前端直接 <img> 显示。 */
export async function qrDataUrl(text, { width = 320 } = {}) {
  return QRCode.toDataURL(text, { margin: 1, width, errorCorrectionLevel: 'M' });
}

// ---------------- 发送 ----------------

const tokenCache = new Map();

export async function tenantToken(appId, appSecret) {
  const hit = tokenCache.get(appId);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`飞书 tenant_access_token 失败 code=${json.code} ${json.msg ?? ''}`);
  const token = json.tenant_access_token;
  tokenCache.set(appId, { token, exp: Date.now() + (json.expire ?? 7200) * 1000 });
  return token;
}

async function postMessage(token, body) {
  const res = await fetch(`${API}/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return json;
}

export async function sendText(bot, text) {
  const token = await tenantToken(bot.appId, bot.appSecret);
  const LIMIT = 4000;
  let rest = String(text ?? '').trim() || '(空消息)';
  const chunks = [];
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf('\n', LIMIT);
    if (cut < LIMIT * 0.5) cut = LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  const ids = [];
  for (const chunk of chunks) {
    const json = await postMessage(token, {
      receive_id: bot.openId,
      msg_type: 'text',
      content: JSON.stringify({ text: chunk }),
    });
    if (json.code !== 0) throw new Error(`飞书发文本失败 code=${json.code} ${json.msg ?? ''}`);
    ids.push(json.data?.message_id);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { format: 'text', parts: chunks.length, ids };
}

export async function sendCard(bot, card) {
  const token = await tenantToken(bot.appId, bot.appSecret);
  const json = await postMessage(token, {
    receive_id: bot.openId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
  if (json.code !== 0) {
    const err = new Error(`飞书发卡片失败 code=${json.code} ${json.msg ?? ''}`);
    err.code = json.code;
    throw err;
  }
  return { format: 'card', parts: 1, ids: [json.data?.message_id] };
}

export async function sendFile(bot, filePath) {
  const token = await tenantToken(bot.appId, bot.appSecret);
  const name = path.basename(filePath);
  const buf = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append('file_type', 'stream');
  formData.append('file_name', name);
  formData.append('file', new Blob([buf]), name);
  const up = await fetch(`${API}/im/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const uj = await up.json();
  if (uj.code !== 0) throw new Error(`飞书上传文件失败 code=${uj.code} ${uj.msg ?? ''}`);
  const json = await postMessage(token, {
    receive_id: bot.openId,
    msg_type: 'file',
    content: JSON.stringify({ file_key: uj.data.file_key }),
  });
  if (json.code !== 0) throw new Error(`飞书发文件失败 code=${json.code} ${json.msg ?? ''}`);
  return { messageId: json.data?.message_id, fileKey: uj.data.file_key, name };
}

/** 手动绑定前先验证凭据是否可用，顺便取一个 open_id（可选）。 */
export async function verifyApp(appId, appSecret) {
  await tenantToken(appId, appSecret);
  return true;
}
