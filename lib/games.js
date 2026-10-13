/**
 * 游戏检测 —— 「检测到游戏就不让本插件启用代理」
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 * 打游戏时不希望网络环境被改动，所以只要检测到游戏在运行，就拒绝
 * **新**启动代理内核（已在运行的不动，见 stopOnGame 开关）。
 *
 * ── 只管自己 ──────────────────────────────────────────────────────────
 * 本文件刻意**不判断"某个程序是不是游戏"**：判据是系统自己的"当前可否打扰"
 * 状态 + 前台窗口是否无边框全屏。换句话说，它认的是「现在这个场景像不像在
 * 全屏玩游戏」，不是「这是哪个软件」。
 *
 * 这么做是因为：误判的代价仅仅是代理插件这次不启动（--no-gate 即可绕过），
 * 而维护"谁是加速器、谁是远程控制、谁是平台客户端"的名单既不可能穷尽，
 * 又会因为漏列而把真正该拦的场景放过去。
 *
 * ── 例外：用户白名单（gameAllow）──────────────────────────────────────
 * 上面说的是**不由本插件预置**任何名单。但用户自己可能确实需要例外 ——
 * 比如某款远程控制/录屏/无边框视频播放器全屏时也被判成了游戏。
 * 所以留了 gameAllow：**只由用户自己填**，默认空。
 * 白名单里的程序在前台时，判据 1 与判据 2 都不生效（见 evaluateGate）。
 *
 * 注意与早期版本的区别：早先曾预置过 42 条内置白名单（UU/迅游/雷神…），
 * 那是错的 —— 用户明确要求「不要管别的什么系统代理软件，只管自己」，
 * 所以内置名单已删除，只剩这个用户自填的。
 *
 * ── 上游程序 ──────────────────────────────────────────────────────────
 * 本项目运行时会下载 mihomo（Clash.Meta 内核）© MetaCubeX，GPL-3.0，
 * 不修改、不重打包，仅以独立进程调用。本文件与 mihomo 无代码关系。
 *
 * ── DSH 版本 ──────────────────────────────────────────────────────────
 * 面向 DeepSeek Harness 0.2.0-rc.2（Electron 44.0.0）。
 *
 * ── 自动安装提醒 ──────────────────────────────────────────────────────
 * 本文件**不下载任何东西**，也不联网。
 *
 * ── 免责声明 ──────────────────────────────────────────────────────────
 * 自用工具，按「原样」提供、不附带任何担保。检测基于系统状态推断，
 * 不保证覆盖所有游戏与所有全屏场景。
 *
 * ── 判据（全部来自 probe.js 的常驻探测进程）────────────────────────────
 *   1（主）SHQueryUserNotificationState ∈ {2 忙碌, 3 独占全屏, 4 演示}
 *          —— Windows 自己在说「现在别打扰用户」。实测能识别无边框全屏。
 *   2（辅）前台窗口铺满整块显示器且无标题栏，且不是 shell 组件
 *          —— 兜住系统没报状态的无边框全屏。
 *
 * 为什么必须有判据 2：QUNS 只在窗口"占据"屏幕时变 2，某些无边框实现
 * 不会触发；反过来，单靠窗口特征会把 explorer 桌面、输入法宿主误判成
 * 游戏（实测过），所以窗口特征只能当补充、且要排除 shell 组件。
 *
 * ── 白名单的匹配方式 ──────────────────────────────────────────────────
 * 填**裸名字**（`obs64.exe`）按进程名比对，大小写不敏感；
 * 填**完整路径**（`D:\path\to\OBS\obs64.exe`）按全路径比对（反斜杠归一）。
 * 两种混着填都行 —— 含 `\` 或 `/` 视为路径，否则视为名字。
 */
import { sampleForeground } from './probe.js';

/** 设置的默认值。 */
export const GAME_DEFAULTS = {
  /** 检测到游戏时，禁止**新**启动代理内核。 */
  blockOnGame: true,
  /**
   * 检测到游戏时，把已在运行的代理内核也关掉。
   * 默认 **false** —— 对应「只拦新的，已有的不动」：正在跑的东西
   * 突然被掐断，比"多跑一会儿"更破坏体验。
   */
  stopOnGame: false,
  /**
   * 用户白名单：这些程序在前台时不算"游戏"。
   * **默认为空，由用户自己填**（见文件头「例外：用户白名单」）。
   */
  gameAllow: [],
};

/** QUNS 取值 → 中文名（便于界面与日志显示）。 */
export const QUNS_NAMES = {
  1: '锁屏',
  2: '忙碌',
  3: '独占全屏',
  4: '演示模式',
  5: '可打扰',
  6: '免打扰时段',
  7: '应用自定',
};

