// Host 侧：/api/read-it-later RPC —— 绑定、机器人管理、按轮次分享到所选机器人。
import fs from 'node:fs';
import { collect } from './collect.mjs';
import path from 'node:path';
import { buildCard, buildText } from './card.mjs';
import { currentSettings, publicSettings, resolveTheme, updateSettings } from './settings.mjs';
import { OUTBOX, existingFiles, fileSize, zipFiles, zipNameFor } from './zip.mjs';
import { listPresets, savePreset, removePreset } from './presets.mjs';
import { loadArms, saveArms } from './arms.mjs';
import { monitorStatus, monitorTick } from './monitor.mjs';
import * as feishu from './feishu.mjs';
import * as weixin from './weixin.mjs';
import { beginBind, bindStatus, submitCode, cancelBind, cancelAll } from './bind.mjs';
import {
  listBots, getBot, addBot, updateBot, removeBot, publicBot, defaultBotId, markSend,
} from './store.mjs';

const RPC_PATH = '/api/read-it-later';
const RPC_METHOD = 'read-it-later';
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const ANSWER_CHARS = 6000;

const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clip(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}\n…（已截断，原长 ${str.length} 字）` : str;
}

function normalizeInclude(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { prompts: v.prompts !== false, answers: v.answers !== false, files: v.files !== false };
}

function scopeOf(payload) {
  return {
    turn: Number.isInteger(payload?.turn) ? payload.turn : null,
    seq: Number.isInteger(payload?.seq) ? payload.seq : null,
  };
}

/** 纯文本版由 card.mjs 提供（微信走它；飞书卡片失败时也回退到它）。 */

function withPlatformError(error, platform) {
  const msg = error?.message ?? String(error);
  return `${platform === 'feishu' ? '飞书' : '微信'}发送失败：${msg}`;
}

async function sendViaBot(bot, { text, card, cards, attach = null, files = [] }) {
  const report = { format: 'text', textParts: 0, filesSent: 0, filesSkipped: [], attached: [] };
  const list = Array.isArray(cards) && cards.length ? cards : card ? [card] : [];
  const hasBody = Boolean(list.length || text);

  if (list.length && bot.platform === 'feishu') {
    try {
      let parts = 0;
      for (const one of list) {
        const r = await feishu.sendCard(bot, one);
        parts += r.parts ?? 1;
        if (list.length > 1) await new Promise((resolve) => setTimeout(resolve, 260));
      }
      report.format = 'card';
      report.textParts = parts;
      report.cards = list.length;
    } catch (error) {
      report.cardError = `卡片发送失败，已回退文本：${error?.message ?? error}`;
      const r = await feishu.sendText(bot, text);
      report.textParts = r.parts ?? 1;
    }
  } else if (hasBody) {
    const r = bot.platform === 'feishu' ? await feishu.sendText(bot, text) : await weixin.sendText(bot, text);
    report.textParts = r.parts ?? 1;
  }

  const sendOne = async (filePath, name) => {
    const st = fs.statSync(filePath);
    if (!st.isFile()) throw new Error('不是文件');
    if (st.size > MAX_ZIP_BYTES) throw new Error('超过 100MB');
    if (bot.platform === 'feishu') await feishu.sendFile(bot, filePath);
    else await weixin.sendFile(bot, filePath);
    report.filesSent += 1;
    report.attached.push({ name: name ?? path.basename(filePath), bytes: st.size });
  };

  if (attach?.path) {
    try {
      await sendOne(attach.path, attach.name);
    } catch (error) {
      report.filesSkipped.push({ path: attach.path, reason: error?.message ?? '上传失败' });
    }
  } else {
    for (const file of files.slice(0, MAX_FILES)) {
      try {
        await sendOne(file);
      } catch (error) {
        report.filesSkipped.push({ path: file, reason: error?.message ?? '上传失败' });
      }
    }
  }
  return report;
}

/**
 * 把一轮的文件打成「会话标题第 N 轮.zip」。打包失败时退回逐个发送。
 */
async function packageFiles(data, files, options = {}) {
  const list = existingFiles(files ?? []);
  if (!list.length) return { fileItems: [], attach: null, files: [], zipError: null };
  const fileItems = list.map((f) => ({ name: f.name, sizeLabel: fileSize(f.bytes) }));

  // 关掉「压缩附件」：像早期版本一样逐个发送文件
  if (options.zip === false) {
    return {
      fileItems,
      attach: null,
      files: list.slice(0, MAX_FILES).map((f) => f.path),
      zipError: null,
    };
  }

  const outName = zipNameFor(data.title, data.turn);
  const outPath = path.join(OUTBOX, outName);
  try {
    const r = await zipFiles(list.map((f) => f.path), outPath);
    return { fileItems, attach: { path: outPath, name: outName, bytes: r.bytes, count: r.count }, files: [], zipError: null };
  } catch (error) {
    return {
      fileItems,
      attach: null,
      files: list.filter((f) => f.bytes <= MAX_FILE_BYTES).map((f) => f.path),
      zipError: error?.message ?? String(error),
    };
  }
}

function resolveBot(payload) {
  const byId = typeof payload?.botId === 'string' ? getBot(payload.botId) : null;
  if (byId) return byId;
  const fallback = defaultBotId();
  return fallback ? getBot(fallback) : null;
}

// ---------------- 方法 ----------------

function status() {
  return ok({
    bots: listBots().map(publicBot),
    defaultBotId: defaultBotId(),
    store: '~/.dsh/read-it-later/bots.json',
  });
}

async function bindBegin(payload) {
  const platform = payload?.platform;
  if (platform !== 'feishu' && platform !== 'weixin') return fail('ril/bad-platform', '只能绑定飞书或微信。');
  try {
    return ok(await beginBind(platform));
  } catch (error) {
    return fail('ril/bind-failed', error?.message ?? '生成二维码失败');
  }
}

function bindPoll(payload) {
  const attemptId = payload?.attemptId;
  if (typeof attemptId !== 'string') return fail('ril/bad-request', '缺少 attemptId。');
  const state = bindStatus(attemptId);
  if (!state) return fail('ril/no-attempt', '这次绑定已结束，请重新生成二维码。');
  return ok(state);
}

function bindVerify(payload) {
  const attemptId = payload?.attemptId;
  const code = payload?.code;
  if (typeof attemptId !== 'string' || typeof code !== 'string') return fail('ril/bad-request', '缺少 attemptId 或配对码。');
  const state = submitCode(attemptId, code);
  if (!state) return fail('ril/no-attempt', '当前不需要输入配对码。');
  return ok(state);
}

function bindCancel(payload) {
  if (typeof payload?.attemptId !== 'string') return fail('ril/bad-request', '缺少 attemptId。');
  cancelBind(payload.attemptId);
  return ok({ cancelled: true });
}

async function bindManual(payload) {
  if (payload?.platform !== 'feishu') return fail('ril/bad-platform', '手动绑定目前只支持飞书 App ID/Secret。');
  const appId = String(payload?.appId ?? '').trim();
  const appSecret = String(payload?.appSecret ?? '').trim();
  const openId = String(payload?.openId ?? '').trim();
  const name = String(payload?.name ?? '').trim() || '飞书机器人';
  if (!appId || !appSecret) return fail('ril/bad-request', '请填写 App ID 与 App Secret。');
  if (!openId) return fail('ril/bad-request', '请填写要接收消息的 open_id（可与机器人单聊后取得）。');
  try {
    await feishu.verifyApp(appId, appSecret);
  } catch (error) {
    return fail('ril/bad-credentials', error?.message ?? '凭据校验失败');
  }
  const bot = {
    id: `feishu-${Math.random().toString(16).slice(2, 12)}`,
    platform: 'feishu',
    name,
    appId,
    appSecret,
    openId,
    createdAt: Date.now(),
  };
  addBot(bot);
  return ok({ bot: publicBot(bot) });
}

function botRemove(payload) {
  if (typeof payload?.botId !== 'string') return fail('ril/bad-request', '缺少 botId。');
  return ok({ removed: removeBot(payload.botId) });
}

function botRename(payload) {
  const bot = typeof payload?.botId === 'string' ? getBot(payload.botId) : null;
  if (!bot) return fail('ril/no-bot', '机器人不存在。');
  const name = String(payload?.name ?? '').trim().slice(0, 60);
  if (!name) return fail('ril/bad-request', '名字不能为空。');
  updateBot(bot.id, { name });
  return ok({ bot: publicBot(getBot(bot.id)) });
}

async function botTest(payload) {
  const bot = resolveBot(payload);
  if (!bot) return fail('ril/no-bot', '还没有绑定任何机器人。');
  try {
    const r = await sendViaBot(bot, {
      text: `✅ dsh-read-it-later 测试消息\n机器人：${bot.name || bot.id}\n时间：${stamp()}`,
      card: null,
      files: [],
    });
    markSend(bot.id, null);
    return ok({ sent: r });
  } catch (error) {
    markSend(bot.id, error?.message ?? String(error));
    return fail('ril/send-failed', withPlatformError(error, bot.platform));
  }
}

async function sharePreview(payload, ctx) {
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return fail('ril/missing-session', '缺少会话 ID。');
  const bot = resolveBot(payload);
  try {
    const data = await collect(ctx, sessionId, { maxAnswers: 3, ...scopeOf(payload) });
    return ok({
      sessionId: data.sessionId,
      title: data.title,
      turn: Number.isInteger(data.turn) ? data.turn : scopeOf(payload).turn,
      counts: { prompts: data.prompts.length, answers: data.answers.length, files: data.files.length },
      bot: publicBot(bot),
      bots: listBots().map(publicBot),
    });
  } catch (error) {
    return fail('ril/collect-failed', error?.message ?? '读取会话失败');
  }
}

async function shareSend(payload, ctx) {
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return fail('ril/missing-session', '缺少会话 ID。');
  const bot = resolveBot(payload);
  if (!bot) return fail('ril/no-bot', '还没有绑定机器人，请先到设置里绑定飞书或微信。');
  const include = normalizeInclude(payload?.include);

  let data;
  try {
    data = await collect(ctx, sessionId, { maxAnswers: 3, ...scopeOf(payload) });
  } catch (error) {
    return fail('ril/collect-failed', error?.message ?? '读取会话失败');
  }

  const hasBody = include.prompts || include.answers;
  if (!hasBody && !(include.files && data.files.length)) {
    return fail('ril/empty', '这次没有可发送的内容（可勾选提示词 / 回复 / 文件）。');
  }

  const settings = currentSettings();
  const pkg = include.files
    ? await packageFiles(data, data.files, { zip: settings.zip })
    : { fileItems: [], attach: null, files: [], zipError: null };
  const theme = resolveTheme(settings, data.title);
  const cards = hasBody && bot.platform === 'feishu'
    ? [buildCard({ ...data, fileItems: pkg.fileItems }, include, theme, { summarize: settings.summarize })]
    : null;
  const text = buildText(data, include);

  let report;
  try {
    report = await sendViaBot(bot, { text, cards, attach: pkg.attach, files: pkg.files });
    markSend(bot.id, null);
  } catch (error) {
    markSend(bot.id, error?.message ?? String(error));
    return fail('ril/send-failed', withPlatformError(error, bot.platform));
  }

  return ok({
    bot: publicBot(bot),
    sessionId: data.sessionId,
    title: data.title,
    turn: Number.isInteger(data.turn) ? data.turn : scopeOf(payload).turn,
    counts: { prompts: data.prompts.length, answers: data.answers.length, files: data.files.length },
    packaged: pkg.attach ? { name: pkg.attach.name, bytes: pkg.attach.bytes, count: pkg.attach.count } : null,
    zipError: pkg.zipError,
    theme: theme.id,
    sent: report,
  });
}

// ---------------- 预处理：预存提示词 + 结果自动回传 ----------------

const AUTO_POLL_MS = 3000;
const arms = new Map();
// 等待上限从设置里读（默认 20 分钟，1–180 可调）；每次判断都取新值，改了立即生效。
const autoTimeoutMs = () => currentSettings().autoTimeoutMin * 60 * 1000;
const persistArms = () => saveArms(arms);

const armKey = (sessionId) => String(sessionId ?? '').replace(/^session-/, '');

const presetList = () => ok({ presets: listPresets(), store: '~/.dsh/read-it-later/presets.json' });

function presetSave(payload) {
  try {
    return ok({ presets: savePreset(payload) });
  } catch (error) {
    return fail('ril/bad-preset', error?.message ?? '保存预设失败');
  }
}

function presetDelete(payload) {
  if (typeof payload?.id !== 'string' || !payload.id) return fail('ril/bad-preset', '缺少预设 id。');
  try {
    return ok({ presets: removePreset(payload.id) });
  } catch (error) {
    return fail('ril/bad-preset', error?.message ?? '删除预设失败');
  }
}

function finishArm(rec, state, result, error) {
  rec.state = state;
  rec.result = result ?? null;
  rec.error = error ?? null;
  if (rec.timer) clearInterval(rec.timer);
  rec.timer = null;
  persistArms();
}

/** 轮询该会话日志：出现新一轮 turn/end 就把那一轮发出去。 */
async function tickArm(ctx, key) {
  const rec = arms.get(key);
  if (!rec || rec.state !== 'waiting') return;
  // 上一拍还在解日志（大日志要几秒）就跳过这一拍，避免同一条结果被并发发两次。
  if (rec.busy) return;
  rec.busy = true;
  try {
    await tickArmOnce(ctx, key);
  } finally {
    rec.busy = false;
  }
}

async function tickArmOnce(ctx, key) {
  const rec = arms.get(key);
  if (!rec || rec.state !== 'waiting') return;
  const timeoutMs = autoTimeoutMs();
  if (Date.now() - rec.startedAt > timeoutMs) {
    finishArm(rec, 'timeout', null, `等待结果超时（${Math.round(timeoutMs / 60000)} 分钟）。可以再点一次「预处理发送」重来。`);
    return;
  }

  let data;
  try {
    const st = fs.statSync(rec.armLog);
    if (st.size === rec.logSize) return; // 日志没长，直接跳过（避免每拍都解一次大日志）
  } catch {
    // 读不到 stat 就照常解一次
  }
  try {
    data = await collect(ctx, rec.sessionId, { maxAnswers: 3, withLog: true });
  } catch {
    return; // 日志暂时读不到，下一拍再试
  }
  if (Number.isInteger(data.turns)) rec.armLog = data.logFile || rec.armLog;
  try {
    rec.logSize = data.logFile ? fs.statSync(data.logFile).size : rec.logSize;
  } catch {
    // 忽略
  }
  if (!(Number.isInteger(data.turns) && data.turns > rec.baseline)) return;

  const turn = Number.isInteger(data.lastTurn) ? data.lastTurn : null;
  let scoped;
  try {
    scoped = await collect(ctx, rec.sessionId, { maxAnswers: 3, turn, withLog: true });
  } catch (error) {
    finishArm(rec, 'error', null, error?.message ?? '读取结果失败');
    return;
  }

  const bot = getBot(rec.botId);
  if (!bot) {
    finishArm(rec, 'error', null, '机器人已被移除。');
    return;
  }

  const include = rec.include;
  const hasBody = include.prompts || include.answers;
  const settings = currentSettings();
  const pkg = include.files
    ? await packageFiles(scoped, scoped.files, { zip: settings.zip })
    : { fileItems: [], attach: null, files: [], zipError: null };
  const theme = resolveTheme(settings, scoped.title);
  const cards = hasBody && bot.platform === 'feishu'
    ? [buildCard({ ...scoped, fileItems: pkg.fileItems }, include, theme, { summarize: settings.summarize })]
    : null;
  const text = buildText(scoped, include);

  try {
    const report = await sendViaBot(bot, { text, cards, attach: pkg.attach, files: pkg.files });
    markSend(bot.id, null);
    finishArm(rec, 'done', {
      turn,
      counts: { prompts: scoped.prompts.length, answers: scoped.answers.length, files: scoped.files.length },
      packaged: pkg.attach ? { name: pkg.attach.name, bytes: pkg.attach.bytes, count: pkg.attach.count } : null,
      sent: report,
    }, null);
  } catch (error) {
    markSend(bot.id, error?.message ?? String(error));
    finishArm(rec, 'error', null, withPlatformError(error, bot.platform));
  }
}

async function autoArm(payload, ctx) {
  const sessionId = payload?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return fail('ril/missing-session', '缺少会话 ID。');
  const bot = resolveBot(payload);
  if (!bot) return fail('ril/no-bot', '还没有绑定机器人，请先绑定飞书或微信。');

  let data;
  try {
    data = await collect(ctx, sessionId, { maxAnswers: 3, withLog: true });
  } catch (error) {
    return fail('ril/collect-failed', error?.message ?? '读取会话失败');
  }
  if (!Number.isInteger(data.turns)) {
    return fail('ril/no-turns', '读不到本会话的轮次计数，无法判断「这一轮结束」，请先把会话跑完一轮再试。');
  }

  const key = armKey(sessionId);
  const old = arms.get(key);
  if (old?.timer) clearInterval(old.timer);

  let logSize = 0;
  try {
    logSize = data.logFile ? fs.statSync(data.logFile).size : 0;
  } catch {
    logSize = 0;
  }

  const rec = {
    sessionId,
    botId: bot.id,
    include: normalizeInclude(payload?.include),
    // 从「思考中」的按钮预约发送时，若这一轮其实刚好已经结束（openTurn=false），
    // 把基线往前挪一格，第一拍就把刚结束的这轮发出去，而不是干等下一轮。
    baseline: payload?.fromRunning && data.openTurn === false && Number.isInteger(data.turns)
      ? Math.max(0, data.turns - 1)
      : (Number.isInteger(data.turns) ? data.turns : 0),
    armLog: data.logFile ?? null,
    logSize,
    startedAt: Date.now(),
    state: 'waiting',
    timer: null,
    error: null,
    result: null,
  };
  rec.timer = setInterval(() => {
    void tickArm(ctx, key).catch(() => {});
  }, AUTO_POLL_MS);
  if (typeof rec.timer?.unref === 'function') rec.timer.unref();
  arms.set(key, rec);
  persistArms();

  return ok({ armed: true, baseline: rec.baseline, state: rec.state, bot: publicBot(bot) });
}

function autoStatus(payload) {
  const rec = arms.get(armKey(payload?.sessionId));
  if (!rec) return ok({ armed: false, state: 'idle' });
  return ok({
    armed: rec.state === 'waiting',
    state: rec.state,
    baseline: rec.baseline,
    startedAt: rec.startedAt,
    elapsedMs: Date.now() - rec.startedAt,
    timeoutAt: rec.state === 'waiting' ? rec.startedAt + autoTimeoutMs() : null,
    error: rec.error,
    result: rec.result,
  });
}

function autoCancel(payload) {
  const rec = arms.get(armKey(payload?.sessionId));
  if (!rec) return ok({ armed: false, state: 'idle' });
  finishArm(rec, 'cancelled', null, null);
  return ok({ armed: false, state: 'cancelled' });
}

/**
 * Host 启动时把上次没等完的「预处理发送」接回来。
 * - 还在窗口内的：重建定时器，并立刻打一拍（停机期间会话已经跑完的，这一拍就会补发）；
 * - 已经过期的：标成 timeout，告诉用户重来一次，而不是永远停在「等待中」。
 */
export async function restoreArms(ctx) {
  const stored = loadArms();
  const now = Date.now();
  const timeoutMs = autoTimeoutMs();
  let restored = 0;
  for (const [key, snap] of Object.entries(stored)) {
    if (!snap || snap.state !== 'waiting' || !snap.sessionId) continue;
    const startedAt = Number(snap.startedAt) || now;
    const rec = {
      sessionId: snap.sessionId,
      botId: snap.botId,
      include: normalizeInclude(snap.include),
      baseline: Number.isInteger(snap.baseline) ? snap.baseline : 0,
      armLog: snap.armLog ?? null,
      logSize: Number(snap.logSize) || 0,
      startedAt,
      state: 'waiting',
      timer: null,
      busy: false,
      error: null,
      result: null,
    };
    arms.set(key, rec);
    if (now - startedAt > timeoutMs) {
      finishArm(rec, 'timeout', null, `等待结果超时（插件重启时已超过 ${Math.round(timeoutMs / 60000)} 分钟）。可以再点一次「预处理发送」重来。`);
      continue;
    }
    rec.timer = setInterval(() => {
      void tickArm(ctx, key).catch(() => {});
    }, AUTO_POLL_MS);
    if (typeof rec.timer?.unref === 'function') rec.timer.unref();
    restored += 1;
    // 立刻打一拍：停机期间会话已经跑完的，这一拍就把结果补发出去。
    await tickArm(ctx, key).catch(() => {});
  }
  persistArms();
  return { restored };
}

/** 会话标题缓存：随机配色要按「会话标题」散列，标题只能从会话日志里读，读一次记住即可。 */
const titleCache = new Map();

async function titleOfSession(sessionId, ctx) {
  if (!sessionId) return '';
  if (titleCache.has(sessionId)) return titleCache.get(sessionId);
  try {
    const data = await collect(ctx, sessionId, { maxAnswers: 1 });
    const title = data?.title || '';
    if (title) {
      if (titleCache.size > 200) titleCache.clear();
      titleCache.set(sessionId, title);
    }
    return title;
  } catch {
    return '';
  }
}

async function settingsGet(payload, ctx) {
  const seed = (await titleOfSession(payload?.sessionId, ctx)) || payload?.sessionId || '';
  return ok(publicSettings({ seed }));
}

async function settingsSet(payload, ctx) {
  const patch = {};
  for (const key of ['themeId', 'randomTheme', 'summarize', 'zip', 'unlocked', 'autoTimeoutMin', 'monitorTurns', 'monitorAsk']) {
    if (payload?.[key] !== undefined) patch[key] = payload[key];
  }
  if (!Object.keys(patch).length) return fail('ril/bad-request', '没有需要保存的设置。');
  const gated = ['themeId', 'randomTheme', 'summarize', 'zip', 'autoTimeoutMin', 'monitorTurns', 'monitorAsk'].some((k) => patch[k] !== undefined);
  if (gated && !currentSettings().unlocked) {
    return fail('ril/locked', '高级设置请支持本项目：点开项目主页点个 Star 后再生效。');
  }
  updateSettings(patch);
  const seed = (await titleOfSession(payload?.sessionId, ctx)) || payload?.sessionId || '';
  return ok(publicSettings({ seed }));
}

const HANDLERS = {
  status,
  // 诊断：宿主是否暴露了会话控制器（飞书卡片点选要靠它把回答写回会话）
  'debug.controller': (_payload, ctx) => {
    let controller = null;
    try {
      controller = ctx.get?.('sessionController') ?? null;
    } catch {
      controller = null;
    }
    return ok({ hasController: Boolean(controller?.prompt), keys: controller ? Object.keys(controller).slice(0, 8) : [] });
  },
  // 诊断：试出 sessionController.prompt 的正确调用方式（不写入任何真实会话）
  'debug.prompt': async (_payload, ctx) => {
    let controller = null;
    try {
      controller = ctx.get?.('sessionController') ?? null;
    } catch (error) {
      return ok({ stage: 'get', error: error?.message ?? String(error) });
    }
    if (!controller?.prompt) return ok({ stage: 'get', error: 'no controller' });
    const request = {
      sessionId: 'ril-does-not-exist',
      content: [{ type: 'text', text: 'ping' }],
      mode: 'steer',
    };
    const attempt = async (label, fn) => {
      try {
        await fn();
        return { label, ok: true };
      } catch (error) {
        return { label, ok: false, error: error?.message ?? String(error) };
      }
    };
    const results = [];
    results.push(await attempt('prompt(req)', () => controller.prompt(request)));
    results.push(await attempt('prompt(req, signal)', () => controller.prompt(request, AbortSignal.timeout(5000))));
    const remote = controller.typertRemote;
    results.push({ label: 'typertRemote', keys: remote ? Object.keys(remote).slice(0, 10) : null, type: typeof remote });
    return ok({ fn: { type: typeof controller.prompt, length: controller.prompt.length }, results });
  },
  'monitor.status': () => ok(monitorStatus()),
  'monitor.tick': async () => ok(await monitorTick()),
  'bind.begin': bindBegin,
  'bind.poll': bindPoll,
  'bind.verify': bindVerify,
  'bind.cancel': bindCancel,
  'bind.manual': bindManual,
  'bot.remove': botRemove,
  'bot.rename': botRename,
  'bot.test': botTest,
  'share.preview': sharePreview,
  'share.send': shareSend,
  'preset.list': presetList,
  'preset.save': presetSave,
  'preset.delete': presetDelete,
  'auto.arm': autoArm,
  'auto.status': autoStatus,
  'auto.cancel': autoCancel,
  'settings.get': settingsGet,
  'settings.set': settingsSet,
};

export function mountRpc(ctx) {
  const register = ctx?.connection?.fetch?.register;
  if (typeof register !== 'function') {
    throw new TypeError('DSH Host Connection Fetch registry is required');
  }

  return register({
    path: RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const ct = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (ct !== 'application/json') return new Response('content type must be application/json', { status: 415 });

      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ type: 'server-response', rpcId: null, result: fail('ril/bad-json', '请求体不是 JSON。') });
      }

      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : null;
      // body.method 是端点名（read-it-later），真正的动作在 payload.method。
      const method = body?.payload?.method;
      const payload = body?.payload?.payload ?? {};
      const handler = HANDLERS[method];
      if (!handler) {
        return Response.json({
          type: 'server-response',
          rpcId,
          result: fail('ril/unknown-method', `未知方法：${method ?? '?'}`),
        });
      }

      try {
        const result = await handler(payload, ctx);
        return Response.json({ type: 'server-response', rpcId, result });
      } catch (error) {
        return Response.json({
          type: 'server-response',
          rpcId,
          result: fail('ril/internal', error?.message ?? '服务内部错误'),
        });
      }
    },
  });
}

export function shutdown() {
  cancelAll();
}
