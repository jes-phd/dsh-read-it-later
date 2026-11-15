// 插件外观 / 发送行为设置。
// 存在 ~/.dsh/read-it-later/settings.json，0600，写入用临时文件 + rename。
//
// - randomTheme: 按会话标题散列出配色（同一个会话永远同一个颜色，不同会话尽量不同）
// - summarize:   飞书卡片只显示 100 字摘要 + 「详情」折叠面板；关掉则直接全文
// - zip:         附件打成一个 zip；关掉则逐个文件发送
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(homedir(), '.dsh', 'read-it-later');
export const SETTINGS_FILE = join(DIR, 'settings.json');

export const GITHUB_URL = 'https://github.com/jes-phd/dsh-read-it-later';

/** 组合：accent 用于按钮/选中态，accentSoft 用于选中底色，feishuTemplate 用于飞书卡片 header。 */
export const THEMES = [
  {
    id: 'default',
    name: '星野蓝',
    note: '当前默认',
    accent: '#2f6df6',
    accentSoft: 'rgba(47, 109, 246, 0.12)',
    feishuTemplate: 'blue',
  },
  {
    id: 'lavender',
    name: '淡紫',
    note: '安静',
    accent: '#8b5cf6',
    accentSoft: 'rgba(139, 92, 246, 0.14)',
    feishuTemplate: 'violet',
  },
  {
    id: 'butter',
    name: '淡黄',
    note: '明快',
    accent: '#c99a12',
    accentSoft: 'rgba(201, 154, 18, 0.16)',
    feishuTemplate: 'yellow',
  },
  {
    id: 'mint',
    name: '薄荷绿',
    note: '清爽',
    accent: '#0f9d76',
    accentSoft: 'rgba(15, 157, 118, 0.14)',
    feishuTemplate: 'green',
  },
  {
    id: 'rose',
    name: '玫瑰粉',
    note: '柔和',
    accent: '#d94b7c',
    accentSoft: 'rgba(217, 75, 124, 0.14)',
    feishuTemplate: 'carmine',
  },
  {
    id: 'sky',
    name: '天青',
    note: '通透',
    accent: '#0e8f9e',
    accentSoft: 'rgba(14, 143, 158, 0.14)',
    feishuTemplate: 'turquoise',
  },
  {
    id: 'sunset',
    name: '落日橙',
    note: '热烈',
    accent: '#d8641b',
    accentSoft: 'rgba(216, 100, 27, 0.14)',
    feishuTemplate: 'orange',
  },
  {
    id: 'indigo',
    name: '靛蓝',
    note: '沉稳',
    accent: '#4f46e5',
    accentSoft: 'rgba(79, 70, 229, 0.14)',
    feishuTemplate: 'indigo',
  },
  {
    id: 'ice',
    name: '冰蓝',
    note: '冷静',
    accent: '#3d8fd1',
    accentSoft: 'rgba(61, 143, 209, 0.14)',
    feishuTemplate: 'wathet',
  },
  {
    id: 'graphite',
    name: '石墨灰',
    note: '低调',
    accent: '#5b6570',
    accentSoft: 'rgba(91, 101, 112, 0.14)',
    feishuTemplate: 'grey',
  },
];

export const DEFAULT_SETTINGS = {
  themeId: 'default',
  randomTheme: true,
  summarize: true,
  zip: true,
  // 高级设置默认锁着：点开项目主页（点个 Star）之后才解锁。
  unlocked: false,
};

function ensureDir() {
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
  } catch {}
}

function read() {
  try {
    if (!existsSync(SETTINGS_FILE)) return {};
    const raw = readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(next) {
  ensureDir();
  const tmp = `${SETTINGS_FILE}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, SETTINGS_FILE);
}

export function themeById(id) {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** FNV-1a 32 位散列：同一个种子永远落到同一个配色。 */
function hash32(text) {
  let h = 0x811c9dc5;
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function themeForSeed(seed) {
  if (!seed) return THEMES[0];
  return THEMES[hash32(seed) % THEMES.length];
}

export function currentSettings() {
  const raw = read();
  return {
    themeId: themeById(raw.themeId).id,
    randomTheme: raw.randomTheme !== false,
    summarize: raw.summarize !== false,
    zip: raw.zip !== false,
    unlocked: raw.unlocked === true,
    theme: themeById(raw.themeId),
  };
}

/** 这个会话实际用的主题：开了随机就按标题散列，否则用固定配色。 */
export function resolveTheme(settings, seed) {
  return settings.randomTheme ? themeForSeed(seed) : themeById(settings.themeId);
}

/** 部分更新：themeId / randomTheme / summarize / zip / unlocked。 */
export function updateSettings(patch = {}) {
  const raw = read();
  const next = { ...raw };
  if (typeof patch.themeId === 'string' && THEMES.some((t) => t.id === patch.themeId)) {
    next.themeId = patch.themeId;
  }
  if (typeof patch.unlocked === 'boolean') next.unlocked = patch.unlocked;
  for (const key of ['randomTheme', 'summarize', 'zip']) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  write(next);
  return currentSettings();
}

/**
 * 给前端 / RPC 用的公开设置。
 * seed 传会话标题（拿不到时传 sessionId）：决定「随机配色」下当前会话的颜色。
 */
export function publicSettings(extra = {}) {
  const settings = currentSettings();
  const seed = extra.seed ?? '';
  const current = resolveTheme(settings, seed);
  return {
    themeId: settings.themeId,
    randomTheme: settings.randomTheme,
    summarize: settings.summarize,
    zip: settings.zip,
    unlocked: settings.unlocked,
    themes: THEMES.map((t) => ({
      id: t.id,
      name: t.name,
      note: t.note,
      accent: t.accent,
      accentSoft: t.accentSoft,
      feishuTemplate: t.feishuTemplate,
    })),
    current,
    currentId: current.id,
    seed: seed || null,
    github: GITHUB_URL,
    settingsFile: SETTINGS_FILE,
  };
}
