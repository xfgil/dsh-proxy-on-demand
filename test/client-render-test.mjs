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
 *   9 allowInput  10 proxies  11 nodeBusy  12 proxyBusy
 *
 * 2026-10-13 用户裁决「只留滚动的列表，分组删光」+「把连通性删了留测延迟」，
 * 于是 nodeGroup / conn / testUrl 三个 state 被删掉，索引整体前移。
 * 下面各段的状态队列**恰好不用改**：带 proxies 的那几段本来就在索引 10 放了
 * proxies，11 放空串（原 nodeGroup → 现 nodeBusy），12 也空（原 nodeBusy → 现 proxyBusy）。
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
    // 系统代理实况（宿主 /status 附带，读注册表真实值）
    sysProxy: { current: '127.0.0.1:7890', ours: true, occupiedByOther: false, enabled: true, gameProxyPaused: false },
    plugin: { kernelVersion: '1.19.32', generations: 4, requests: 7, lastError: null },
  };
  // 这一段测的是「非常驻」模式：只有非常驻才该显示空闲倒计时与「续期」按钮。
  // 常驻模式的覆盖在下面第 12 段。
  const settings = {
    enabled: true, port: 7890, idleMs: 120000, subscriptionUrl: '',
    subscriptionIntervalMs: 0, autoImportFlClash: true, configSource: '',
    lastSyncAt: null, lastSyncNote: '',
    resident: false, systemProxy: true,
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
  check('13 非常驻时显示空闲秒数与剩余时间', () => {
    const s = textOf(tree);
    assert(s.includes('120'), '缺空闲秒数');
    assert(s.includes('秒后自动关闭'), '缺剩余时间文案');
  });
  check('14 内核启停是一个开关，不是三个大按钮（用户 m02007/m02138）', () => {
    const s = textOf(tree);
    // 用户原话：「内核开关你就不能做个开关吗，为什么非要两个钮？」
    // 以及后来贴了张开关截图：「搞两个这种开关，不要摆三个大按钮在那」。
    assert(s.includes('代理内核'), '缺内核开关区块');
    assert(s.includes('运行中'), '缺运行中状态');
    // 三个旧按钮必须彻底消失
    assert(!s.includes('立即启动'), '「立即启动」按钮残留');
    assert(!s.includes('停止内核'), '「停止内核」按钮残留');
    assert(!s.includes('续期空闲计时'), '「续期空闲计时」按钮残留');
  });
  check('14b 系统代理是那种开关（不是大按钮）', () => {
    const s = textOf(tree);
    assert(s.includes('Windows 系统代理'), '缺系统代理区块');
    assert(s.includes('已开启（全局流量走本插件内核）'), 'ours=true 时应显示已开启');
    // 旧的大按钮文案必须消失
    assert(!s.includes('关闭系统代理'), '旧「关闭系统代理」按钮残留');
    assert(!s.includes('打开系统代理'), '旧「打开系统代理」按钮残留');
  });
  check('14c 开关用的是 role=switch 的按钮', () => {
    // 用户要的是 iOS 那种胶囊开关：必须是 role=switch，且带上 aria-checked，
    // 这样键盘/读屏也能用。顺带确认它真的渲染出来了。
    const switches = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.$$typeof !== 'element') return;
      // 函数组件（如 Toggle）要先求值，role 在它返回的元素上
      if (typeof n.type === 'function') { walk(n.type(n.props)); return; }
      if (n.props?.role === 'switch') switches.push(n);
      walk(n.props?.children);
    };
    walk(tree);
    assert(switches.length >= 2, `应至少有两个开关（内核 + 系统代理），实际 ${switches.length}`);
    switches.forEach((sw) => {
      assert(typeof sw.props['aria-checked'] === 'boolean', 'aria-checked 必须是布尔');
    });
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
  check('22 游戏闸只剩「启动前拦一道」', () => {
    const s = textOf(tree);
    assert(s.includes('游戏运行时禁止启用代理'), '缺主开关');
    assert(s.includes('检测到游戏连内核也一起关掉'), '缺 stopOnGame 开关');
    // 2026-10-13 用户明确反对我加的那条自动摘系统代理：
    //   「都说了开游戏只是不能启动代理插件，你没事动游戏闸做什么」
    // 所以这条开关必须彻底从界面消失。
    assert(!s.includes('检测到游戏就暂停系统代理'), '我加的「暂停系统代理」开关残留');
    assert(!s.includes('暂停系统代理'), '「暂停系统代理」文案残留');
    // 游戏中的提示也应只说"不会启动"，不再提"已自动暂停"。
    assert(!s.includes('已自动暂停系统代理'), '旧的「已自动暂停」提示残留');
    assert(s.includes('不会启动'), '游戏中提示应只说不会启动内核');
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

// ── 10. 节点面板（2026-10-13 新增）────────────────────────────────────────
//
// 背景：此前插件只有「导入配置」，没有「看节点、选节点」—— 143 个节点配 14 个
// type:select 分组，界面上一块死数据。这一节锁住新面板的三条关键行为：
//   ① 内核没跑时说「内核未运行」而不是报错；
//   ② 内核在跑时按分组列出节点，并标出当前选中；
//   ③ 列表容器高度 = 行数 × 行高（保证「一屏 8 个」是算出来的，不随字体漂）。
{
  const st = {
    coreAlive: true, portUp: true, pid: 999, idleMs: 120000, remainingMs: 60000,
    gameRunning: false,
  };
  const settings = { enabled: true, port: 7890, idleMs: 120000 };
  const proxies = {
    ok: true,
    coreRunning: true,
    total: 179,
    hidden: 39,
    groups: [
      {
        name: 'Yue.to | 悦通', type: 'Selector', selectable: true,
        now: '悦·🇭🇰香港1 · A', count: 3,
        members: ['悦·🇭🇰香港1 · A', '悦·🇯🇵日本1 · B', 'DIRECT'],
      },
      { name: '悦 · 自动选择', type: 'URLTest', selectable: false, now: '悦·🇭🇰香港1 · A', count: 2, members: ['a', 'b'] },
    ],
    nodes: [
      { name: '悦·🇭🇰香港1 · A', type: 'Hysteria2', delay: 42, fake: false },
      { name: '悦·🇯🇵日本1 · B', type: 'Vless', delay: null, fake: false },
    ],
  };
  // state 顺序（必须与 client.js 的 useState 顺序一致）：
  //   st, cfg, cfgInfo, busy, msg, err, subInput, manual, showManual,
  //   allowInput, proxies, nodeGroup, nodeBusy
  const React = makeReact([st, settings, null, '', null, null, '', '', false, '', proxies, '', '']);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  let tree = null;
  check('35 有节点数据时渲染不抛异常', () => { tree = reg.C(); assert(tree, '返回空'); });

  const s = textOf(tree);
  check('36 节点面板显示已连接与节点数', () => {
    assert(s.includes('节点选择'), '缺面板标题');
    assert(s.includes('已连接'), '缺已连接徽章');
  });
  check('37 列出分组内的节点名', () => {
    assert(s.includes('悦·🇭🇰香港1 · A'), '缺节点 A');
    assert(s.includes('悦·🇯🇵日本1 · B'), '缺节点 B');
  });
  check('38 标出当前选中并显示延迟', () => {
    assert(s.includes('● '), '缺当前选中标记');
    assert(s.includes('42 ms'), '缺延迟显示');
    assert(s.includes('未测速'), '缺未测速占位');
  });
  check('39 隐藏的系统条目数有说明', () => {
    assert(s.includes('39'), '缺隐藏条目数');
  });
  check('40 节点列表是竖排滚动容器，且高度按 8 行算', () => {
    // 找到列表容器：有 overflowY:auto 且 maxHeight 的那个 div
    let found = null;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const st2 = n.props?.style;
      if (st2 && st2.overflowY === 'auto' && typeof st2.maxHeight === 'number') found = st2;
      const kids = n.props?.children;
      if (kids) walk(kids);
    };
    walk(tree);
    assert(found, '没找到可滚动的节点列表容器');
    // 8 行 × 28px + 2px 边框
    assert(found.maxHeight === 8 * 28 + 2, `高度应为 226，实际 ${found.maxHeight}`);
  });
  check('41 分组控件已删光，只剩滚动列表（用户 m02118「分组删光」）', () => {
    // 用户原话：「只留滚动的列表，分组删光」。
    // 于是分组下拉框、optgroup、以及列表里那些 📁 子分组条目统统不许出现。
    let selects = 0;
    let optgroups = 0;
    let options = 0;
    let folderMarks = 0;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.type === 'select') selects += 1;
      if (n.type === 'optgroup') optgroups += 1;
      if (n.type === 'option') options += 1;
      if (typeof n === 'string' && n.includes('📁')) folderMarks += 1;
      walk(n.props?.children);
    };
    walk(tree);
    assert(selects === 0, `不该再有分组下拉，找到 ${selects} 个 select`);
    assert(optgroups === 0, `不该有 optgroup，找到 ${optgroups} 个`);
    assert(options === 0, `不该有 option，找到 ${options} 个`);
    assert(folderMarks === 0, `不该再把子分组当条目列出，找到 ${folderMarks} 处 📁`);
  });
  check('41b 连通性测试已删，只留测延迟（用户 m02008）', () => {
    // 用户原话：「你那个连通性为什么只有香港，把连通性删了留测延迟吧」。
    const s = textOf(tree);
    assert(s.includes('测延迟'), '缺「测延迟」按钮');
    assert(!s.includes('测连通性'), '「测连通性」按钮残留');
    assert(!s.includes('连通性测试地址'), '连通性地址输入框残留');
    assert(!s.includes('连通性'), '「连通性」字样残留');
  });
}

