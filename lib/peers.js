/**
 * 检测「别的代理软件正在运行」，用于自动静默让路。
 *
 * 用途：dsh-proxy-on-demand 的礼让机制 —— 用户自己开了 FlClash / Clash Verge /
 *       v2rayN 之类的东西时，本插件不去抢端口、不改变网络环境，安静退到一边。
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 *       （本文件与内核无关，也不改动它）
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；只用 Node 内建模块。
 * 自动安装提醒：本文件不下载任何东西。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 *
 * ── 为什么只看端口，不看进程名 ──────────────────────────────────────────────
 *
 * 用户明确要求：不要判断「这是哪个软件」，只看网络资源有没有被占。
 * 于是判据只有一条 —— **本地是不是已经有东西在监听代理端口**。
 *
 * 这样做的代价与收益：
 *   · 收益：以后换任何代理软件都自动适用，不需要维护名单；也不会因为
 *     "某个软件不在名单里"而漏判。
 *   · 代价：无法覆盖「代理软件开着但还没监听端口」以及「TUN 模式不监听
 *     任何端口」这两种情况（见 README 的已知限制）。
 *
 * ── 为什么必须排除自己的内核 ────────────────────────────────────────────────
 *
 * 我们自己就监听 cfg.port（默认 7890）。如果只按"端口有人听"判断，
 * 本插件跑起来的那一刻就会把自己认成"别的代理"，永远自我阻断。
 * 所以调用方要传 ownAlive —— 我们自己的内核活着时，ownPort 上的监听
 * 算我们的，不算别人的。
 *
 * ── 与游戏闸门的关系 ────────────────────────────────────────────────────────
 *
 * 两者是姊妹机制，都在 core.start() 之前拦一道，但触发条件完全不同：
 *   · 游戏闸门：系统进入不可打扰状态 → 不起代理（怕破坏游戏体验）
 *   · 礼让机制：别人已经占了代理端口 → 不起代理（怕跟人抢）
 * 都遵循同一个原则：**只拦新的，已有的不动**，且检测失败时放行。
 */

import net from 'node:net';

export const PEER_DEFAULTS = {
  /** 检测到别的代理在跑时，自动静默让路（不启动自己的内核）。 */
  yieldToPeer: true,
};

/**
 * 常见代理软件的默认监听端口。
 *
 * 覆盖范围按「客户端默认值」而不是「品牌」来列，理由同上：认的是资源不是软件。
 * 本机实测过的几个：
 *   · 7890 — FlClash / Clash 系默认混合端口（本插件默认也用这个）
 *   · 7897 — Clash Verge Rev 默认
 *   · 10808/10809 — v2rayN 默认（socks / http）
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

/** 检测结果缓存时长。界面 4 秒轮询，取 3 秒避免每次都重探。 */
export const DETECT_TTL_MS = 3000;

// ── 端口探测 ─────────────────────────────────────────────────────────────────

/**
 * 探一个 loopback 端口有没有人在听。
 *
 * 用 net.createConnection 而不是 netstat / Get-NetTCPConnection：后者要起
 * 外部进程（约 100-300ms），而这里并发探 15 个端口实测总共 1-2ms。
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

// ── 判定（纯函数，可离线测试）────────────────────────────────────────────────

/**
 * 根据端口探测结果判断「别人是不是在跑代理」。
 *
 * 抽成纯函数是为了能完全离线测试 —— 判定规则不该依赖机器当时在跑什么。
 *
 * @param {object}   o
 * @param {number}   o.ownPort   本插件自己要用的端口
 * @param {boolean}  o.ownAlive  本插件的内核是否活着（活着则 ownPort 算自己的）
 * @param {Array}    o.results   samplePorts() 的返回值
 */
