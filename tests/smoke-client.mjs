// 客户端冒烟：加载 client.js，断言槽注册与 inject 契约。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const stubReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init ?? null }),
};

const registrations = [];
let loaded = null;

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

const source = readFileSync(join(here, '..', 'client.js'), 'utf8');
new Function('window', 'require', source)(globalThis.window, (name) => {
  if (name === 'react') return stubReact;
  throw new Error(`client.js 只能 require('react')，却请求了 ${name}`);
});

assert.ok(loaded, 'client.js 没有调用 __ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-read-it-later', '插件 id 必须是 dsh-read-it-later');

const plugin = loaded.factory((name) => {
  if (name === 'react') return stubReact;
  throw new Error(`不可 require ${name}`);
});

assert.deepEqual(plugin.inject, ['slots', 'connection', 'sessions', 'locale']);

const ctx = {
  connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  slots: {
    inject(name, factory) {
      assert.ok(
        name === 'conversation.chat.turnTail'
        || name === 'conversation.composer.dock'
        || name === 'settings.section',
        `未知槽 ${name}`,
      );
      return factory();
    },
    register(options, Component) {
      registrations.push({ options, Component });
      return () => {};
    },
  },
};

const dispose = plugin.apply(ctx);
assert.equal(typeof dispose, 'function', 'apply 应返回清理函数');

const turn = registrations.find((r) => r.options.name === 'conversation.chat.turnTail');
assert.ok(turn, '没有注册 conversation.chat.turnTail');
assert.equal(turn.options.id, 'ril-turn-share');
assert.equal(turn.options.order, 40);

const settings = registrations.find((r) => r.options.name === 'settings.section');
assert.ok(settings, '没有注册 settings.section');
assert.equal(settings.options.id, 'dsh-read-it-later');
assert.equal(settings.options.order, 22);
assert.equal(settings.options.label(), 'Read It Later');

// 组件本身应能渲染成元素树（不需要真实 React）
const el = turn.Component({
  turn: 3,
  seq: 42,
  call: async () => ({ ok: true, value: { bots: [], defaultBotId: null, counts: { prompts: 1, answers: 1, files: 0 } } }),
});
assert.ok(el && el.type, '分享组件没有渲染出节点');

const panel = settings.Component({ close: () => {} });
assert.ok(panel && panel.type, '设置面板没有渲染出节点');

// 界面语言跟随 DSH 的 locale 服务（DSH 的静态 HTML 恒为 lang="en"，只看 <html lang> 会误判成英文）
function textsOf(node, out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) textsOf(n, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (typeof node.type === 'function') {
    textsOf(node.type(node.props), out);
    return out;
  }
  if (node.props?.children) textsOf(node.props.children, out);
  return out;
}

function renderWithLocale(active) {
  registrations.length = 0;
  const scoped = {
    ...ctx,
    locale: { getSnapshot: () => ({ active }), subscribe: () => () => {} },
  };
  plugin.apply(scoped);
  const registered = registrations.find((r) => r.options.name === 'conversation.chat.turnTail');
  const tree = registered.Component({ turn: 3, seq: 42, sessionId: 'session-test' });
  return textsOf(tree).join(' | ');
}

const zhText = renderWithLocale('zh');
assert.match(zhText, /发至IM/, `中文界面的按钮应显示「发至IM」，实际：${zhText}`);
const enText = renderWithLocale('en');
assert.match(enText, /Send to IM/, `英文界面的按钮应显示「Send to IM」，实际：${enText}`);

dispose();
console.log(JSON.stringify({
  ok: true,
  registrations: registrations.map((r) => r.options),
  locale: { zh: /发至IM/.test(zhText), en: /Send to IM/.test(enText) },
}));
