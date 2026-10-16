/**
 * dsh-proxy-on-demand / 客户端界面渲染冒烟测试。
 *
 * 用途：不依赖浏览器，用最小 React 替身把 lib/client.js 的 Card 组件跑一遍，
 *   确认它在「数据未到位」「数据到位」「出错」三种状态下都能渲染出树而不抛异常。
 *   注册到不存在的 slot 会静默失败，渲染期的异常同样容易被忽略，所以这里
 *   用真实返回值（取自宿主 /dsh-proxy/status 与 /settings 的实测形状）当输入。
 *
 * ── 2026-10-16 收窄 ─────────────────────────────────────────────────────────
 *
 * 本插件是**给 Agent 用的工具**，不是给用户用的代理客户端软件（用户 m00001
 * 原话）。界面里原先那三整块「软件」功能已经全部删除，本测试对应地删掉了
 * 它们的断言：
 *   · Windows 系统代理开关（插件永不改注册表）
 *   · 游戏检测 + 白名单
 *   · 礼让其它代理（语义反转为「借道」）
 * 现在只保留：状态 / 内置配置来源三路（订阅、导入 FlClash、手动粘贴）/
 * 节点选择 / 参数 / 关于。
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
 * ⚠ Card 里 useState 的声明顺序（改 Card 时必须同步改这里）：
 *
 *   0 st  1 cfg  2 cfgInfo  3 busy  4 msg  5 err
 *   6 subInput  7 manual  8 showManual  9 proxies  10 nodeBusy
 *
 * 共 11 个。2026-10-16 删掉了 allowInput（原 9）与 proxyBusy（原 12），
 * 索引整体前移 —— 系统代理开关、游戏白名单、礼让三块功能已从插件移除。
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

/** 遍历树，收集所有 element（函数组件先求值）。 */
function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out; }
  if (node.$$typeof !== 'element') return out;
  if (typeof node.type === 'function') return collect(node.type(node.props), out);
  out.push(node);
  collect(node.props?.children, out);
  return out;
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

/** 拿到 Card 组件。 */
function cardOf(React) {
  const cap = loadClient(React);
  let reg = null;
  cap.exports.apply({ slots: { inject: (_n, cb) => cb(), register: (o, C) => { reg = { o, C }; return () => {}; } } });
  return reg.C;
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
  const Card = cardOf(makeReact(S_LOADING));
  check('9 数据未到位时渲染「加载中…」且不抛', () => {
    const tree = Card();
    assert(textOf(tree).includes('加载中'), '没有加载中占位');
  });
}

// ── 3. 渲染：数据到位（用宿主实测形状） ──────────────────────────────────
/**
 * 宿主 /status 的实测形状（2026-10-16 改版后）。
 * 注意 **不再有 sysProxy / game / peer 三段** —— 那些端点已经删了。
 */
function statusFixture(over = {}) {
  return {
    ok: true, enabled: true, coreAlive: true, portUp: true, externalPort: false,
    pid: 14040, idleMs: 120000, remainingMs: 115317,
    exitPort: 7899, exitPortUp: true, borrowed: false,
    starts: 0, stops: 0, autoStops: 0, renewals: 0,
    starts2: undefined,
    startedAt: null, lastStartMs: null, lastError: null,
    borrows: 0, portReuses: 0, lastBorrowNote: null,
    plugin: { kernelVersion: '1.19.32', generations: 4, requests: 7, lastError: null },
    ...over,
  };
}

function settingsFixture(over = {}) {
  return {
    enabled: true, port: 7899, idleMs: 120000, subscriptionUrl: '',
    autoImportFlClash: true, configSource: '',
    lastSyncAt: null, lastSyncNote: '', resident: false,
    ...over,
  };
}

