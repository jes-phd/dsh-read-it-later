// 飞书长连接：接收「卡片按钮点击」与「机器人收到的文字消息」，把它们回填成会话里的选择。
import * as Lark from '@larksuiteoapi/node-sdk';
import { listBots } from './store.mjs';
import { matchAsk, clearAsk } from './asks.mjs';
import { sendText } from './feishu.mjs';

const clients = new Map();

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
  for (const bot of bots) {
    if (clients.has(bot.id)) continue;
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
        const hit = matchAsk(text);
        if (!hit) return {};
        await answerPending(ctx, { ...hit.ask, option: hit.option });
        return {};
      },
    });
    client
      .start({ eventDispatcher: dispatcher })
      .then(() => console.log(`[read-it-later] 飞书长连接已建立：${bot.name || bot.id}`))
      .catch((error) => console.warn('[read-it-later] 飞书长连接启动失败:', error?.message ?? error));
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
    await controller.prompt({
      sessionId: ask.sessionId,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      mode: 'steer',
    });
    clearAsk(ask.sessionId, ask.askId);
    const bot = listBots().find((item) => item.platform === 'feishu');
    if (bot) await confirm(bot, `已回填到会话：${ask.option}`);
    return { ok: true, message: `已选择：${ask.option}` };
  } catch (error) {
    const message = error?.message ?? String(error);
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
