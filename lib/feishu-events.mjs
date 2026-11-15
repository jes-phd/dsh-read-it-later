// 飞书长连接：接收「卡片按钮点击」与「机器人收到的文字消息」，把它们回填成会话里的选择。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { listBots } from './store.mjs';
import { matchAsk, clearAsk } from './asks.mjs';
import { sendText } from './feishu.mjs';

// 模块级 + 全局双份：插件反复重载时，旧实例的连接必须先关掉，
// 否则同一个应用会挂两条长连接，点击事件可能落到跑着旧代码的那条上。
const REGISTRY = (globalThis.__rilWsClients ??= new Map());
const clients = REGISTRY;
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
        const hit = matchAsk(text);
        if (!hit) return {};
        await answerPending(ctx, { ...hit.ask, option: hit.option });
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
  try {
    // prompt(request, signal) 第二个参数是必需的 AbortSignal（少传会报 throwIfAborted）
    await controller.prompt(
      {
        sessionId: ask.sessionId,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        mode: 'steer',
      },
      AbortSignal.timeout(20000),
    );
    trace('answer.ok', { sessionId: ask.sessionId, askId: ask.askId, option: ask.option });
    clearAsk(ask.sessionId, ask.askId);
    const bot = listBots().find((item) => item.platform === 'feishu');
    if (bot) await confirm(bot, `已回填到会话：${ask.option}`);
    return { ok: true, message: `已选择：${ask.option}` };
  } catch (error) {
    const message = error?.message ?? String(error);
    trace('answer.fail', { sessionId: ask.sessionId, askId: ask.askId, message });
    console.warn('[read-it-later] 回填选择失败:', message);
    if (/not found|unknown|no such session|不存在|找不到/i.test(message)) {
      return { ok: false, message: '这个会话已经找不到了（可能已归档），这次选择没法回填' };
    }
    return { ok: false, message: `回填失败：${message}` };
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