// ── 11. 内核没跑时，节点面板必须说「未运行」而不是报错 ────────────────────
{
  const st = { coreAlive: false, portUp: false, pid: null, idleMs: 120000, remainingMs: 0 };
  const settings = { enabled: true, port: 7890, idleMs: 120000 };
  const proxies = { ok: true, coreRunning: false, reason: '连不上内核的管理 API' };
  const React = makeReact([st, settings, null, '', null, null, '', '', false, '', proxies, '', '']);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  let tree = null;
  check('42 内核未运行时节点面板不抛异常', () => { tree = reg.C(); assert(tree, '返回空'); });
  const s = textOf(tree);
  check('43 内核未运行时显示「内核未运行」与原因', () => {
    assert(s.includes('内核未运行'), '缺未运行徽章');
    assert(s.includes('连不上内核'), '缺原因说明');
  });
}

// ── 12. 常驻模式：内核一直开着，系统代理是独立开关 ──────────────────────
//
// 用户拍板（原话）：「不该跟Fl一样内核一直开着再单独搞个开关吗」。
// 常驻下不该出现空闲倒计时、不该有「续期」按钮，且系统代理开关必须可用。
{
  const st = {
    ok: true, enabled: true, coreAlive: true, portUp: true, externalPort: false,
    pid: 4242, idleMs: 120000, remainingMs: 0,
    starts: 1, stops: 0, autoStops: 0, renewals: 0,
    startedAt: null, lastStartMs: null, lastError: null,
    sysProxy: { current: '127.0.0.1:7890', ours: false, occupiedByOther: false, enabled: false, gameProxyPaused: false },
    plugin: { kernelVersion: '1.19.32', generations: 1, requests: 1, lastError: null },
  };
  const settings = {
    enabled: true, port: 7890, idleMs: 120000, resident: true, systemProxy: true,
  };
  const React = makeReact([st, settings, null, '', null, null, '', '', false]);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  let tree = null;
  check('44 常驻模式渲染不抛异常', () => { tree = reg.C(); assert(tree, '返回空'); });
  const s = textOf(tree);
  check('45 常驻时说明不会自动关闭', () => {
    assert(s.includes('常驻运行'), '缺常驻说明');
    assert(!s.includes('秒后自动关闭'), '常驻下不该出现空闲倒计时');
  });
  check('46 常驻时隐藏空闲倒计时，内核开关显示已开', () => {
    assert(!s.includes('续期空闲计时'), '常驻下不该有续期按钮');
    assert(!s.includes('秒后自动关闭'), '常驻下不该有倒计时');
    // 开关是"开"的状态：区块里应写着「运行中」
    assert(s.includes('运行中'), '缺运行中状态');
  });
  check('47 常驻下系统代理开关仍可独立操作', () => {
    // 开关形态下不再有「打开系统代理」这类按钮文字，改判状态文案 + role=switch。
    assert(s.includes('已关闭（浏览器直连）'), 'ours=false 时应显示已关闭');
    assert(s.includes('内核在后台待命'), '缺待命说明');
    let switches = 0;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.$$typeof !== 'element') return;
      if (typeof n.type === 'function') { walk(n.type(n.props)); return; }
      if (n.props?.role === 'switch') switches += 1;
      walk(n.props?.children);
    };
    walk(tree);
    assert(switches >= 2, `内核与系统代理应各有一个开关，实际 ${switches}`);
  });
}

