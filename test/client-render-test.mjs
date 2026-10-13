/**
 * dsh-proxy-on-demand / 客户端界面渲染冒烟测试。
 *
 * 用途：不依赖浏览器，用最小 React 替身把 lib/client.js 的 Card 组件跑一遍，
 *   确认它在「数据未到位」「数据到位」「出错」三种状态下都能渲染出树而不抛异常。
 *   注册到不存在的 slot 会静默失败，渲染期的异常同样容易被忽略，所以这里
 *   用真实返回值（取自宿主 /dsh-proxy/status 与 /settings 的实测形状）当输入。
 *
 * 上游：mihomo © MetaCubeX（GPL-3.0），本测试不涉及内核。
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2（Electron 44.0.0）。
 * 自用免责：按「原样」提供、无担保。
 * 自动安装提醒：本测试**不联网、不下载内核**，只做纯渲染。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'lib', 'client.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    pass += 1;
  } catch (e) {
    console.log(`FAIL ${name} — ${e && e.message ? e.message : e}`);
    fail += 1;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

/** 极简 React 替身：够 Card 用即可。 */
function makeReact(stateQueue) {
  let cursor = 0;
  const effects = [];
  return {
    effects,
    createElement: (type, props, ...children) => ({
      $$typeof: 'element',
      type,
      props: { ...(props || {}), children: children.length === 0 ? undefined : (children.length === 1 ? children[0] : children) },
    }),
    useState: (init) => {
      const i = cursor++;
      const v = i < stateQueue.length ? stateQueue[i] : (typeof init === 'function' ? init() : init);
      return [v, () => {}];
    },
    useEffect: (fn) => { effects.push(fn); },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
  };
}

/**
 * Card 里 useState 的声明顺序（改 Card 时必须同步改这里）：
 *   0 st  1 cfg  2 cfgInfo  3 busy  4 msg  5 err  6 subInput  7 manual  8 showManual
 */
const S_LOADING = [null, null, null, '', null, null, '', '', false];
const S_ERR = [null, null, null, '', null, 'HTTP 500', '', '', false];