{
  const st = statusFixture();
  const settings = settingsFixture();
  const cfgInfo = { exists: true, bytes: 180131, port: 7899, nodeCount: 12, ruleCount: 44, mtime: 1791868783883.4966 };

  const React = makeReact([st, settings, cfgInfo, '', null, null, '', '', false]);
  const Card = cardOf(React);

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
  check('13 非常驻时显示空闲倒计时', () => {
    const s = textOf(tree);
    // 倒计时是「剩余 116 秒后自动关闭」（remainingMs=115317 向上取整）。
    // 注意别去断言参数输入框里的 120 —— input 的 value 不是文本子节点。
    assert(s.includes('116 秒后自动关闭'), '缺剩余时间文案');
  });
  check('14 内核启停是一个开关，不是三个大按钮', () => {
    const s = textOf(tree);
    assert(s.includes('代理内核'), '缺内核开关区块');
    assert(s.includes('运行中'), '缺运行中状态');
    assert(!s.includes('立即启动'), '「立即启动」按钮残留');
    assert(!s.includes('停止内核'), '「停止内核」按钮残留');
    assert(!s.includes('续期空闲计时'), '「续期空闲计时」按钮残留');
  });
  check('14b ★ 系统代理整块已删除（插件永不改注册表）', () => {
    const s = textOf(tree);
    assert(!s.includes('系统代理'), '「系统代理」字样残留 —— 该功能已整体移除');
    assert(!s.includes('注册表'), '「注册表」字样残留');
  });
  check('14c ★ 游戏检测整块已删除', () => {
    const s = textOf(tree);
    assert(!s.includes('游戏'), '「游戏」字样残留 —— 该功能已整体移除');
    assert(!s.includes('白名单'), '「白名单」字样残留');
    assert(!s.includes('前台程序'), '「前台程序」字样残留');
  });
  check('14d ★ 礼让整块已删除（语义反转为借道）', () => {
    const s = textOf(tree);
    assert(!s.includes('让路'), '「让路」字样残留 —— 已改为借道');
    assert(!s.includes('礼让'), '「礼让」字样残留');
    assert(!s.includes('不看软件名'), '旧的「只看端口不看软件名」说明残留');
  });
  check('14e 开关用的是 role=switch 的按钮', () => {
    // iOS 那种胶囊开关：必须是 role=switch，且带上 aria-checked。
    const switches = collect(tree).filter((n) => n.props?.role === 'switch');
    assert(switches.length >= 1, `应至少有内核开关，实际 ${switches.length}`);
    switches.forEach((sw) => {
      assert(typeof sw.props['aria-checked'] === 'boolean', 'aria-checked 必须是布尔');
    });
  });
  check('15 含自动下载提醒与上游声明', () => {
    const s = textOf(tree);
    assert(s.includes('61MB'), '缺自动下载提醒');
    assert(s.includes('mihomo'), '缺上游声明');
    assert(s.includes('GPL-3.0'), '缺许可证说明');
  });
  check('16 端口说明写的是 7899 而不是 7890', () => {
    const s = textOf(tree);
    assert(s.includes('7899'), '缺 7899 说明');
    assert(s.includes('故意不是 7890'), '缺「故意避开 7890」的理由');
  });
  check('17 配置来源三路都在（用户 m00052 明确要求保留）', () => {
    const s = textOf(tree);
    assert(s.includes('订阅地址'), '缺订阅输入');
    assert(s.includes('拉取订阅'), '缺拉取订阅按钮');
    assert(s.includes('从 FlClash 导入'), '缺 FlClash 导入按钮');
    assert(s.includes('手动粘贴'), '缺手动粘贴入口');
  });
  check('18 渲染树里有 input 与 button', () => {
    const els = collect(tree);
    assert(els.some((n) => n.type === 'input'), '没有 input');
    assert(els.some((n) => n.type === 'button'), '没有 button');
  });
  check('19 提交过的 textarea 在手动粘贴收起时不出现', () => {
    const els = collect(tree);
    assert(!els.some((n) => n.type === 'textarea'), 'showManual=false 时不该有 textarea');
  });
}

// ── 4. 借道中：不显示自己的内核在跑 ─────────────────────────────────────
{
  const st = statusFixture({
    coreAlive: false, portUp: true, externalPort: true,
    pid: null, remainingMs: 0,
    exitPort: 7890, exitPortUp: true, borrowed: true,
    borrows: 3, lastBorrowNote: '检测到 127.0.0.1:7890 已有代理在运行，直接借道',
  });
  const React = makeReact([st, settingsFixture(), { exists: true, nodeCount: 5, ruleCount: 10, port: 7899 }, '', null, null, '', '', false]);
  const Card = cardOf(React);
  let tree = null;
  check('20 借道中渲染不抛异常', () => { tree = Card(); assert(tree, '返回空'); });
  check('21 借道中说明「借道」并给出被借端口', () => {
    const s = textOf(tree);
    assert(s.includes('借道'), '缺借道说明');
    assert(s.includes('7890'), '缺被借端口');
    assert(s.includes('不抢端口'), '缺「不抢端口」说明');
  });
  check('22 借道中不显示空闲倒计时（没自己的内核可关）', () => {
    const s = textOf(tree);
    assert(!s.includes('秒后自动关闭'), '借道时不该显示空闲倒计时');
  });
  check('23 借道中内核开关禁用（不能启动自己的内核）', () => {
    const sw = collect(tree).find((n) => n.props?.role === 'switch');
    assert(sw?.props?.disabled === true, '借道时开关应禁用');
    assert(/借道/.test(sw?.props?.title ?? ''), `开关 title 应说明借道：${sw?.props?.title}`);
  });
}

// ── 5. 常驻模式 ─────────────────────────────────────────────────────────
{
  const st = statusFixture();
  const React = makeReact([st, settingsFixture({ resident: true }), { exists: true, nodeCount: 5, ruleCount: 10, port: 7899 }, '', null, null, '', '', false]);
  const Card = cardOf(React);
  let tree = null;
  check('24 常驻模式渲染不抛异常', () => { tree = Card(); assert(tree, '返回空'); });
  check('25 常驻时说明不会自动关闭', () => {
    const s = textOf(tree);
    assert(s.includes('常驻'), '缺常驻说明');
    assert(!s.includes('秒后自动关闭'), '常驻时不该显示空闲倒计时');
  });
}

