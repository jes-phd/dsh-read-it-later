// 状态监控：盯着所有 DSH 会话，按设置往 IM 推两种小消息。
//
//   1. 某一轮成功结束 → 「✅ 完成一轮」短消息（谁在跑什么，一眼看到）
//   2. 会话卡在「等你决定」（提问 / 审批）→ 把问题与选项发过去，提示尽快抉择
//
// 实现要点：只解「体积变了」的日志（解一次 5MB 的 zstd 要几百毫秒），
// 一轮最多扫 25 个最近 3 天内的会话；状态存 ~/.dsh/read-it-later/monitor.json，
// 同一个提问 id、同一轮次不会重复推。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentSettings } from './settings.mjs';
import { defaultBotId, getBot } from './store.mjs';
import * as feishu from './feishu.mjs';
import * as weixin from './weixin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, '..', 'monitor-scan.py');
const DIR = join(homedir(), '.dsh', 'read-it-later');
const STATE_FILE = process.env.RIL_MONITOR_FILE || join(DIR, 'monitor.json');
const SESSIONS = join(homedir(), '.dsh', 'sessions');

const TICK_MS = 45 * 1000;
const MAX_SESSIONS = 25;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const ASK_SILENCE_MS = 60 * 1000; // 卡住至少 1 分钟才推，避免刚弹出来就吵

let timer = null;
const stats = { lastTickAt: null, scanned: 0, skipped: 0, sentTurn: 0, sentAsk: 0, lastError: null };

function pythonBin() {
  // 与 collect.mjs 一致：优先用装了 zstandard 的那个 python。
  const home = process.env.USERPROFILE ?? homedir();
  const preferred = join(home, '.dsh', 'asr', 'Scripts', process.platform === 'win32' ? 'python.exe' : 'python');
  if (existsSync(preferred)) return preferred;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function writeState(state) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } catch {
    // 状态写不进去最多重复推一次，不影响主流程
  }
}

function scanOne(sessionId) {
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), [SCAN, '--session', sessionId], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim() || 'null'));
      } catch {
        resolve(null);
      }
    });
  });
}

function listLogs() {
  if (!existsSync(SESSIONS)) return [];
  const out = [];
  const now = Date.now();
  for (const ws of readdirSync(SESSIONS)) {
    const wsDir = join(SESSIONS, ws);
    let entries = [];
    try {
      entries = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('session-')) continue;
      const dir = join(wsDir, name);
      let files = [];
      try {
        files = readdirSync(dir).filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f));
      } catch {
        continue;
      }
      let best = null;
      for (const f of files) {
        const path = join(dir, f);
        try {
          const st = statSync(path);
          if (!best || st.size > best.size) best = { path, size: st.size, mtime: st.mtimeMs };
        } catch {
          // ignore
        }
      }
      if (!best) continue;
      if (now - best.mtime > MAX_AGE_MS) continue;
      out.push({
        sessionId: name.replace(/^session-/, ''),
        workspace: ws,
        size: best.size,
        mtime: best.mtime,
        logFile: best.path,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);
}

function clip(text, limit) {
  const str = String(text ?? '').replace(/\s+/g, ' ').trim();
  return str.length > limit ? `${str.slice(0, limit)}…` : str;
}

/** 飞书发卡片（失败回退文本）；微信只能发文本。 */
async function send(bot, message) {
  if (bot.platform === 'weixin') return weixin.sendText(bot, message.text);
  try {
    return await feishu.sendCard(bot, message.card);
  } catch (error) {
    stats.lastError = error?.message ?? String(error);
    return feishu.sendText(bot, message.text);
  }
}

function timeLabel() {
  return new Date().toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function metaLine(info) {
  const bits = [`第 ${info.lastTurn || info.turns} 轮`, timeLabel()];
  if (info.workspace) bits.push(info.workspace);
  return { tag: 'markdown', content: bits.map((b) => `<font color='grey'>${b}</font>`).join('<font color=\'grey\'> · </font>') };
}

/** 卡片外壳：header + 元素列表 + 可选宽度。 */
function card(header, elements) {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      template: header.template || 'blue',
      title: { tag: 'plain_text', content: header.title },
      ...(header.subtitle ? { subtitle: { tag: 'plain_text', content: header.subtitle } } : {}),
    },
    body: { elements },
  };
}

/** 「完成一轮」卡片：隐藏的答复详情放在折叠面板里。 */
export function turnCard(info) {
  const title = info.title || info.sessionId.slice(0, 8);
  const elements = [metaLine(info)];
  const reply = (info.reply || '').trim();
  if (reply) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: '**📄 本轮回答详情**' },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [{ tag: 'markdown', content: clip(reply, 3000) }],
    });
  } else {
    elements.push({ tag: 'markdown', content: "<font color='grey'>（这一轮没有可摘出来的文字答复）</font>" });
  }
  return card({ template: 'green', title: `✅ 完成一轮 · ${title}` }, elements);
}

