// 绑定编排：飞书 device registration / 微信 iLink 扫码，后台轮询并把结果写进 bots.json。
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { beginRegistration, pollRegistrationOnce, qrDataUrl } from './feishu.mjs';
import * as weixin from './weixin.mjs';
import { addBot, newId } from './store.mjs';

const attempts = new Map();
const TTL_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function publicAttempt(a) {
  return {
    attemptId: a.id,
    platform: a.platform,
    state: a.state,
    message: a.message ?? '',
    qrImage: a.qrImage ?? '',
    qrUrl: a.qrUrl ?? '',
    expiresAt: a.expiresAt,
  };
}

// 微信返回的 qrcode_img_content 是一个「扫开后渲染二维码」的落地页（HTML），
// 不是图片本身；所以这里用链接文本在本地重新编码成 PNG，行为与 dsh-im 一致。
async function qrFromUrl(url) {
  if (!url) return '';
  try {
    return await QRCode.toDataURL(url, { type: 'image/png', errorCorrectionLevel: 'M', margin: 2, width: 320 });
  } catch {
    return url;
  }
}

function finish(a, state, message, botId) {
  a.state = state;
  a.message = message;
  a.finishedAt = Date.now();
  if (botId) a.botId = botId;
  setTimeout(() => {
    if (attempts.get(a.id) === a) attempts.delete(a.id);
  }, 5 * 60 * 1000).unref?.();
}

async function feishuLoop(a) {
  try {
    while (!a.cancelled && Date.now() < a.expiresAt) {
      const r = await pollRegistrationOnce({ base: a.base, deviceCode: a.deviceCode });
      if (a.cancelled) return;
      if (r.state === 'ready') {
        const bot = addBot({
          id: newId('feishu'),
          platform: 'feishu',
          name: r.name || '飞书机器人',
          appId: r.appId,
          appSecret: r.appSecret,
          openId: r.openId,
          domain: r.domain,
          createdAt: Date.now(),
        });
        finish(a, 'done', '绑定成功', bot.id);
        return;
      }
      if (r.state === 'slow_down') {
        a.intervalMs = Math.max(a.intervalMs, r.intervalMs ?? 5000);
      } else if (r.state === 'pending') {
        // keep waiting
      } else {
        finish(a, 'error', r.message || '授权失败');
        return;
      }
      await sleep(a.intervalMs);
    }
    if (!a.cancelled) finish(a, 'expired', '二维码已过期，请重新生成');
  } catch (error) {
    if (!a.cancelled) finish(a, 'error', error?.message ?? '绑定失败');
  }
}

function waitForCode(a) {
  return new Promise((resolve) => {
    a.codeResolver = resolve;
  });
}

async function weixinLoop(a) {
  try {
    while (!a.cancelled && Date.now() < a.expiresAt) {
      if (a.state === 'needs_code' && !a.verifyCode) {
        await waitForCode(a);
        if (a.cancelled) return;
      }
      const r = await weixin.pollLogin({ qrcode: a.qrcode, baseUrl: a.baseUrl, verifyCode: a.verifyCode });
      if (a.cancelled) return;
      switch (r?.status) {
        case 'wait':
          a.state = 'pending';
          a.message = '等待扫码';
          break;
        case 'scaned':
          a.state = 'scanned';
          a.message = '已扫码，请在手机上确认';
          a.verifyCode = null;
          break;
        case 'scaned_but_redirect':
          a.baseUrl = weixin.normalizeBaseUrl(r.redirect_host, a.baseUrl);
          a.state = 'scanned';
          break;
        case 'need_verifycode':
          a.state = 'needs_code';
          a.message = '请输入手机上显示的配对码';
          a.verifyCode = null;
          break;
        case 'verify_code_blocked':
          finish(a, 'error', '配对码错误次数过多，请重新生成二维码');
          return;
        case 'expired':
          finish(a, 'expired', '二维码已过期，请重新生成');
          return;
        case 'binded_redirect':
          finish(a, 'error', '该微信账号已在本机绑定过，请在列表里查看');
          return;
        case 'confirmed': {
          if (!r.bot_token || !r.ilink_bot_id || !r.ilink_user_id) {
            finish(a, 'error', '微信授权成功但凭据不完整');
            return;
          }
          const bot = addBot({
            id: newId('weixin'),
            platform: 'weixin',
            name: '微信机器人',
            token: r.bot_token,
            baseUrl: weixin.normalizeBaseUrl(r.baseurl, a.baseUrl),
            wxBotId: r.ilink_bot_id,
            ownerUserId: r.ilink_user_id,
            createdAt: Date.now(),
          });
          finish(a, 'done', '绑定成功', bot.id);
          return;
        }
        default:
          finish(a, 'error', `未识别的扫码状态：${r?.status ?? '?'}`);
          return;
      }
    }
    if (!a.cancelled) finish(a, 'expired', '二维码已过期，请重新生成');
  } catch (error) {
    if (!a.cancelled) finish(a, 'error', error?.message ?? '绑定失败');
  }
}

export async function beginBind(platform) {
  if (platform !== 'feishu' && platform !== 'weixin') throw new Error('只支持飞书和微信');
  const now = Date.now();
  // 同一平台只保留一个在途尝试，避免同时开多个二维码。
  for (const old of attempts.values()) {
    if (old.platform === platform && !old.finishedAt) {
      old.cancelled = true;
      attempts.delete(old.id);
    }
  }

  if (platform === 'feishu') {
    const r = await beginRegistration({});
    const a = {
      id: `att-${randomBytes(6).toString('hex')}`,
      platform,
      state: 'pending',
      message: '等待扫码',
      createdAt: now,
      expiresAt: now + r.expiresIn * 1000,
      base: r.base,
      deviceCode: r.deviceCode,
      intervalMs: r.intervalMs,
      qrUrl: r.qrUrl,
      qrImage: await qrDataUrl(r.qrUrl),
      cancelled: false,
    };
    attempts.set(a.id, a);
    feishuLoop(a);
    return publicAttempt(a);
  }

  const r = await weixin.beginLogin();
  const a = {
    id: `att-${randomBytes(6).toString('hex')}`,
    platform,
    state: 'pending',
    message: '等待扫码',
    createdAt: now,
    expiresAt: now + TTL_MS,
    baseUrl: r.baseUrl,
    qrcode: r.qrcode,
    qrUrl: r.qrUrl,
    qrImage: await qrFromUrl(r.qrUrl),
    verifyCode: null,
    cancelled: false,
  };
  attempts.set(a.id, a);
  weixinLoop(a);
  return publicAttempt(a);
}

export function bindStatus(attemptId) {
  const a = attempts.get(attemptId);
  if (!a) return null;
  return { ...publicAttempt(a), botId: a.botId ?? null };
}

export function submitCode(attemptId, code) {
  const a = attempts.get(attemptId);
  if (!a || a.state !== 'needs_code') return null;
  a.verifyCode = String(code);
  const resolve = a.codeResolver;
  a.codeResolver = null;
  a.state = 'pending';
  a.message = '正在校验配对码…';
  resolve?.(true);
  return publicAttempt(a);
}

export function cancelBind(attemptId) {
  const a = attempts.get(attemptId);
  if (!a) return false;
  a.cancelled = true;
  a.codeResolver?.(false);
  finish(a, 'cancelled', '已取消');
  return true;
}

export function cancelAll() {
  for (const a of attempts.values()) {
    a.cancelled = true;
    a.codeResolver?.(false);
  }
  attempts.clear();
}
