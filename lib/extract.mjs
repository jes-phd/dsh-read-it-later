// Session-log analysis in pure JS.
//
// 原来靠 share-extract.py（Python + zstandard）解多帧 zstd 日志；
// 现在优先走 Host 的 sessionQuery.readSession()，它返回的就是完整的
// {type, seq, time, data} 事件数组，和落盘日志同构，于是这一层可以完全 JS 化，
// 机器上不再需要装 Python / zstandard。

/** 事件里是否为 user 真用户输入 */
function isUserMessage(rec) {
  const d = rec?.data ?? {};
  return d?.source?.kind === 'user';
}

/** 把 assistant/user message 的 content 里 type==='text' 的片段拼起来 */
export function textOf(msg) {
  const content = Array.isArray(msg?.content) ? msg.content : [];
  const parts = [];
  for (const c of content) {
    if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('\n').trim();
}

/** 给定 seq，判断它属于哪个 turn（该 turn 的 turn/start seq 是 <= seq 里最大的） */
export function turnOf(seq, starts) {
  let cur = null;
  for (const [st, tn] of starts) {
    if (typeof seq === 'number' && seq >= st) cur = tn;
    else if (typeof seq === 'number') break;
  }
  return cur;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function filesFromCall(d, push) {
  if (!['write', 'edit', 'present', 'save'].includes(d?.name)) return;
  const a = parseArgs(d?.arguments);
  if (typeof a.file_path === 'string') push(a.file_path);
  if (typeof a.path === 'string') push(a.path);
  for (const f of Array.isArray(a.files) ? a.files : []) {
    if (f && typeof f.path === 'string') push(f.path);
  }
}

/**
 * 把一个会话的事件数组整理成「可发送内容」。
 *
 * @param {Array<{type:string, seq:number, data:any}>} events
 * @param {{turn?: number|null, seq?: number|null, maxAnswers?: number}} [opts]
 */
export function analyzeEvents(events, opts = {}) {
  const maxAnswers = Number.isInteger(opts.maxAnswers) ? opts.maxAnswers : 3;
  const list = Array.isArray(events) ? events : [];

  const starts = [];
  for (const r of list) {
    const tn = r?.data?.turn;
    if (r?.type === 'turn/start' && Number.isInteger(tn)) starts.push([r.seq ?? 0, tn]);
  }
  starts.sort((a, b) => a[0] - b[0]);

  let want = Number.isInteger(opts.turn) ? opts.turn : null;
  if (want === null && Number.isInteger(opts.seq)) want = turnOf(opts.seq, starts);

  const inScope = (r) => (want === null ? true : turnOf(r?.seq, starts) === want);

  let title = null;
  let cwd = null;
  const prompts = [];
  const userMsgs = [];
  const answers = [];
  const files = [];
  const seen = new Set();
  let turns = 0;
  let lastTurnEnded = null;
  let replyParts = [];

  for (const r of list) {
    const t = r?.type;
    const d = r?.data ?? {};
    if (t === 'session' && cwd === null) {
      cwd = d.cwd ?? r.cwd ?? null;
    } else if (t === 'session/title') {
      const v = d.title;
      if (typeof v === 'string' && v.trim()) title = v.trim();
    } else if (t === 'turn/start') {
      if (Number.isInteger(d.turn)) lastTurnEnded = false;
    } else if (t === 'turn/end') {
      turns += 1;
      lastTurnEnded = true;
      if (replyParts.length) {
        // 定稿上一轮的答复文本，供「完成一轮」通知使用
        replyParts = replyParts.slice();
      }
    } else if (t === 'tool/call') {
      if (!inScope(r)) continue;
      filesFromCall(d, (p) => {
        if (p && !p.startsWith('<') && !seen.has(p)) {
          seen.add(p);
          files.push(p);
        }
      });
    } else if (t === 'user/message') {
      if (!isUserMessage(r)) continue;
      const txt = textOf(d);
      if (!txt) continue;
      if (inScope(r)) {
        if (!userMsgs.length || userMsgs[userMsgs.length - 1] !== txt) userMsgs.push(txt);
      }
    } else if (t === 'agent/inbox/spliced') {
      if (want !== null) continue;
      for (const ins of Array.isArray(d.inserted) ? d.inserted : []) {
        if (!ins || ins?.source?.kind !== 'user') continue;
        const txt = textOf({ content: ins.content });
        if (txt && (!prompts.length || prompts[prompts.length - 1] !== txt)) prompts.push(txt);
      }
    } else if (t === 'assistant/message') {
      if (!inScope(r)) continue;
      const txt = textOf(d.message);
      if (txt) answers.push({ turn: d.turn ?? turnOf(r?.seq, starts), text: txt });
    } else if (t === 'deliverables/presented') {
      if (!inScope(r)) continue;
      for (const f of Array.isArray(d.files) ? d.files : []) {
        const p = f && typeof f.path === 'string' ? f.path : null;
        if (p && !seen.has(p)) {
          seen.add(p);
          files.push(p);
        }
      }
    }
  }

  // 最后一轮是否还没结束（正在跑）
  const openTurn = lastTurnEnded === false;

  // 收尾：答案取最后 maxAnswers 条（或指定轮次的全部）
  const kept = want !== null ? answers : answers.slice(-Math.max(1, maxAnswers));
  const lastTurn = want !== null ? want : kept.length ? kept[kept.length - 1].turn : null;

  // 最后一条 assistant 文本（不带轮次过滤），用于「完成一轮」卡片详情
  let reply = '';
  for (const r of list) {
    if (r?.type === 'assistant/message') {
      const txt = textOf(r.data?.message);
      if (txt) reply = txt;
    }
  }

  return {
    title,
    cwd,
    turn: want,
    prompts: userMsgs.length ? userMsgs : prompts,
    answers: kept.map((a) => a.text),
    files,
    turns,
    lastTurn,
    openTurn,
    reply: reply.slice(0, 8000),
  };
}

/**
 * 状态监控用：一轮是否跑完、最后一条答复、是否需要你决定（提问 / 审批）。
 * @param {Array} events readSession().events
 */
export function scanSession(events) {
  const list = Array.isArray(events) ? events : [];
  let title = '';
  let cwd = '';
  let turns = 0;
  let lastTurn = 0;
  let reply = '';
  let cur = [];
  let lastEndIdx = -1;
  const questions = new Map();
  const approvals = new Map();

  list.forEach((rec, idx) => {
    const kind = rec?.type;
    const d = rec?.data ?? {};
    const at = rec?.time ?? d.time ?? null;

    if (kind === 'session/title') {
      const v = typeof d.title === 'string' ? d.title.trim() : '';
      if (v) title = v;
    } else if (kind === 'session') {
      if (typeof d.cwd === 'string') cwd = d.cwd;
    } else if (kind === 'assistant/message') {
      for (const part of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (part && part.type === 'text' && part.text) cur.push(part.text);
      }
    } else if (kind === 'turn/end') {
      turns += 1;
      lastEndIdx = idx;
      if (cur.length) {
        reply = cur.filter((t) => t.trim()).join('\n\n').trim();
        cur = [];
      }
      if (Number.isInteger(d.turn)) lastTurn = d.turn;
    } else if (kind === 'tool/call' && (d.name === 'ask_user_question' || d.name === 'question')) {
      const callId = d.callId;
      if (!callId) return;
      const payload = parseArgs(d.arguments);
      const first = Array.isArray(payload.questions) && payload.questions.length ? payload.questions[0] : {};
      const options = (Array.isArray(first.options) ? first.options : [])
        .map((o) => (o && typeof o.label === 'string' ? o.label : null))
        .filter(Boolean);
      questions.set(callId, {
        questionId: first.id || '',
        idx,
        at,
        title: first.header || '',
        text: first.question || payload.question || '',
        options,
      });
    } else if (kind === 'approval/asked') {
      if (d.id) {
        approvals.set(d.id, {
          idx,
          at,
          title: d.toolName || '',
          text: d.reason || '需要你确认这次操作',
          options: ['允许', '拒绝'],
        });
      }
    } else if (kind === 'approval/decided') {
      approvals.delete(d.id);
    } else if (kind === 'tool/result') {
      const line = JSON.stringify(d);
      for (const callId of [...questions.keys()]) {
        if (line.includes(callId)) questions.delete(callId);
      }
    }
  });

  const candidates = [];
  for (const [callId, info] of questions) if (info.idx > lastEndIdx) candidates.push(['question', callId, info]);
  for (const [askId, info] of approvals) if (info.idx > lastEndIdx) candidates.push(['approval', askId, info]);
  candidates.sort((a, b) => a[2].idx - b[2].idx);

  let pending = null;
  if (candidates.length) {
    const [kind, id, info] = candidates[candidates.length - 1];
    pending = {
      id,
      questionId: info.questionId || '',
      kind,
      title: info.title || '',
      text: info.text || '',
      options: info.options || [],
      at: info.at,
    };
  }

  return {
    title,
    cwd,
    turns,
    lastTurn,
    reply: reply.slice(0, 8000),
    openTurn: lastEndIdx !== list.length - 1,
    pending,
  };
}