/** 「需要你决定」卡片：隐藏详情 + 选项按钮。 */
export function askCard(info) {
  const title = info.title || info.sessionId.slice(0, 8);
  const p = info.pending;
  const options = (p.options || []).slice(0, 8);
  const elements = [];
  if (p.title) elements.push({ tag: 'markdown', content: `**${clip(p.title, 60)}**` });
  if (p.text) elements.push({ tag: 'markdown', content: clip(p.text, 500) });

  // 选项用文字列出，直接回复数字即可：不依赖卡片回调，最可靠
  if (options.length) {
    const lines = options.map((opt, i) => `**${i + 1}** · ${clip(opt, 60)}`).join('\n');
    elements.push({ tag: 'markdown', content: lines });
    elements.push({
      tag: 'markdown',
      content: "<font color='grey'>直接回复数字（1 / 2 / 3）即可选择，不用点按钮。</font>",
    });
  }

  elements.push({
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: '**📄 详情**' },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [
      { tag: 'markdown', content: `**问题**\n${clip(p.text || p.title || '（没有更多描述）', 1200)}` },
      ...(options.length
        ? [{ tag: 'markdown', content: `**选项**\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` }]
        : []),
      { tag: 'markdown', content: `<font color='grey'>会话：${title}\n卡住时间：${p.at ? new Date(Number(p.at)).toLocaleString('zh-CN', { hour12: false }) : '刚刚'}</font>` },
    ],
  });

  return card(
    { template: p.kind === 'approval' ? 'orange' : 'wathet', title: `⏳ 需要你决定 · ${title}` },
    elements,
  );
}

/** 文本兜底（微信只能收文本）。 */
function turnText(info) {
  const title = info.title || info.sessionId.slice(0, 8);
  return [
    `✅ 完成一轮 · ${title}`,
    `第 ${info.lastTurn || info.turns} 轮 · ${timeLabel()}`,
    info.workspace ? `工作区：${info.workspace}` : '',
    info.reply ? `\n${clip(info.reply, 600)}` : '',
  ].filter(Boolean).join('\n');
}

function askText(info) {
  const title = info.title || info.sessionId.slice(0, 8);
  const p = info.pending;
  const lines = [`⏳ 需要你决定 · ${title}`];
  if (p.title) lines.push(p.title);
  if (p.text) lines.push(clip(p.text, 300));
  if (p.options?.length) {
    lines.push('选项：');
    p.options.slice(0, 8).forEach((opt, i) => lines.push(`${i + 1}. ${opt}`));
  }
  lines.push(p.kind === 'approval'
    ? '（回到 DSH 点「允许 / 拒绝」即可，别让它一直挂着）'
    : '（回到 DSH 选一个，或者直接打字回答）');
  return lines.join('\n');
}

/** 扫描一轮。导出出来，方便测试与「立即检查一次」。 */
export async function monitorTick() {
  const settings = currentSettings();
  const state = readState();
  state.sessions = state.sessions || {};
  stats.lastTickAt = Date.now();

  if (!settings.monitorTurns && !settings.monitorAsk) {
    stats.scanned = 0;
    stats.skipped = 0;
    return { ...stats, enabled: false };
  }

  const botId = defaultBotId();
  const bot = botId ? getBot(botId) : null;
  if (!bot) {
    stats.lastError = '没有默认机器人';
    return { ...stats, enabled: true, error: stats.lastError };
  }

  const logs = listLogs();
  stats.scanned = 0;
  stats.skipped = 0;

  for (const log of logs) {
    const prev = state.sessions[log.sessionId] || {};
    // 日志没长就跳过解码；但「刚打开卡住提醒」时要补扫一次，
    // 否则一个早就卡住的会话会永远等不到通知。
    const askPending = settings.monitorAsk && prev.checkedAsk !== true;
    if (prev.size === log.size && !askPending) {
      stats.skipped += 1;
      continue;
    }
    const info = await scanOne(log.sessionId);
    if (!info || info.error) {
      stats.skipped += 1;
      continue;
    }
    stats.scanned += 1;
    info.workspace = log.workspace;

    // ① 成功完成一轮
    if (settings.monitorTurns && info.turns > (prev.turns ?? info.turns) && info.turns > 0) {
      try {
        await send(bot, { card: turnCard(info), text: turnText(info) });
        stats.sentTurn += 1;
      } catch (error) {
        stats.lastError = error?.message ?? String(error);
      }
    }

    // ② 卡在需要决定
    if (settings.monitorAsk && info.pending) {
      const at = Number(info.pending.at) || 0;
      const quiet = at ? Date.now() - at : ASK_SILENCE_MS;
      if (quiet >= ASK_SILENCE_MS && prev.askId !== info.pending.id) {
        try {
          await send(bot, { card: askCard(info), text: askText(info) });
          stats.sentAsk += 1;
          prev.askId = info.pending.id;
          recordAsk({
            sessionId: info.sessionId,
            askId: info.pending.id,
            questionId: info.pending.questionId,
            title: info.title,
            text: info.pending.text,
            kind: info.pending.kind,
            options: info.pending.options,
            at: info.pending.at,
          });
        } catch (error) {
          stats.lastError = error?.message ?? String(error);
        }
      }
    } else if (!info.pending) {
      prev.askId = null;
    }

    state.sessions[log.sessionId] = {
      size: info.size || log.size,
      turns: info.turns,
      checkedAsk: settings.monitorAsk,
      askId: prev.askId ?? null,
      title: info.title || '',
      workspace: log.workspace,
      at: Date.now(),
    };
  }

  writeState(state);
  return { ...stats, enabled: true, bot: bot.name || bot.platform };
}

export function monitorStatus() {
  const settings = currentSettings();
  return {
    running: Boolean(timer),
    enabled: Boolean(settings.monitorTurns || settings.monitorAsk),
    monitorTurns: settings.monitorTurns,
    monitorAsk: settings.monitorAsk,
    tickMs: TICK_MS,
    ...stats,
    stateFile: STATE_FILE,
  };
}

export function startMonitor() {
  if (timer) return;
  // 启动后先等 20 秒（把开机的抖动错开），之后每 45 秒一轮。
  const kick = setTimeout(() => {
    void monitorTick().catch(() => {});
  }, 20 * 1000);
  if (typeof kick.unref === 'function') kick.unref();
  timer = setInterval(() => {
    void monitorTick().catch(() => {});
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