/** 视为「别打扰」的状态。 */
const QUNS_BLOCK = new Set([2, 3, 4]);

/**
 * shell 组件：它们也会出现"无边框铺满屏幕"，但不是游戏。
 * 只用于判据 2（窗口特征）；判据 1（系统状态）不受此影响 ——
 * 系统说忙就是忙，不因为前台是 explorer 就推翻。
 */
const SHELL_PROCESSES = new Set([
  'explorer.exe',
  'textinputhost.exe',
  'shellexperiencehost.exe',
  'startmenuexperiencehost.exe',
  'searchhost.exe',
  'searchapp.exe',
  'applicationframehost.exe',
  'lockapp.exe',
  'dwm.exe',
  'taskmgr.exe',
  'sihost.exe',
  'ctfmon.exe',
  'runtimebroker.exe',
  'winstore.app.exe',
  'screensketch.exe',
  'gamebar.exe',
  'gamebarpresencewriter.exe',
]);

/** 取路径里的文件名（小写）。 */
function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/\//g, '\\');
  const i = s.lastIndexOf('\\');
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

/** 归一化路径：反斜杠统一、去尾空格、小写。 */
function normPath(p) {
  return String(p ?? '').replace(/\//g, '\\').trim().toLowerCase();
}

/** 是否含路径分隔符（含则按全路径比对，否则按进程名比对）。 */
function isPathEntry(s) {
  return /[\\/]/.test(String(s ?? ''));
}

/**
 * 把用户填的白名单整理成两个集合。
 *
 * 不做去重/截断这类"保护"——那是 settings.js 写入时的事；这里只做匹配
 * 需要的归一化，保证纯函数可测。
 */
function compileAllow(allow) {
  const paths = new Set();
  const names = new Set();
  if (Array.isArray(allow)) {
    for (const raw of allow) {
      const s = String(raw ?? '').trim();
      if (!s) continue;
      if (isPathEntry(s)) paths.add(normPath(s));
      else names.add(s.toLowerCase());
    }
  }
  return { paths, names };
}

/** 前台程序是否命中用户白名单。 */
function isAllowed(fg, allow) {
  if (!fg?.name) return false;
  if (allow.names.has(fg.name)) return true;
  if (fg.path && allow.paths.has(normPath(fg.path))) return true;
  return false;
}

// ── 缓存 ──────────────────────────────────────────────────────────────
// 界面 4 秒轮询一次，闸门在每次起内核前也会问一次；没有缓存的话
// 每次都要往探测进程发一轮请求。3 秒 TTL 让一轮轮询只真探测一次。
const DETECT_TTL_MS = 3000;
let detectCache = null;

/** 清掉检测缓存（改设置后调用，否则 3 秒内还看到旧结论）。 */
export function clearGameCache() {
  detectCache = null;
}

/**
 * 纯函数判定核心 —— 把探测结果映射成结论。
 *
 * **抽出来是为了能离线测试**：detectGames 要真去问系统，而判定规则
 * 本身不该依赖机器当时在跑什么。测试直接喂构造数据即可覆盖全部组合。
 *
 * @param {object} o
 * @param {object|null} o.probe 探测帧（probe.js 的 sampleForeground 形状，或 {ok:false}）
 * @param {string[]} [o.allow] 用户白名单（裸名字或全路径，见文件头）
 * @returns {{gameRunning:boolean, hit:object|null, fg:object|null, allowed:boolean,
 *            allowHit:string|null, quns:number|null, qunsName:string|null,
 *            probeOk:boolean, probeError:string|null}}
 */
export function evaluateGate({ probe, allow = [] }) {
  const probeOk = !!probe?.ok;
  const probeError = probeOk ? null : String(probe?.error ?? '探测不可用');

  let fg = null;
  let quns = null;
  if (probeOk) {
    quns = typeof probe.quns === 'number' ? probe.quns : null;
    const p = probe.fgPath ? String(probe.fgPath) : '';
    fg = {
      pid: probe.pid ?? null,
      path: p || null,
      name: p ? baseName(p) : null,
      title: String(probe.title ?? ''),
      caption: !!probe.caption,
      full: !!probe.full,
      rect: Array.isArray(probe.rect) ? probe.rect : null,
      mon: Array.isArray(probe.mon) ? probe.mon : null,
    };
  }
  const fgIsShell = !!(fg?.name && SHELL_PROCESSES.has(fg.name));

  // ── 用户白名单：命中则两条判据都不生效 ────────────────────────
  const allowSet = compileAllow(allow);
  const allowed = isAllowed(fg, allowSet);
  // 记下命中的是名字还是路径，便于界面显示"为什么这次没拦"
  let allowHit = null;
  if (allowed) {
    allowHit = fg.path && allowSet.paths.has(normPath(fg.path)) ? 'path' : 'name';
  }

  // ── 判据 1（主）：系统说「别打扰」──────────────────────────────
  let hit = null;
  if (!allowed && probeOk && quns != null && QUNS_BLOCK.has(quns)) {
    hit = {
      kind: 'quns',
      quns,
      qunsName: QUNS_NAMES[quns] ?? String(quns),
      pid: fg?.pid ?? null,
      path: fg?.path ?? null,
      name: fg?.name ?? null,
      title: fg?.title ?? '',
      label: fg?.name || '未知程序',
    };
  }

  // ── 判据 2（辅）：无边框全屏窗口 ──────────────────────────────
  if (!allowed && !hit && probeOk && fg && fg.full && !fg.caption && !fgIsShell) {
    hit = {
      kind: 'fullscreen',
      quns,
      qunsName: quns != null ? (QUNS_NAMES[quns] ?? String(quns)) : null,
      pid: fg.pid,
      path: fg.path,
      name: fg.name,
      title: fg.title,
      label: fg.name || '未知程序',
    };
  }

  return {
    gameRunning: !!hit,
    hit,
    fg,
    allowed,
    allowHit,
    quns,
    qunsName: quns != null ? (QUNS_NAMES[quns] ?? String(quns)) : null,
    probeOk,
    probeError,
  };
}

/**
 * 真去问一次系统。
 *
 * @param {object} o
 * @param {string} [o.runtimeDir] 运行时目录（探测 exe 在这下面）
 * @param {boolean} [o.force] 忽略缓存
 * @param {number} [o.ttlMs] 缓存时长
 * @param {boolean} [o.useProbe] 传 false 可跳过探测（测试用）
 * @param {string[]} [o.allow] 用户白名单
 */
export async function detectGames({
  runtimeDir = null, force = false, ttlMs = DETECT_TTL_MS, useProbe = true,
  allow = [],
} = {}) {
  const t0 = Date.now();
  // 白名单计入缓存键：改了白名单就不能再拿旧结论（否则界面改完 3 秒内
  // 看到的还是"被拦"，让人以为没生效）。这里用拼串做键，白名单最多几十项。
  const allowKey = Array.isArray(allow) ? allow.join('\u0001') : '';
  if (!force && detectCache && detectCache.allowKey === allowKey
      && (Date.now() - detectCache.at) < ttlMs) {
    return { ...detectCache.result, ms: 0, cached: true };
  }

  let probe = { ok: false, error: '探测已跳过' };
  if (useProbe) {
    try {
      probe = await sampleForeground({ runtimeDir });
    } catch (e) {
      probe = { ok: false, error: String(e?.message ?? e) };
    }
  }

  const ev = evaluateGate({ probe, allow });
  const result = {
    ...ev,
    probeMs: typeof probe.ms === 'number' ? probe.ms : null,
    ms: Date.now() - t0,
    checkedAt: Date.now(),
    cached: false,
  };

  detectCache = { at: Date.now(), allowKey, result };
  return result;
}

/** 把检测结果拼成一句人话（界面与报错共用）。 */
export function describeHit(d) {
  if (!d?.gameRunning || !d.hit) return null;
  if (d.hit.kind === 'quns') {
    const what = d.hit.label && d.hit.label !== '未知程序' ? `（${d.hit.label}）` : '';
    return `系统处于「${d.hit.qunsName}」状态${what}`;
  }
  return `检测到无边框全屏窗口（${d.hit.label}）`;
}

/**
 * 闸门 —— 起内核前调用。
 *
 * @returns {Promise<{blocked:boolean, reason:string, detail:object|null, message?:string}>}
 *   reason ∈ 'disabled' | 'no-game' | 'detect-failed' | 'game-running'
 */
export async function gameGate({
  blockOnGame = true, force = false, runtimeDir = null, useProbe = true,
  allow = [],
} = {}) {
  if (blockOnGame === false) return { blocked: false, reason: 'disabled', detail: null };

  let d;
  try {
    d = await detectGames({ force, runtimeDir, useProbe, allow });
  } catch (e) {
    // 检测本身失败时**不拦**：宁可放过，也不要因为检测崩了让代理彻底不可用。
    return { blocked: false, reason: 'detect-failed', detail: { error: String(e?.message ?? e) } };
  }

  if (!d.gameRunning) return { blocked: false, reason: 'no-game', detail: d };

  const what = describeHit(d) || '检测到游戏正在运行';
  return {
    blocked: true,
    reason: 'game-running',
    detail: d,
    message: `${what}，已按设置禁止启用代理。`
      + '游戏退出后会自动恢复。'
      + '可在设置里关掉「游戏运行时禁止启用代理」，或把该程序加进白名单、'
      + '或给本次命令加 --no-gate 强行启用。',
  };
}
