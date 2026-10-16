/**
 * 「借道」探测：本机已经有代理在跑时，直接复用它的端口。
 *
 * 用途：dsh-proxy-on-demand 的借道机制 —— 用户自己开着 FlClash / Clash Verge /
 *       v2rayN 之类的东西时，本插件**不另起内核**，直接走那个已经建好的代理。
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 *       （本文件与内核无关，也不改动它）
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；只用 Node 内建模块。
 * 自动安装提醒：本文件不下载任何东西。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 *
 * ── 语义变更（2026-10-16）──────────────────────────────────────────────────
 *
 * 本文件以前是「**礼让**」：检测到别的代理在跑就**拒绝启动**，宁可没有代理。
 * 那是个错误的方向 —— 用户的诉求是「你能起代理，但别影响我用 Fl」，
 * 而不是「有人在用 Fl 时你就别工作」。而且旧默认端口 7890 与 FlClash 相同，
 * 撞车是必然的（见 core.js 的 DEFAULTS.port 注释）。
 *
 * 现在改成「**借道**」：别人在跑 → **用它的**；没人跑 → 才自己起（端口 7899，
 * 与所有常见代理端口都不同）。结果：两边永远不会抢，而且大部分时候
 * 本插件连进程都不用起。
 *
 * ── 为什么只看端口，不看进程名 ──────────────────────────────────────────────
 *
 * 用户明确要求：不要判断「这是哪个软件」，只看网络资源有没有被占。
 * 于是判据只有一条 —— **本地是不是已经有东西在监听代理端口**。
 *
 * 代价：无法覆盖「代理软件开着但还没监听端口」以及「TUN 模式不监听任何端口」
 * 这两种情况（见 README 的已知限制）。那时我们会自己起一个内核，功能不受影响。
 */

import net from 'node:net';

/**
 * 常见代理软件的默认监听端口 —— 也是**借道候选**。
 *
 * 覆盖范围按「客户端默认值」而不是「品牌」来列，理由同上：认的是资源不是软件。
 * 本机实测过的几个：
 *   · 7890 — FlClash / Clash 系默认混合端口
 *   · 7897 — Clash Verge Rev 默认
 *   · 10808/10809 — v2rayN 默认（socks / http）
 *
 * ⚠️ **不含 7899** —— 那是本插件自己的端口（见 core.js 的 DEFAULTS.port）。
 *    把它列进来会在「自己的内核刚被杀、端口还没释放」时把自己借给自己。
 */
export const COMMON_PROXY_PORTS = [
  7890, 7891, 7892, 7893, // Clash / mihomo 系常用
  7897, 7898,             // Clash Verge Rev 系
  10808, 10809, 10810,    // v2rayN / xray 系
  1080, 1081,             // SOCKS 惯例端口
  2080, 2081,             // sing-box / 部分客户端
  20171, 20172,           // Clash Verge 旧版
  8889,                   // Clash for Windows 混合端口
  8118,                   // privoxy
  9910,                   // 部分加速器
];

/** 单端口探测超时。loopback 上被拒是瞬时的，这个值只防防火墙 DROP。 */
const PROBE_TIMEOUT_MS = 400;

/** 借道探测结果缓存时长。避免同一次操作里反复探。 */
export const BORROW_TTL_MS = 3000;

// ── 端口探测 ─────────────────────────────────────────────────────────────────

/**
 * 探一个 loopback 端口有没有人在听。
 *
 * 用 net.createConnection 而不是 netstat / Get-NetTCPConnection：后者要起
 * 外部进程（约 100-300ms），而这里并发探 18 个端口实测总共 1-2ms。
 */
export function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (up) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve({ port, up, ms: Date.now() - t0 });
    };
    s.on('connect', () => finish(true));
    s.on('error', () => finish(false));
    s.setTimeout(timeoutMs, () => finish(false));
  });
}

