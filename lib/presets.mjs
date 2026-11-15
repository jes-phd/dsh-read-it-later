// 「预处理」预存提示词：存在 ~/.dsh/read-it-later/presets.json。
// 每条预设 = 一段提示词，点一下就会送进当前会话，结果由 auto 模块自动回传到机器人。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.dsh', 'read-it-later');
const FILE = path.join(DIR, 'presets.json');

/** 首次使用时写入的三条默认预设。 */
export const DEFAULT_PRESETS = [
  {
    text: '我要换到另一台设备继续这个项目：请把本会话已经完成的工作整理成一个离线交接压缩包（zip），里面包含 ① 一份交接说明（目标、已完成、当前状态、关键决策与理由、遗留问题、下一步），② 本会话里生成的全部文件，③ 必要的上下文与记忆摘要；目的是让下一台设备上的我（或另一个 AI 会话）能直接读懂进度并继续探索。压缩包用「会话标题 + 日期」命名。',
  },
  {
    text: '把本会话里产生的待办事项整理成清单，按优先级排序，并标注负责人（如果有）。',
  },
  {
    text: '帮我总结今天本会话的所有内容，结果会形成一个“总结+日期”的 MD 文件。',
  },
];

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function readRaw() {
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.presets) ? parsed.presets : null;
  } catch {
    return null;
  }
}

function writeRaw(presets) {
  ensureDir();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, presets }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function normalize(item, index) {
  const text = String(item?.text ?? '').trim();
  if (!text) return null;
  return {
    id: typeof item?.id === 'string' && item.id ? item.id : `p${index + 1}-${text.length}`,
    text,
    createdAt: Number.isFinite(item?.createdAt) ? item.createdAt : Date.now(),
  };
}

/** 读取预设；文件不存在时写入默认三条。 */
export function listPresets() {
  const raw = readRaw();
  if (!raw) {
    const seeded = DEFAULT_PRESETS.map((p, i) => normalize({ ...p, id: `preset-${i + 1}` }, i)).filter(Boolean);
    try {
      writeRaw(seeded);
    } catch {
      // 只读环境下仍返回默认值，不影响界面显示
    }
    return seeded;
  }
  return raw.map(normalize).filter(Boolean);
}

/** 新增或更新一条预设。 */
export function savePreset(input) {
  const text = String(input?.text ?? '').trim();
  if (!text) throw new Error('提示词不能为空。');
  const presets = listPresets();
  const id = typeof input?.id === 'string' && input.id ? input.id : '';
  const at = presets.findIndex((p) => p.id === id);
  if (at >= 0) {
    presets[at] = { ...presets[at], text };
  } else {
    presets.push({ id: `preset-${Date.now().toString(36)}`, text, createdAt: Date.now() });
  }
  writeRaw(presets);
  return presets;
}

/** 删除一条预设。 */
export function removePreset(id) {
  const presets = listPresets().filter((p) => p.id !== id);
  writeRaw(presets);
  return presets;
}

export const PRESET_FILE = FILE;
