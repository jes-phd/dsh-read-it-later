// 飞书长连接：接收「卡片按钮点击」与「机器人收到的文字消息」，把它们回填成会话里的选择。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { askCard } from './monitor.mjs';
import { listBots } from './store.mjs';
import { matchAsk, completeAsk, queuedCount } from './asks.mjs';
import { sendCard, sendText } from './feishu.mjs';

// 模块级 + 全局双份：插件反复重载时，旧实例的连接必须先关掉，
// 否则同一个应用会挂两条长连接，点击事件可能落到跑着旧代码的那条上。
const REGISTRY = (globalThis.__rilWsClients ??= new Map());
const clients = REGISTRY;
const seenMessages = new Set();
let lastPromoteAt = 0;
const LOG_FILE = process.env.RIL_EVENTS_LOG || path.join(os.homedir(), '.dsh', 'read-it-later', 'events.log');

/** 把长连接上发生的事写进日志，出问题时能回看。 */
function trace(event, detail) {
  const line = `[${new Date().toISOString()}] ${event} ${JSON.stringify(detail ?? null)}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* ignore */
  }
}

function textOf(message) {
  try {
    const content = JSON.parse(message?.content || '{}');
    return String(content.text || '').replace(/@_user_\d+/g, '').trim();
  } catch {
    return '';
  }
}

async function confirm(bot, text) {
  try {
    await sendText({ appId: bot.appId, appSecret: bot.appSecret, openId: bot.openId }, text);
  } catch (error) {
    console.warn('[read-it-later] 回执消息发送失败:', error?.message ?? error);
  }
}

/**
 * 为每个已绑定的飞书机器人建立长连接。
 * @param ctx Host 上下文（用来把选择写回会话）
 */
export function startFeishuEvents(ctx) {
  const bots = listBots().filter((bot) => bot.platform === 'feishu' && bot.appId && bot.appSecret);
  // 先把上一次留下的连接全部收掉，保证事件只落在当前这份代码上。
  for (const [id, client] of clients) {
    try {
      client.close?.({ force: true });
      trace('ws.close', { bot: id });
    } catch {
      /* ignore */
    }
    clients.delete(id);
  }
  for (const bot of bots) {
    const client = new Lark.WSClient({
      appId: bot.appId,
      appSecret: bot.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      autoReconnect: true,
      onError: (error) => console.warn('[read-it-later] 飞书长连接错误:', error?.message ?? error),
    });
    const dispatcher = new Lark.EventDispatcher({}).register({
      'card.action.trigger': async (data) => {
        const value = data?.action?.value || {};
        trace('card.action.trigger', { value, operator: data?.operator?.open_id });
        if (value.ril !== 'ask' || !value.sessionId || !value.option) return {};
        const said = await answerPending(ctx, {
          sessionId: String(value.sessionId),
          askId: String(value.askId || ''),
          questionId: String(value.questionId || ''),
          option: String(value.option),
        });
        return { toast: { type: said.ok ? 'success' : 'error', content: said.message } };
      },
      'im.message.receive_v1': async (data) => {
        const from = data?.sender?.sender_id?.open_id;
        if (from !== bot.openId) return {};
        const text = textOf(data?.message);
        trace('im.message.receive_v1', { from, text });
        const mid = String(data?.message?.message_id || '');
        if (mid) {
          if (seenMessages.has(mid)) {
            trace('msg.duplicate', { mid, text });
            return {};
          }
          seenMessages.add(mid);
          if (seenMessages.size > 200) seenMessages.delete(seenMessages.values().next().value);
        }
        // 刚发出去的下一张卡有个短暂的「回答空窗」：这期间到达的回复几乎都是对上一张卡的补发
        if (lastPromoteAt && Date.now() - lastPromoteAt < 2500) {
          trace('msg.stale', { text, sincePromoteMs: Date.now() - lastPromoteAt });
          return {};
        }
        const hit = matchAsk(text);
        if (!hit) {
          trace('ask.no-match', { text });
          return {};
        }
        const said = await answerPending(ctx, { ...hit.ask, option: hit.option });
        trace('ask.replied', { askId: hit.ask.askId, option: hit.option, ok: said.ok });
        if (!said.ok) {
          const label = hit.ask.title ? `「${hit.ask.title}」` : '';
          await confirm(bot, `${label}${said.message}`).catch(() => {});
        }
        return {};
      },
    });
    client
      .start({ eventDispatcher: dispatcher })
      .then(() => {
        trace('ws.ready', { bot: bot.id });
        console.log(`[read-it-later] 飞书长连接已建立：${bot.name || bot.id}`);
      })
      .catch((error) => {
        trace('ws.error', { message: error?.message ?? String(error) });
        console.warn('[read-it-later] 飞书长连接启动失败:', error?.message ?? error);
      });
    clients.set(bot.id, client);
  }
}

export async function answerPending(ctx, ask) {
  let controller = null;
  try {
    controller = ctx.get?.('sessionController') ?? null;
  } catch {
    controller = null;
  }
  if (!controller?.prompt) {
    return { ok: false, message: '宿主没有会话控制器，暂时无法回填' };
  }
  const payload = {
    kind: 'answer_to_pending_question',
    callId: ask.askId,
    answers: [{ id: ask.questionId || ask.askId, selected: [ask.option] }],
  };
  const requestId = `ril-${ask.askId || 'ask'}-${Date.now()}`;
  const buildRequest = (mode) => ({
    sessionId: ask.sessionId,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    mode,
    requestId,
  });
  // 走底层 commands.prompt(request, source)：source 必须是我们自己构造的普通对象。
  // 直接调 controller.prompt 时它会用 ctx.invocation 推断 source，在没有网关调用的场景里
  // 会塞进不可序列化的对象，报 `session event "agent/inbox/spliced" carries non-JSON-serializable data`。
  const send = (mode) => {
    const commands = controller.commands;
    if (commands?.prompt) {
      return commands.prompt(buildRequest(mode), { kind: 'user', rpcId: requestId });
    }
    return controller.prompt(buildRequest(mode), AbortSignal.timeout(20000));
  };
  try {
    // prompt(request, signal) 第二个参数是必需的 AbortSignal（少传会报 throwIfAborted）
    // 会话正在等回答时用 steer 直接插进当前轮；已经空闲（例如回答得太晚）就退回 queue 排队。
    try {
      await send('steer');
    } catch (error) {
      const message = error?.message ?? String(error);
      if (/not found|not-found|不存在/i.test(message)) throw error;
      trace('answer.retry_queue', { sessionId: ask.sessionId, askId: ask.askId, message });
      await send('queue');
    }
    trace('answer.ok', { sessionId: ask.sessionId, askId: ask.askId, option: ask.option });
    const next = completeAsk(ask.sessionId, ask.askId);
    const bot = listBots().find((item) => item.platform === 'feishu');
    if (bot) {
      await confirm(bot, `已回填到会话：${ask.option}${next ? '（还有待你决定的事项，已发下一条）' : ''}`).catch(() => {});
      await promote(bot, next);
    }
    return { ok: true, message: `已选择：${ask.option}` };
  } catch (error) {
    const message = error?.message ?? String(error);
    const reason = error?.details?.reason;
    trace('answer.fail', { sessionId: ask.sessionId, askId: ask.askId, message, reason });
    console.warn('[read-it-later] 回填选择失败:', message, reason ?? '');
    if (/throwIfAborted/i.test(message)) {
      return { ok: false, message: '这条连接是旧版残留（旧代码没传 AbortSignal），请完全退出 DSH 再打开一次' };
    }
    if (/not found|unknown|no such session|不存在|找不到/i.test(message)) {
      await promoteAfterFailure(ask);
      return { ok: false, message: '这个会话已经找不到了（可能已归档），这次选择没法回填' };
    }
    await promoteAfterFailure(ask);
    return { ok: false, message: `回填失败：${message}${reason ? '（' + reason + '）' : ''}` };
  }
}

/** 一条答完后，把排队里的下一条推上来发出去。 */
async function promote(bot, next) {
  if (!next || !bot) return;
  const card = next.card ? askCard(next.card) : null;
  if (!card) return;
  try {
    await sendCard(bot, card);
    lastPromoteAt = Date.now();
    trace('ask.promoted', { askId: next.askId, remaining: queuedCount() });
  } catch (error) {
    trace('ask.promote-failed', { askId: next.askId, message: error?.message ?? String(error) });
  }
}

async function promoteAfterFailure(ask) {
  const next = completeAsk(ask.sessionId, ask.askId);
  const bot = listBots().find((item) => item.platform === 'feishu');
  if (bot) {
    await confirm(bot, `已跳过这一条${next ? '（还有待你决定的事项，已发下一条）' : ''}`).catch(() => {});
    await promote(bot, next);
  }
}

/** 停掉所有长连接（插件卸载时调用）。 */
export function stopFeishuEvents() {
  for (const [id, client] of clients) {
    try {
      client.close({ force: true });
    } catch {
      /* ignore */
    }
    clients.delete(id);
  }
}

export const FEISHU_EVENT_CLIENTS = clients;
