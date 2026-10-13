/**
 * dsh-proxy-on-demand —— 给 DSH 用的「按需代理」插件。
 *
 * 平时不占端口、不留后台进程；需要时自动拉起 mihomo 内核，
 * 空闲一段时间后**自动关闭**。全部自包含在插件内，不依赖外部安装。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 用途
 *   给 DeepSeek Harness（DSH）提供一个随叫随到、用完就走的本地 HTTP 代理。
 *   代理只在真正需要时存在，不做常驻服务，不抢 7890 端口。
 *
 * 上游程序
 *   mihomo（即 Clash.Meta 内核）© MetaCubeX
 *     https://github.com/MetaCubeX/mihomo
 *   本插件**不修改、不重打包**内核，只在其 GitHub Release 里下载官方二进制
 *   （默认最新版，实测 v1.19.32 / windows-amd64 / 约 61MB）原样运行。
 *   内核以 GPL-3.0 授权，版权归 MetaCubeX 及 mihomo 贡献者所有。
 *
 * DSH 版本
 *   面向 DeepSeek Harness 0.2.0-rc.2（Electron 44.0.0）开发与验证。
 *   依赖的宿主能力：cordis 插件加载、webServer.register({kind:'prefix'})、
 *   client slot `settings.section`。更高版本若改了这些接口需相应调整。
 *   （注意：客户端 slot 名必须先用 cordis_inspect_query 的 Slots/listSubTree
 *   确认；注册到不存在的 slot 不报错，只是静默不渲染。）
 *
 * 自动安装提醒
 *   **本插件首次运行会自动联网下载内核**（约 61MB）写入 ../runtime/，
 *   不需要你手动装任何东西，也不会写系统目录、不改注册表、不设系统代理。
 *   想彻底清除：删掉 runtime/ 目录即可，磁盘上不留残余。
 *   如果不想让它自动下载，可在配置里设 autoDownload:false，或预先放好内核。
 *
 * 免责声明（自用工具）
 *   本插件为作者自用而写，按「原样」提供，不附带任何明示或默示的担保。
 *   代理内核、节点/订阅配置及其合法性由使用者自行负责；请遵守你所在地的
 *   法律法规，以及你所使用服务的使用条款。作者不对因使用本软件造成的
 *   任何直接或间接后果承担责任。
 * ───────────────────────────────────────────────────────────────────────
 *
 * 为什么不用 FlClash 的内核：
 *   FlClashCore.exe 是 GUI 专用的 IPC 从属进程 —— main() 要求 os.Args[1]
 *   是**管道名**（core/main.go），配置全部由界面经 IPC 下发，
 *   无法脱离 GUI 独立启动（实测 `-v` 会 panic）。所以直接用上游标准内核。
 *
 * 为什么不依赖第三方 npm 包：
 *   profile 侧解析不到它们；且 pnpm install 会重写 node_modules，有把别的
 *   插件一并重装的风险（本机 2026-10-12 那次 0.9.0 升级就是这样冲掉了
 *   29 处手改补丁）。所以只用 Node 内建模块。
 */

import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureKernel, latestVersion, DEFAULT_MIRRORS } from './downloader.js';
import { exampleConfig, findFlClashConfig, forceExternalController, materialize, pickFreePort, probePort, readExternalController } from './config.js';
import { ProxyCore } from './core.js';
import { disposeProbe, ensureProbe, probeStatus } from './probe.js';
import { listProxies, selectProxy, testGroupDelay, testConnectivity, testConnectivityMany, sampleActivity } from './nodes.js';
import {
  clearBackup, enableSystemProxy, loadBackup, occupiedByOther, pointsAtUs,
  readSystemProxy, restoreSystemProxy, saveBackup,
} from './systemproxy.js';
import {
  clearGameCache, describeHit, detectGames, gameGate,
} from './games.js';
import {
  clearPeerCache, detectPeers, describePeer, peerGate,
} from './peers.js';
import {
  applySubscription, configSummary, readSettings, writeManualConfig, writeSettings,
} from './settings.js';

export const name = 'proxy-on-demand';

/** 插件自身的包根。runtime 放在 ../runtime（.gitignore 排除）。 */
const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  enabled: true,
  port: 7890,
  idleMs: 120000,
  autoDownload: true,
  kernelVersion: '',
  runtimeDir: '',
  configFile: '',
  autoImportFlClash: true,
};

const KERNEL_REPO = 'MetaCubeX/mihomo';
const KERNEL_EXE = 'mihomo.exe';

/** 统计放 globalThis，热重载后仍连续累计。 */
const STATS_KEY = Symbol.for('dsh-proxy-on-demand.stats');
const stats = (globalThis[STATS_KEY] ??= {
  startedAt: Date.now(),
  generations: 0,
  requests: 0,
  prepares: 0,
  imports: 0,
  subscriptions: 0,
  lastPrepareAt: null,
  lastError: null,
  kernelVersion: null,
  /** 系统代理相关的计数（2026-10-13 新增）。 */
  proxyOn: 0,
  proxyOff: 0,
  proxySkipped: 0,
});
stats.generations += 1;