// ── 13. 游戏期间：插件只做一件事 —— 不启动内核 ─────────────────────────
//
// 2026-10-13 用户明确反对我加的「检测到游戏就自动摘系统代理」：
//   「都说了开游戏只是不能启动代理插件，你没事动游戏闸做什么」
// 于是这一段由「游戏暂停系统代理的说明」改成**反向断言**：不该有任何
// 自动摘代理的说法，游戏中的提示只准说「不会启动」。
{
  const st = {
    coreAlive: true, portUp: true, pid: 777, remainingMs: 0,
    sysProxy: { current: '127.0.0.1:7890', ours: true, occupiedByOther: false, enabled: true, gameProxyPaused: false },
    game: {
      ok: true, gameRunning: true, blocked: true, what: '系统处于「独占全屏」状态（game.exe）',
      hit: { kind: 'quns', quns: 3, label: 'game.exe' },
      quns: 3, qunsName: '独占全屏',
      fg: { name: 'game.exe', path: 'D:\\Games\\game.exe' },
      probeOk: true, ms: 1, checkedAt: Date.now(), cached: false,
    },
  };
  const settings = { enabled: true, port: 7890, idleMs: 120000, resident: false, blockOnGame: true };
  const React = makeReact([st, settings, null, '', null, null, '', '', false]);
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  let tree = null;
  check('48 游戏运行中渲染不抛异常', () => { tree = reg.C(); assert(tree, '返回空'); });
  const s = textOf(tree);
  check('49 游戏期间只拦启动，不碰系统代理（用户 m02009 的回滚锁）', () => {
    assert(s.includes('检测到游戏'), '缺游戏徽章');
    assert(s.includes('不会启动代理内核'), '缺"不会启动"的说明');
    // 这三条是回滚锁：任何自动摘代理的痕迹都不许回来
    assert(!s.includes('自动暂停系统代理'), '「自动暂停系统代理」残留');
    assert(!s.includes('已自动暂停'), '「已自动暂停」残留');
    assert(!s.includes('游戏结束会自动恢复'), '「游戏结束会自动恢复」残留');
    // 系统代理此时仍是我们开着的，开关应显示为"已开启"，而不是被摘掉
    assert(s.includes('已开启（全局流量走本插件内核）'), '游戏期间不该把系统代理说成已摘除');
  });
}

console.log('');
console.log(`RESULT: ${fail === 0 ? 'ALL PASS' : 'FAILED'} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
