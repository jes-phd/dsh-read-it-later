import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.telegram.org';

async function call(bot, method, payload, timeoutMs = 15000) {
  const url = `${API}/bot${bot.token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) {
    const err = new Error(json?.description ? `Telegram 拒绝：${json.description}` : `Telegram 请求失败（HTTP ${res.status}）`);
    err.providerCode = String(json?.error_code ?? res.status);
    throw err;
  }
  return json.result;
}

/** 校验 Bot Token，返回机器人资料。 */
export async function verifyToken(token) {
  const clean = String(token ?? '').trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(clean)) throw new Error('Bot Token 格式不对（形如 123456789:AA…）');
  const me = await call({ token: clean }, 'getMe');
  return { token: clean, name: me.username ? `@${me.username}` : me.first_name, botId: String(me.id) };
}

/**
 * 从最近的 update 里找出「跟机器人说过话」的 chat id。
 * 绑定流程：先给机器人发一句任意消息，再回来点「读取会话」。
 */
export async function discoverChat(token) {
  const updates = await call({ token }, 'getUpdates', { limit: 20, timeout: 0 });
  const ids = [];
  for (const update of Array.isArray(updates) ? updates : []) {
    const chat = update?.message?.chat ?? update?.edited_message?.chat ?? update?.my_chat_member?.chat;
    if (chat?.id && !ids.some((item) => item.id === chat.id)) {
      ids.push({ id: chat.id, title: chat.title || chat.username || chat.first_name || String(chat.id), type: chat.type });
    }
  }
  if (ids.length === 0) throw new Error('还没收到过消息：先在 Telegram 里给这个机器人随便发一句，再点一次。');
  return ids[0];
}

export async function sendText(bot, text) {
  const content = String(text ?? '').trim();
  if (!content) throw new Error('消息为空');
  const chunks = [];
  let rest = content;
  while (rest.length > 3800) {
    let cut = rest.lastIndexOf('\n', 3800);
    if (cut < 1900) cut = 3800;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  const ids = [];
  for (const chunk of chunks) {
    const msg = await call(bot, 'sendMessage', {
      chat_id: bot.chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
    ids.push(msg?.message_id ?? null);
  }
  return { format: 'text', parts: chunks.length, ids };
}

export async function sendFile(bot, filePath) {
  const bytes = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const form = new FormData();
  form.set('chat_id', String(bot.chatId));
  form.set('document', new Blob([bytes]), name);
  const res = await fetch(`${API}/bot${bot.token}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) {
    const err = new Error(json?.description ? `Telegram 发文件失败：${json.description}` : `Telegram 发文件失败（HTTP ${res.status}）`);
    err.providerCode = String(json?.error_code ?? res.status);
    throw err;
  }
  return { id: json.result?.message_id ?? null, name };
}