export function evaluatePeers({ ownPort = 7890, ownAlive = false, results = [] } = {}) {
  const hits = [];
  for (const r of results) {
    if (!r?.up) continue;
    // 自己的内核监听自己的端口 —— 不算"别人"
    if (r.port === ownPort && ownAlive) continue;
    hits.push({
      kind: r.port === ownPort ? 'own-port' : 'port',
      port: r.port,
      note: r.port === ownPort
        ? '本插件要用的端口已被别的程序占用'
        : '常见代理端口有人监听',
    });
  }
  hits.sort((a, b) => a.port - b.port);
  return { peerRunning: hits.length > 0, hits };
}

/** 把判定结果说成人话。 */
export function describePeer(d) {
  if (!d?.peerRunning) return '未检测到其它代理';
  const ports = d.hits.map((h) => h.port).join('、');
  return `端口 ${ports} 正在被监听`;
}

// ── 采样入口 ─────────────────────────────────────────────────────────────────

let cache = { at: 0, ownPort: null, ownAlive: null, value: null };

export function clearPeerCache() {
  cache = { at: 0, ownPort: null, ownAlive: null, value: null };
}

/**
 * 检测别的代理是否在运行。
 *
 * @param {object}  o
 * @param {number}  o.ownPort    本插件端口（默认 7890）
 * @param {boolean} o.ownAlive   本插件内核是否活着
 * @param {boolean} o.force      跳过缓存
 * @param {number}  o.ttlMs      缓存时长
 * @param {number}  o.timeoutMs  单端口超时
 * @param {number[]} o.extraPorts 额外要探的端口
 */
export async function detectPeers({
  ownPort = 7890,
  ownAlive = false,
  force = false,
  ttlMs = DETECT_TTL_MS,
  timeoutMs = PROBE_TIMEOUT_MS,
  extraPorts = [],
} = {}) {
  const now = Date.now();
  const fresh = cache.value
    && now - cache.at < ttlMs
    && cache.ownPort === ownPort
    && cache.ownAlive === ownAlive;
  if (fresh && !force) return { ...cache.value, cached: true };

  const t0 = Date.now();
  const ports = [...COMMON_PROXY_PORTS, ownPort, ...extraPorts];
  const results = await samplePorts(ports, timeoutMs);
  const ev = evaluatePeers({ ownPort, ownAlive, results });
  const value = {
    ...ev,
    ownPort,
    ownAlive,
    probed: [...new Set(ports)].length,
    ms: Date.now() - t0,
    checkedAt: now,
    cached: false,
  };
  cache = { at: now, ownPort, ownAlive, value };
  return value;
}

/**
 * 闸门：检测到别的代理在跑时是否该让路。
 *
 * 返回 { blocked, reason, detail, message }，reason ∈
 *   disabled / no-peer / peer-running / detect-failed
 *
 * 与游戏闸门一样：**检测本身出错时放行** —— 宁可多起一次内核，
 * 也不要因为探测代码出问题就让代理彻底不可用。
 */
export async function peerGate({
  yieldToPeer = true,
  ownPort = 7890,
  ownAlive = false,
  force = false,
  ttlMs = DETECT_TTL_MS,
} = {}) {
  if (yieldToPeer === false) return { blocked: false, reason: 'disabled' };

  let d;
  try {
    d = await detectPeers({ ownPort, ownAlive, force, ttlMs });
  } catch (e) {
    return {
      blocked: false,
      reason: 'detect-failed',
      detail: { error: String(e?.message ?? e) },
      message: `代理礼让检测失败（${String(e?.message ?? e)}），按放行处理。`,
    };
  }

  if (d.peerRunning) {
    const who = d.hits.find((h) => h.kind === 'own-port') ?? d.hits[0];
    return {
      blocked: true,
      reason: 'peer-running',
      detail: d,
      message: `检测到其它代理正在运行（${describePeer(d)}），已按设置自动静默让路，不启动本插件的内核。`
        + (who?.kind === 'own-port' ? `端口 ${who.port} 被别的程序占用，本插件不会去抢。` : '')
        + '可在设置里关掉「检测到其它代理时自动让路」，或给本次命令加 --no-peer 强行启用。',
    };
  }

  return { blocked: false, reason: 'no-peer', detail: d };
}
