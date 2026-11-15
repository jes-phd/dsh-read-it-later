// dsh-read-it-later —— Web 客户端
// ① 每轮对话结尾的「发到 IM」按钮（可勾选提示词/回复/文件，选择已绑定机器人）
// ② 设置 → Read It Later：扫码绑定飞书 / 微信机器人（自带绑定，不依赖 dsh-im）
window.__ModuleLoader__.load({
  id: 'dsh-read-it-later',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

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
        if (!res.ok) throw new Error(`接口不可达（HTTP ${res.status}）`);
        const json = await res.json();
        if (json?.type !== 'server-response') throw new Error('接口返回格式不正确');
        return json.result;
      };
    }

    function unwrap(result) {
      if (!result) throw new Error('接口没有返回结果');
      if (result.ok) return result.value;
      throw new Error(result.error?.message ?? '请求失败');
    }

    function errorText(error) {
      return String(error?.message ?? error);
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
      return p === 'feishu' ? '飞书' : p === 'weixin' ? '微信' : p;
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

      const sessionId = useCallback(() => {
        if (sessionIdRef.current) return sessionIdRef.current;
        const el = rootRef.current?.closest?.('[data-conversation-session]');
        const id = el?.getAttribute?.('data-conversation-session') ?? '';
        if (id) sessionIdRef.current = id;
        return id;
      }, []);

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
          const fmt = sent.format === 'card' ? '卡片' : '消息';
          setNote(`已发送${fmt} ${sent.textParts ?? 0} 条，文件 ${sent.filesSent ?? 0} 个 → ${value.bot?.name || platformLabel(value.bot?.platform)}`);
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
          if (!session?.prompt) throw new Error('当前会话还没就绪，暂时无法发送提示词。');
          if (session.getSnapshot?.()?.running) {
            throw new Error('这一轮还在运行，等它结束后再点，才能把结果对应到这条提示词。');
          }
          unwrap(await call('auto.arm', { botId, sessionId: sessionId(), include }));
          const result = await session.prompt([{ type: 'text', text: preset.text }], 'queue');
          if (result && result.ok === false) throw new Error(result.error?.message ?? '提示词被拒绝。');
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
              if (sent.cards) parts.push(`卡片 ${sent.cards} 张`);
              else if (sent.textParts) parts.push(`消息 ${sent.textParts} 条`);
              if (sent.filesSent) parts.push(`文件 ${sent.filesSent} 个`);
              setPresetNote(`已自动发送第 ${r.turn ?? '?'} 轮${parts.length ? `（${parts.join('、')}）` : ''}。`);
              setAutoWatch(null);
            } else if (value.state === 'error' || value.state === 'timeout') {
              setError(`自动回传失败：${value.error || value.state}`);
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
          setError('提示词不能为空。');
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
          title: '把这一轮的提示词、回复和文件发送到已绑定的机器人',
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
        h('span', null, `${open ? '收起' : '发至IM'}${turn ? ` · 第 ${turn} 轮` : ''}`)),
        note && !open ? h('span', { style: S.ok }, note) : null,
        error && !open ? h('span', { style: S.err }, error) : null,

        open ? h('div', { style: { ...S.panel, flexBasis: '100%', marginLeft: 0 } },
          h('div', { style: S.line },
            bots.length > 0
              ? h('select', {
                style: S.select,
                value: botId,
                title: '选择要发送到的机器人',
                onChange: (e) => setBotId(e.target.value),
              }, bots.map((bot) => h('option', { key: bot.id, value: bot.id },
                `${platformLabel(bot.platform)} · ${bot.name || bot.id}`)))
              : h('span', { style: S.muted }, '未绑定机器人'),
            h('div', { style: S.midGroup },
              h('span', { style: S.chip(include.prompts), role: 'button', title: '包含本轮的提示词', onClick: () => toggle('prompts') }, label('prompts', '提示词')),
              h('span', { style: S.chip(include.answers), role: 'button', title: '包含本轮的回复内容', onClick: () => toggle('answers') }, label('answers', '回复')),
              h('span', { style: S.chip(include.files), role: 'button', title: '包含本轮生成的文件', onClick: () => toggle('files') }, label('files', '附件')),
              h('button', {
                type: 'button',
                style: { ...S.buttonPrimary, opacity: disabled ? 0.5 : 1 },
                disabled,
                onClick: send,
              }, busy ? '发送中…' : '发送到机器人'),
              h('button', {
                type: 'button',
                style: S.buttonAccent,
                title: '预存提示词：点一下送进本会话，这一轮结果自动回传',
                onClick: () => setShowPresets((v) => !v),
              }, showPresets ? '收起预处理' : '预处理发送')),
            h('button', {
              type: 'button',
              style: S.buttonGhost,
              title: '绑定机器人 / 高级设置',
              onClick: () => setShowBind((v) => !v),
            }, showBind ? '收起设置' : '⚙ 绑定设置')),

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
                placeholder: '输入要预存的提示词，例如：帮我总结今天本会话的所有内容，结果形成一个“总结+日期”的 MD 文件。',
                onChange: (e) => setEditing({ ...editing, text: e.target.value }),
              }),
              h('div', { style: S.presetActions },
                h('button', {
                  type: 'button',
                  style: S.buttonPrimary,
                  disabled: busy,
                  onClick: savePreset,
                }, '保存'),
                h('button', { type: 'button', style: S.buttonGhost, onClick: () => setEditing(null) }, '取消'))) : null,
            h('div', { style: S.presetGrid },
              presets.map((preset) => h('div', { style: S.presetCard, key: preset.id },
                h('p', { style: S.presetText, title: preset.text }, preset.text),
                h('div', { style: S.presetActions },
                  h('button', {
                    type: 'button',
                    style: { ...S.buttonPrimary, padding: '3px 10px', opacity: bots.length === 0 ? 0.5 : 1 },
                    disabled: Boolean(presetBusy) || bots.length === 0,
                    title: '发送这条提示词到本会话，结果自动回传',
                    onClick: () => sendPreset(preset),
                  }, presetBusy === preset.id ? '发送中…' : '▶ 发送'),
                  h('button', {
                    type: 'button',
                    style: S.link,
                    onClick: () => setEditing({ id: preset.id, text: preset.text }),
                  }, '编辑'),
                  h('button', {
                    type: 'button',
                    style: S.link,
                    onClick: () => deletePreset(preset.id),
                  }, '删除'))))),
            h('div', { style: S.foot },
              h('span', { style: S.muted }, '点「▶ 发送」把提示词送进本会话，这一轮出结果后自动回传到上面的机器人。'),
              h('button', {
                type: 'button',
                style: S.link,
                onClick: () => setEditing({ id: '', text: '' }),
              }, '＋ 添加'))) : null,

          h('div', { style: S.foot },
            counts ? h('span', { style: S.muted },
              `本轮：提示词 ${counts.prompts} · 回复 ${counts.answers} · 文件 ${counts.files}`) : null,
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
      const [manual, setManual] = useState({ open: false, appId: '', appSecret: '', openId: '', name: '' });
      const [busy, setBusy] = useState(false);
      const [advanced, setAdvanced] = useState(false);
      const [themes, setThemes] = useState([]);
      const [themeId, setThemeId] = useState('');
      const [currentId, setCurrentId] = useState('');
      const [randomTheme, setRandomTheme] = useState(true);
      const [summarize, setSummarize] = useState(true);
      const [zipFiles, setZipFiles] = useState(true);
      const [autoTimeoutMin, setAutoTimeoutMin] = useState(20);
      const [github, setGithub] = useState('');
      const [unlocked, setUnlocked] = useState(false);

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
          unwrap(await call('bind.manual', { platform: 'feishu', ...manual }));
          setManual({ open: false, appId: '', appSecret: '', openId: '', name: '' });
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
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, 'Read It Later 机器人'),
          h('div', { style: S.muted },
            '在这里绑定自己的飞书 / 微信机器人。绑定与 dsh-im 完全独立：不装 dsh-im 也能用，装了也不会互相影响。凭据只写在本机 ~/.dsh/read-it-later/bots.json。')),

        error ? h('div', { style: S.err }, error) : null,

        // 绑定中的二维码
        attempt ? h('div', { style: S.card },
          h('div', { style: S.row },
            h('strong', null, `绑定${platformLabel(attempt.platform)}机器人`),
            h('span', { style: S.muted }, attempt.message || '等待扫码')),
          attempt.qrImage
            ? h('img', { src: attempt.qrImage, alt: '扫码绑定二维码', style: S.qr })
            : h('div', { style: S.muted }, '二维码生成中…'),
          attempt.qrUrl
            ? h('div', { style: S.muted },
              '扫码打不开时，可在手机里打开：',
              h('a', { href: attempt.qrUrl, target: '_blank', rel: 'noreferrer', style: { color: 'var(--ril-accent, #2f6df6)', wordBreak: 'break-all' } }, attempt.qrUrl))
            : null,
          h('div', { style: S.muted },
            attempt.platform === 'feishu'
              ? '用飞书 App 扫码，确认后会自动创建并绑定一个「专属 AI 助手」应用。'
              : '用微信扫码，按手机提示确认；若要求配对码，在下面输入。'),
          attempt.state === 'needs_code'
            ? h('div', { style: S.row },
              h('input', {
                style: { ...S.input, width: 160 },
                placeholder: '手机上的配对码',
                value: code,
                onChange: (e) => setCode(e.target.value),
              }),
              h('button', { type: 'button', style: S.buttonPrimary, onClick: submitCode }, '提交配对码'))
            : null,
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.buttonGhost, onClick: cancel }, '取消绑定'),
            h('span', { style: S.muted }, `状态：${attempt.state}`)))
          : null,

        // 已绑定列表
        h('div', { style: S.card },
          h('div', { style: S.row, justifyContent: 'space-between' },
            h('strong', null, `已绑定（${bots.length}）`),
            h('div', { style: S.row },
              h('button', { type: 'button', style: S.buttonPrimary, disabled: busy || !!attempt, onClick: () => startBind('feishu') }, '＋ 绑定飞书'),
              h('button', { type: 'button', style: S.buttonPrimary, disabled: busy || !!attempt, onClick: () => startBind('weixin') }, '＋ 绑定微信'))),
          bots.length === 0
            ? h('div', { style: S.muted }, '还没有机器人。点上面的按钮扫码绑定。')
            : bots.map((bot) => h('div', {
              key: bot.id,
              style: { ...S.row, justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--dsh-border, #eee)' },
            },
            h('div', null,
              h('div', null, `${bot.platform === 'feishu' ? '🟦' : '🟩'} ${bot.name || bot.id}`,
                bot.id === defaultId ? h('span', { style: { ...S.muted, marginLeft: 6 } }, '（默认）') : null),
              h('div', { style: S.muted },
                `${platformLabel(bot.platform)}${bot.detail ? ` · ${bot.detail}` : ''}${bot.lastSendAt ? ` · 上次发送 ${new Date(bot.lastSendAt).toLocaleString()}` : ''}`),
              bot.lastError ? h('div', { style: S.err }, bot.lastError) : null),
            h('div', { style: S.row },
              h('button', { type: 'button', style: S.buttonGhost, disabled: busy, onClick: () => testBot(bot.id) }, '发测试消息'),
              h('button', { type: 'button', style: { ...S.buttonGhost, color: '#d4380d' }, disabled: busy, onClick: () => removeBot(bot.id) }, '解绑'))))),

        // 手动绑定兜底
        h('div', { style: S.card },
          h('div', { style: S.row, justifyContent: 'space-between' },
            h('strong', null, '手动绑定飞书应用（可选）'),
            h('button', { type: 'button', style: S.buttonGhost, onClick: () => setManual((m) => ({ ...m, open: !m.open })) },
              manual.open ? '收起' : '展开')),
          manual.open ? h('div', { style: { display: 'grid', gap: 8 } },
            h('input', { style: S.input, placeholder: 'App ID（cli_…）', value: manual.appId, onChange: (e) => setManual((m) => ({ ...m, appId: e.target.value })) }),
            h('input', { style: S.input, placeholder: 'App Secret', type: 'password', value: manual.appSecret, onChange: (e) => setManual((m) => ({ ...m, appSecret: e.target.value })) }),
            h('input', { style: S.input, placeholder: '接收消息的 open_id（ou_…）', value: manual.openId, onChange: (e) => setManual((m) => ({ ...m, openId: e.target.value })) }),
            h('input', { style: S.input, placeholder: '备注名（可选）', value: manual.name, onChange: (e) => setManual((m) => ({ ...m, name: e.target.value })) }),
            h('div', null, h('button', { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: saveManual }, '保存并验证')))
            : h('div', { style: S.muted }, '如果你已经有飞书自建应用，可以用 App ID / App Secret / open_id 直接绑定。')),

        // 高级设置：解锁提示 + 外观/发送行为 + 项目地址
        h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('strong', null, '高级设置'),
            h('button', { type: 'button', style: S.buttonGhost, onClick: () => setAdvanced((v) => !v) },
              advanced ? '收起' : '展开')),
          advanced ? h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              margin: '4px 0 12px', padding: '8px 12px', borderRadius: 10,
              fontSize: 12.5,
              background: unlocked ? 'rgba(15, 157, 118, 0.08)' : 'rgba(47, 109, 246, 0.07)',
              border: `1px solid ${unlocked ? 'rgba(15, 157, 118, 0.25)' : 'rgba(47, 109, 246, 0.18)'}`,
            },
          },
            h('span', null, unlocked ? '✅ 已解锁，高级设置可以自由调整。' : '🔒 高级设置请支持本项目，点赞后生效。'),
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
            }, unlocked ? '再去项目主页看看' : '点开 GitHub 点个 Star →')) : null,
          advanced ? h('div', { style: { display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', {
              style: {
                flex: '1 1 320px', display: 'grid', gap: 10,
                opacity: unlocked ? 1 : 0.42,
                filter: unlocked ? 'none' : 'grayscale(1)',
                pointerEvents: unlocked ? 'auto' : 'none',
                transition: 'opacity .18s ease',
              },
              title: unlocked ? '' : '点开上面的项目主页即可解锁',
            },
              h('div', { style: { display: 'grid', gap: 6 } },
                check('摘要显示', summarize, (v) => applySettings({ summarize: v }), '勾选：只显示 100 字摘要 +「详情」折叠；不勾：直接全文铺在卡片里'),
                check('压缩附件', zipFiles, (v) => applySettings({ zip: v }), '勾选：附件打成一个 zip；不勾：每个文件单独发'),
                check('随机配色', randomTheme, (v) => applySettings({ randomTheme: v }), '按会话标题散列配色，每个会话尽量不同色（同一个会话颜色固定）'),
                h('label', {
                  style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' },
                  title: '预处理发送后最多等多久：超时会标成「等待结果超时」，不会无限挂着',
                },
                h('span', null, '自动回传等待'),
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
                h('span', { style: S.muted }, '分钟（1–180，默认 20；插件重启后仍在窗口内会接着等）'))),
              h('div', { style: S.muted }, randomTheme ? '配色：随机（每个会话按标题取色）' : '配色：固定（点下面的颜色切换）'),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                themes.map((t) => h('button', {
                  key: t.id,
                  type: 'button',
                  title: t.note ? `${t.name} · ${t.note}` : t.name,
                  style: {
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                    borderRadius: 999, cursor: 'pointer', fontSize: 12,
                    opacity: randomTheme ? 0.55 : 1,
                    border: `1px solid ${!randomTheme && t.id === themeId ? t.accent : 'var(--dsh-border, #d9d9d9)'}`,
                    background: !randomTheme && t.id === themeId ? t.accentSoft : 'transparent',
                    color: 'inherit',
                  },
                  onClick: () => applyTheme(t.id),
                },
                h('span', { style: { width: 12, height: 12, borderRadius: '50%', background: t.accent, display: 'inline-block' } }),
                t.name,
                !randomTheme && t.id === themeId ? ' ✓' : '',
                randomTheme && t.id === currentId ? ' ← 本会话' : '')))),
            h('div', { style: { flex: '0 1 200px', display: 'grid', gap: 6, alignContent: 'start' } },
              h('div', { style: { ...S.muted, lineHeight: 1.6 } },
                '高级设置会随插件版本更新，默认推荐：摘要显示 + 压缩附件 + 随机配色。'))) : null,
          advanced ? h('div', { style: { ...S.muted, marginTop: 10, wordBreak: 'break-all' } },
            '项目地址：',
            github
              ? h('a', { href: github, target: '_blank', rel: 'noreferrer', onClick: unlock, style: { color: 'var(--ril-accent, #2f6df6)' } }, github)
              : '（待填）') : null) );
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
