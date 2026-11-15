// dsh-read-it-later —— Web 客户端
// ① 每轮对话结尾的「发到 IM」按钮（可勾选提示词/回复/文件，选择已绑定机器人）
// ② 设置 → Read It Later：扫码绑定飞书 / 微信机器人（自带绑定，不依赖 dsh-im）
window.__ModuleLoader__.load({
  id: 'dsh-read-it-later',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    // 预存提示词：英文界面优先用 textEn（用户自己编辑过的只有 text）。
    const presetText = (preset) => {
      if (!preset) return '';
      const en = typeof preset.textEn === 'string' ? preset.textEn.trim() : '';
      return UI_LANG === 'en' && en ? en : preset.text;
    };

    // 跟随 DSH 界面语言：非中文环境插件整体切英文（文案走 L(中文, English)）。
    const UI_LANG = (() => {
      try {
        const html = typeof document !== 'undefined' ? document.documentElement?.getAttribute?.('lang') : '';
        const nav = typeof navigator !== 'undefined' ? navigator.language : '';
        return String(html || nav || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'zh';
      }
    })();
    const L = (zh, en) => (UI_LANG === 'en' ? en : zh);

    const RPC_PATH = '/api/read-it-later';
    const RPC_ENDPOINT = 'read-it-later';

    // 先走 Harness 的 RPC；没有 connection 服务时退回同源 fetch 裸协议。
    function makeCall(appCtx) {
      let seq = 0;
      return async function call(method, payload = {}) {
        let rpc;
        try {
          rpc = appCtx?.connection?.rpc;
        } catch {
          rpc = null;
        }
        if (rpc && typeof rpc.call === 'function') {
          try {
            return await rpc.call('/api', RPC_ENDPOINT, { method, payload });
          } catch (error) {
            if (!/without inject|not available|undefined/i.test(String(error?.message ?? error))) throw error;
          }
        }
        const rpcId = `ril-${Date.now()}-${++seq}`;
        const res = await fetch(RPC_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method: RPC_ENDPOINT, payload: { method, payload } }),
        });
        if (!res.ok) throw new Error(L(`接口不可达（HTTP ${res.status}）`, `Endpoint unreachable (HTTP ${res.status})`));
        const json = await res.json();
        if (json?.type !== 'server-response') throw new Error(L('接口返回格式不正确', 'Unexpected response format'));
        return json.result;
      };
    }

    function unwrap(result) {
      if (!result) throw new Error(L('接口没有返回结果', 'Empty response'));
      if (result.ok) return result.value;
      throw new Error(result.error?.message ?? L('请求失败', 'Request failed'));
    }

    // 错误文案：RPC 返回的是「ril/xxx: 说明」，直接抛给用户太生硬。
    // 这里保留原文，但补一句「你该做什么」，并且对常见码换成更短的说法。
    const ERROR_HINTS = {
      'ril/no-bot': L('还没有绑定机器人：点右边「⚙ 绑定设置」，扫码绑定飞书或微信。', 'No bot yet: open “⚙ Bind & settings” on the right and scan to bind Feishu or WeChat.'),
      'ril/locked': L('高级设置先解锁：点开项目主页点个 Star，回来就能改。', 'Advanced settings are locked: star the project page, then come back.'),
      'ril/missing-session': L('拿不到会话 ID：刷新一下页面再试。', 'Cannot read the session id: refresh the page and retry.'),
      'ril/collect-failed': L('读取会话记录失败：等这一轮说完、或者刷新页面再试。', 'Could not read the session log: wait for this turn to finish, or refresh.'),
      'ril/no-turns': L('这个会话还没有跑完过一轮，先聊一轮再点「预处理发送」。', 'This session has no finished turn yet — send one message first.'),
      'ril/no-preset': L('没有找到这条预设，可能已被删除。', 'That preset no longer exists.'),
      'ril/bad-request': L('请求参数不对，刷新页面再试。', 'Bad request: refresh the page and retry.'),
    };

    function errorText(error) {
      const raw = String(error?.message ?? error ?? '');
      const m = /^(ril\/[a-z-]+):\s*([\s\S]*)$/.exec(raw);
      const code = m ? m[1] : '';
      const detail = m ? m[2].trim() : raw;
      const hint = ERROR_HINTS[code];
      if (!hint) return detail || raw || L('未知错误', 'Unknown error');
      if (!detail || detail === hint) return hint;
      return `${hint}（${detail}）`;
    }

    // 面板展开时轻轻淡入（只注入一次，避免每一轮都塞一个 <style>）。
    const RIL_STYLE_ID = 'read-it-later-anim';
    function ensureAnimStyle() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(RIL_STYLE_ID)) return;
      const el = document.createElement('style');
      el.id = RIL_STYLE_ID;
      el.textContent = [
        '@keyframes rilIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}',
        '.ril-panel{animation:rilIn .18s ease-out both}',
        '@media (prefers-reduced-motion: reduce){.ril-panel{animation:none}}',
      ].join('\n');
      document.head.appendChild(el);
    }

    // ---------------- 样式 ----------------
    const S = {
      bar: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
        padding: '6px 2px', fontSize: 12, color: 'var(--dsh-text-2, #666)',
      },
      barTail: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, width: '100%',
        padding: '6px 2px', fontSize: 12, color: 'var(--dsh-text-2, #666)',
      },
      legend: {
        fontFamily: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Songti SC", "Noto Serif SC", serif',
        fontStyle: 'italic', fontSize: 13, letterSpacing: '0.16em', lineHeight: 1,
        color: 'var(--dsh-text-3, #b3b3b3)', whiteSpace: 'nowrap', userSelect: 'none',
      },
      midGroup: {
        flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 5, flexWrap: 'wrap',
      },
      rule: {
        flex: 1, minWidth: 24, height: 1, borderRadius: 1, alignSelf: 'center',
        background: 'linear-gradient(90deg, transparent 0%, var(--dsh-text-3, #b3b3b3) 55%, var(--dsh-text-3, #b3b3b3) 100%)',
        opacity: 0.55, transition: 'opacity .18s ease',
      },
      button: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px', borderRadius: 999, border: '1px solid var(--dsh-border, #d9d9d9)',
        background: 'var(--dsh-surface, #fff)', color: 'inherit', cursor: 'pointer', fontSize: 12,
      },
      buttonPrimary: {
        padding: '5px 12px', borderRadius: 8, border: '1px solid transparent',
        background: 'var(--ril-accent, #2f6df6)', color: '#fff', cursor: 'pointer', fontSize: 12,
      },
      buttonAccent: {
        padding: '4px 12px', borderRadius: 8, border: '1px solid var(--ril-accent, #2f6df6)',
        background: 'var(--ril-accent-soft, rgba(47,109,246,.12))', color: 'var(--ril-accent, #2f6df6)',
        cursor: 'pointer', fontSize: 12,
      },
      buttonGhost: {
        padding: '4px 10px', borderRadius: 8, border: '1px solid var(--dsh-border, #d9d9d9)',
        background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12,
      },
      panel: {
        marginTop: 6, padding: 12, borderRadius: 12, width: '100%', boxSizing: 'border-box',
        border: '1px solid var(--dsh-border, #e3e3e3)', background: 'var(--dsh-surface, #fff)',
        boxShadow: '0 6px 24px rgba(0,0,0,.08)', fontSize: 12,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      line: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      link: {
        border: 'none', background: 'transparent', color: 'var(--ril-accent, #2f6df6)', cursor: 'pointer',
        fontSize: 12, padding: '2px 0', whiteSpace: 'nowrap',
      },
      bindBox: {
        marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsh-border, #eee)',
        maxHeight: 520, overflowY: 'auto',
      },
      chip: (on) => ({
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 999,
        cursor: 'pointer', fontSize: 12,
        border: `1px solid ${on ? 'var(--ril-accent, #2f6df6)' : 'var(--dsh-border, #d9d9d9)'}`,
        background: on ? 'var(--ril-accent-soft, rgba(47,109,246,.12))' : 'transparent',
        color: on ? 'var(--ril-accent, #2f6df6)' : 'inherit',
      }),
      select: {
        padding: '4px 8px', borderRadius: 8, border: '1px solid var(--dsh-border, #d9d9d9)',
        background: 'var(--dsh-surface, #fff)', color: 'inherit', fontSize: 12, maxWidth: 150,
      },
      input: {
        padding: '5px 8px', borderRadius: 8, border: '1px solid var(--dsh-border, #d9d9d9)',
        background: 'var(--dsh-surface, #fff)', color: 'inherit', fontSize: 12, width: '100%',
        boxSizing: 'border-box',
      },
      muted: { color: 'var(--dsh-text-3, #999)', fontSize: 11 },
      presetGrid: { display: 'grid', gap: 8, marginTop: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' },
      presetCard: {
        border: '1px solid var(--dsh-border, #e3e3e3)', borderRadius: 10, padding: '8px 10px',
        display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--dsh-surface-2, #fafafa)',
      },
      presetText: {
        fontSize: 12, lineHeight: 1.45, color: 'inherit', margin: 0,
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      },
      presetActions: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      foot: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 },
      textarea: {
        padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsh-border, #d9d9d9)',
        background: 'var(--dsh-surface, #fff)', color: 'inherit', fontSize: 12, width: '100%',
        minHeight: 72, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit',
      },
      err: { color: '#d4380d', fontSize: 11 },
      ok: { color: '#237804', fontSize: 11 },
      card: {
        border: '1px solid var(--dsh-border, #e3e3e3)', borderRadius: 12, padding: 14,
        display: 'flex', flexDirection: 'column', gap: 10,
      },
      qr: { width: 240, height: 240, imageRendering: 'pixelated', borderRadius: 8, background: '#fff' },
    };

    function platformLabel(p) {
      if (p === 'feishu') return L('飞书', 'Feishu');
      if (p === 'weixin') return L('微信', 'WeChat');
      if (p === 'telegram') return 'Telegram';
      if (p === 'discord') return 'Discord';
      if (p === 'dingtalk') return L('钉钉', 'DingTalk');
      return p;
    }

    function platformIcon(p) {
      if (p === 'feishu') return '🟦';
      if (p === 'weixin') return '🟩';
      if (p === 'telegram') return '✈️';
      if (p === 'discord') return '🎮';
      if (p === 'dingtalk') return '🔔';
      return '💬';
    }

    // ---------------- 每轮对话结尾的分享按钮 ----------------
    function ShareTurn(props) {
      const { call } = props;
      const sessionIdRef = useRef(null);
      const rootRef = useRef(null);
      const [open, setOpen] = useState(false);
      const [hovered, setHovered] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [note, setNote] = useState('');
      const [bots, setBots] = useState([]);
      const [botId, setBotId] = useState('');
      const [include, setInclude] = useState({ prompts: true, answers: true, files: true });
      const [counts, setCounts] = useState(null);
      const [showBind, setShowBind] = useState(false);
      const [bindTick, setBindTick] = useState(0);
      const [presets, setPresets] = useState([]);
      const [showPresets, setShowPresets] = useState(false);
      const [editing, setEditing] = useState(null); // { id, text }
      const [presetBusy, setPresetBusy] = useState('');
      const [presetNote, setPresetNote] = useState('');
      const [autoWatch, setAutoWatch] = useState(null); // { since, preset }
      const [theme, setTheme] = useState(null);

      useEffect(() => {
        ensureAnimStyle();
      }, []);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const el = rootRef.current?.closest?.('[data-conversation-session]');
            const sid = el?.getAttribute?.('data-conversation-session') ?? '';
            const value = unwrap(await call('settings.get', sid ? { sessionId: sid } : {}));
            if (alive) setTheme(value.current ?? null);
          } catch {}
        })();
        return () => {
          alive = false;
        };
      }, [call, bindTick]);

      // 槽位是 session 作用域，标准 props 里直接带 sessionId；DOM 只是兜底。
      const sessionId = useCallback(() => {
        if (typeof props?.sessionId === 'string' && props.sessionId) return props.sessionId;
        if (sessionIdRef.current) return sessionIdRef.current;
        const el = rootRef.current?.closest?.('[data-conversation-session]');
        const id = el?.getAttribute?.('data-conversation-session') ?? '';
        if (id) sessionIdRef.current = id;
        return id;
      }, [props?.sessionId]);

      const turn =
        Number.isInteger(props?.turn) ? props.turn
          : Number.isInteger(props?.turn?.turn) ? props.turn.turn
            : null;
      const seq = Number.isInteger(props?.seq) ? props.seq : null;

      const refresh = useCallback(async () => {
        try {
          const value = unwrap(await call('status'));
          setBots(value.bots ?? []);
          setBotId((prev) => prev || value.defaultBotId || value.bots?.[0]?.id || '');
        } catch (e) {
          setError(errorText(e));
        }
      }, [call]);

      // 这一轮一结束就先把计数取回来，点开面板时不用等解码（否则会「滞后」一两秒）
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const value = unwrap(await call('share.preview', { botId, sessionId: sessionId(), turn, seq }));
            if (alive) setCounts(value.counts);
          } catch {
            /* 预取失败不打扰用户，点开时再报错 */
          }
        })();
        return () => {
          alive = false;
        };
      }, [botId, call, seq, turn]);

      useEffect(() => {
        if (!open) return undefined;
        setError('');
        setNote('');
        refresh();
        let alive = true;
        (async () => {
          try {
            const value = unwrap(await call('share.preview', { botId, sessionId: sessionId(), turn, seq }));
            if (alive) setCounts(value.counts);
          } catch (e) {
            if (alive) setError(errorText(e));
          }
        })();
        return () => {
          alive = false;
        };
      }, [open, botId, bindTick, call, refresh, seq, sessionId, turn]);

      async function send() {
        setBusy(true);
        setError('');
        setNote('');
        try {
          const value = unwrap(await call('share.send', { botId, sessionId: sessionId(), turn, seq, include }));
          const sent = value.sent ?? {};
          const fmt = sent.format === 'card' ? L('卡片', 'card') : L('消息', 'message');
          setNote(L(`已发送${fmt} ${sent.textParts ?? 0} 条，文件 ${sent.filesSent ?? 0} 个 → ${value.bot?.name || platformLabel(value.bot?.platform)}`, `Sent ${sent.textParts ?? 0} ${fmt} message(s), ${sent.filesSent ?? 0} file(s) → ${value.bot?.name || platformLabel(value.bot?.platform)}`));
        } catch (e) {
          setError(errorText(e));
          // 机器人可能在别处被解绑了：失败后刷新一下列表，别让下拉一直停在幽灵项上。
          void refresh();
        } finally {
          setBusy(false);
        }
      }

      const loadPresets = useCallback(async () => {
        try {
          const value = unwrap(await call('preset.list'));
          setPresets(value.presets ?? []);
        } catch (e) {
          setError(errorText(e));
        }
      }, [call]);

      useEffect(() => {
        if (!showPresets) return;
        loadPresets();
      }, [showPresets, loadPresets]);

      /** 点预设：先让 Host 记住基线轮次，再把提示词送进当前会话。 */
      async function sendPreset(preset) {
        setPresetBusy(preset.id);
        setError('');
        setNote('');
        setPresetNote('');
        try {
          const sessions = props.appCtx?.get ? props.appCtx.get('sessions') : props.appCtx?.sessions;
          const session = sessions?.binding?.(sessionId())?.session;
          if (!session?.prompt) throw new Error(L('当前会话还没就绪，暂时无法发送提示词。', 'The session is not ready yet.'));
          if (session.getSnapshot?.()?.running) {
            throw new Error(L('这一轮还在运行，等它结束后再点，才能把结果对应到这条提示词。', 'This turn is still running — wait for it to finish first.'));
          }
          unwrap(await call('auto.arm', { botId, sessionId: sessionId(), include }));
          const promptText = presetText(preset);
          const result = await session.prompt([{ type: 'text', text: promptText }], 'queue');
          if (result && result.ok === false) throw new Error(result.error?.message ?? L('提示词被拒绝。', 'The prompt was rejected.'));
          setPresetNote(`已发送「${preset.text.slice(0, 18)}${preset.text.length > 18 ? '…' : ''}」，等这一轮跑完，结果会自动发到机器人（等待中…）。`);
          setAutoWatch({ since: Date.now() });
        } catch (e) {
          setError(errorText(e));
        } finally {
          setPresetBusy('');
        }
      }

      /** 预处理发送后的自动回传：轮询 Host 侧状态，出结果就把结论写到提示行。 */
      useEffect(() => {
        if (!autoWatch) return undefined;
        let alive = true;
        const started = autoWatch.since;
        const timer = setInterval(async () => {
          try {
            const value = unwrap(await call('auto.status', { sessionId: sessionId() }));
            if (!alive) return;
            if (value.state === 'done') {
              const r = value.result ?? {};
              const sent = r.sent ?? {};
              const parts = [];
              if (sent.cards) parts.push(L(`卡片 ${sent.cards} 张`, `${sent.cards} card(s)`));
              else if (sent.textParts) parts.push(L(`消息 ${sent.textParts} 条`, `${sent.textParts} message(s)`));
              if (sent.filesSent) parts.push(L(`文件 ${sent.filesSent} 个`, `${sent.filesSent} file(s)`));
              setPresetNote(L(`已自动发送第 ${r.turn ?? '?'} 轮${parts.length ? `（${parts.join('、')}）` : ''}。`, `Auto-sent turn ${r.turn ?? '?'}${parts.length ? ` (${parts.join(', ')})` : ''}.`));
              setAutoWatch(null);
            } else if (value.state === 'error' || value.state === 'timeout') {
              setError(L(`自动回传失败：${value.error || value.state}`, `Auto-send failed: ${value.error || value.state}`));
              setAutoWatch(null);
            } else if (value.state === 'cancelled' || value.state === 'idle' || !value.armed) {
              setAutoWatch(null);
            } else if (Date.now() - started > 21 * 60 * 1000) {
              setAutoWatch(null);
            }
          } catch {
            // 忽略单次失败，下一拍再试
          }
        }, 3000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [autoWatch, call, sessionId]);

      async function savePreset() {
        if (!editing) return;
        const text = String(editing.text ?? '').trim();
        if (!text) {
          setError(L('提示词不能为空。', 'The prompt cannot be empty.'));
          return;
        }
        setBusy(true);
        setError('');
        try {
          const value = unwrap(await call('preset.save', { id: editing.id || undefined, text }));
          setPresets(value.presets ?? []);
          setEditing(null);
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }

      async function deletePreset(id) {
        setBusy(true);
        setError('');
        try {
          const value = unwrap(await call('preset.delete', { id }));
          setPresets(value.presets ?? []);
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }

      const toggle = (key) => setInclude((prev) => ({ ...prev, [key]: !prev[key] }));
      const label = (key, text) => `${include[key] ? '✓' : '○'} ${text}`;
      const disabled = busy || !counts || bots.length === 0 || (
        !include.prompts && !include.answers && !(include.files && counts.files > 0)
      );

      const vars = theme
        ? { '--ril-accent': theme.accent, '--ril-accent-soft': theme.accentSoft, width: '100%' }
        : { width: '100%' };

      return h('div', { ref: rootRef, style: { ...S.barTail, ...vars }, 'data-ril-turn': String(turn ?? '') },
        h('span', {
          style: { ...S.legend, opacity: hovered ? 1 : 0, transition: 'opacity .18s ease' },
          'aria-hidden': 'true',
        }, 'Read it later'),
        h('span', { style: { ...S.rule, opacity: hovered ? 0.55 : 0 }, 'aria-hidden': 'true' }),
        h('button', {
          type: 'button',
          style: S.button,
          onClick: () => setOpen((v) => !v),
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          onFocus: () => setHovered(true),
          onBlur: () => setHovered(false),
          title: L('把这一轮的提示词、回复和文件发送到已绑定的机器人', 'Send this turn\'s prompt, reply and files to a bound bot'),
        },
        h('span', {
          style: {
            display: 'inline-block', fontSize: 13, lineHeight: 1, position: 'relative', top: -1.5,
            filter: hovered ? 'none' : 'grayscale(1)',
            opacity: hovered ? 1 : 0.8,
            transition: 'filter .18s ease, opacity .18s ease',
          },
          'aria-hidden': 'true',
        }, '📤'),
        h('span', null, `${open ? L('收起', 'Collapse') : L('发至IM', 'Send to IM')}${turn ? L(` · 第 ${turn} 轮`, ` · turn ${turn}`) : ''}`)),
        note && !open ? h('span', { style: S.ok }, note) : null,
        error && !open ? h('span', { style: S.err }, error) : null,

        open ? h('div', { className: 'ril-panel', style: { ...S.panel, flexBasis: '100%', marginLeft: 0 } },
          h('div', { style: S.line },
            bots.length > 0
              ? h('select', {
                style: S.select,
                value: botId,
                title: L('选择要发送到的机器人', 'Choose the bot'),
                onChange: (e) => setBotId(e.target.value),
              }, bots.map((bot) => h('option', { key: bot.id, value: bot.id },
                `${platformLabel(bot.platform)} · ${bot.name || bot.id}`)))
              : h('span', { style: S.muted }, L('未绑定机器人', 'No bot bound')),
            h('div', { style: S.midGroup },
              h('span', { style: S.chip(include.prompts), role: 'button', title: L('包含本轮的提示词', 'Include this turn\'s prompt'), onClick: () => toggle('prompts') }, label('prompts', L('提示词', 'Prompt'))),
              h('span', { style: S.chip(include.answers), role: 'button', title: L('包含本轮的回复内容', 'Include this turn\'s reply'), onClick: () => toggle('answers') }, label('answers', L('回复', 'Reply'))),
              h('span', { style: S.chip(include.files), role: 'button', title: L('包含本轮生成的文件', 'Include this turn\'s files'), onClick: () => toggle('files') }, label('files', L('附件', 'Files'))),
              h('button', {
                type: 'button',
                style: { ...S.buttonPrimary, opacity: disabled ? 0.5 : 1 },
                disabled,
                onClick: send,
              }, busy ? L('发送中…', 'Sending…') : L('发送到机器人', 'Send to bot')),
              h('button', {
                type: 'button',
                style: S.buttonAccent,
                title: L('预存提示词：点一下送进本会话，这一轮结果自动回传', 'Saved prompts: click one to send it here; the result comes back to the bot'),
                onClick: () => setShowPresets((v) => !v),
              }, showPresets ? L('收起预处理', 'Hide presets') : L('预处理发送', 'Queue & send'))),
            h('button', {
              type: 'button',
              style: S.buttonGhost,
              title: L('绑定机器人 / 高级设置', 'Bind bot / advanced settings'),
              onClick: () => setShowBind((v) => !v),
            }, showBind ? L('收起设置', 'Hide settings') : '⚙ ' + L('绑定设置', 'Bind & settings'))),

          showBind ? h('div', { style: S.bindBox },
            h(SettingsPanel, {
              call,
              compact: true,
              onChanged: () => {
                setBindTick((v) => v + 1);
                refresh();
              },
            })) : null,

          showPresets ? h('div', { style: S.bindBox },
            editing ? h('div', { style: S.presetCard },
              h('textarea', {
                style: S.textarea,
                value: editing.text,
                placeholder: L('输入要预存的提示词，例如：帮我总结今天本会话的所有内容，结果形成一个“总结+日期”的 MD 文件。', 'Prompt to save, e.g. Summarize this session and write it to a Markdown file named summary + date.'),
                onChange: (e) => setEditing({ ...editing, text: e.target.value }),
              }),
              h('div', { style: S.presetActions },
                h('button', {
                  type: 'button',
                  style: S.buttonPrimary,
                  disabled: busy,
                  onClick: savePreset,
                }, L('保存', 'Save')),
                h('button', { type: 'button', style: S.buttonGhost, onClick: () => setEditing(null) }, L('取消', 'Cancel')))) : null,
            h('div', { style: S.presetGrid },
              presets.map((preset) => h('div', { style: S.presetCard, key: preset.id },
                h('p', { style: S.presetText, title: presetText(preset) }, presetText(preset)),
                h('div', { style: S.presetActions },
                  h('button', {
                    type: 'button',
                    style: { ...S.buttonPrimary, padding: '3px 10px', opacity: bots.length === 0 ? 0.5 : 1 },
                    disabled: Boolean(presetBusy) || bots.length === 0,
                    title: L('发送这条提示词到本会话，结果自动回传', 'Send this prompt here; the result is pushed back to the bot'),
                    onClick: () => sendPreset(preset),
                  }, presetBusy === preset.id ? L('发送中…', 'Sending…') : L('▶ 发送', '▶ Send')),
                  h('button', {
                    type: 'button',
                    style: S.link,
                    onClick: () => setEditing({ id: preset.id, text: presetText(preset) }),
                  }, L('编辑', 'Edit')),
                  h('button', {
                    type: 'button',
                    style: S.link,
                    onClick: () => deletePreset(preset.id),
                  }, L('删除', 'Delete')))))),
            h('div', { style: S.foot },
              h('span', { style: S.muted }, L('点「▶ 发送」把提示词送进本会话，这一轮出结果后自动回传到上面的机器人。', 'Click ▶ Send to drop this prompt into the session; the result is pushed to the bot automatically.')),
              h('button', {
                type: 'button',
                style: S.link,
                onClick: () => setEditing({ id: '', text: '' }),
              }, L('＋ 添加', '+ Add')))) : null,

          h('div', { style: S.foot },
            h('span', { style: S.muted },
              counts
                ? L(`本轮：提示词 ${counts.prompts} · 回复 ${counts.answers} · 文件 ${counts.files}`, `Turn: prompts ${counts.prompts} · replies ${counts.answers} · files ${counts.files}`)
                : L('本轮：统计中…', 'Turn: counting…')),
            presetNote ? h('span', { style: S.ok }, presetNote) : null,
            note ? h('span', { style: S.ok }, note) : null,
            error ? h('span', { style: S.err }, error) : null))
        : null);
    }

    // ---------------- 设置页：绑定管理 ----------------
    function SettingsPanel(props) {
      const { call, compact, onChanged } = props;
      const [bots, setBots] = useState([]);
      const [defaultId, setDefaultId] = useState('');
      const [error, setError] = useState('');
      const [attempt, setAttempt] = useState(null); // {platform, attemptId, qrImage, state, message}
      const [code, setCode] = useState('');
      const [manual, setManual] = useState({ open: false, platform: 'feishu', appId: '', appSecret: '', openId: '', name: '', token: '', chatId: '', channelId: '', webhook: '', secret: '' });
      const [busy, setBusy] = useState(false);
      const [advanced, setAdvanced] = useState(false);
      const [themes, setThemes] = useState([]);
      const [themeId, setThemeId] = useState('');
      const [currentId, setCurrentId] = useState('');
      const [randomTheme, setRandomTheme] = useState(true);
      const [summarize, setSummarize] = useState(true);
      const [zipFiles, setZipFiles] = useState(true);
      const [autoTimeoutMin, setAutoTimeoutMin] = useState(20);
      const [monitorTurns, setMonitorTurns] = useState(false);
      const [monitorAsk, setMonitorAsk] = useState(false);
      const [github, setGithub] = useState('');
      const [unlocked, setUnlocked] = useState(false);
      const [note, setNote] = useState('');

      const refresh = useCallback(async () => {
        try {
          const value = unwrap(await call('status'));
          setBots(value.bots ?? []);
          setDefaultId(value.defaultBotId ?? '');
        } catch (e) {
          setError(errorText(e));
        }
      }, [call]);

      const bump = useCallback(() => {
        try {
          onChanged?.();
        } catch {}
      }, [onChanged]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const loadSettings = useCallback(async () => {
        try {
          const value = unwrap(await call('settings.get'));
          setThemes(value.themes ?? []);
          setThemeId(value.themeId ?? '');
          setCurrentId(value.currentId ?? '');
          setRandomTheme(value.randomTheme !== false);
          setSummarize(value.summarize !== false);
          setZipFiles(value.zip !== false);
          setAutoTimeoutMin(Number.isFinite(value.autoTimeoutMin) ? value.autoTimeoutMin : 20);
          setMonitorTurns(value.monitorTurns === true);
          setMonitorAsk(value.monitorAsk === true);
          setGithub(value.github ?? '');
          setUnlocked(value.unlocked === true);
        } catch {}
      }, [call]);

      useEffect(() => {
        loadSettings();
      }, [loadSettings]);

      async function applySettings(patch) {
        try {
          const el = typeof document !== 'undefined' ? document.querySelector('[data-conversation-session]') : null;
          const sid = el?.getAttribute?.('data-conversation-session') ?? '';
          const value = unwrap(await call('settings.set', sid ? { ...patch, sessionId: sid } : patch));
          setThemes(value.themes ?? []);
          setThemeId(value.themeId ?? '');
          setCurrentId(value.currentId ?? '');
          setRandomTheme(value.randomTheme !== false);
          setSummarize(value.summarize !== false);
          setZipFiles(value.zip !== false);
          setAutoTimeoutMin(Number.isFinite(value.autoTimeoutMin) ? value.autoTimeoutMin : 20);
          setMonitorTurns(value.monitorTurns === true);
          setMonitorAsk(value.monitorAsk === true);
          setUnlocked(value.unlocked === true);
          bump();
        } catch (e) {
          setError(errorText(e));
        }
      }

      const applyTheme = (id) => applySettings({ themeId: id, randomTheme: false });

      // 点开项目主页即解锁高级设置（本机记住，之后不再拦）。
      const unlock = () => {
        if (unlocked) return;
        applySettings({ unlocked: true });
      };

      const check = (label, value, onChange, title) => h('label', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' },
        title,
      },
        h('input', { type: 'checkbox', checked: !!value, onChange: (e) => onChange(e.target.checked) }),
        h('span', null, label));

      // 轮询绑定状态
      useEffect(() => {
        if (!attempt?.attemptId) return undefined;
        let alive = true;
        const timer = setInterval(async () => {
          try {
            const value = unwrap(await call('bind.poll', { attemptId: attempt.attemptId }));
            if (!alive) return;
            setAttempt((prev) => (prev ? { ...prev, ...value } : prev));
            if (value.state === 'done') {
              setAttempt(null);
              setCode('');
              await refresh();
              bump();
            }
          } catch (e) {
            if (alive) {
              setError(errorText(e));
              setAttempt(null);
            }
          }
        }, 1200);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [attempt?.attemptId, call, refresh, bump]);

      async function startBind(platform) {
        setError('');
        setBusy(true);
        try {
          const value = unwrap(await call('bind.begin', { platform }));
          setAttempt(value);
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }

      async function submitCode() {
        if (!attempt?.attemptId || !code.trim()) return;
        try {
          unwrap(await call('bind.verify', { attemptId: attempt.attemptId, code: code.trim() }));
          setCode('');
        } catch (e) {
          setError(errorText(e));
        }
      }

      async function cancel() {
        if (attempt?.attemptId) {
          try {
            await call('bind.cancel', { attemptId: attempt.attemptId });
          } catch {}
        }
        setAttempt(null);
        setCode('');
      }

      async function removeBot(id) {
        setBusy(true);
        try {
          unwrap(await call('bot.remove', { botId: id }));
          await refresh();
          bump();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }

      async function makeDefault(id) {
        setBusy(true);
        setError('');
        try {
          unwrap(await call('bot.default', { botId: id }));
          await refresh();
          bump();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }

      async function testBot(id) {
        setBusy(true);
        setError('');
        try {
          unwrap(await call('bot.test', { botId: id }));
          await refresh();
        } catch (e) {
          setError(errorText(e));
          await refresh();
        } finally {
          setBusy(false);
        }
      }

      async function saveManual() {
        setBusy(true);
        setError('');
        try {
          const value = unwrap(await call('bind.manual', { ...manual, platform: manual.platform || 'feishu' }));
          // Telegram 第一次没给 chatId 时，Host 先把读到的会话回传，第二次带上它才真正落库
          if (value?.pending?.chatId) {
            setManual((m) => ({ ...m, chatId: value.pending.chatId }));
            setNote(`已读到会话「${value.pending.chatTitle ?? value.pending.chatId}」，再点一次「保存并验证」即可完成绑定。`);
            return;
          }
          setManual({ open: false, platform: 'feishu', appId: '', appSecret: '', openId: '', name: '', token: '', chatId: '', channelId: '', webhook: '', secret: '' });
          await refresh();
          bump();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }

      const cur = themes.find((t) => t.id === themeId) ?? null;
      const vars = cur ? { '--ril-accent': cur.accent, '--ril-accent-soft': cur.accentSoft } : {};
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: compact ? '100%' : 760, ...vars } },
        compact ? null : h('div', null,
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, L('Read It Later 机器人', 'Read It Later bots')),
          h('div', { style: S.muted },
            L('在这里绑定自己的飞书 / 微信机器人。绑定与 dsh-im 完全独立：不装 dsh-im 也能用，装了也不会互相影响。凭据只写在本机 ~/.dsh/read-it-later/bots.json。', 'Bind your own Feishu / WeChat / Telegram / Discord / DingTalk bot. Credentials stay in ~/.dsh/read-it-later/bots.json on this machine.'))),

        error ? h('div', { style: S.err }, error) : null,
        note ? h('div', { style: S.ok }, note) : null,

        // 绑定中的二维码
        attempt ? h('div', { style: S.card },
          h('div', { style: S.row },
            h('strong', null, `绑定${platformLabel(attempt.platform)}机器人`),
            h('span', { style: S.muted }, attempt.message || L('等待扫码', 'Waiting for the scan'))),
          attempt.qrImage
            ? h('img', { src: attempt.qrImage, alt: L('扫码绑定二维码', 'Binding QR code'), style: S.qr })
            : h('div', { style: S.muted }, L('二维码生成中…', 'Generating the QR code…')),
          attempt.qrUrl
            ? h('div', { style: S.muted },
              L('扫码打不开时，可在手机里打开：', 'If the scan does not open, use this link on your phone:'),
              h('a', { href: attempt.qrUrl, target: '_blank', rel: 'noreferrer', style: { color: 'var(--ril-accent, #2f6df6)', wordBreak: 'break-all' } }, attempt.qrUrl))
            : null,
          h('div', { style: S.muted },
            attempt.platform === 'feishu'
              ? L('用飞书 App 扫码，确认后会自动创建并绑定一个「专属 AI 助手」应用。', 'Scan with the Feishu app; it creates and binds a personal assistant app for you.')
              : L('用微信扫码，按手机提示确认；若要求配对码，在下面输入。', 'Scan with WeChat and confirm on the phone; enter the pairing code below if asked.')),
          attempt.state === 'needs_code'
            ? h('div', { style: S.row },
              h('input', {
                style: { ...S.input, width: 160 },
                placeholder: L('手机上的配对码', 'Pairing code from the phone'),
                value: code,
                onChange: (e) => setCode(e.target.value),
              }),
              h('button', { type: 'button', style: S.buttonPrimary, onClick: submitCode }, L('提交配对码', 'Submit the code')))
            : null,
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.buttonGhost, onClick: cancel }, L('取消绑定', 'Cancel binding')),
            h('span', { style: S.muted }, `状态：${attempt.state}`)))
          : null,

        // 已绑定列表
        h('div', { style: S.card },
          h('div', { style: S.row, justifyContent: 'space-between' },
            h('strong', null, `已绑定（${bots.length}）`),
            h('div', { style: { ...S.row, flexWrap: 'wrap' } },
              h('button', { type: 'button', style: S.buttonPrimary, disabled: busy || !!attempt, onClick: () => startBind('feishu') }, L('＋ 绑飞书', '+ Feishu')),
              h('button', { type: 'button', style: S.buttonPrimary, disabled: busy || !!attempt, onClick: () => startBind('weixin') }, L('＋ 绑微信', '+ WeChat')),
              h('button', { type: 'button', style: S.buttonGhost, disabled: busy, onClick: () => setManual((m) => ({ ...m, open: !m.open, platform: 'telegram' })) }, '＋ Telegram'),
              h('button', { type: 'button', style: S.buttonGhost, disabled: busy, onClick: () => setManual((m) => ({ ...m, open: !m.open, platform: 'discord' })) }, '＋ Discord'),
              h('button', { type: 'button', style: S.buttonGhost, disabled: busy, onClick: () => setManual((m) => ({ ...m, open: !m.open, platform: 'dingtalk' })) }, L('＋ 钉钉', '+ DingTalk')))),
          bots.length === 0
            ? h('div', { style: S.muted }, L('还没有机器人。点上面的按钮扫码绑定。', 'No bot yet. Use the buttons above to bind one.'))
            : bots.map((bot) => h('div', {
              key: bot.id,
              style: { ...S.row, justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--dsh-border, #eee)' },
            },
            h('div', null,
              h('div', null, `${platformIcon(bot.platform)} ${bot.name || bot.id}`,
                bot.id === defaultId ? h('span', { style: { ...S.muted, marginLeft: 6 } }, L('（默认）', ' (default)')) : null),
              h('div', { style: S.muted },
                `${platformLabel(bot.platform)}${bot.detail ? ` · ${bot.detail}` : ''}${bot.lastSendAt ? L(` · 上次发送 ${new Date(bot.lastSendAt).toLocaleString()}`, ` · last sent ${new Date(bot.lastSendAt).toLocaleString()}`) : ''}`),
              bot.lastError ? h('div', { style: S.err }, bot.lastError) : null),
            h('div', { style: S.row },
              bot.id === defaultId
                ? h('span', { style: { ...S.muted, padding: '0 6px' } }, L('默认机器人', 'Default'))
                : h('button', { type: 'button', style: S.buttonGhost, disabled: busy, onClick: () => makeDefault(bot.id) }, L('设为默认', 'Set default')),
              h('button', { type: 'button', style: S.buttonGhost, disabled: busy, onClick: () => testBot(bot.id) }, L('发测试消息', 'Send test')),
              h('button', { type: 'button', style: { ...S.buttonGhost, color: '#d4380d' }, disabled: busy, onClick: () => removeBot(bot.id) }, L('解绑', 'Unbind')))))),

        // 手动绑定：飞书应用 / Telegram / Discord / 钉钉
        h('div', { style: S.card },
          h('div', { style: S.row, justifyContent: 'space-between' },
            h('strong', null, L('手动绑定（可选）', 'Manual binding (optional)')),
            h('button', { type: 'button', style: S.buttonGhost, onClick: () => setManual((m) => ({ ...m, open: !m.open })) },
              manual.open ? L('收起', 'Collapse') : L('展开', 'Expand'))),
          manual.open ? h('div', { style: { display: 'grid', gap: 8 } },
            h('div', { style: { ...S.row, flexWrap: 'wrap' } },
              ['feishu', 'telegram', 'discord', 'dingtalk'].map((p) => h('button', {
                key: p,
                type: 'button',
                style: (manual.platform || 'feishu') === p ? S.buttonPrimary : S.buttonGhost,
                onClick: () => setManual((m) => ({ ...m, platform: p })),
              }, `${platformIcon(p)} ${platformLabel(p)}`))),
            (manual.platform || 'feishu') === 'feishu' ? h('div', { style: { display: 'grid', gap: 8 } },
              h('input', { style: S.input, placeholder: 'App ID（cli_…）', value: manual.appId, onChange: (e) => setManual((m) => ({ ...m, appId: e.target.value })) }),
              h('input', { style: S.input, placeholder: 'App Secret', type: 'password', value: manual.appSecret, onChange: (e) => setManual((m) => ({ ...m, appSecret: e.target.value })) }),
              h('input', { style: S.input, placeholder: L('接收消息的 open_id（ou_…）', 'open_id that receives messages (ou_…)'), value: manual.openId, onChange: (e) => setManual((m) => ({ ...m, openId: e.target.value })) })) : null,
            manual.platform === 'telegram' ? h('div', { style: { display: 'grid', gap: 8 } },
              h('input', { style: S.input, placeholder: 'Bot Token（123456789:AA…）', value: manual.token, onChange: (e) => setManual((m) => ({ ...m, token: e.target.value })) }),
              h('input', { style: S.input, placeholder: L('Chat ID（留空 = 自动读取最近给机器人发消息的会话）', 'Chat ID (empty = use the most recent chat that messaged the bot)'), value: manual.chatId, onChange: (e) => setManual((m) => ({ ...m, chatId: e.target.value })) }),
              h('div', { style: S.muted }, L('留空时请先在 Telegram 里给这个机器人随便发一句，再点「保存并验证」。', 'If empty, first send the bot any message in Telegram, then click Save & verify.'))) : null,
            manual.platform === 'discord' ? h('div', { style: { display: 'grid', gap: 8 } },
              h('input', { style: S.input, placeholder: 'Bot Token', type: 'password', value: manual.token, onChange: (e) => setManual((m) => ({ ...m, token: e.target.value })) }),
              h('input', { style: S.input, placeholder: L('频道 ID（右键频道 → 复制频道 ID）', 'Channel ID (right-click the channel → copy channel ID)'), value: manual.channelId, onChange: (e) => setManual((m) => ({ ...m, channelId: e.target.value })) })) : null,
            manual.platform === 'dingtalk' ? h('div', { style: { display: 'grid', gap: 8 } },
              h('input', { style: S.input, placeholder: 'Webhook（https://oapi.dingtalk.com/robot/send?access_token=…）', value: manual.webhook, onChange: (e) => setManual((m) => ({ ...m, webhook: e.target.value })) }),
              h('input', { style: S.input, placeholder: L('加签密钥（安全设置里选了「加签」才需要）', 'Signing secret (only if the robot uses signed requests)'), type: 'password', value: manual.secret, onChange: (e) => setManual((m) => ({ ...m, secret: e.target.value })) }),
              h('div', { style: S.muted }, L('钉钉群机器人只能发文本，附件会以文件名清单的形式出现在正文里。', 'DingTalk robots are text-only; attachments appear as a file-name list in the text.'))) : null,
            h('input', { style: S.input, placeholder: L('备注名（可选）', 'Label (optional)'), value: manual.name, onChange: (e) => setManual((m) => ({ ...m, name: e.target.value })) }),
            h('div', null, h('button', { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: saveManual }, L('保存并验证', 'Save & verify'))))
            : h('div', { style: S.muted }, L('已经有机器人凭据？飞书 App ID / Telegram Token / Discord Token / 钉钉 Webhook 都能直接粘进来绑定。', 'Already have credentials? Feishu App ID, Telegram token, Discord token and DingTalk webhook all work here.'))),

        // 高级设置：解锁提示 + 外观/发送行为 + 项目地址
        h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('strong', null, L('高级设置', 'Advanced')),
            h('button', { type: 'button', style: S.buttonGhost, onClick: () => setAdvanced((v) => !v) },
              advanced ? L('收起', 'Collapse') : L('展开', 'Expand'))),
          advanced ? h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              margin: '4px 0 12px', padding: '8px 12px', borderRadius: 10,
              fontSize: 12.5,
              background: unlocked ? 'rgba(15, 157, 118, 0.08)' : 'rgba(47, 109, 246, 0.07)',
              border: `1px solid ${unlocked ? 'rgba(15, 157, 118, 0.25)' : 'rgba(47, 109, 246, 0.18)'}`,
            },
          },
            h('span', null, unlocked ? L('✅ 已解锁，高级设置可以自由调整。', '✅ Unlocked — advanced settings are editable.') : L('🔒 高级设置请支持本项目，点赞后生效。', '🔒 Star the project to unlock advanced settings.')),
            h('a', {
              href: github || 'https://github.com/jes-phd/dsh-read-it-later',
              target: '_blank',
              rel: 'noreferrer',
              onClick: unlock,
              style: {
                color: 'var(--ril-accent, #2f6df6)',
                textDecoration: 'underline',
                fontWeight: 600,
                cursor: 'pointer',
              },
            }, unlocked ? L('再去项目主页看看', 'Visit the project page') : L('点开 GitHub 点个 Star →', 'Open GitHub and star it →'))) : null,
          advanced ? h('div', { style: { display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', {
              style: {
                flex: '1 1 320px', display: 'grid', gap: 10,
                opacity: unlocked ? 1 : 0.42,
                filter: unlocked ? 'none' : 'grayscale(1)',
                pointerEvents: unlocked ? 'auto' : 'none',
                transition: 'opacity .18s ease',
              },
              title: unlocked ? '' : L('点开上面的项目主页即可解锁', 'Open the project page above to unlock'),
            },
              h('div', { style: { display: 'grid', gap: 6 } },
                check(L('摘要显示', 'Show summary'), summarize, (v) => applySettings({ summarize: v }), L('勾选：只显示 100 字摘要 +「详情」折叠；不勾：直接全文铺在卡片里', 'Checked: 100-character summary with a collapsible detail; unchecked: full text on the card')),
                check(L('压缩附件', 'Zip attachments'), zipFiles, (v) => applySettings({ zip: v }), L('勾选：附件打成一个 zip；不勾：每个文件单独发', 'Checked: attachments bundled into one zip; unchecked: sent one by one')),
                check(L('随机配色', 'Random color'), randomTheme, (v) => applySettings({ randomTheme: v }), L('按会话标题散列配色，每个会话尽量不同色（同一个会话颜色固定）', 'Pick the card color from the session title, so each session looks different (stable per session)')),
                h('label', {
                  style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' },
                  title: L('预处理发送后最多等多久：超时会标成「等待结果超时」，不会无限挂着', 'How long to wait after a queued prompt: on timeout it says so instead of hanging forever'),
                },
                h('span', null, L('自动回传等待', 'Auto-send wait')),
                h('input', {
                  type: 'number',
                  min: 1,
                  max: 180,
                  value: autoTimeoutMin,
                  style: {
                    width: 64, padding: '3px 8px', borderRadius: 8, fontSize: 13,
                    border: '1px solid var(--dsh-border, #d9d9d9)', background: 'var(--dsh-surface, #fff)', color: 'inherit',
                  },
                  onChange: (event) => setAutoTimeoutMin(Number(event.target.value) || 1),
                  onBlur: () => applySettings({ autoTimeoutMin }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') applySettings({ autoTimeoutMin });
                  },
                }),
                h('span', { style: S.muted }, L('分钟（1–180，默认 20；插件重启后仍在窗口内会接着等）', 'minutes (1–180, default 20; still resumed after a restart)'))),
              h('div', { style: { marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #ededed)' } },
                h('div', { style: { ...S.muted, fontWeight: 600, marginBottom: 4 } }, L('状态监控（盯所有 DSH 会话，推到默认机器人）', 'Status monitor (watch all DSH sessions, push to the default bot)')),
                check(L('完成一轮就通知', 'Notify on each finished turn'), monitorTurns, (v) => applySettings({ monitorTurns: v }), L('任何会话成功跑完一轮，就给 IM 发一条简短消息（哪一轮、什么时间）', 'When any session finishes a turn, send a short IM message (which turn, when)')),
                check(L('卡住时把选项推给你', 'Push options when a session waits'), monitorAsk, (v) => applySettings({ monitorAsk: v }), L('会话停在「等你决定」（提问 / 审批）超过 1 分钟，就把问题和选项发到 IM，提示你尽快抉择', 'When a session waits for your decision (question / approval) for over a minute, push the question and options to IM')))),
              h('div', { style: { marginTop: 6, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #ededed)' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('span', { style: { ...S.muted, fontWeight: 600 } }, L('配色', 'Color')),
                  h('button', {
                    type: 'button',
                    title: L('按会话标题散列取色，每个会话尽量不同色', 'Color picked from the session title, so each session differs'),
                    style: {
                      padding: '3px 9px', borderRadius: 999, fontSize: 11.5, cursor: 'pointer',
                      border: `1px solid ${randomTheme ? 'var(--ril-accent, #2f6df6)' : 'var(--dsh-border, #d9d9d9)'}`,
                      background: randomTheme ? 'var(--ril-accent-soft, rgba(47,109,246,.12))' : 'transparent',
                      color: 'inherit',
                    },
                    onClick: () => applySettings({ randomTheme: !randomTheme }),
                  }, randomTheme ? L('✓ 随机', '✓ Random') : L('随机', 'Random')),
                  themes.map((t) => h('button', {
                    key: t.id,
                    type: 'button',
                    title: t.note ? `${t.name} · ${t.note}` : t.name,
                    style: {
                      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px',
                      borderRadius: 999, cursor: 'pointer', fontSize: 11.5,
                      border: `1px solid ${(!randomTheme && t.id === themeId) || (randomTheme && t.id === currentId) ? t.accent : 'var(--dsh-border, #d9d9d9)'}`,
                      background: !randomTheme && t.id === themeId ? t.accentSoft : 'transparent',
                      color: 'inherit',
                    },
                    onClick: () => applyTheme(t.id),
                  },
                  h('span', { style: { width: 11, height: 11, borderRadius: '50%', background: t.accent, display: 'inline-block' } }),
                  t.name,
                  !randomTheme && t.id === themeId ? ' ✓' : '')),
                  h('span', { style: { flex: 1, minWidth: 6 } }),
                  github ? h('a', {
                    href: github,
                    target: '_blank',
                    rel: 'noreferrer',
                    onClick: unlock,
                    title: github,
                    style: { color: 'var(--ril-accent, #2f6df6)', fontSize: 12, textDecoration: 'none', whiteSpace: 'nowrap' },
                  }, L('项目地址 →', 'Project →')) : null)))) : null) );
    }


    return {
      inject: ['slots', 'connection', 'sessions'],
      apply(ctx) {
        const call = makeCall(ctx);

        const disposers = [];
        disposers.push(ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'ril-turn-share',
          order: 40,
        }, (props) => h(ShareTurn, { ...props, call, appCtx: ctx }))));

        disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-read-it-later',
          order: 22,
          label: () => 'Read It Later',
        }, (props) => h(SettingsPanel, { ...props, call }))));

        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.();
            } catch {}
          }
        };
      },
    };
  },
});
