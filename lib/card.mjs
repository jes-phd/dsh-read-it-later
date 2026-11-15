// 把一轮会话内容排版成飞书「消息卡片」（schema 2.0）：
// 彩色标题栏、元信息分栏、可折叠的提示词、正文（标题/列表/代码块/表格）、文件清单。
// 目的：把原来的一大段纯文本变成可扫读的卡片。

const MAX_MD = 2800; // 单个 markdown 元素的安全长度
const MAX_TABLE_ROWS = 30;
const MAX_TABLE_COLS = 6;

const plain = (s) => ({ tag: 'plain_text', content: String(s ?? '') });

function clip(s, n = 400) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 去掉 markdown 记号，用于卡片 table 的单元格（table 单元格不解析 markdown）。 */
function stripMd(s) {
  return String(s ?? '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把一段 markdown 拆成卡片元素：标题、表格、分割线、正文。 */
function blocksOf(markdown, opts = {}) {
  const out = [];
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let buf = [];
  let i = 0;

  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    for (const piece of splitLong(text, MAX_MD)) {
      out.push({ tag: 'markdown', content: piece, text_size: 'normal' });
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 表格：表头行 + 分隔行 + 数据行
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      const header = splitRow(line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        rows.push(splitRow(lines[j]));
        j += 1;
      }
      out.push(opts.plainTable ? { tag: 'markdown', content: tableToMd(header, rows), text_size: 'normal' } : tableOf(header, rows));
      i = j;
      continue;
    }

    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ tag: 'hr' });
      i += 1;
      continue;
    }

    // 标题 → 加粗行（卡片 markdown 的 # 支持不稳定，用加粗 + 字号模拟）
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      out.push({ tag: 'markdown', content: `**${h[2].replace(/\*\*/g, '')}**`, text_size: level <= 2 ? 'heading' : 'normal' });
      i += 1;
      continue;
    }

    buf.push(line);
    i += 1;
  }
  flush();
  return out;
}

function tableToMd(header, rows) {
  const head = `**${header.join(' · ')}**`;
  const body = rows.slice(0, 40).map((r) => `• ${r.join(' · ')}`);
  if (rows.length > 40) body.push(`… 还有 ${rows.length - 40} 行`);
  return [head, ...body].join('\n');
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => stripMd(c));
}

function tableOf(header, rows) {
  const cols = Math.min(header.length, MAX_TABLE_COLS);
  const columns = [];
  for (let c = 0; c < cols; c += 1) {
    columns.push({
      name: `c${c}`,
      display_name: clip(header[c] || `列${c + 1}`, 40),
      data_type: 'text',
      width: 'auto',
      horizontal_align: 'left',
    });
  }
  const body = rows.slice(0, MAX_TABLE_ROWS).map((r) => {
    const row = {};
    for (let c = 0; c < cols; c += 1) row[`c${c}`] = clip(r[c] || '', 220);
    return row;
  });
  const extra = rows.length > MAX_TABLE_ROWS ? `（仅显示前 ${MAX_TABLE_ROWS} 行，共 ${rows.length} 行）` : '';
  return {
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', bold: true, lines: 1 },
    columns,
    rows: body,
    ...(extra ? { footer: plain(extra) } : {}),
  };
}

/** 按段落边界把超长文本切成若干块。 */
function splitLong(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.4) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function metaLine(data) {
  const bits = [];
  if (Number.isInteger(data.turn)) bits.push(`第 ${data.turn} 轮`);
  bits.push(stamp());
  if (data.cwd) bits.push(clip(data.cwd, 60));
  if (data.files?.length) bits.push(`${data.files.length} 个文件`);
  return { tag: 'markdown', content: `<font color='grey'>${bits.join(' · ')}</font>`, text_size: 'notation' };
}

function panel(title, content, expanded = false) {
  const el = {
    tag: 'collapsible_panel',
    expanded,
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '6px' },
    vertical_spacing: '8px',
    padding: '8px',
    elements: [],
  };
  if (Array.isArray(content)) {
    el.elements.push(...content);
    return el;
  }
  for (const piece of splitLong(content, MAX_MD)) {
    el.elements.push({ tag: 'markdown', content: piece, text_size: 'normal' });
  }
  return el;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 组装卡片。
 * @param {{title?:string,turn?:number,cwd?:string,sessionId:string,prompts?:string[],answers?:string[],files?:string[]}} data
 * @param {{prompts?:boolean,answers?:boolean,files?:boolean}} include
 */
// 全文模式下的正文上限：超长会截断，并提示「完整内容见附件」之外的补充说明。
const FULL_LIMIT = 6000;