export function apply(ctx, config) {
  const base = { ...DEFAULTS, ...(config ?? {}) };
  const runtimeDir = base.runtimeDir || join(SELF_ROOT, 'runtime');

  const log = (level, msg) => {
    try { ctx.logger?.[level]?.(`[proxy-on-demand] ${msg}`); } catch { /* ignore */ }
  };

  /** 用户设置（界面可改）。与内核 config.yaml 分开。 */
  let user = { port: base.port, idleMs: base.idleMs, enabled: base.enabled };

  /**
   * 游戏闸门 —— 「检测到游戏运行时禁止启用代理」。
   *
   * 用**闭包回调**注入 core，而不是让 core 直接 import games.js：
   * core 只管进程，判据/设置都属上层；这样 core 能被单独测试。
   *
   * ⚠ 只拦**新起内核**。内核已在跑时 ensureRunning() 直接续租返回，
   *   这正是用户选的「只拦新的，已有的不动」。
   */
  const gate = () => gameGate({
    blockOnGame: user.blockOnGame !== false,
    allow: user.gameAllow ?? [],
    runtimeDir,
  });

  /**
   * 守护 tick 的游戏观察（仅当用户打开 stopOnGame 时才注入）。
   *
   * 默认 **null**：用户明确选了「只拦新的，已有的不动」——游戏开始时代理若
   * 已在跑就保持现状。打开 stopOnGame 后，游戏一起来就会把内核也关掉。
   */
  const gameWatch = () => detectGames({ runtimeDir, allow: user.gameAllow ?? [] })
    .then((d) => ({ gameRunning: d.gameRunning, what: describeHit(d) }));

  /**
   * 礼让闸门 —— 「检测到其它代理正在运行就自动静默让路」。
   *
   * 只看**网络占用**（常见代理端口有没有人在监听），不看进程名 —— 这样以后
   * 换成任何代理软件都自动适用，不需要维护名单。
   *
   * ⚠ 必须把 ownAlive 传下去：我们自己就监听 user.port，若不排除自己，
   *   内核一跑起来就会把自己认成「别的代理」，从此永远自我阻断。
   *   而「这个端口上的监听是不是我自己」只有 core 知道，所以由 core 算好再给。
   */
  const peerGateFn = ({ ownAlive } = {}) => peerGate({
    yieldToPeer: user.yieldToPeer !== false,
    ownPort: user.port,
    ownAlive: ownAlive === true,
  });

  /**
   * 上一次采样到的代理累计流量（用于判断"有没有新增流量"）。
   *
   * 放在 core 之前声明：activityWatch 回调里要用它做前后比较。
   */
  let lastActivity = null;

  /**
   * 系统代理钩子 —— 「开内核就连带开系统代理，关内核就精确还原」。
   *
   * ## 为什么必须有（用户 2026-10-13 原话）
   *
   * > 「肯定A啊，要不然为什么我不让你在我打游戏的时候运行插件？
   * >   肯定是因为他是系统代理啊」
   *
   * 之前插件只做到「起内核 + 开 7890」，系统代理要用户手动开 —— 于是
   * 点了「立即启动」内核在跑、端口在听，浏览器却仍直连，GitHub 照样打不开
   * （实测 `ERR_CONNECTION_RESET`）。
   *
   * ## 架构（2026-10-13 定稿）
   *
   * 两层是**拆开**的，但内核的默认行为仍是「用完自动关」：
   *
   *   · **内核**默认空闲自动关（本插件的核心理由）；想在设置里打开「常驻」
   *     也可以 —— 那只是省掉每次 1~2 秒的启动等待，不是默认。
   *   · **系统代理是独立开关** —— 它才是"全局生效、会打扰人"的东西，
   *     必须**看得见、点得动**，不能再是"内核在不在跑"的隐式副作用。
   *
   * ## 五条安全规则（按重要性排序）
   *
   * 1. **打游戏时只是不让"启动"**：游戏探测发现游戏 → 插件拒绝启动内核
   *    （见 gate）。**已经在跑的内核与系统代理都不动** —— 用户原话：
   *    「都说了开游戏只是不能启动代理插件，你没事动游戏闸做什么」。
   * 2. **不抢别人的**：系统代理已经开着且指向别的服务器（多半是 FlClash）时，
   *    我们**只报告不覆盖**。抢过来会让 FlClash 的设置失效，两边还会互相还原。
   * 3. **先备份后改**：原值落盘到 runtime/proxy-backup.json，崩溃重启也还原得回来。
   * 4. **开关持久化**：proxyEnabled 存进 settings.json，重启后保持用户的选择。
   * 5. **失败不致命**：设置失败只记日志，内核照常可用（用户还能手动配代理）。
   */
  /**
   * 系统代理的**唯一**开关实现 —— 开和关都走这里，保证幂等且可重入。
   *
   * @param want - true = 指向我们；false = 还原成用户原值
   * @param reason - 关的时候记进日志的原因
   * @returns `{ changed, skipped?, reason? }`
   */
  async function applySystemProxy(want, reason) {
    const cur = await readSystemProxy();

    if (want) {
      // ── 不抢别人的 ────────────────────────────────────────────────
      // 已经开着且指向别的服务器（多半是 FlClash）：只报告不覆盖。
      // 抢过来会让对方的设置失效，两边还会互相还原、互相踩。
      if (occupiedByOther(cur, user.port)) {
        stats.proxySkipped = (stats.proxySkipped ?? 0) + 1;
        log('info', `系统代理已被其它程序占用（${cur.server}），本插件不动它`);
        return { changed: false, skipped: 'occupied', server: cur.server };
      }
      if (pointsAtUs(cur, user.port)) return { changed: false, reason: '已经是我们的' };
      // 只在第一次改之前备份 —— 反复开关不能把"已开"的状态覆盖进备份，
      // 否则还原时会错误地把我们自己的设置当成用户原值。
      if (!(await loadBackup(runtimeDir))) await saveBackup(runtimeDir, cur);
      await enableSystemProxy(user.port, null);        // null = 合并保留用户原有绕过项
      stats.proxyOn = (stats.proxyOn ?? 0) + 1;
      log('info', `系统代理已指向 127.0.0.1:${user.port}`);
      return { changed: true, on: true };
    }

    // ── 关：精确还原 ─────────────────────────────────────────────
    const bk = await loadBackup(runtimeDir);
    if (!bk) return { changed: false, reason: '没有备份（我们没改过）' };
    await restoreSystemProxy(bk);
    await clearBackup(runtimeDir);
    stats.proxyOff = (stats.proxyOff ?? 0) + 1;
    log('info', `系统代理已还原${reason ? `（${reason}）` : ''}`);
    return { changed: true, on: false };
  }

  /**
   * 用户点了面板上的系统代理开关。
   *
   * 这是「看得见、点得动」的核心 —— 之前系统代理是内核起停的隐式副作用，
   * 用户既不知道它开没开、也没法单独关掉。现在它是一个显式状态。
   */
  async function setSystemProxy(on) {
    if (on) {
      // 开之前得确保内核在跑 —— 不然把系统代理指向一个没人监听的端口，
      // 用户会整个断网（这比"没开代理"糟糕得多）。
      if (!(await core.ownCoreAlive())) await ensureAndStart();
      const r = await applySystemProxy(true);
      if (r.skipped === 'occupied') {
        throw new Error(`系统代理已被其它程序占用（${r.server}），本插件不抢。请先关掉它。`);
      }
      return { on: true, ...r };
    }
    return { on: false, ...(await applySystemProxy(false, '用户手动关闭')) };
  }

  /**
   * 宿主「代际」号 —— 用来区分「热重载」和「宿主真的退出了」。
   *
   * 为什么需要：宿主监视着插件目录，**只要插件往 runtime 下写文件就会触发热重载**
   * （实测 `.json` / `.js` / `.mjs` / `.lock` 都会）。而热重载的次序是
   * 「先 dispose 旧实例，再 apply 新实例」——旧实例的 dispose 原本会调
   * `proxyHook.onStopped('host-dispose')` 去还原系统代理，于是：
   *
   *   - 用户点一下系统代理开关 → `saveBackup()` 写 `proxy-backup.json` → 热重载
   *     → 旧实例把刚打开的系统代理**还原掉**、顺手 `clearBackup()`；
   *   - 每次续租写 `lease.json` → 同样热重载 → 同样还原。
   *
   * 表现就是用户看到的「点了没反应」「接口报告 changed:true 但读回还是 0」
   * （2026-10-13 排查结论）。修法是：dispose 时先看有没有新实例接管。
   *
   * 每次 `apply()` 都把自己的代际号写进 `globalThis`（跨热重载保留）。
   */
  const HOST_GEN_KEY = Symbol.for('dsh-proxy-on-demand.host-generation');
  const myGeneration = (globalThis[HOST_GEN_KEY] ?? 0) + 1;
  globalThis[HOST_GEN_KEY] = myGeneration;

  /** dispose 后等这么久再看有没有新实例接管（热重载是同步紧接着发生的）。 */
  const DISPOSE_GRACE_MS = 1200;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * dispose 时释放系统代理 —— **只在「宿主真退出」且「内核真没了」时才还原**。
   *
   * 两条判据：
   *   1. 内核还活着 → 不管是不是热重载，系统代理指向一个**活的**内核都是对的，
   *      立刻返回、什么都不动。（内核是 detached 子进程，宿主退出它通常还活着。）
   *   2. 内核没了 → 等一小会看有没有新实例接管（新实例可能把内核重新拉起来）；
   *      代际号变了就是热重载，交给新实例；没变才是宿主真退出，这才还原。
   */
  async function releaseSystemProxyOnDispose() {
    if (await core.ownCoreAlive()) return;
    await sleep(DISPOSE_GRACE_MS);
    if (globalThis[HOST_GEN_KEY] !== myGeneration) return;   // 有新实例接管了
    await applySystemProxy(false, 'host-dispose');
  }

  const proxyHook = {
    /** 内核起来了：如果用户开着系统代理开关，就指向我们。 */
    async onStarted() {
      if (user.systemProxy === false) return;          // 用户关掉了这个能力
      // 用户把"启动时自动开系统代理"关掉时，内核起来也不动系统设置。
      // （proxyWantOn 是用户在面板上按的开关，见下面的 setSystemProxy）
      if (user.proxyOnStart === false) return;
      await applySystemProxy(true);
    },

    /** 内核停了：精确还原。 */
    async onStopped(reason) {
      await applySystemProxy(false, reason);
    },

    /**
     * 启动时兜底：上次宿主被强杀、来不及走 stop()，系统代理可能还指着我们
     * 那个已经死掉的端口 —— 那会让用户整个上不了网。这里收拾干净。
     *
     * ⚠ 2026-10-13 修：**内核还活着时不能还原**。
     *
     * 热重载（写 runtime 下任意文件都会触发）的次序是「dispose 旧实例 → apply
     * 新实例」，新实例起来就会调本函数。此时内核是 detached 子进程、**仍在运行**，
     * 系统代理指向它是完全正确的；若这里照旧还原，等于每写一次状态文件就把用户
     * 的系统代理关一次 —— 这正是「点了开关没反应」的另一半根因。
     *
     * 所以：内核活着 = 认领（保留系统代理与备份，什么都不动）；
     * 内核没了 = 上次真的残留了，才还原。
     */
    async adopt() {
      const bk = await loadBackup(runtimeDir);
      if (!bk) return { adopted: false };
      try {
        const cur = await readSystemProxy();
        // 只有当"当前值确实是我们留下的"才处理，避免误伤用户后来手动改的设置。
        if (!pointsAtUs(cur, user.port)) {
          await clearBackup(runtimeDir);
          return { adopted: false, reason: '系统代理已不是我们的，清理备份' };
        }
        if (await core.ownCoreAlive()) {
          log('info', '内核仍在运行，保留系统代理设置（多半只是热重载）');
          return { adopted: false, claimed: true, reason: '内核仍在运行' };
        }
        await restoreSystemProxy(bk);
        await clearBackup(runtimeDir);
        log('info', '发现上次残留的系统代理设置，已还原');
        return { adopted: true };
      } catch (e) {
        return { adopted: false, error: String(e?.message ?? e) };
      }
    },
  };

  const core = new ProxyCore({
    dir: runtimeDir,
    exe: KERNEL_EXE,
    config: 'config.yaml',
    port: base.port,
    idleMs: base.idleMs,
    log,
    // 游戏观察：**只有用户显式打开 stopOnGame 时才注入**。
    //
    // 2026-10-13 回退。用户原话：
    //   「留内核关代理啊，都说了开游戏只是不能启动代理插件，你没事动游戏闸做什么」
    //   → 选「回到原样：游戏时只禁止启动插件，别的什么都不动」
    //
    // 所以这里不再因为 pauseProxyOnGame 而观察 —— 游戏闸门只做"启动前拦一道"
    // （见上面的 gate），已经在跑的内核与系统代理都不动。
    gameWatch: () => (user.stopOnGame === true
      ? gameWatch()
      : Promise.resolve({ gameRunning: false })),
    /**
     * 活跃观察：**代理端口还有流量就自动续租**。
     *
     * 修的是「我用 github 时，关闭倒计时仍在继续」—— 用户用浏览器走代理，
     * 而续租原本只在 CLI 命令里做，于是下载到一半内核被杀。
     * 详见 core.checkIdle() 与 nodes.sampleActivity() 的注释。
     *
     * 采样值存在闭包里：需要**与上一次比较**才能知道流量有没有增长，
     * 单次采样只能拿到累计值。
     */
    activityWatch: async () => {
      const ep = await currentEndpoint();
      const a = await sampleActivity(ep, lastActivity);
      lastActivity = { up: a.up, down: a.down };
      return a;
    },
    gate,
    peerGate: peerGateFn,
    proxyHook,
  });

  /** 把用户设置同步到 core 的参数上。 */
  async function syncSettings() {
    user = await readSettings(runtimeDir);
    core.cfg.port = user.port;
    core.cfg.idleMs = user.idleMs;
    // 常驻：内核不因空闲而关。**默认 false**（= 空闲自动关，本插件的核心理由）。
    // 用户 2026-10-13 原话：「完成任务自动关为什么删？不是有个开关吗？」
    core.cfg.resident = user.resident === true;
    // 兼容老设置：显式打开 stopOnGame 时游戏期间连内核一起关。
    core.cfg.stopOnGame = user.stopOnGame === true;
    return user;
  }

  // 首次加载时读一次设置
  void syncSettings().catch(() => {});

  ctx.effect(() => {
    core.startIdleWatcher();
    // 探测程序编译（约 0.2s，一次性）——失败不影响其它功能，闸门会退化成
    // 「只用窗口特征 + 进程名单」。
    void ensureProbe({ runtimeDir, onLog: (m) => log('info', m) })
      .then((r) => { if (!r.ok) log('warn', `游戏探测程序不可用：${r.error}`); })
      .catch(() => {});
    // 兜底收拾上次的残留：如果宿主被强杀、没走到 stop()，系统代理可能还指着
    // 我们那个已经死掉的端口 —— 那会让用户整个上不了网（必须先于一切网络操作）。
    void proxyHook.adopt()
      .then((r) => { if (r?.adopted) log('info', '已还原上次残留的系统代理'); })
      .catch(() => {});
    return () => {
      core.dispose();
      disposeProbe();
      // 宿主退出时释放系统代理 —— 但**不能盲目还原**：写 runtime 下任意文件都会
      // 触发热重载，而热重载也会走到这里。详见 releaseSystemProxyOnDispose()。
      void releaseSystemProxyOnDispose().catch(() => {});
    };
  });

  // ── 管理 API 端点（节点列表 / 切节点要用它）──────────────────────────────
  //
  // 为什么需要：mihomo 的「列出节点、切换节点」全走它的管理 API，而导入的
  // FlClash 配置里 `external-controller` 是空字符串 —— 等于把门锁上了。
  // 这里给它分配一个**本机随机端口 + 随机密钥**，随配置一起落盘。
  //
  // 安全边界（对应「打游戏时零打扰」）：只绑 127.0.0.1、带 secret、
  // 且**只在内核运行期间存在**（内核一停端口就没了）。
  const CONTROLLER_KEY = Symbol.for('dsh-proxy-on-demand.controller');
  async function controllerEndpoint() {
    // 端口与密钥持久化在 globalThis，热重载后不换端口（换了的话配置里的值会对不上）。
    let c = globalThis[CONTROLLER_KEY];
    if (!c) {
      c = { port: null, secret: null };
      globalThis[CONTROLLER_KEY] = c;
    }
    if (c.port === null) c.port = await pickControllerPort();
    if (c.secret === null) c.secret = randomBytes(16).toString('hex');
    return { port: c.port, secret: c.secret };
  }

  /**
   * 挑一个空闲的本机端口给管理 API 用（从 9090 起）。
   *
   * 直接复用 config.js 的 `pickFreePort` —— 那边已经踩过「同步探测恒判空闲」
   * 的坑并修好了，这里不该再写第二份探测逻辑。
   */
  function pickControllerPort() {
    return pickFreePort(9090);
  }

  /** 读当前 config.yaml 里实际生效的管理端点（内核可能吃的是老配置）。 */
  async function currentEndpoint() {
    const c = await controllerEndpoint();
    const p = join(runtimeDir, 'config.yaml');
    try {
      const text = await fsp.readFile(p, 'utf8');
      const got = readExternalController(text);
      if (Number.isInteger(got.port)) return got;
    } catch {
      /* 配置还没生成 */
    }
    return { host: '127.0.0.1', port: c.port, secret: c.secret };
  }

  // ── 内核与配置准备 ────────────────────────────────────────────────────────
  async function prepareKernel() {
    // 自动安装提醒：这是本插件唯一会下载可执行文件的地方。
    if (!existsSync(join(runtimeDir, KERNEL_EXE))) {
      log('info', '首次使用：将从 MetaCubeX/mihomo 官方 Release 自动下载内核（约 61MB）到 runtime/，'
        + '不需要手动安装；想清除就删掉该目录。上游以 GPL-3.0 授权，本插件不修改其二进制。');
    }
    const tag = base.kernelVersion
      || (await latestVersion(`https://api.github.com/repos/${KERNEL_REPO}/releases/latest`, {
        onLog: (m) => log('info', m),
      }));
    if (!tag) throw new Error('无法获取内核版本号');
    // 资源名里的版本号**带 v 前缀**：mihomo-windows-amd64-v1.19.32.zip
    const ver = tag.startsWith('v') ? tag : `v${tag}`;
    const plain = ver.replace(/^v/, '');
    const url = `https://github.com/${KERNEL_REPO}/releases/download/${ver}/mihomo-windows-amd64-${ver}.zip`;

    const k = await ensureKernel({
      dir: runtimeDir,
      url,
      entry: 'mihomo-windows-amd64.exe',
      exe: KERNEL_EXE,
      // 直连 github.com 的 release 下载在国内会挂死，必须有镜像回退
      mirrors: Array.isArray(base.downloadMirrors) ? base.downloadMirrors : DEFAULT_MIRRORS,
      onLog: (m) => log('info', m),
    });
    stats.kernelVersion = plain;
    return { kernel: k.cached ? 'cached' : 'downloaded', version: plain, bytes: k.bytes };
  }

  /** 确保有可用的 config.yaml。 */
  async function ensureConfig({ forceImport = false } = {}) {
    await fsp.mkdir(runtimeDir, { recursive: true });
    const configPath = join(runtimeDir, 'config.yaml');
    const ctl = await controllerEndpoint();
    if (existsSync(configPath) && !forceImport) {
      // 已有配置：也要确认管理 API 是开的 —— 老配置里这一项可能是空的，
      // 那节点面板就永远读不到东西。这里**就地补一次**（幂等）。
      await ensureControllerInConfig(configPath, ctl);
      return { source: 'existing' };
    }

    if (base.configFile && existsSync(base.configFile)) {
      const r = await materialize(base.configFile, runtimeDir, {
        controllerPort: ctl.port, controllerSecret: ctl.secret,
      });
      return { source: 'configFile', ...r };
    }

    const s = await readSettings(runtimeDir);
    if (s.autoImportFlClash !== false) {
      const found = await findFlClashConfig();
      if (found.found) {
        const r = await materialize(found.path, runtimeDir, {
          controllerPort: ctl.port, controllerSecret: ctl.secret,
        });
        stats.imports += 1;
        await writeSettings(runtimeDir, { configSource: 'flclash', lastSyncAt: Date.now(), lastSyncNote: `已从 FlClash 导入（${r.rulesTotal} 条规则，管理 API :${ctl.port}）` });
        return { source: 'flclash', ...r };
      }
    }

    await fsp.writeFile(configPath, exampleConfig(base.port), 'utf8');
    await ensureControllerInConfig(configPath, ctl);
    await writeSettings(runtimeDir, { configSource: 'example', lastSyncAt: Date.now(), lastSyncNote: '生成了模板配置' });
    return { source: 'example' };
  }

  /**
   * 就地确保 config.yaml 打开管理 API（幂等）。
   *
   * 为什么要单独一步：`ensureConfig` 在配置已存在时会直接返回，于是**老配置
   * 永远停在 `external-controller: ""`**，节点面板读不到东西。这里补一次，
   * 内容没变就不落盘（避免每次启动都写文件、触发多余的重载）。
   *
   * ⚠️ 这里**只**补管理 API，不再动分组里的测速地址。
   *
   * 2026-10-13 我一度在这里顺手把 9 处 `url: gstatic/generate_204` 换成国内的
   * miui，理由是「gstatic 在国内被墙 → 面板满屏超时」。**那是误判**：内核测速
   * 是经由节点发出去的，走节点的出口，与本机能否直连 gstatic 无关；12 样本
   * 对照里三者等价（不传 92% / 组目标 83% / miui 83%）。真病根是 DNS 端口冲突
   * （`forceDnsPort` 修）。而且擅自改写用户的测速目标会**偏离 FlClash**，
   * 与用户 2026-10-13 的要求相反。
   */
  async function ensureControllerInConfig(configPath, ctl) {
    try {
      const text = await fsp.readFile(configPath, 'utf8');
      let next = text;
      const notes = [];

      const ctlFix = forceExternalController(next, ctl.port, ctl.secret);
      if (ctlFix.text !== next) {
        next = ctlFix.text;
        notes.push(`管理 API（127.0.0.1:${ctl.port}，仅本机、仅内核运行期间）`);
      }

      if (next !== text) {
        await fsp.writeFile(configPath, next, 'utf8');
        log('info', `已修补配置：${notes.join('；')}`);
        return { changed: true };
      }
      return { changed: false };
    } catch (e) {
      log('warn', `写管理 API 配置失败：${String(e?.message ?? e)}`);
      return { changed: false, error: String(e?.message ?? e) };
    }
  }

  async function ensureAndStart() {
    if (!existsSync(join(runtimeDir, KERNEL_EXE))) await prepareKernel();
    await ensureConfig();
    await syncSettings();
    return core.ensureRunning();
  }

  /**
   * 给界面看的游戏检测状态。
   *
   * 走 detectGames 的 3 秒 TTL 缓存 —— 界面 4 秒轮询一次，实际采样频率约 3 秒一次。
   * 附上 `gate` 字段直接告诉界面"现在能不能启动"。
   */
  async function gameStatus({ force = false } = {}) {
    const d = await detectGames({ runtimeDir, force, allow: user.gameAllow ?? [] });
    return {
      ok: true,
      blockOnGame: user.blockOnGame !== false,
      stopOnGame: user.stopOnGame === true,
      allow: user.gameAllow ?? [],
      allowHit: d.allowHit,
      allowed: d.allowed === true,
      gameRunning: d.gameRunning,
      blocked: (user.blockOnGame !== false) && d.gameRunning,
      what: describeHit(d),
      hit: d.hit,
      quns: d.quns,
      qunsName: d.qunsName,
      fg: d.fg,
      probeOk: d.probeOk,
      probeError: d.probeError,
      probeMs: d.probeMs,
      ms: d.ms,
      checkedAt: d.checkedAt,
      cached: d.cached,
    };
  }

  /**
   * 给界面看的「礼让」状态：别的代理是不是在跑？
   *
   * ownAlive 要现算 —— 我们自己监听 user.port，不排除自己的话，内核一跑
   * 就会被当成「别的代理」。
   */
  async function peerStatus({ force = false } = {}) {
    const ownAlive = await core.ownCoreAlive();
    const d = await detectPeers({ ownPort: user.port, ownAlive, force });
    return {
      ok: true,
      yieldToPeer: user.yieldToPeer !== false,
      ownPort: user.port,
      ownAlive,
      peerRunning: d.peerRunning,
      blocked: (user.yieldToPeer !== false) && d.peerRunning,
      what: describePeer(d),
      hits: d.hits,
      probed: d.probed,
      ms: d.ms,
      checkedAt: d.checkedAt,
      cached: d.cached,
    };
  }

  // ── HTTP 面（仅 loopback）─────────────────────────────────────────────────
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      const remote = req.socket?.remoteAddress ?? '';
      const ok = remote === '::1' || remote.startsWith('127.') ||
        /^::ffff:127\./.test(remote);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if (!ok) { res.statusCode = 403; res.end(JSON.stringify({ ok: false, reason: 'loopback only' })); return; }

      const url = new URL(req.url ?? '/', 'http://localhost');
      // register({kind:'prefix'}) 后 pathname 仍带前缀，需自行剥离
      const path = (url.pathname ?? '/').replace(/^\/dsh-proxy(?=-|\/|$)/, '') || '/';
      const method = req.method ?? 'GET';

      let body = '';
      if (method !== 'GET' && method !== 'HEAD') {
        for await (const chunk of req) body += chunk;
        if (body.length > 2e6) { res.statusCode = 413; res.end('{"ok":false}'); return; }
      }
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }

      const send = (obj, code = 200) => { res.statusCode = code; res.end(JSON.stringify(obj, null, 2)); };

      try {
        stats.requests += 1;

        switch (`${method} ${path}`) {
          case 'GET /':
          case 'GET /status': {
            await syncSettings();
            const st = await core.status();
            // 附上游戏检测状态（界面显示用）。force:false 走 3 秒 TTL 缓存，
            // 界面 4 秒轮询不会真的每次都去采样。
            let game = null;
            try { game = await gameStatus(); } catch (e) { game = { ok: false, error: String(e?.message ?? e) }; }
            let peer = null;
            try { peer = await peerStatus(); } catch (e) { peer = { ok: false, error: String(e?.message ?? e) }; }
            // 系统代理的当前实况（读注册表，不是读我们的记忆）——
            // 界面上的开关要反映**真实状态**，用户可能自己改过。
            let sysProxy = null;
            try {
              const cur = await readSystemProxy();
              sysProxy = {
                ...cur,
                ours: pointsAtUs(cur, user.port),
                occupiedByOther: occupiedByOther(cur, user.port),
                enabled: user.systemProxy !== false,      // 插件是否被允许管它
              };
            } catch (e) { sysProxy = { error: String(e?.message ?? e) }; }
            send({
              ok: true, enabled: user.enabled !== false, ...st, game, peer, sysProxy,
              plugin: {
                kernelVersion: stats.kernelVersion, generations: stats.generations,
                requests: stats.requests, lastError: stats.lastError,
                probe: probeStatus(),
              },
            });
            return;
          }
          // ── 系统代理独立开关（2026-10-13 新增）──────────────────────────
          //
          // 用户原话：「不该跟Fl一样内核一直开着再单独搞个开关吗」。
          // 是 —— 内核常驻，系统代理由这一个端点显式开关。
          case 'POST /system-proxy': {
            await syncSettings();
            const want = payload.on !== false;            // 默认当"开"处理
            const r = await setSystemProxy(want);
            send({
              ok: true, ...r,
              note: want
                ? (r.changed ? `系统代理已指向 127.0.0.1:${user.port}` : (r.skipped ? '系统代理被其它程序占用，未改动' : '系统代理本来就是开的'))
                : (r.changed ? '系统代理已还原' : '系统代理没有需要还原的改动'),
            });
            return;
          }
          // 读当前系统代理实况（界面单独刷新用）
          case 'GET /system-proxy': {
            await syncSettings();
            const cur = await readSystemProxy();
            send({
              ok: true, current: cur,
              ours: pointsAtUs(cur, user.port),
              occupiedByOther: occupiedByOther(cur, user.port),
              enabled: user.systemProxy !== false,
            });
            return;
          }
          case 'GET /settings': {
            const s = await syncSettings();
            send({ ok: true, settings: s, config: await configSummary(runtimeDir) });
            return;
          }
          case 'POST /settings': {
            const next = await writeSettings(runtimeDir, payload);
            user = next;
            core.cfg.port = next.port;
            core.cfg.idleMs = next.idleMs;
            // 开关/端口变了，两个检测的缓存都必须失效，
            // 否则界面改完 3 秒内还会看到旧结论
            clearGameCache();
            clearPeerCache();
            send({ ok: true, settings: next, note: '设置已保存' });
            return;
          }
          case 'POST /prepare': {
            const k = await prepareKernel();
            const c = await ensureConfig({ forceImport: Boolean(payload.forceImport) });
            stats.prepares += 1; stats.lastPrepareAt = Date.now();
            send({ ok: true, ...k, config: c });
            return;
          }
          case 'POST /start': {
            await syncSettings();
            const r = await ensureAndStart();
            send({ ok: true, ...r, proxy: `http://127.0.0.1:${user.port}`, note: r.started ? `内核已启动（${r.ms}ms）` : (r.external ? '端口已被其他程序占用，直接复用' : '内核已在运行') });
            return;
          }
          case 'POST /stop': {
            const r = await core.stop('manual');
            send({ ok: true, ...r, note: r.killed ? '已关闭内核' : '没有由本插件启动的内核' });
            return;
          }
          case 'POST /renew': {
            const r = await core.renew();
            send({ ok: true, ...r, note: r.alive ? `空闲计时已重置为 ${Math.round(user.idleMs / 1000)} 秒` : '当前没有运行中的内核' });
            return;
          }
          // ── 游戏闸门 ──────────────────────────────────────────────────────
          case 'GET /game': {
            // force=1 绕过缓存（界面上的「重新检测」按钮）
            const force = url.searchParams.get('force') === '1';
            await syncSettings();
            send({ ok: true, ...(await gameStatus({ force })) });
            return;
          }
          case 'POST /game/clear-cache': {
            clearGameCache();
            send({ ok: true, note: '检测缓存已清除' });
            return;
          }
          // 把某个程序加进游戏检测白名单。
          // 不传 path/name 时取**当前前台程序** —— 界面上「把刚才那个程序加进来」
          // 就是这个用法（用户在全屏被拦时，前台正是那个程序）。
          case 'POST /game/allow': {
            let entry = '';
            let source = 'manual';
            if (payload.path) { entry = String(payload.path).trim(); source = 'path'; }
            else if (payload.name) { entry = String(payload.name).trim(); source = 'name'; }
            else {
              const d = await detectGames({ runtimeDir, force: true, allow: user.gameAllow ?? [] });
              const fg = d.fg;
              if (!fg?.path && !fg?.name) {
                send({ ok: false, error: '当前没有可加入白名单的前台程序' }, 400);
                return;
              }
              // 默认用**进程名**而不是全路径：同一个程序升级/换目录后名字通常不变，
              // 名字条目更耐用。用户想要精确匹配可以在界面上手填全路径。
              entry = fg.name || fg.path;
              source = 'foreground';
            }
            if (!entry) { send({ ok: false, error: '白名单条目为空' }, 400); return; }
            const cur = user.gameAllow ?? [];
            const lower = entry.toLowerCase();
            if (cur.some((x) => String(x).toLowerCase() === lower)) {
              send({ ok: true, added: false, entry, allow: cur, note: `「${entry}」已在白名单里` });
              return;
            }
            const next = await writeSettings(runtimeDir, { gameAllow: [...cur, entry] });
            user = next;
            clearGameCache();
            log('info', `已把「${entry}」加进游戏检测白名单（来源：${source}）`);
            send({ ok: true, added: true, entry, allow: next.gameAllow, note: `已把「${entry}」加进白名单` });
            return;
          }
          case 'POST /game/allow/remove': {
            const target = String(payload.entry ?? payload.value ?? '').trim().toLowerCase();
            if (!target) { send({ ok: false, error: '缺少 entry' }, 400); return; }
            const cur = user.gameAllow ?? [];
            const next = await writeSettings(runtimeDir, {
              gameAllow: cur.filter((x) => String(x).toLowerCase() !== target),
            });
            user = next;
            clearGameCache();
            send({ ok: true, allow: next.gameAllow, note: '已从白名单移除' });
            return;
          }
          // ── 礼让闸门 ──────────────────────────────────────────────────────
          case 'GET /peers': {
            const force = url.searchParams.get('force') === '1';
            await syncSettings();
            send({ ok: true, ...(await peerStatus({ force })) });
            return;
          }
          case 'POST /peers/clear-cache': {
            clearPeerCache();
            send({ ok: true, note: '礼让检测缓存已清除' });
            return;
          }
          case 'POST /config/from-subscription': {
            const s = await syncSettings();
            const sub = String(payload.url ?? s.subscriptionUrl ?? '').trim();
            if (!sub) { send({ ok: false, error: '未提供订阅地址' }, 400); return; }
            const ctl = await controllerEndpoint();
            const r = await applySubscription(runtimeDir, sub, {
              controllerPort: ctl.port, controllerSecret: ctl.secret,
            });
            stats.subscriptions += 1;
            await writeSettings(runtimeDir, {
              subscriptionUrl: sub, configSource: 'subscription',
              lastSyncAt: Date.now(), lastSyncNote: `订阅已更新（${r.nodeCount} 个节点）`,
            });
            send({ ok: true, ...r, note: `订阅已拉取：识别到 ${r.nodeCount} 个节点` });
            return;
          }
          case 'POST /config/import-flclash': {
            const found = await findFlClashConfig();
            if (!found.found) { send({ ok: false, error: '本机没有找到 FlClash 配置文件' }, 404); return; }
            const ctl = await controllerEndpoint();
            const r = await materialize(found.path, runtimeDir, {
              controllerPort: ctl.port, controllerSecret: ctl.secret,
            });
            stats.imports += 1;
            const summary = await configSummary(runtimeDir);
            await writeSettings(runtimeDir, {
              configSource: 'flclash', lastSyncAt: Date.now(),
              lastSyncNote: `已从 FlClash 导入（${summary.nodeCount} 个节点 / ${summary.ruleCount} 条规则）`,
            });
            send({
              ok: true, ...r, nodeCount: summary.nodeCount ?? 0, ruleCount: summary.ruleCount ?? 0,
              note: `已从 FlClash 导入：${summary.nodeCount} 个节点、${summary.ruleCount} 条规则`,
            });
            return;
          }
          // ── 节点面板 ──────────────────────────────────────────────────────
          case 'GET /proxies': {
            const ep = await currentEndpoint();
            const r = await listProxies(ep, { includeFake: url.searchParams.get('fake') === '1' });
            send({ ok: true, ...r, endpoint: { port: ep.port } });
            return;
          }
          case 'POST /proxies/select': {
            const ep = await currentEndpoint();
            const r = await selectProxy(ep, payload.group, payload.node);
            if (r.ok) {
              log('info', `节点已切换：${r.group} → ${r.node}${r.verified ? '' : '（未回读确认）'}`);
            }
            send(r, r.ok ? 200 : 400);
            return;
          }
          case 'POST /proxies/test': {
            const ep = await currentEndpoint();
            const r = await testGroupDelay(ep, payload.group, {
              timeoutMs: Number(payload.timeoutMs ?? 3000),
              url: payload.url ? String(payload.url) : undefined,
            });
            send(r, r.ok ? 200 : 400);
            return;
          }
          // 连通性测试：**真的以该节点为出口发一次请求**，只有拿到响应才算通。
          // 与 /proxies/test（只测延迟）不是一回事 —— 用户要的正是这个。
          case 'POST /proxies/connectivity': {
            const ep = await currentEndpoint();
            const opts = {
              url: payload.url ? String(payload.url) : undefined,
              timeoutMs: Number(payload.timeoutMs ?? 8000),
            };
            const r = payload.node
              ? await testConnectivity(ep, payload.node, opts)
              : await testConnectivityMany(ep, payload.nodes ?? [], opts);
            send(r, r.ok ? 200 : 400);
            return;
          }
          case 'POST /config/manual': {
            const r = await writeManualConfig(runtimeDir, String(payload.text ?? ''));
            await writeSettings(runtimeDir, { configSource: 'manual', lastSyncAt: Date.now(), lastSyncNote: `手动写入（${r.nodeCount} 个节点）` });
            send({ ok: true, ...r, note: `已保存（${r.nodeCount} 个节点）` });
            return;
          }
          case 'GET /config/example': {
            send({ ok: true, text: exampleConfig(base.port) });
            return;
          }
          case 'POST /fetch': {
            const target = String(payload.url ?? '');
            if (!/^https?:\/\//i.test(target)) { send({ ok: false, error: 'url 必须是 http(s)' }, 400); return; }
            await ensureAndStart();
            const r = await proxyGet(target, user.port, Number(payload.maxBytes ?? 200000));
            await core.renew();
            send({ ok: true, ...r });
            return;
          }
          default:
            res.statusCode = 404;
            send({ ok: false, reason: 'not found', endpoints: ENDPOINTS }, 404);
        }
      } catch (e) {
        stats.lastError = String(e?.message ?? e);
        log('error', String(e?.message ?? e));
        // 被游戏闸门拦下 → 409 Conflict（不是服务器错误，是当前状态不允许）
        if (e?.code === 'GAME_BLOCKED') {
          send({ ok: false, blocked: true, reason: 'game-running', error: String(e?.message ?? e), gate: e.gate ?? null }, 409);
          return;
        }
        // 被礼让闸门拦下 → 同样是 409（别的代理在跑，不是出错）
        if (e?.code === 'PEER_BLOCKED') {
          send({ ok: false, blocked: true, reason: 'peer-running', error: String(e?.message ?? e), gate: e.gate ?? null }, 409);
          return;
        }
        send({ ok: false, error: String(e?.message ?? e) }, 500);
      }
    };

    const dispose = webCtx.webServer.register({ kind: 'prefix', path: '/dsh-proxy', handler });
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  });

  log('info', `已挂载，HTTP 面 /dsh-proxy（runtime: ${runtimeDir}）`);
}

