// 自动回传的「待命臂」持久化。
//
// 为什么要有它：autoreply 的等待记录原来只存在内存 Map 里，DSH 一重启（升级、
// 换配置、崩溃）就丢了 —— 用户明明点了「预处理发送」，回来却什么都没收到。
// 现在每次 arm / 收尾都落盘到 ~/.dsh/read-it-later/arms.json，Host 起来时
// restoreArms() 读回来：还在超时窗口内的继续盯，已经过期的标成 timeout，
// 停机期间已经跑完的那一轮会在第一拍就被发现并补发。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.dsh', 'read-it-later');
// 测试可以用 RIL_ARMS_FILE 指到临时文件，避免动到用户真实的等待记录。
export const ARMS_FILE = process.env.RIL_ARMS_FILE || join(DIR, 'arms.json');

function ensureDir() {
  const dir = join(ARMS_FILE, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 只保留需要落盘的字段：timer 这类运行时句柄不能序列化。 */
export function armSnapshot(rec) {
  return {
    sessionId: rec.sessionId,
    botId: rec.botId,
    include: rec.include,
    baseline: rec.baseline,
    armLog: rec.armLog ?? null,
    logSize: rec.logSize ?? 0,
    startedAt: rec.startedAt,
    state: rec.state,
    error: rec.error ?? null,
    result: rec.result ?? null,
    updatedAt: Date.now(),
  };
}

export function loadArms() {
  try {
    const raw = readFileSync(ARMS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const arms = data?.arms;
    if (!arms || typeof arms !== 'object') return {};
    return arms;
  } catch {
    return {};
  }
}

export function saveArms(arms) {
  try {
    ensureDir();
    const body = { version: 1, arms: {} };
    // 传进来的可能是 Map（rpc.mjs 里就是），也可能是普通对象。
    const entries = arms instanceof Map ? [...arms.entries()] : Object.entries(arms || {});
    for (const [key, rec] of entries) {
      body.arms[key] = rec?.timer || rec?.state ? armSnapshot(rec) : rec;
    }
    const tmp = `${ARMS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 1), { mode: 0o600 });
    renameSync(tmp, ARMS_FILE);
  } catch {
    // 落盘失败不影响主流程（最坏情况就是重启后不补发）
  }
}
