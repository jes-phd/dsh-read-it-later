// 微信通道：腾讯 iLink 机器人扫码绑定 + 发消息/文件。
// 协议与 dsh-im 的 weixin 通道一致（同一套 iLink 接口），但独立实现、独立存凭据。
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const QR_BASE = 'https://ilinkai.weixin.qq.com/';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const PROTOCOL_VERSION = '2.4.6';
const BOT_TYPE = '3';
const APP_ID = 'bot';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6; // 132102

function baseInfo() {
  return { channel_version: PROTOCOL_VERSION, bot_agent: 'DSH-ReadItLater/0.1.0' };
}

function commonHeaders() {
  return { 'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': String(CLIENT_VERSION) };
}

function authHeaders(token) {
  const headers = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function normalizeBaseUrl(value, fallback = QR_BASE) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)weixin\.qq\.com$/i.test(url.hostname)) return fallback;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return fallback;
  }
}

async function requestJson({ method, baseUrl, endpoint, body, token, timeoutMs = 15_000, auth = true }) {
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL(endpoint, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: auth ? authHeaders(token) : commonHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`微信接口 HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 生成扫码二维码。 */
export async function beginLogin() {
  const response = await requestJson({
    method: 'POST',
    baseUrl: QR_BASE,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    body: { local_token_list: [] },
    timeoutMs: 10_000,
    auth: false,
  });
  if (!response?.qrcode) throw new Error(response?.errcode ? `微信拒绝二维码申请（${response.errcode}）` : '微信没有返回二维码');
  return {
    qrcode: response.qrcode,
    qrUrl: response.qrcode_img_content ?? '',
    baseUrl: QR_BASE,
  };
}

/** 轮询扫码状态（长轮询，调用方应放在后台循环里）。 */
export async function pollLogin({ qrcode, baseUrl = QR_BASE, verifyCode }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(String(verifyCode).trim())}`;
  return requestJson({
    method: 'GET',
    baseUrl,
    endpoint,
    timeoutMs: 35_000,
    auth: false,
  });
}

/**
 * 一次心跳：确认机器人能发消息（失败时用 notifystart 唤醒，再重试一次）。
 */
async function ensureStart(bot) {
  const body = { base_info: baseInfo() };
  const json = await requestJson({
    method: 'POST',
    baseUrl: bot.baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    token: bot.token,
    body,
    timeoutMs: 10_000,
  }).catch(() => null);
  return json;
}

// 机器人必须先「上线」（notifystart）才能发消息；否则第一发会被拒，
// 表现为「刚绑定完点发至IM 失败，去设置里点一次测试就好了」。
const startedBots = new Set();

async function ensureStarted(bot) {
  const key = String(bot?.token ?? '');
  if (!key || startedBots.has(key)) return;
  await ensureStart(bot).catch(() => null);
  startedBots.add(key);
}

export async function sendText(bot, text) {
  await ensureStarted(bot);
  const content = String(text ?? '').trim();
  if (!content) throw new Error('消息为空');
  const chunks = [];
  let rest = content;
  while (rest.length > 1800) {
    let cut = rest.lastIndexOf('\n', 1800);
    if (cut < 900) cut = 1800;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);

  const send = async (chunk) => {
    const clientId = `dsh-ril-${randomUUID()}`;
    const json = await requestJson({
      method: 'POST',
      baseUrl: bot.baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      token: bot.token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: bot.ownerUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        },
        base_info: baseInfo(),
      },
    });
    if (json?.ret !== undefined && json.ret !== 0) {
      const err = new Error(`微信发消息被拒绝（ret=${json.ret}）`);
      err.providerCode = String(json.ret);
      throw err;
    }
    return json;
  };

  const ids = [];
  for (const chunk of chunks) {
    try {
      const json = await send(chunk);
      ids.push(json?.message_id ?? json?.msg_id ?? null);
    } catch (error) {
      // 任何拒绝都先唤醒一次再重试：首个消息最常见的失败就是「会话还没上线」。
      startedBots.delete(String(bot?.token ?? ''));
      await ensureStart(bot).catch(() => null);
      const json = await send(chunk);
      ids.push(json?.message_id ?? json?.msg_id ?? null);
    }
  }
  return { format: 'text', parts: chunks.length, ids };
}

function paddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16;
}

async function uploadCdn(uploadUrl, bytes, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
    },
    body,
  });
  if (res.status !== 200) throw new Error(`微信 CDN 上传失败（HTTP ${res.status}）`);
  const param = res.headers.get('x-encrypted-param');
  if (!param) throw new Error('微信 CDN 上传响应缺少下载参数');
  return param;
}

export async function sendFile(bot, filePath) {
  const bytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const fileKey = randomBytes(16).toString('hex');
  const aesKey = randomBytes(16);

  const upload = await requestJson({
    method: 'POST',
    baseUrl: bot.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    token: bot.token,
    body: {
      filekey: fileKey,
      media_type: 3,
      to_user_id: bot.ownerUserId,
      rawsize: bytes.byteLength,
      rawfilemd5: createHash('md5').update(bytes).digest('hex'),
      filesize: paddedSize(bytes.byteLength),
      no_need_thumb: true,
      aeskey: aesKey.toString('hex'),
      base_info: baseInfo(),
    },
  });
  if (!upload?.upload_param && !upload?.upload_full_url) {
    throw new Error(`微信拒绝上传（ret=${upload?.ret ?? upload?.errcode ?? '?'}）`);
  }
  let uploadUrl;
  if (upload.upload_full_url) {
    uploadUrl = upload.upload_full_url;
  } else {
    const url = new URL(`${CDN_BASE}/upload`);
    url.searchParams.set('encrypted_query_param', upload.upload_param);
    url.searchParams.set('filekey', fileKey);
    uploadUrl = url.toString();
  }
  const downloadParam = await uploadCdn(uploadUrl, bytes, aesKey);

  const json = await requestJson({
    method: 'POST',
    baseUrl: bot.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    token: bot.token,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: bot.ownerUserId,
        client_id: `dsh-ril-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{
          type: 4,
          file_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64'),
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(bytes.byteLength),
          },
        }],
      },
      base_info: baseInfo(),
    },
  });
  if (json?.ret !== undefined && json.ret !== 0) throw new Error(`微信发文件被拒绝（ret=${json.ret}）`);
  return { name: fileName, messageId: json?.message_id ?? null };
}