/**
 * 经内核代理取一次内容。
 *
 * https 目标必须先 CONNECT 建隧道 —— 直接把 https 请求打到明文代理端口会
 * 因为 TLS 握手打在 HTTP 代理上而失败（`Client network socket disconnected
 * before secure TLS connection was established`），这不是代理的问题。
 */
async function proxyGet(target, port, maxBytes) {
  const net = await import('node:net');
  const http = await import('node:http');
  const https = await import('node:https');
  const u = new URL(target);
  const isHttps = u.protocol === 'https:';

  if (!isHttps) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'GET', path: target, headers: { Host: u.host } },
        (res) => {
          let d = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { if (d.length < maxBytes) d += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, maxBytes) }));
        },
      );
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('代理请求超时')); });
      req.end();
    });
  }

  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => {
      s.write(`CONNECT ${u.hostname}:${u.port || 443} HTTP/1.1\r\nHost: ${u.host}\r\n\r\n`);
    });
    let buf = '';
    s.on('data', function onData(chunk) {
      buf += chunk.toString('binary');
      if (!buf.includes('\r\n\r\n')) return;
      s.off('data', onData);
      const head = buf.slice(0, buf.indexOf('\r\n\r\n'));
      if (/^HTTP\/1\.[01] 200/.test(head)) resolve(s);
      else { s.destroy(); reject(new Error(`代理隧道建立失败：${head.split('\r\n')[0]}`)); }
    });
    s.on('error', reject);
    s.setTimeout(20000, () => { s.destroy(); reject(new Error('建立隧道超时')); });
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      { socket, agent: false, servername: u.hostname, host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET' },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (d.length < maxBytes) d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, maxBytes) }));
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('代理请求超时')); });
    req.end();
  });
}