/** 并发探一组端口。 */
export async function samplePorts(ports, timeoutMs = PROBE_TIMEOUT_MS) {
  const list = [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];
  return Promise.all(list.map((p) => probePort(p, timeoutMs)));
}

// ── 借道判定（纯函数，可离线测试）────────────────────────────────────────────

/**
 * 从一批探测结果里挑一个**借道目标**。
 *
 * 抽成纯函数是为了能完全离线测试 —— 判定规则不该依赖机器当时在跑什么。
 *
 * 挑选顺序：`extraPorts`（调用方显式指定的，优先）→ `COMMON_PROXY_PORTS` 的
 * 原始顺序（7890 排第一，也就是「FlClash 优先」）。**不按端口号排序** ——
 * 名单顺序本身就编码了优先级。
 *
 * @param {object}   o
 * @param {number}   o.ownPort   本插件自己的端口（这个不算"可借"）
 * @param {Array}    o.results   samplePorts() 的返回值
 * @param {number[]} o.order     候选优先级顺序
 * @returns {{port:number, note:string}|null}
 */
export function evaluateBorrow({ ownPort = 7899, results = [], order = [] } = {}) {
  const up = new Map();
  for (const r of results) if (r?.up) up.set(r.port, true);
  for (const p of order) {
    if (!Number.isInteger(p) || p === ownPort) continue;
    if (up.get(p)) {
      return {
        port: p,
        note: `检测到 127.0.0.1:${p} 已有代理在运行，直接借道（本插件不启动自己的内核）`,
      };
    }
  }
  return null;
}

// ── 采样入口 ─────────────────────────────────────────────────────────────────

let cache = { at: 0, ownPort: null, value: null };

export function clearBorrowCache() {
  cache = { at: 0, ownPort: null, value: null };
}

/**
 * 找一个可以借道的代理端口。
 *
 * @param {object}  o
 * @param {number}  o.ownPort    本插件自己的端口（不会被当成可借目标）
 * @param {boolean} o.force      跳过缓存
 * @param {number}  o.ttlMs      缓存时长
 * @param {number}  o.timeoutMs  单端口超时
 * @param {number[]} o.extraPorts 额外候选（排在名单前面）
 * @returns `{port,note,probed,ms,cached}|null`
 */
export async function findBorrowableProxy({
  ownPort = 7899,
  force = false,
  ttlMs = BORROW_TTL_MS,
  timeoutMs = PROBE_TIMEOUT_MS,
  extraPorts = [],
} = {}) {
  const now = Date.now();
  if (!force && cache.ownPort === ownPort && now - cache.at < ttlMs) {
    return cache.value ? { ...cache.value, cached: true } : null;
  }

  const order = [...extraPorts, ...COMMON_PROXY_PORTS].filter((p) => p !== ownPort);
  const ports = [...new Set([...order, ownPort])];
  const t0 = Date.now();
  const results = await samplePorts(ports, timeoutMs);
  const hit = evaluateBorrow({ ownPort, results, order });

  const value = hit
    ? { ...hit, probed: ports.length, ms: Date.now() - t0, checkedAt: now, cached: false }
    : null;
  cache = { at: now, ownPort, value };
  return value;
}

/**
 * 给界面/CLI 看的借道概况。
 *
 * @returns `{ borrowing, port, note, candidates, ms }`
 */
export async function borrowStatus({ ownPort = 7899, force = false } = {}) {
  const hit = await findBorrowableProxy({ ownPort, force });
  return {
    borrowing: Boolean(hit),
    port: hit?.port ?? null,
    note: hit?.note ?? '未检测到可借道的代理，需要时本插件会启动自己的内核',
    candidates: [...new Set(COMMON_PROXY_PORTS.filter((p) => p !== ownPort))],
    probed: hit?.probed ?? COMMON_PROXY_PORTS.length,
    ms: hit?.ms ?? 0,
    cached: hit?.cached ?? false,
  };
}
