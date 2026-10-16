/**
 * 内核进程控制 + 空闲自动关。
 *
 * 用途：dsh-proxy-on-demand 的进程侧 —— 拉起 / 续租 / 到点杀掉 mihomo 内核。
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 *       （本文件只负责 spawn 它，不改动其二进制）
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；只用 Node 内建模块。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 *
 * 「用完自动关」是本插件存在的核心理由，实现要点：
 *
 * 1. **租约**：每次请求都 renew( leaseMs )，相当于"我还在用"。
 * 2. **守护轮询**：每 tickMs 检查，租约过期 → 杀内核 → 清状态文件。
 * 3. **只杀自己**：记录 core.pid，绝不按进程名扫杀（否则可能误杀
 *    用户自己开的 FlClash/其他 mihomo）。
 * 4. **宿主关闭时清理**：ctx.effect 的 dispose 里做一次兜底。
 *
 * ── 借道优先（2026-10-16 重构）─────────────────────────────────────────────
 *
 * 本插件**先借后起**：如果本机已经有代理在监听（FlClash / Clash Verge /
 * v2rayN …），直接复用它的端口，**自己一个进程都不起**。只有确实没人听时
 * 才拉起自己的内核。
 *
 * 这样做有两层原因：
 *   · 省资源、无副作用 —— 用户已经在跑的代理没必要再来一份；
 *   · 消除「两个内核抢同一个端口」的历史事故 —— 本插件的端口默认已改为
 *     冷门的 7899（见 DEFAULTS.port），不再与 FlClash 的 7890 撞车。
 *
 * 刻意**不依赖外部包**：profile 侧解析不到 pm2 / node-windows 之类，
 * 一律用 Node 内建 child_process + fs。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULTS = {
  /**
   * 混合代理端口。
   *
   * ⚠️ **故意不是 7890**（2026-10-16 改）。7890 是 FlClash / Clash for Windows
   * 的默认混合端口，本插件过去也用 7890，于是「插件内核先起 → 占住 7890 →
   * FlClash 内核起不来」。用户报的正是这个：
   *
   *   「我代理的时候 fl 内核连不上」
   *
   * 7899 是同一段里没人用的一个：既不与 FlClash(7890)、Clash Verge(7897)、
   * 各种 clash 系(7890-7898) 撞，也不在任何常见代理端口名单里，
   * 所以 FlClash 随时可以照常启动。
   */
  port: 7899,
  /** 空闲多久后自动关闭（毫秒）。**仅在 `resident` 为 false 时生效。** */
  idleMs: 120000,
  /** 守护轮询间隔（毫秒）。 */
  tickMs: 15000,
  /** 内核启动超时（毫秒）。 */
  startTimeoutMs: 30000,
  /**
   * 常驻模式。**默认 false** —— 也就是「用完自动关」（本插件存在的核心理由）。
   *
   * 用户 2026-10-13 明确问过「完成任务自动关为什么删？不是有个开关吗？」——
   * 我先前把它默认改成 true 并把倒计时/续期藏了起来，等于**悄悄删掉了这个功能**，
   * 那是错的。现在恢复原默认，常驻只作为**可选开关**保留给想省启动等待的人。
   */
  resident: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProxyCore {
  constructor({ dir, exe, config, log = () => {}, borrowPort = null, activityWatch = null, ...opts }) {
    this.dir = dir;
    this.exePath = join(dir, exe);
    this.configPath = join(dir, config);
    this.log = log;
    this.cfg = { ...DEFAULTS, ...opts };

    /**
     * 「借道」回调（由 index.js 注入，内部用 peers.js 探常见代理端口）。
     *
     * 返回 **端口号** 表示「这个端口上已经有代理在跑，直接用它」，
     * 返回 null/undefined 表示没人可借、需要自己起内核。
     * **未注入时永远返回 null**（= 老行为：总是自己起）。
     *
     * 为什么用回调而不是让 core 直接 import peers.js：core 只管进程，
     * 判据属上层；注入让 core 能被单独测试。
     */
    this.borrowPort = borrowPort;

    /**
     * 每个守护 tick 的「代理是否仍有真流量」观察，用于**自动续租**。
     *
     * 返回 `{ active, detail? }`。**默认 null = 不查**（保持旧行为）。
     * 修的是「用户正在用代理（浏览器访问 GitHub），倒计时却照样走完把内核杀掉」
     * 这个事故 —— 详见 checkIdle() 里的注释。
     */
    this.activityWatch = activityWatch;

    /**
     * 当前**实际使用的出口端口**。
     *
     * 三种来源，优先级从高到低：
     *   · 自己拉起的内核 → cfg.port（7899）
     *   · 借道别人的代理 → 那个人的端口（多半是 7890）
     *   · 自己的端口被别人占 → 也当借道（罕见，兜底）
     *
     * 由 ensureRunning() 设置、stop() 清空。对外通过 exitPort() 读。
     */
    this.currentExitPort = null;

    // ⚠️ 状态文件**绝不能用 `.json` 扩展名**。
    //
    // 宿主监视着插件目录，而实测（2026-10-14，21 种扩展名矩阵）**只有 `.json`
    // 会触发热重载**，`.state`/`.log`/`.txt`/`.dat`/`.lock`/`.yaml`… 全部不触发
    // （子目录里的 `.json` 同样触发）。而热重载的次序是「dispose 旧实例 →
    // apply 新实例」，于是每写一次状态文件就重建一次插件 —— 租约、忙锁
    // 全都会被这个重建打断，表现为「代理开着却关不掉」「设置改了不生效」。
    //
    // 换成 `.state` 之后这条链从根上断掉 —— 不是「打个补丁躲过竞态」，是
    // 让热重载**根本不会发生**。
    this.pidPath = join(dir, 'core.pid');
    this.leasePath = join(dir, 'lease.state');
    this.busyPath = join(dir, 'busy.state');
    this.coreLogPath = join(dir, 'core.log');

    // 旧版本用的是 `lease.json` / `busy.json`；升级后要清理掉，否则宿主一看到
    // 这两个 `.json` 就再触发热重载，而且旧租约内容会误导 checkIdle()。
    this.legacyPaths = [
      join(dir, 'lease.json'),
      join(dir, 'busy.json'),
      // 更早的版本还写过这两个（系统代理接管已整体移除，文件不再有人读，
      // 但留着会继续触发热重载）。
      join(dir, 'settings.json'),
      join(dir, 'proxy-backup.json'),
    ];

    this.child = null;
    this.timer = null;
    this.stats = {
      starts: 0,
      stops: 0,
      autoStops: 0,
      renewals: 0,
      /** 借道别人的代理、自己没起内核的次数。 */
      borrows: 0,
      /** 自己的端口被别人占、直接复用对方代理的次数（罕见兜底）。 */
      portReuses: 0,
      startedAt: null,
      lastStartMs: null,
      lastError: null,
      /** 最近一次借道的说明。 */
      lastBorrowNote: null,
    };
  }

  // ── 状态文件 ──────────────────────────────────────────────────────────────
  async readJson(p) {
    try {
      return JSON.parse(await fsp.readFile(p, 'utf8'));
    } catch {
      return null;
    }
  }

  async writeLease() {
    await fsp.writeFile(
      this.leasePath,
      JSON.stringify({ deadline: Date.now() + this.cfg.idleMs }),
      'utf8',
    );
  }

  /**
   * 清掉旧版本留下的 `.json` 状态文件。
   *
   * 必须在**任何写入之前**做：只要有这些文件在，宿主一看到 `.json` 就会
   * 触发热重载，而我们正是为了躲开热重载才改的名。旧租约还会让 checkIdle()
   * 误判剩余时间。
   *
   * 幂等，且失败不影响运行（大不了多一次热重载）。
   */
  async sweepLegacy() {
    await Promise.allSettled((this.legacyPaths ?? []).map((p) => fsp.unlink(p)));
  }

  async pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0); // 信号 0 = 只探测存在性
      return true;
    } catch {
      return false;
    }
  }

  /** 端口是否被监听。用 Node 自己连一下，避免依赖 netstat。 */
  async portUp(port = this.cfg.port) {
    const net = await import('node:net');
    return new Promise((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      s.setTimeout(1200, () => { s.destroy(); resolve(false); });
    });
  }

  /** 当前由本插件拉起的内核是否还活着。 */
  async ownCoreAlive() {
    const j = await this.readJson(this.pidPath);
    if (!j?.pid) return false;
    return this.pidAlive(j.pid);
  }

  /** 当前实际使用的出口端口（自己起的 / 借来的）。 */
  exitPort() {
    return this.currentExitPort ?? this.cfg.port;
  }

  // ── 启停 ──────────────────────────────────────────────────────────────────
  /**
   * 保证「有一个可用的代理出口」。
   *
   * 三条路，按顺序试：
   *   1. **自己的内核还活着** → 续租，直接用；
   *   2. **别人已经有代理在跑** → 借道（借它的端口），自己一个进程都不起；
   *   3. 都没有 → 拉起自己的内核（用 cfg.port，默认 7899）。
   *
   * 第 2 条是 2026-10-16 新增的**优先借道**。以前这里只有在
   * 「自己的端口恰好被别人占」时才复用对方 —— 那等于要求双方端口相同才生效。
   * 现在主动去探常见代理端口，只要有人在听就借。
   */
  /**
   * 确保有一个可用的出口。
   *
   * @param {object} [opts]
   *   `borrow: false` —— **这次不许借道，坚持起自己的内核**。
   *   什么时候需要：用户明确要操作「我们配置里的节点」（导入订阅/自动选点）。
   *   借道走的是别人内核的出口，那些节点根本不在它里面 —— 想切也切不了。
   *   起自己的内核不会跟 FlClash 抢（端口是隔离的，见 DEFAULTS.port），
   *   这正是本插件设计里允许的共存方式。
   */
  async ensureRunning({ borrow = true } = {}) {
    if (await this.ownCoreAlive()) {
      await this.writeLease();
      return { started: false, port: this.exitPort() };
    }

    // ── 借道优先 ──────────────────────────────────────────────────────────
    const borrowed = borrow ? await this.findBorrowable() : null;
    if (borrowed) {
      this.currentExitPort = borrowed.port;
      await this.writeLease();
      this.stats.borrows += 1;
      this.stats.lastBorrowNote = borrowed.note ?? `借道 127.0.0.1:${borrowed.port}`;
      return { started: false, borrowed: true, port: borrowed.port, note: borrowed.note };
    }

    // ── 兜底：自己的端口已有人在听 ────────────────────────────────────────
    //
    // 新端口（7899）下基本不会发生；留着是为了「用户手动把端口改成 7890」
    // 这种自定义配置不会把自己打死。
    if (await this.portUp(this.cfg.port)) {
      this.currentExitPort = this.cfg.port;
      await this.writeLease();
      this.stats.portReuses += 1;
      this.stats.lastBorrowNote = `端口 ${this.cfg.port} 已被占用，直接复用`;
      return { started: false, external: true, port: this.cfg.port };
    }

    return this.start();
  }

  /**
   * 问一次「有没有代理可以借道」。
   *
   * 回调自身抛错时返回 null —— **宁可自己多起一个内核，也不要因为探测代码
   * 出问题就让代理彻底不可用**。
   */
  async findBorrowable() {
    if (!this.borrowPort) return null;
    try {
      const r = await this.borrowPort({ ownPort: this.cfg.port, ownAlive: false });
      if (r == null) return null;
      // 只接受端口号或 { port, note }；别的一律当作"没得借"
      if (Number.isInteger(r)) return { port: r };
      if (Number.isInteger(r?.port)) return r;
      return null;
    } catch (e) {
      this.log?.('warn', `借道探测失败，改为自己起内核：${String(e?.message ?? e)}`);
      return null;
    }
  }

  async start() {
    if (!existsSync(this.exePath)) throw new Error(`内核未就绪: ${this.exePath}（请先调用 prepare）`);
    if (!existsSync(this.configPath)) throw new Error(`缺少配置: ${this.configPath}`);

    const t0 = Date.now();
    const out = (await import('node:fs')).openSync(this.coreLogPath, 'a');
    const child = spawn(this.exePath, ['-f', this.configPath, '-d', this.dir], {
      cwd: this.dir,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    this.child = child;

    try { (await import('node:fs')).closeSync(out); } catch { /* ignore */ }

    await fsp.writeFile(this.pidPath, JSON.stringify({ pid: child.pid }), 'utf8');
    await this.writeLease();

    // 等端口就绪
    const deadline = Date.now() + this.cfg.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.portUp(this.cfg.port)) {
        this.currentExitPort = this.cfg.port;
        this.stats.starts += 1;
        this.stats.startedAt = Date.now();
        this.stats.lastStartMs = Date.now() - t0;
        return { started: true, pid: child.pid, ms: Date.now() - t0, port: this.cfg.port };
      }
      await sleep(300);
    }
    const tail = await this.tailLog();
    this.stats.lastError = `内核启动超时：${tail}`;
    throw new Error(`内核启动超时（${this.cfg.startTimeoutMs}ms）。日志尾部：\n${tail}`);
  }

  async tailLog(lines = 20) {
    try {
      const t = await fsp.readFile(this.coreLogPath, 'utf8');
      return t.split(/\r?\n/).slice(-lines).join('\n');
    } catch {
      return '(无日志)';
    }
  }

  /**
   * 「忙锁」：标记有一条长命令正在用代理。
   *
   * 为什么不能只靠续租：守护每 tickMs(15s) 才检查一次，而 CLI 的续租也是定时器。
   * 两者错开时，理论上有窗口让守护在"命令还在跑"时把内核杀掉。忙锁把这个窗口
   * 彻底关掉 —— 只要锁在，checkIdle() 一律不动内核。
   *
   * 用 PID 记录持有者，持有者进程若已消失，锁自动失效（避免崩溃后永久卡住）。
   */
  async acquireBusy() {
    await fsp.writeFile(this.busyPath, JSON.stringify({ pid: process.pid, since: Date.now() }), 'utf8');
  }

  async releaseBusy() {
    await fsp.unlink(this.busyPath).catch(() => {});
  }

  /** 锁是否被一个活着的进程持有。 */
  async busyHeld() {
    const b = await this.readJson(this.busyPath);
    if (!b?.pid) return false;
    if (await this.pidAlive(b.pid)) return true;
    await fsp.unlink(this.busyPath).catch(() => {});   // 持有者已死，清掉
    return false;
  }

  async renew() {
    const port = this.exitPort();
    if (!(await this.ownCoreAlive()) && !(await this.portUp(port))) return { alive: false };
    this.stats.renewals += 1;
    await this.writeLease();
    return { alive: true, deadline: Date.now() + this.cfg.idleMs, port };
  }

  /** 停止由本插件拉起的内核。借道来的东西不归我们关。 */
  async stop(reason = 'manual') {
    const j = await this.readJson(this.pidPath);
    let killed = false;
    if (j?.pid && (await this.pidAlive(j.pid))) {
      try { process.kill(j.pid); killed = true; } catch { /* 已退出 */ }
    }
    this.stats.stops += 1;
    if (reason === 'idle') this.stats.autoStops += 1;
    this.currentExitPort = null;
    await Promise.allSettled([
      fsp.unlink(this.pidPath),
      fsp.unlink(this.leasePath),
      fsp.unlink(this.busyPath),
    ]);
    return { killed, reason };
  }

  /**
   * **换配置后让内核重新加载**（2026-10-16 新增）。
   *
   * 场景：用户导入了新订阅 / 换了 FlClash 配置 / 手贴了一份 YAML。
   * 内核是**启动时读一次 config.yaml**，之后改文件它并不知道 —— 于是界面显示
   * 「导入成功，143 个节点」，实际跑的仍是旧配置。这种「报告成功但没生效」
   * 正是本次要消灭的东西。
   *
   * 做法就是**停掉再起**，不用管理 API 的 `/configs` 热重载：
   *   · 热重载对 `mixed-port` 这类监听项本来就不生效（要重启才能换端口）；
   *   · 本插件的内核是**按需启停**的，重启成本只有几百毫秒（实测 820ms）；
   *   · 少一条依赖内核版本行为的路径。
   *
   * 只在**我们自己起的**内核上做：借道时那个内核不归我们管，重启它会打断
   * 用户自己的代理 —— 返回 `{ restarted: false, reason: 'borrowed' }`，
   * 由调用方决定要不要改成起自己的内核。
   */
  async restart(reason = 'config') {
    const alive = await this.ownCoreAlive();
    if (!alive) {
      return { restarted: false, reason: 'not-running' };
    }
    await this.stop(reason);
    // 让 OS 把端口放干净 —— stop() 只是发信号，立刻 start 有几率撞上 TIME_WAIT。
    await sleep(250);
    return { restarted: true, ...(await this.start()) };
  }

  // ── 空闲守护 ──────────────────────────────────────────────────────────────
  startIdleWatcher() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.checkIdle(); }, this.cfg.tickMs);
    this.timer.unref?.();
  }

  async checkIdle() {
    try {
      if (await this.busyHeld()) return;            // 有命令正在用：绝不关

      // ── 活跃观察（2026-10-13 修「用 GitHub 时倒计时仍在继续」）────────────
      //
      // 事故原委：用户反馈「我用 github 时，关闭倒计时仍在继续」。
      // 根因是租约只由 `renew()` 写入，而 renew 只在 **CLI 命令**里被调用
      // （`POST /fetch` 之类）。浏览器/其它程序走代理端口的流量插件**完全感知不到** ——
      // 于是用户正下载着，20 秒倒计时一到就把内核杀了。
      //
      // 修法：每个 tick 先问一次「代理端口最近有没有真流量」。有就自动续租，
      // 让倒计时退回起点。判据是**累计字节数在增长**（不是"有没有连接"——
      // 长连接挂着但不传数据也算空闲）。
      //
      // ⚠️ 借道时**不续租**：那是别人家的内核，我们没资格替它改寿命，
      //    而且它的存活根本不归我们管。借道本身也不占资源，无需回收。
      if (this.activityWatch) {
        let a = null;
        try { a = await this.activityWatch(); } catch { /* 观察失败不影响空闲逻辑 */ }
        if (a?.active === true) {
          if (await this.ownCoreAlive()) {
            await this.writeLease();
            this.stats.autoRenews = (this.stats.autoRenews ?? 0) + 1;
            this.stats.lastActivityAt = Date.now();
            this.log?.('debug', `检测到代理仍有流量（${a.detail ?? ''}），已自动续租`);
          }
          return;
        }
      }

      // ── 常驻模式：内核不因空闲而关 ────────────────────────────────────────
      if (this.cfg.resident !== false) return;

      // 借道别人时不写租约、也永不"关"（没什么可关的），直接返回。
      if (!(await this.ownCoreAlive())) {
        this.currentExitPort = null;
        await fsp.unlink(this.leasePath).catch(() => {});
        return;
      }

      const lease = await this.readJson(this.leasePath);
      if (!lease?.deadline) return;                 // 没有租约 = 没在用
      if (Date.now() < lease.deadline) return;      // 还没到期

      await this.stop('idle');
      this.log?.('info', `空闲超时，已自动关闭代理内核（空闲 ${Math.round(this.cfg.idleMs / 1000)}s）`);
    } catch (e) {
      this.stats.lastError = String(e?.message ?? e);
    }
  }

  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async status() {
    const lease = await this.readJson(this.leasePath);
    const pidInfo = await this.readJson(this.pidPath);
    const alive = await this.ownCoreAlive();
    const port = await this.portUp(this.cfg.port);
    const ep = this.exitPort();
    const exitUp = ep === this.cfg.port ? port : await this.portUp(ep);
    return {
      coreAlive: alive,
      portUp: port,
      externalPort: port && !alive,
      /** 当前出口端口（自己起的 = ownPort，借来的 = 别人的）。 */
      exitPort: ep,
      exitPortUp: exitUp,
      /** 是否在借道（自己没起内核，走别人的代理）。 */
      borrowed: !alive && exitUp && ep !== this.cfg.port,
      pid: alive ? pidInfo?.pid ?? null : null,
      idleMs: this.cfg.idleMs,
      remainingMs: lease?.deadline ? Math.max(0, lease.deadline - Date.now()) : 0,
      ...this.stats,
    };
  }
}

export { DEFAULTS as CORE_DEFAULTS, dirname };
