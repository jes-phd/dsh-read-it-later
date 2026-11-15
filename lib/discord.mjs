import fs from 'node:fs';
import path from 'node:path';

const API = 'https://discord.com/api/v10';

function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

async function call(bot, method, endpoint, body, timeoutMs = 15000) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bot ${bot.token}`,
      'user-agent': 'DSH-ReadItLater (https://github.com/jes-phd/dsh-read-it-later, 0.1.0)',
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!res.ok) {
    const reason = json?.message ?? `HTTP ${res.status}`;
    const err = new Error(`Discord 拒绝：${reason}`);
    err.providerCode = String(res.status);
    throw err;
  }
  return json;
}

/** 校验 Bot Token。 */
export async function verifyToken(token) {
  const clean = String(token ?? '').trim();
  if (clean.length < 30) throw new Error('Bot Token 看起来太短了，复制完整的一条（三段用点分隔）');
  const me = await call({ token: clean }, 'GET', '/users/@me');
  return { token: clean, name: me.global_name || me.username, botId: me.id };
}

/** 校验频道 ID 是否可发消息（顺便读频道名）。 */
export async function verifyChannel(token, channelId) {
  const id = String(channelId ?? '').trim();
  if (!/^\d{6,}$/.test(id)) throw new Error('频道 ID 应该是纯数字：在 Discord 里右键频道 → 复制频道 ID');
  const channel = await call({ token }, 'GET', `/channels/${id}`);
  return { channelId: id, name: channel.name ? `#${channel.name}` : id, guildId: channel.guild_id ?? null };
}

export async function sendText(bot, text) {
  const content = String(text ?? '').trim();
  if (!content) throw new Error('消息为空');
  const chunks = [];
  let rest = content;
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf('\n', 1900);
    if (cut < 950) cut = 1900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  const ids = [];
  for (const chunk of chunks) {
    const msg = await call(bot, 'POST', `/channels/${bot.channelId}/messages`, { content: chunk });
    ids.push(msg?.id ?? null);
  }
  return { format: 'text', parts: chunks.length, ids, tz: timezone() };
}

export async function sendFile(bot, filePath) {
  const bytes = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const form = new FormData();
  form.set('payload_json', JSON.stringify({ content: '', attachments: [{ id: '0', filename: name }] }));
  form.set('files[0]', new Blob([bytes]), name);
  const msg = await call(bot, 'POST', `/channels/${bot.channelId}/messages`, form, 120000);
  return { id: msg?.id ?? null, name };
}