/** 把渲染出的 element 树转成字符串，便于断言内容。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (node.$$typeof === 'element') {
    const t = node.type;
    if (typeof t === 'function') return textOf(t(node.props));
    // 输入框的 placeholder 与按钮上的文字一样是用户看得见的，算进文本
    const ph = node.props?.placeholder;
    const kids = textOf(node.props.children);
    return ph ? `${kids} ${ph}` : kids;
  }
  return '';
}

function loadClient(React) {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        captured = { id, exports: factory((name) => {
          if (name === 'react') return React;
          throw new Error(`未预期的 require(${name})`);
        }) };
      },
    },
  };
  // 每次都重新求值，避免模块级状态串场
  const src = readFileSync(CLIENT, 'utf8');
  const fn = new Function('window', 'console', 'fetch', 'setInterval', 'clearInterval', src);
  fn(globalThis.window, console, () => Promise.reject(new Error('测试中不应发起 fetch')), () => 0, () => {});
  return captured;
}

// ── 1. 模块形状 ──────────────────────────────────────────────────────────
{
  const React = makeReact([]);
  const cap = loadClient(React);
  check('1 模块 id 正确', () => assert(cap.id === 'dsh-proxy-on-demand', `id=${cap.id}`));
  check('2 导出 apply/inject/name', () => {
    assert(typeof cap.exports.apply === 'function', 'apply 不是函数');
    assert(Array.isArray(cap.exports.inject), 'inject 不是数组');
    assert(typeof cap.exports.name === 'string', 'name 不是字符串');
  });
  check('3 inject 含 slots', () => assert(cap.exports.inject.includes('slots'), JSON.stringify(cap.exports.inject)));

  // ── 4. 注册进真实存在的 slot ───────────────────────────────────────────
  let registered = null;
  const ctx = {
    slots: {
      inject: (name, cb) => { assert(name === 'settings.section', `inject 名是 ${name}`); cb(); },
      register: (opts, Comp) => { registered = { opts, Comp }; return () => {}; },
    },
  };
  check('4 apply 不抛异常', () => cap.exports.apply(ctx));
  check('5 注册名是 settings.section', () => assert(registered?.opts?.name === 'settings.section', JSON.stringify(registered?.opts)));
  check('6 id 非空（slot 必填字段）', () => assert(typeof registered?.opts?.id === 'string' && registered.opts.id.length > 0, 'id 缺失'));
  check('7 label 可投影为字符串', () => {
    const l = registered.opts.label;
    const s = typeof l === 'function' ? l() : l;
    assert(typeof s === 'string' && s.length > 0, `label=${s}`);
  });
  check('8 传入的是组件函数', () => assert(typeof registered.Comp === 'function', 'Comp 不是函数'));
}

// ── 2. 渲染：数据未到位（cfg=null） ──────────────────────────────────────
{
  const React = makeReact(S_LOADING);
  const cap = loadClient(React);
  const Card = (() => {
    let reg = null;
    cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
    return reg.C;
  })();
  check('9 数据未到位时渲染「加载中…」且不抛', () => {
    const tree = Card();
    assert(textOf(tree).includes('加载中'), '没有加载中占位');
  });
}

// ── 3. 渲染：数据到位（用宿主实测形状） ──────────────────────────────────
{
  const st = {
    ok: true, enabled: true, coreAlive: true, portUp: true, externalPort: false,
    pid: 14040, idleMs: 120000, remainingMs: 115317,
    starts: 0, stops: 0, autoStops: 0, renewals: 0,
    startedAt: null, lastStartMs: null, lastError: null,
    plugin: { kernelVersion: '1.19.32', generations: 4, requests: 7, lastError: null },
  };
  const settings = {
    enabled: true, port: 7890, idleMs: 120000, subscriptionUrl: '',
    subscriptionIntervalMs: 0, autoImportFlClash: true, configSource: '',
    lastSyncAt: null, lastSyncNote: '',
  };
  const cfgInfo = { exists: true, bytes: 180131, port: 7890, nodeCount: 12, ruleCount: 44, mtime: 1791868783883.4966 };

  const React = makeReact([st, settings, cfgInfo, '', null, null, '', '', false]);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  const Card = reg.C;

  let tree = null;
  check('10 数据到位时渲染不抛异常', () => { tree = Card(); assert(tree, '返回空'); });
  check('11 显示运行中徽章与 PID', () => {
    const s = textOf(tree);
    assert(s.includes('运行中'), '缺运行中');
    assert(s.includes('14040'), '缺 PID');
  });
  check('12 显示节点与规则统计', () => {
    const s = textOf(tree);
    assert(s.includes('12'), '缺节点数');
    assert(s.includes('44'), '缺规则数');
  });
  check('13 显示空闲秒数与剩余时间', () => {
    const s = textOf(tree);
    assert(s.includes('120'), '缺空闲秒数');
    assert(s.includes('秒后自动关闭'), '缺剩余时间文案');
  });
  check('14 含三个操作按钮', () => {
    const s = textOf(tree);
    assert(s.includes('立即启动') && s.includes('立即关闭') && s.includes('续期'), '按钮缺失');
  });
  check('15 含自动下载提醒与上游声明', () => {
    const s = textOf(tree);
    assert(s.includes('61MB'), '缺自动下载提醒');
    assert(s.includes('mihomo'), '缺上游声明');
    assert(s.includes('MetaCubeX'), '缺上游版权');
    assert(s.includes('GPL-3.0'), '缺上游授权');
  });
  check('16 含自用免责声明', () => {
    const s = textOf(tree);
    assert(s.includes('原样') || s.includes('担保'), '缺免责声明');
  });
}

// ── 4. 渲染：出错状态 ────────────────────────────────────────────────────
{
  const React = makeReact(S_ERR);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  const Card = reg.C;
  check('17 出错时仍能渲染并显示错误', () => {
    const s = textOf(Card());
    assert(s.includes('加载中'), '没有占位');
    assert(s.includes('HTTP 500'), '没有显示错误');
  });
}

// ── 5. 渲染：游戏检测区块（检测到游戏）───────────────────────────────────
{
  const st = {
    ok: true, enabled: true, coreAlive: false, portUp: false, externalPort: false,
    pid: null, idleMs: 120000, remainingMs: 0,
    starts: 0, stops: 0, autoStops: 0, renewals: 0,
    startedAt: null, lastStartMs: null, lastError: null,
    plugin: { kernelVersion: '1.19.32', generations: 1, requests: 2, lastError: null },
    game: {
      ok: true, blockOnGame: true, stopOnGame: false,
      gameRunning: true, blocked: true,
      what: '系统处于「独占全屏」状态（game.exe）',
      hit: { kind: 'quns', quns: 3, qunsName: '独占全屏', label: 'game.exe' },
      quns: 3, qunsName: '独占全屏',
      fg: { name: 'game.exe', path: 'D:\\Games\\SomeGame\\bin\\game.exe' },
      probeOk: true, probeError: null, probeMs: 1, ms: 1,
      checkedAt: Date.now(), cached: false,
    },
  };
  const settings = {
    enabled: true, port: 7890, idleMs: 120000, subscriptionUrl: '',
    subscriptionIntervalMs: 0, autoImportFlClash: true, configSource: '',
    lastSyncAt: null, lastSyncNote: '', blockOnGame: true, stopOnGame: false,
  };
  const cfgInfo = { exists: true, bytes: 180131, port: 7890, nodeCount: 12, ruleCount: 44, mtime: 1 };

  const React = makeReact([st, settings, cfgInfo, '', null, null, '', '', false]);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  const Card = reg.C;

  let tree = null;
  check('19 游戏检测区块渲染不抛', () => { tree = Card(); assert(tree, '返回空'); });
  check('20 检测到游戏时显示徽章与原因', () => {
    const s = textOf(tree);
    assert(s.includes('游戏检测'), '缺区块标题');
    assert(s.includes('检测到游戏'), '缺徽章');
    assert(s.includes('独占全屏'), '缺原因');
  });
  check('21 显示系统状态与前台程序', () => {
    const s = textOf(tree);
    assert(s.includes('QUNS'), '缺 QUNS 值');
    assert(s.includes('game.exe'), '缺前台程序名');
    assert(s.includes('D:\\Games\\SomeGame\\bin\\game.exe'), '缺前台程序路径');
  });
  check('22 两个开关文案齐全', () => {
    const s = textOf(tree);
    assert(s.includes('游戏运行时禁止启用代理'), '缺主开关');
    assert(s.includes('检测到游戏就关掉已在运行的代理'), '缺 stopOnGame 开关');
  });
  check('23 说明里点明判据不看「是哪个软件」', () => {
    const s = textOf(tree);
    assert(s.includes('SHQueryUserNotificationState'), '缺系统 API 说明');
    assert(s.includes('没有标题栏'), '缺窗口特征说明');
  });
  check('24 用户白名单区块在，且不预置任何名单', () => {
    const s = textOf(tree);
    // 用户明确要求保留「自行添加白名单」，所以区块必须在
    assert(s.includes('白名单'), '缺白名单区块');
    assert(s.includes('这些程序不算游戏'), '缺白名单标题');
    // 但**内置名单**必须是删掉的（用户要求「只管自己」）
    assert(!s.includes('额外识别'), '额外游戏区块残留');
    assert(!s.includes('内置白名单'), '内置白名单开关残留');
    assert(s.includes('不预置任何名单'), '没有说明白名单由用户自填');
  });
  check('24b 白名单区块含输入框与加入按钮', () => {
    const s = textOf(tree);
    assert(s.includes('加入'), '缺「加入」按钮');
    assert(s.includes('进程名或完整路径'), '缺输入框占位文案');
  });
  check('24c 白名单为空时明说为空', () => {
    const s = textOf(tree);
    assert(s.includes('白名单为空'), '没有显示「白名单为空」');
  });
  check('24d 白名单非空时逐条列出并可移除', () => {
    // 换一份带白名单的状态再渲染一次
    const st2 = JSON.parse(JSON.stringify(st));
    st2.game.allow = ['obs64.exe', 'D:\\path\\to\\OBS\\obs64.exe'];
    const React2 = makeReact([st2, settings, cfgInfo, '', null, null, '', '', false]);
    const cap2 = loadClient(React2);
    let reg2 = null;
    cap2.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg2 = { o, C }; return () => {}; } } });
    const s2 = textOf(reg2.C());
    assert(s2.includes('obs64.exe'), '缺白名单条目');
    assert(s2.includes('D:\\path\\to\\OBS\\obs64.exe'), '缺路径条目');
    assert(s2.includes('移除'), '缺移除按钮');
  });
  check('24e 命中白名单时说明为何这次不拦', () => {
    const st3 = JSON.parse(JSON.stringify(st));
    st3.game.allow = ['obs64.exe'];
    st3.game.allowHit = 'name';
    st3.game.allowed = true;
    st3.game.gameRunning = false;
    const React3 = makeReact([st3, settings, cfgInfo, '', null, null, '', '', false]);
    const cap3 = loadClient(React3);
    let reg3 = null;
    cap3.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg3 = { o, C }; return () => {}; } } });
    const s3 = textOf(reg3.C());
    assert(s3.includes('命中白名单'), '没有说明命中白名单');
    assert(s3.includes('不拦'), '没有说明因此不拦');
  });
}

// ── 6. 渲染：探测不可用时应明说「因此不拦」──────────────────────────────
{
  const st = {
    ok: true, coreAlive: false, portUp: false, pid: null, remainingMs: 0,
    game: {
      ok: true, blockOnGame: true, stopOnGame: false,
      gameRunning: false, blocked: false, what: null, hit: null,
      quns: null, qunsName: null, fg: null,
      probeOk: false, probeError: '探测进程未就绪', probeMs: null, ms: 0,
    },
  };
  const settings = { enabled: true, port: 7890, idleMs: 120000, blockOnGame: true, stopOnGame: false };
  const React = makeReact([st, settings, null, '', null, null, '', '', false]);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  const s = textOf(reg.C());
  check('25 探测不可用时说明原因', () => {
    assert(s.includes('探测进程未就绪'), '没有显示探测错误');
  });
  check('26 探测不可用时明说「不拦」', () => {
    assert(s.includes('不拦'), '没有说明不拦的后果');
  });
}

// ── 7. 渲染：礼让区块（检测到其它代理）──────────────────────────────────
{
  const st = {
    ok: true, enabled: true, coreAlive: false, portUp: true, externalPort: true,
    pid: null, idleMs: 120000, remainingMs: 0,
    game: { ok: true, blockOnGame: true, stopOnGame: false, gameRunning: false, probeOk: true, quns: 5, qunsName: '可打扰' },
    peer: {
      ok: true, yieldToPeer: true, ownPort: 7890, ownAlive: false,
      peerRunning: true, blocked: true,
      what: '端口 7890、10808 正在被监听',
      hits: [
        { kind: 'own-port', port: 7890, note: '本插件要用的端口已被别的程序占用' },
        { kind: 'port', port: 10808, note: '常见代理端口有人监听' },
      ],
      probed: 18, ms: 2, checkedAt: Date.now(), cached: false,
    },
  };
  const settings = {
    enabled: true, port: 7890, idleMs: 120000,
    blockOnGame: true, stopOnGame: false, yieldToPeer: true,
  };
  const React = makeReact([st, settings, null, '', null, null, '', '', false]);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  const Card = reg.C;

  let tree = null;
  check('28 礼让区块渲染不抛', () => { tree = Card(); assert(tree, '返回空'); });
  check('29 检测到其它代理时显示徽章与端口', () => {
    const s = textOf(tree);
    assert(s.includes('其它代理'), '缺区块标题');
    assert(s.includes('检测到其它代理'), '缺徽章');
    assert(s.includes('10808'), '缺端口号');
  });
  check('30 明说会自动静默让路', () => {
    const s = textOf(tree);
    assert(s.includes('自动静默让路'), '没说明让路行为');
    assert(s.includes('不抢端口'), '没说明不抢端口');
  });
  check('31 礼让开关文案齐全', () => {
    const s = textOf(tree);
    assert(s.includes('检测到其它代理时自动让路'), '缺礼让开关');
  });
  check('32 说明里点明只看端口不看软件名', () => {
    const s = textOf(tree);
    assert(s.includes('网络占用'), '缺「只看网络占用」说明');
    assert(s.includes('不认软件名字'), '缺「不认软件名」说明');
  });
}

// ── 8. 渲染：没有其它代理时不显示拦截提示 ────────────────────────────────
{
  const st = {
    ok: true, coreAlive: false, portUp: false, pid: null, remainingMs: 0,
    peer: {
      ok: true, yieldToPeer: true, ownPort: 7890, ownAlive: false,
      peerRunning: false, blocked: false, what: '未检测到其它代理',
      hits: [], probed: 18, ms: 2, checkedAt: Date.now(), cached: false,
    },
  };
  const settings = { enabled: true, port: 7890, idleMs: 120000, yieldToPeer: true };
  const React = makeReact([st, settings, null, '', null, null, '', '', false]);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  const s = textOf(reg.C());
  check('33 没有其它代理时显示「没有其它代理」', () => {
    assert(s.includes('没有其它代理'), '缺正常徽章');
  });
  check('34 没有其它代理时不显示让路提示', () => {
    assert(!s.includes('自动静默让路'), '不该出现拦截提示');
  });
}

// ── 9. slot 注入名写错时应能被察觉 ───────────────────────────────────────
{
  const React = makeReact([]);
  const cap = loadClient(React);
  let injectedName = null;
  cap.exports.apply({
    slots: {
      inject: (n, cb) => { injectedName = n; cb(); },
      register: () => () => {},
    },
  });
  check('27 注入的 slot 名不是已废弃的 settings.plugin.item', () => {
    assert(injectedName !== 'settings.plugin.item', `仍是废弃名 ${injectedName}`);
  });
}

console.log('');
console.log(`RESULT: ${fail === 0 ? 'ALL PASS' : 'FAILED'} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