const ENDPOINTS = {
  status: 'GET  /dsh-proxy/status',
  settings: 'GET|POST /dsh-proxy/settings',
  prepare: 'POST /dsh-proxy/prepare',
  start: 'POST /dsh-proxy/start',
  stop: 'POST /dsh-proxy/stop',
  renew: 'POST /dsh-proxy/renew',
  subscription: 'POST /dsh-proxy/config/from-subscription  {"url":"..."}',
  importFlClash: 'POST /dsh-proxy/config/import-flclash',
  manual: 'POST /dsh-proxy/config/manual  {"text":"..."}',
  example: 'GET  /dsh-proxy/config/example',
  fetch: 'POST /dsh-proxy/fetch  {"url":"https://..."}',
  game: 'GET  /dsh-proxy/game[?force=1]',
  gameClearCache: 'POST /dsh-proxy/game/clear-cache',
  gameAllow: 'POST /dsh-proxy/game/allow  {"path"|"name"?}  不传则取当前前台程序',
  gameAllowRemove: 'POST /dsh-proxy/game/allow/remove  {"entry":"..."}',
  peers: 'GET  /dsh-proxy/peers[?force=1]',
  peersClearCache: 'POST /dsh-proxy/peers/clear-cache',
  proxies: 'GET  /dsh-proxy/proxies[?fake=1]   分组 + 节点 + 当前选中（内核未运行时 coreRunning=false）',
  proxiesSelect: 'POST /dsh-proxy/proxies/select  {"group":"Yue.to | 悦通","node":"悦·🇭🇰香港1 · A"}',
  proxiesTest: 'POST /dsh-proxy/proxies/test  {"group":"...","timeoutMs":3000}  测延迟（不验证能否上网）',
  proxiesConnectivity: 'POST /dsh-proxy/proxies/connectivity  {"node":"..."|"nodes":[...],"url"?}  连通性测试：真的以该节点为出口发一次请求',
};

export default { name, apply };
