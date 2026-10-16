/**
 * dsh-proxy-on-demand —— 给 DSH 用的「按需代理」插件。
 *
 * 平时不占端口、不留后台进程；需要时自动拉起 mihomo 内核，
 * 空闲一段时间后**自动关闭**。全部自包含在插件内，不依赖外部安装。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 它是什么
 *   一个**给 Agent 用的工具**，不是给用户用的代理客户端。
 *   对外只有两样东西：HTTP 接口（`/dsh-proxy/*`）和 CLI（`dsh-proxy`）。
 *   设置界面只剩「配置从哪来」——订阅地址、从本机代理软件导入、手动粘贴，
 *   因为那是 Agent 没法替你决定的唯一一件事。除此之外没有任何面板。
 *
 *   ⚠️ 它**不接管系统代理**，也不判断你在不在打游戏。
 *   那两件事是「客户端软件」的行为，曾经让插件变成一个会打扰人的东西
 *   （2026-10-16 用户裁决：「我希望他能回归一个给你用的插件，而不是给我用的软件」）。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 端口（这是本插件最容易踩的坑，写在最前面）
 *
 *   自己的内核用 **7899**，不是 7890。7890 是 FlClash / Clash for Windows 的
 *   默认混合端口 —— 本插件曾用它，于是「插件内核先起 → 占住 7890 →
 *   FlClash 内核起不来」。用户原话：
 *
 *     「我代理的时候 fl 内核连不上」
 *
 *   另外本插件**优先借道**：FlClash 等已经有代理在跑时，直接复用它的端口，
 *   自己一个进程都不起。见 core.js / peers.js 的文件头。
 *
 * ───────────────────────────────────────────────────────────────────────
 * 用途
 *   给 DeepSeek Harness（DSH）提供一个随叫随到、用完就走的本地 HTTP 代理。
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
import { exampleConfig, findFlClashConfig, forceDnsPort, forceExternalController, forceMixedPort, materialize, pickFreePort, probePort, readExternalController } from './config.js';
import { ProxyCore } from './core.js';
import {
  autoSelectProxy, listProxies, selectProxy, testGroupDelay, testConnectivity,
  testConnectivityMany, sampleActivity,
} from './nodes.js';
import {
  borrowStatus, clearBorrowCache, findBorrowableProxy,
} from './peers.js';
import {
  applySubscription, configSummary, legacySettingsPath, readSettings, settingsPath,
  writeManualConfig, writeSettings,
} from './settings.js';

export const name = 'proxy-on-demand';

/** 插件自身的包根。runtime 放在 ../runtime（.gitignore 排除）。 */
const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  enabled: true,
  /**
   * 自己的内核用哪个混合端口。
   *
   * ⚠️ **故意不是 7890**（2026-10-16 改）：7890 是 FlClash / Clash 系的默认端口，
   * 本插件过去也用 7890，于是「插件先起 → 占住 7890 → FlClash 内核起不来」。
   * 详见 core.js 的 DEFAULTS.port 注释。
   */
  port: 7899,
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
   * 借道探测 —— 「本机已经有代理在跑就直接用它的」。
   *
   * 只看**网络占用**（常见代理端口有没有人在监听），不看进程名 —— 用户明确
   * 要求过不要判断「这是哪个软件」，只看资源有没有被占。于是以后换成任何
   * 代理软件都自动适用，不需要维护名单。
   *
   * 返回 `{ port, note }` 表示可借；返回 null 表示没人可借、需要自己起内核。
   * core 收到端口后直接拿它当出口，**一个进程都不起**。
   *
   * ⚠ 必须把 ownPort 传下去并排除：我们自己就监听 user.port，若不排除，
   *   内核刚起来就会被自己认成「可以借的代理」，直接借到自己头上。
   */
  const borrowFn = async ({ ownPort } = {}) => findBorrowableProxy({
    ownPort: Number.isInteger(ownPort) ? ownPort : user.port,
  });

  /**
   * 上一次采样到的代理累计流量（用于判断"有没有新增流量"）。
   *
   * 放在 core 之前声明：activityWatch 回调里要用它做前后比较。
   */
  let lastActivity = null;

  /**
   * 宿主「代际」号 —— 用来区分「热重载」和「宿主真的退出了」。
   *
   * ## 起因（历史，系统代理已移除，但代际判定仍然有用）
   *
   * 宿主的插件监视器**只看 `.json`**（2026-10-14 用 21 种扩展名实测的矩阵；
   * 早前记的「`.lock`/`.js` 也会」是误判，当时被同批 `.json` 写入混淆了）。
   * 而热重载的次序是「先 dispose 旧实例，再 apply 新实例」——旧实例的 dispose
   * 会去清理它以为属于自己的东西，于是每写一次状态文件就把刚做的改动撤销一次。
   * 表现就是用户看到的「点了没反应」。
   *
   * ## 两层修法
   *
   * 1. **治本：状态文件不再用 `.json`**（`lease.state` / `busy.state` /
   *    `settings.state`）→ 热重载**根本不会发生**。
   * 2. **兜底：这里仍然判代际号**。因为宿主还会因别的理由重载插件
   *    （用户编辑源码、插件管理器操作），那时的 dispose 同样不该乱动
   *    新实例正在用的东西（比如内核）。
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
   * dispose 时的清理。
   *
   * ⚠️ **绝不杀内核**。内核是 detached 子进程，宿主退出它照样活着，而它正是
   * 「借道」机制依赖的对象 —— 杀了它，下一次调用就得多等 1~2 秒重新启动。
   *
   * 唯一做的事是等一小会看有没有新实例接管；**热重载**时代际号会变（新实例
   * 已经接手了），所以什么都不用做；**宿主真退出**时内核留着自己到点关门
   * （租约过期，见 core.checkIdle）。两种情况下本插件都不需要额外动作 ——
   * 这也是「它是个工具而不是服务」的直接体现：工具不该在主人走后还忙着收尾。
   *
   * 保留函数是为了让 dispose 路径显式、可测，而不是因为它有副作用。
   */
  async function releaseOnDispose() {
    await sleep(DISPOSE_GRACE_MS);
    if (globalThis[HOST_GEN_KEY] !== myGeneration) return { handedOver: true };
    return { handedOver: false };
  }

  const core = new ProxyCore({
    dir: runtimeDir,
    exe: KERNEL_EXE,
    config: 'config.yaml',
    port: base.port,
    idleMs: base.idleMs,
    log,
    /**
     * 借道回调：本机已有代理在跑时，直接用它（见上面 borrowFn 的说明）。
     *
     * ⚠️ 与旧的「礼让」是**相反**的语义：以前是「别人在跑我就不启动」，
     * 结果是「FlClash 一开，本插件彻底不可用」；现在是「别人在跑我就用它」，
     * 结果是「两边永远不抢，而且大部分时候一个进程都不用起」。
     * 用户 2026-10-16 的原话是「不希望他跟 Fl 抢」，而借道正是「不抢」的最优解。
     */
    borrowPort: borrowFn,
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
  });

  /** 把用户设置同步到 core 的参数上。 */
  async function syncSettings() {
    user = await readSettings(runtimeDir);
    core.cfg.port = user.port;
    core.cfg.idleMs = user.idleMs;
    // 常驻：内核不因空闲而关。**默认 false**（= 空闲自动关，本插件的核心理由）。
    // 用户 2026-10-13 原话：「完成任务自动关为什么删？不是有个开关吗？」
    core.cfg.resident = user.resident === true;
    return user;
  }

  /**
   * 把旧版用 `.json` 命名的状态文件迁移成 `.state`（幂等）。
   *
   * ## 为什么非迁不可
   *
   * 宿主监视着插件目录，而实测（2026-10-14，21 种扩展名矩阵）**只有 `.json`
   * 会触发热重载**，`.state`/`.log`/`.dat`/`.lock`/`.yaml`… 都不触发
   * （子目录里的 `.json` 同样触发）。只要旧的 `settings.json` /
   * `lease.json` / `busy.json` 还躺在 runtime 目录里，
   * 宿主**一看到它们就会继续热重载** —— 换名就白换了。
   *
   * 所以顺序很要紧：**先迁移，再做任何写盘**。否则新实例写下的 `.state`
   * 会和旧 `.json` 同时存在，而旧文件仍然在触发重载。
   *
   * 用 rename（不是 copy）：目标已存在时 rename 会因 EXDEV/EEXIST 失败，
   * 那时退回「读旧写新 + 删旧」。任何一种失败都只记日志，不影响启动 ——
   * 大不了多热重载一次，`sweepLegacy()` 下轮还会再试。
   */
  async function migrateStateFiles() {
    const pairs = [
      [legacySettingsPath(runtimeDir), settingsPath(runtimeDir), '设置'],
    ];
    for (const [oldP, newP, what] of pairs) {
      try {
        if (!existsSync(oldP)) continue;
        if (existsSync(newP)) {
          // 新文件已在：旧文件纯属残留，删掉（它还会触发热重载）
          await fsp.unlink(oldP).catch(() => {});
          continue;
        }
        try {
          await fsp.rename(oldP, newP);
        } catch {
          // rename 失败（跨卷/占用）：退回复制 + 删除
          await fsp.copyFile(oldP, newP);
          await fsp.unlink(oldP).catch(() => {});
        }
        log('info', `${what}文件已迁移：${oldP.split(/[\\/]/).pop()} → ${newP.split(/[\\/]/).pop()}`);
      } catch (e) {
        log('warn', `${what}文件迁移失败（下次启动再试）：${e?.message ?? e}`);
      }
    }
    // 内核侧的两个瞬态文件（lease / busy）没有内容要保留，直接清掉。
    await core.sweepLegacy().catch(() => {});
  }

  // 首次加载：**先迁移状态文件**（在任何写盘之前），再读设置。
  // 顺序不可颠倒 —— 见 migrateStateFiles() 的注释。
  void migrateStateFiles()
    .then(() => syncSettings())
    .catch(() => { void syncSettings().catch(() => {}); });

  ctx.effect(() => {
    core.startIdleWatcher();
    return () => {
      // 只停守护定时器。**内核不杀** —— 它是 detached 子进程，宿主走了它自己
      // 到点关门（租约过期）。详见 releaseOnDispose() 的注释。
      core.dispose();
      void releaseOnDispose().catch(() => {});
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

  /**
   * 老版本（起点 9090）挑出来的控制器端口要作废。
   *
   * 端口和密钥缓存在 `globalThis` 上，**热重载不会让它重挑** —— 这正是当初
   * 缓存的目的（换个端口，config.yaml 里的值与内存里的就对不上，节点面板立刻
   * 失灵）。代价是：改了起点之后，**已经在跑的宿主进程会一直用着旧值**，
   * 实测 `runtime/config.yaml` 里就留着 `external-controller: 127.0.0.1:9090`。
   *
   * `pickFreePort(9090)` 的试探范围是 9090 起 20 个（`tries = 20`，见
   * config.js），所以老值必定落在 `[9090, 9110)` —— 整段判为「旧起点产物」，
   * 清掉重挑。用户手填的端口不在这个范围，不会被误伤。
   *
   * 重挑之后 config.yaml 里的旧值由 `ensureControllerInConfig()` 就地改写，
   * 那一步在每次 `ensureConfig()` 里都跑（幂等）。
   */
  const LEGACY_CTL_FROM = 9090;
  const LEGACY_CTL_TO = 9110;   // 不含
  const isLegacyCtlPort = (p) => Number.isInteger(p) && p >= LEGACY_CTL_FROM && p < LEGACY_CTL_TO;

  async function controllerEndpoint() {
    // 端口与密钥持久化在 globalThis，热重载后不换端口（换了的话配置里的值会对不上）。
    let c = globalThis[CONTROLLER_KEY];
    if (!c) {
      c = { port: null, secret: null };
      globalThis[CONTROLLER_KEY] = c;
    }
    // ★ 起点从 9090 挪到 19090 之后，缓存里的旧值必须主动作废，否则老进程
    //   会一直守着 9090（实测就是这样）。
    if (isLegacyCtlPort(c.port)) {
      c.port = await pickControllerPort();
      log('info', `管理 API 端口已迁离 9090（FlClashCore 的惯例端口）→ ${c.port}`);
    }
    if (c.port === null) c.port = await pickControllerPort();
    if (c.secret === null) c.secret = randomBytes(16).toString('hex');
    return { port: c.port, secret: c.secret };
  }

  /**
   * 挑一个空闲的本机端口给管理 API 用（从 19090 起）。
   *
   * ⚠️ **不从 9090 起**（2026-10-16 改）：9090 是 FlClashCore / Clash 系的惯例
   * 控制端口。虽然 `pickFreePort` 本身会跳过已被占用的端口，但「9090 此刻空闲」
   * 不等于「9090 不会被用」—— 用户在插件内核跑着的时候打开 FlClash，那一瞬间
   * 就会撞上。起点挪到 19090 是把整段挪出所有 Clash 系客户端的默认区。
   *
   * 直接复用 config.js 的 `pickFreePort` —— 那边已经踩过「同步探测恒判空闲」
   * 的坑并修好了，这里不该再写第二份探测逻辑。
   */
  function pickControllerPort() {
    return pickFreePort(19090);
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
    const kernelPath = join(runtimeDir, KERNEL_EXE);

    // 开关检查必须在最前面 —— 连着 README 的承诺：
    // 「不想自动下载就在配置里设 autoDownload: false 并自行放好内核」。
    //
    // 2026-10-14 审计发现：这个键以前**全仓无人读取**（只有 DEFAULTS 的默认值、
    // 一句注释和 package.json 的安装提示文案），`prepareKernel()` 无条件下载。
    // 也就是说用户照 README 设了 false 照样下 61MB，是个纯死配置。
    if (base.autoDownload === false && !existsSync(kernelPath)) {
      throw new Error(
        `内核不存在且 autoDownload=false，不会自动下载：${kernelPath}\n`
        + '请把 mihomo 的 mihomo.exe（Windows amd64）放到该路径，'
        + '或把 autoDownload 改回 true / 用 POST /prepare 手动触发一次下载。',
      );
    }

    // 内核已在本地：直接返回，**不查版本、不联网**。
    //
    // README 承诺「下载一次之后离线可用」，但旧写法无条件走
    // `latestVersion(api.github.com)` —— 断网或 API 被墙时 POST /prepare 会以
    // 「无法获取内核版本号」失败，尽管 exe 好端端躺在磁盘上。
    // `ensureKernel()` 本来第一步就是 stat 这个文件、命中就 `cached:true` 返回，
    // 所以这里提前返回不会漏掉任何校验。
    if (existsSync(kernelPath)) {
      try {
        const st = await fsp.stat(kernelPath);
        if (st.size > 1024 * 1024) {
          return { kernel: 'cached', version: stats.kernelVersion ?? base.kernelVersion ?? null, bytes: st.size };
        }
      } catch {
        /* stat 失败就当作没有，继续走下载 */
      }
    }

    // 自动安装提醒：这是本插件唯一会下载可执行文件的地方。
    if (!existsSync(kernelPath)) {
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
    const proxyPort = user.port;
    if (existsSync(configPath) && !forceImport) {
      // 已有配置：也要确认管理 API 是开的 —— 老配置里这一项可能是空的，
      // 那节点面板就永远读不到东西。这里**就地补一次**（幂等）。
      // 顺便把出口端口拉回插件自己的端口（导入的 FlClash 配置里是 7890，
      // 照抄会让两边抢同一个端口 —— 见 config.js 的 forceMixedPort）
      await ensureControllerInConfig(configPath, ctl, proxyPort);
      return { source: 'existing' };
    }

    if (base.configFile && existsSync(base.configFile)) {
      const r = await materialize(base.configFile, runtimeDir, {
        controllerPort: ctl.port, controllerSecret: ctl.secret, port: proxyPort,
      });
      return { source: 'configFile', ...r };
    }

    const s = await readSettings(runtimeDir);
    if (s.autoImportFlClash !== false) {
      const found = await findFlClashConfig();
      if (found.found) {
        const r = await materialize(found.path, runtimeDir, {
          controllerPort: ctl.port, controllerSecret: ctl.secret, port: proxyPort,
        });
        stats.imports += 1;
        await writeSettings(runtimeDir, { configSource: 'flclash', lastSyncAt: Date.now(), lastSyncNote: `已从 FlClash 导入（${r.rulesTotal} 条规则，管理 API :${ctl.port}）` });
        return { source: 'flclash', ...r };
      }
    }

    await fsp.writeFile(configPath, exampleConfig(proxyPort), 'utf8');
    await ensureControllerInConfig(configPath, ctl, proxyPort);
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
  async function ensureControllerInConfig(configPath, ctl, proxyPort) {
    try {
      const text = await fsp.readFile(configPath, 'utf8');
      let next = text;
      const notes = [];

      const ctlFix = forceExternalController(next, ctl.port, ctl.secret);
      if (ctlFix.text !== next) {
        next = ctlFix.text;
        notes.push(`管理 API（127.0.0.1:${ctl.port}，仅本机、仅内核运行期间）`);
      }

      // ★ 出口端口也拉回自己的：导入的 FlClash 配置里是 7890，照抄会让插件
      // 内核占着 FlClash 的端口（反过来 FlClash 就起不来了），而插件自己的
      // 端口空着、portUp() 恒 false。见 config.js 的 forceMixedPort。
      const portFix = forceMixedPort(next, proxyPort);
      if (portFix.changed) {
        next = portFix.text;
        notes.push(`出口端口 ${portFix.from} → ${proxyPort}（避开 FlClash 的默认端口）`);
      }

      // ★ DNS 同理，而且更隐蔽：配置里停在 1053（FlClashCore 占着）时，内核
      // 端口照样监听、命令照样能跑，**但 DNS 起不来 → 什么都解析不了 →
      // 测速全超时**。2026-10-13 排查「143 个节点全部超时」就是这么来的。
      // 只修 1053 这一个值：老配置里若是我们之前挑好的安全端口（如 1055），
      // 每次启动重挑一遍毫无意义，只会写盘 + 刷日志。
      const dnsFix = await forceDnsPort(next, 15353, { onlyIfPorts: [1053] });
      if (dnsFix.changed) {
        next = dnsFix.text;
        notes.push(`DNS 端口 → ${dnsFix.port}（避开 FlClashCore 占用的 1053）`);
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

  async function ensureAndStart({ borrow = true } = {}) {
    if (!existsSync(join(runtimeDir, KERNEL_EXE))) await prepareKernel();
    await ensureConfig();
    await syncSettings();
    return core.ensureRunning({ borrow });
  }

  /**
   * 配置刚被改写（导入/订阅/手贴）之后，**让内核真的吃上它**。
   *
   * 内核只在启动时读一次 `config.yaml`，改文件它是不知情的。不重启的话，
   * 界面会显示「导入成功，143 个节点」，而实际跑的仍是旧配置 —— 这种
   * 「报告成功但没生效」正是 2026-10-16 这轮改造要消灭的东西。
   *
   * 内核**没在跑**时什么都不做：按需启停是本插件的定位，导入配置这个动作
   * 本身不该顺手拉起一个进程（用户可能只是先把节点存着）。这时返回
   * `applied: false` + 一句说明，让界面如实告诉用户「下次启动时生效」。
   */
  async function reloadIfRunning() {
    if (!(await core.ownCoreAlive())) {
      return { applied: false, reason: 'not-running', note: '内核当前没在跑，新配置将在下次启动时生效' };
    }
    try {
      const r = await core.restart('config');
      return { applied: true, ms: r.ms ?? null, note: '内核已重启，新配置立即生效' };
    } catch (e) {
      return {
        applied: false, reason: 'restart-failed',
        error: String(e?.message ?? e),
        note: `配置已写入，但内核重启失败：${String(e?.message ?? e)}`,
      };
    }
  }

  /**
   * 内核跑着、但手里的 `config.yaml` 比它新 —— 先重启再干活。
   *
   * 判据是文件 mtime 晚于内核启动时刻（`stats.startedAt`）。比「每次都重启」
   * 省一次 800ms 的启停；比「从不检查」多一分正确性。
   */
  async function restartIfConfigStale() {
    if (!(await core.ownCoreAlive())) return { restarted: false, reason: 'not-running' };
    const startedAt = core.stats?.startedAt ?? 0;
    if (!startedAt) return { restarted: false, reason: 'unknown-start' };
    let mtime = 0;
    try { mtime = (await fsp.stat(join(runtimeDir, 'config.yaml'))).mtimeMs; } catch { /* 没配置就不用管 */ }
    if (!mtime || mtime <= startedAt) return { restarted: false, reason: 'fresh' };
    try {
      const r = await core.restart('config');
      return { restarted: true, ms: r.ms ?? null };
    } catch (e) {
      return { restarted: false, reason: 'restart-failed', error: String(e?.message ?? e) };
    }
  }

  /**
   * 给界面看的「借道」状态：本机是不是已经有代理在跑？
   *
   * ownPort 必须传下去并排除 —— 我们自己就监听 user.port，不排除的话，
   * 内核刚起来就会被自己认成「别人的代理」。
   */
  async function peerStatus({ force = false } = {}) {
    const d = await borrowStatus({ ownPort: user.port, force });
    return {
      ok: true,
      borrowing: d.borrowing,
      port: d.port,
      ownPort: user.port,
      ownAlive: await core.ownCoreAlive(),
      note: d.note,
      candidates: d.candidates,
      probed: d.probed,
      ms: d.ms,
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
            // 借道概况：本机是不是已经有别的代理在跑、要不要用它的。
            let peer = null;
            try { peer = await peerStatus(); } catch (e) { peer = { ok: false, error: String(e?.message ?? e) }; }
            send({
              ok: true, enabled: user.enabled !== false, ...st, peer,
              plugin: {
                kernelVersion: stats.kernelVersion, generations: stats.generations,
                requests: stats.requests, lastError: stats.lastError,
              },
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
            // 端口变了，借道缓存必须失效，否则 3 秒内还会看到旧结论
            clearBorrowCache();
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
            const note = r.started
              ? `内核已启动（${r.ms}ms，127.0.0.1:${r.port}）`
              : (r.borrowed ? `借道已有代理 ${'127.0.0.1:'}${r.port}，本插件未启动自己的内核` : '内核已在运行');
            send({ ok: true, ...r, proxy: `http://127.0.0.1:${core.exitPort()}`, note });
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
          // ── 借道 ──────────────────────────────────────────────────────────
          // 本机已经有代理在跑（FlClash / Clash Verge / v2rayN …）时直接用它，
          // 自己一个进程都不起。这条端点只是把结论给人看，判定本身在 peers.js。
          case 'GET /peers': {
            const force = url.searchParams.get('force') === '1';
            await syncSettings();
            send({ ok: true, ...(await peerStatus({ force })) });
            return;
          }
          case 'POST /peers/clear-cache': {
            clearBorrowCache();
            send({ ok: true, note: '借道探测缓存已清除' });
            return;
          }
          case 'POST /config/from-subscription': {
            const s = await syncSettings();
            const sub = String(payload.url ?? s.subscriptionUrl ?? '').trim();
            if (!sub) { send({ ok: false, error: '未提供订阅地址' }, 400); return; }
            const ctl = await controllerEndpoint();
            const r = await applySubscription(runtimeDir, sub, {
              controllerPort: ctl.port, controllerSecret: ctl.secret, port: s.port,
            });
            stats.subscriptions += 1;
            await writeSettings(runtimeDir, {
              subscriptionUrl: sub, configSource: 'subscription',
              lastSyncAt: Date.now(), lastSyncNote: `订阅已更新（${r.nodeCount} 个节点）`,
            });
            // 导入本身**不顺手起内核**（按需启停），但内核已经在跑时新配置必须真的吃上。
            const applied = await reloadIfRunning();
            const summary = await configSummary(runtimeDir);
            send({
              ok: true, ...r, ...applied,
              nodeCount: summary.nodeCount ?? r.nodeCount ?? 0,
              ruleCount: summary.ruleCount ?? 0,
              port: summary.port ?? s.port,
              bytes: summary.bytes ?? null,
              before: payload.before ?? null,
              note: `订阅已拉取：${summary.nodeCount ?? 0} 个节点、${summary.ruleCount ?? 0} 条规则`
                + (applied.applied ? '；内核已重启，立即生效' : ''),
            });
            return;
          }
          case 'POST /config/import-flclash': {
            const found = await findFlClashConfig();
            if (!found.found) { send({ ok: false, error: '本机没有找到 FlClash 配置文件' }, 404); return; }
            const ctl = await controllerEndpoint();
            const r = await materialize(found.path, runtimeDir, {
              controllerPort: ctl.port, controllerSecret: ctl.secret, port: user.port,
            });
            stats.imports += 1;
            const summary = await configSummary(runtimeDir);
            await writeSettings(runtimeDir, {
              configSource: 'flclash', lastSyncAt: Date.now(),
              lastSyncNote: `已从 FlClash 导入（${summary.nodeCount} 个节点 / ${summary.ruleCount} 条规则）`,
            });
            const applied = await reloadIfRunning();
            send({
              ok: true, ...r, ...applied,
              nodeCount: summary.nodeCount ?? 0, ruleCount: summary.ruleCount ?? 0,
              port: summary.port ?? user.port, bytes: summary.bytes ?? null,
              source: found.path,
              note: `已从 FlClash 导入：${summary.nodeCount} 个节点、${summary.ruleCount} 条规则`
                + (applied.applied ? '；内核已重启，立即生效' : ''),
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
          // ── 自动选点 ──────────────────────────────────────────────────────
          //
          // 「挑一个真能上网的节点并切过去」。与 /proxies/test（只测延迟）不是
          // 一回事 —— 延迟低但连不出去的节点太多了，判据必须是**真的发一次请求**。
          //
          // 两个前提：
          //   ① 必须有自己的内核。借道时出口在别人的内核里，我们配置里的节点
          //      根本不在它里面 —— 想切也切不了。所以这里 `borrow: false`，
          //      坚持起自己的（端口隔离了，不会把 FlClash 顶掉）。
          //   ② 配置可能刚被改过，内核还在跑旧的那份 —— 先按 mtime 判一次。
          case 'POST /proxies/auto-select': {
            await syncSettings();
            await restartIfConfigStale();
            const started = await ensureAndStart({ borrow: false });
            const ep = await currentEndpoint();
            const r = await autoSelectProxy(ep, {
              group: payload.group ? String(payload.group) : undefined,
              maxNodes: payload.maxNodes === undefined ? undefined : Number(payload.maxNodes),
              timeoutMs: payload.timeoutMs === undefined ? undefined : Number(payload.timeoutMs),
              concurrency: payload.concurrency === undefined ? undefined : Number(payload.concurrency),
              want: payload.want === undefined ? undefined : Number(payload.want),
              url: payload.url ? String(payload.url) : undefined,
            });
            if (r.ok && started.started) {
              log('info', `自动选点：${r.group} → ${r.node}（测了 ${r.tested} 个，${r.reachable} 个可通，取其最快）`);
            }
            const note = r.ok
              ? `已自动切换到「${r.node}」（延迟 ${r.delay}ms；从 ${r.group} 里测了 ${r.tested} 个，${r.reachable} 个可通）`
              : (r.error ?? '自动选点失败');
            send({ ok: r.ok === true, ...r, endpoint: { port: ep.port }, note }, r.ok ? 200 : 409);
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
            const r = await writeManualConfig(runtimeDir, String(payload.text ?? ''), { port: user.port });
            await writeSettings(runtimeDir, { configSource: 'manual', lastSyncAt: Date.now(), lastSyncNote: `手动写入（${r.nodeCount} 个节点）` });
            const applied = await reloadIfRunning();
            const summary = await configSummary(runtimeDir);
            send({
              ok: true, ...r, ...applied,
              nodeCount: summary.nodeCount ?? r.nodeCount ?? 0,
              ruleCount: summary.ruleCount ?? 0,
              port: summary.port ?? user.port,
              note: `已保存：${summary.nodeCount ?? 0} 个节点、${summary.ruleCount ?? 0} 条规则`
                + (applied.applied ? '；内核已重启，立即生效' : ''),
            });
            return;
          }
          case 'GET /config/example': {
            send({ ok: true, text: exampleConfig(user.port) });
            return;
          }
          case 'POST /fetch': {
            const target = String(payload.url ?? '');
            if (!/^https?:\/\//i.test(target)) { send({ ok: false, error: 'url 必须是 http(s)' }, 400); return; }
            const started = await ensureAndStart();
            // ⚠️ 必须用 exitPort()，不是 user.port —— 借道时出口是**别人的**端口
            // （多半是 7890），用 user.port 会去连一个本插件根本没监听的端口。
            const r = await proxyGet(target, core.exitPort(), Number(payload.maxBytes ?? 200000));
            await core.renew();
            send({ ok: true, ...r, via: `127.0.0.1:${core.exitPort()}`, borrowed: started.borrowed === true });
            return;
          }
          default:
            res.statusCode = 404;
            send({ ok: false, reason: 'not found', endpoints: ENDPOINTS }, 404);
        }
      } catch (e) {
        stats.lastError = String(e?.message ?? e);
        log('error', String(e?.message ?? e));
        // 借道探测本身不会拦人（它只是"用不用别人的"），所以这里没有 409 分支了。
        // 保留 409 的形状是为了给未来可能的"软拒绝"留位置。
        send({ ok: false, error: String(e?.message ?? e) }, 500);
      }
    };

    const dispose = webCtx.webServer.register({ kind: 'prefix', path: '/dsh-proxy', handler });
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  });

  log('info', `已挂载，HTTP 面 /dsh-proxy（runtime: ${runtimeDir}）`);
}

/**
 * 请求时带的 User-Agent。
 *
 * ⚠️ 2026-10-14 修的一个真缺陷：`/fetch` 原先**一个头都不带**（https 分支
 * 连 Host 都没有，全靠 Node 自动补）。后果是 **GitHub 的 REST API 一律回 403**：
 *
 *   Request forbidden by administrative rules. Please make sure your request has
 *   a User-Agent header.
 *
 * 这不是限流（对照组：同一个 URL、同一个代理端口，用 Invoke-WebRequest 走一遍
 * 就是 200，`x-ratelimit-remaining: 58`）。GitHub 对**所有** REST 请求强制要求
 * UA，缺了直接拒 —— 而 `/fetch` 最常见的用途恰恰就是抓 `api.github.com`
 * （README 里的示例就是它），所以这条踩得一点不冤。
 */
const DEFAULT_UA = 'dsh-proxy-on-demand (+https://github.com/xfgil/dsh-proxy-on-demand)';

/**
 * 经内核代理取一次内容。
 *
 * **导出是为了让自测能直接打这条路径**（`test/selftest.mjs` 用它锁住
 * 「必须带 User-Agent」这条回归 —— 见上面 `DEFAULT_UA` 的说明）。
 *
 * https 目标必须先 CONNECT 建隧道 —— 直接把 https 请求打到明文代理端口会
 * 因为 TLS 握手打在 HTTP 代理上而失败（`Client network socket disconnected
 * before secure TLS connection was established`），这不是代理的问题。
 */
export async function proxyGet(target, port, maxBytes) {
  const net = await import('node:net');
  const http = await import('node:http');
  const https = await import('node:https');
  const u = new URL(target);
  const isHttps = u.protocol === 'https:';

  if (!isHttps) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: target,
          headers: { Host: u.host, 'User-Agent': DEFAULT_UA, Accept: '*/*' },
        },
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
      {
        socket,
        agent: false,
        servername: u.hostname,
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' },
      },
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
  peers: 'GET  /dsh-proxy/peers[?force=1]   本机是否已有别的代理（有就借道，不起自己的内核）',
  peersClearCache: 'POST /dsh-proxy/peers/clear-cache',
  proxies: 'GET  /dsh-proxy/proxies[?fake=1]   分组 + 节点 + 当前选中（内核未运行时 coreRunning=false）',
  proxiesSelect: 'POST /dsh-proxy/proxies/select  {"group":"Yue.to | 悦通","node":"悦·🇭🇰香港1 · A"}',
  proxiesTest: 'POST /dsh-proxy/proxies/test  {"group":"...","timeoutMs":3000}  测延迟（不验证能否上网）',
  proxiesAutoSelect: 'POST /dsh-proxy/proxies/auto-select  {"group"?,"maxNodes"?,"want"?}  挑一个真能上网的节点并切过去（测连通性，不是延迟）',
  proxiesConnectivity: 'POST /dsh-proxy/proxies/connectivity  {"node":"..."|"nodes":[...],"url"?}  连通性测试：真的以该节点为出口发一次请求',
};

export default { name, apply };