export function buildCard(data, include, theme = null, options = {}) {
  const summarizeMode = options.summarize !== false;
  const when = stamp();
  const subtitle = [Number.isInteger(data.turn) ? `第 ${data.turn} 轮` : '', when].filter(Boolean).join(' · ');
  const template = theme?.feishuTemplate || 'blue';
  const items = fileItemsOf(data);

  const elements = [];

  if (include.prompts && data.prompts?.length) {
    const full = data.prompts.join('\n\n');
    const q = summarizeMode ? summarize(full, 100) : clip(full, FULL_LIMIT);
    elements.push({ tag: 'markdown', content: `**❓ 提示词**\n${q}`, text_size: 'normal' });
  }

  if (include.answers && data.answers?.length) {
    const full = data.answers.join('\n\n');
    const a = summarizeMode ? summarize(full, 100) : clip(full, FULL_LIMIT);
    if (elements.length) elements.push({ tag: 'hr' });
    if (summarizeMode) {
      elements.push({ tag: 'markdown', content: `**💬 答复**\n${a}`, text_size: 'normal' });
    } else {
      elements.push({ tag: 'markdown', content: '**💬 答复**', text_size: 'normal' });
      elements.push(...blocksOf(full, { plainTable: true }));
    }
  }

  // 文件列表排在「详情」之上，逗号横排，尽量少占纵向空间
  if (include.files && items.length) {
    if (elements.length) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**📎 附件（${items.length}）**\n${items.join('，')}`,
      text_size: 'normal',
    });
  }

  // 关掉「摘要显示」时全文已经在上面的答复块里，就不再需要「详情」折叠面板
  if (summarizeMode && include.answers && data.answers?.length) {
    elements.push(panel('📄 详情：完整回复', blocksOf(data.answers.join('\n\n'), { plainTable: true }), false));
  }

  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>${dateTime(when)} · DSH</font>`,
    text_size: 'notation',
  });

  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: plain(clip(data.title || '会话分享', 40)),
      subtitle: plain(subtitle),
      template,
      padding: '12px 16px 12px 16px',
    },
    body: { elements },
  };
}

/** 文件清单：优先用 RPC 传来的 {name,sizeLabel}，否则退回路径。 */
function fileItemsOf(data) {
  const raw = Array.isArray(data.fileItems) && data.fileItems.length
    ? data.fileItems
    : (data.files ?? []).map((p) => ({ name: String(p).split(/[\\/]/).pop(), sizeLabel: '' }));
  const shown = raw.slice(0, 12).map((f) => (f.sizeLabel ? `${f.name}（${f.sizeLabel}）` : f.name));
  if (raw.length > 12) shown.push(`…等 ${raw.length} 个`);
  return shown;
}

function dateTime(when) {
  return when;
}

/** 摘要：去掉 Markdown 记号，压成一行，默认 100 字以内。 */
function summarize(markdown, limit = 100) {
  const flat = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*:?-{3,}/.test(l) && !/^\s*>/.test(l))
    .join('\n')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 拆卡片接口保留给旧的调用方：现在固定只返回一张大卡片。
 * @param {object} data
 * @param {{prompts?:boolean,answers?:boolean,files?:boolean}} include
 */
export function buildCards(data, include, theme = null, options = {}) {
  return [buildCard(data, include, theme, options)];
}
/** 纯文本兜底：卡片发送失败时退回原来的文本方案。 */
export function buildText(data, include) {
  const lines = [];
  lines.push(`📤【会话分享】${data.title || '(未命名会话)'}`);
  if (data.cwd) lines.push(`🧭 工作区：${data.cwd}`);
  if (Number.isInteger(data.turn)) lines.push(`🔢 轮次：第 ${data.turn} 轮`);
  lines.push(`🕒 时间：${stamp()}`);
  lines.push(`🆔 会话：${data.sessionId}`);
  if (include.prompts && data.prompts?.length) {
    lines.push('', '———— 提示词 ————');
    data.prompts.forEach((p) => lines.push(clip(p, 2000)));
  }
  if (include.answers && data.answers?.length) {
    lines.push('', '———— 结果 ————');
    data.answers.forEach((a) => lines.push(clip(a, 6000), ''));
  }
  if (include.files && data.files?.length) {
    lines.push('', `📎 附带文件：${data.files.length} 个（另发文件消息）`);
  }
  return lines.join('\n').trim();
}

/** 一张「小卡片」：窄标题栏 + 少量元素，便于在飞书里快速扫读。 */
function smallCard(title, subtitle, template, elements) {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: plain(title),
      subtitle: plain(subtitle),
      template,
      padding: '8px 12px 8px 12px',
    },
    body: { elements },
  };
}

function fileLines(files) {
  return files.slice(0, 15).map((f) => {
    const base = String(f).split(/[\\/]/).pop();
    return `• ${clip(base, 60)}`;
  }).join('\n');
}

/**
 * 把一轮内容拆成多张小卡片：提示词 / 回复内容 / 文件清单各一张。
 * 只发一张大卡片时正文过长，拆开后每张都短，飞书里能一屏读完。
 * @param {object} data collect() 的结果
 * @param {{prompts?:boolean,answers?:boolean,files?:boolean}} include
 * @returns {object[]} 可直接逐张发送的卡片数组
 */