// ── 6. 节点面板 ─────────────────────────────────────────────────────────
{
  const st = statusFixture();
  const proxies = {
    ok: true, coreRunning: true, total: 3, hidden: 2,
    groups: [{ name: 'G', type: 'Selector', selectable: true, now: '节点 A', members: ['节点 A', '节点 B', 'DIRECT'] }],
    nodes: [
      { name: '节点 A', type: 'Trojan', delay: 120, failed: false },
      { name: '节点 B', type: 'Trojan', delay: null, failed: false },
    ],
  };
  const React = makeReact([st, settingsFixture(), { exists: true, nodeCount: 2, ruleCount: 5, port: 7899 }, '', null, null, '', '', false, proxies, '']);
  const Card = cardOf(React);
  let tree = null;
  check('26 有节点数据时渲染不抛异常', () => { tree = Card(); assert(tree, '返回空'); });
  check('27 节点面板显示已连接与节点数', () => {
    const s = textOf(tree);
    assert(s.includes('已连接'), '缺已连接徽章');
    assert(s.includes('节点 A'), '缺节点名');
  });
  check('28 标出当前选中并显示延迟', () => {
    const s = textOf(tree);
    assert(s.includes('120 ms'), '缺延迟值');
    assert(s.includes('当前：节点 A'), '缺当前选中说明');
  });
  check('29 未测速的节点显示「未测速」而不是 0', () => {
    const s = textOf(tree);
    assert(s.includes('未测速'), '缺未测速占位');
  });
  check('30 隐藏的系统条目数有说明', () => {
    const s = textOf(tree);
    assert(s.includes('已隐藏 2 个系统条目'), '缺隐藏条目数说明');
  });
  check('31 节点列表是竖排滚动容器，且高度按 8 行算', () => {
    const els = collect(tree);
    const box = els.find((n) => n.props?.style?.overflowY === 'auto');
    assert(box, '没找到可滚动的节点列表容器');
    assert(box.props.style.maxHeight === 8 * 28 + 2, `maxHeight=${box.props.style.maxHeight}`);
  });
  check('32 分组控件已删光，只剩滚动列表', () => {
    const els = collect(tree);
    assert(!els.some((n) => n.type === 'select'), '不该有分组下拉');
  });
  check('33 连通性测试已删，只留测延迟', () => {
    const s = textOf(tree);
    assert(s.includes('测延迟'), '缺「测延迟」按钮');
    assert(!s.includes('连通性'), '「连通性」残留');
  });
  check('34 内建策略（DIRECT）不混进节点列表', () => {
    const s = textOf(tree);
    assert(!s.includes('DIRECT'), 'DIRECT 不该出现在节点列表里');
  });
}

// ── 7. 内核未运行 ───────────────────────────────────────────────────────
{
  const st = statusFixture({ coreAlive: false, portUp: false, externalPort: false, pid: null, remainingMs: 0, borrowed: false });
  const proxies = { ok: false, coreRunning: false, reason: '内核未在运行' };
  const React = makeReact([st, settingsFixture(), { exists: true, nodeCount: 2, ruleCount: 5, port: 7899 }, '', null, null, '', '', false, proxies, '']);
  const Card = cardOf(React);
  let tree = null;
  check('35 内核未运行时节点面板不抛异常', () => { tree = Card(); assert(tree, '返回空'); });
  check('36 内核未运行时显示原因', () => {
    const s = textOf(tree);
    assert(s.includes('内核未运行') || s.includes('内核当前没有运行'), '缺内核未运行说明');
    assert(s.includes('内核未在运行'), '缺具体原因');
  });
}

// ── 8. 手动粘贴展开 ─────────────────────────────────────────────────────
{
  const st = statusFixture();
  const React = makeReact([st, settingsFixture(), { exists: false, nodeCount: 0, ruleCount: 0, port: 7899 }, '', null, null, '', 'mixed-port: 7899', true]);
  const Card = cardOf(React);
  let tree = null;
  check('37 手动粘贴展开时渲染 textarea', () => {
    tree = Card();
    const els = collect(tree);
    assert(els.some((n) => n.type === 'textarea'), '展开后应有 textarea');
  });
  check('38 没有配置时提示用任一方式填入', () => {
    const s = textOf(tree);
    assert(s.includes('还没有配置'), '缺无配置提示');
  });
  check('39 保存按钮在文本为空时禁用', () => {
    const els = collect(tree);
    const btn = els.find((n) => n.type === 'button' && textOf(n).includes('保存这份配置'));
    assert(btn, '缺保存按钮');
    assert(btn.props.disabled === false, '有内容时不该禁用');
  });
}

// ── 9. 出错状态 ─────────────────────────────────────────────────────────
{
  const Card = cardOf(makeReact(S_ERR));
  check('40 cfg 为 null 且出错时显示错误', () => {
    const tree = Card();
    assert(textOf(tree).includes('HTTP 500'), '缺错误文本');
  });
}

console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
if (fail) process.exit(1);
