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
 * 刻意**不依赖外部包**：profile 侧解析不到 pm2 / node-windows 之类，
 * 一律用 Node 内建 child_process + fs。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULTS = {
  /** 混合代理端口。与 FlClash 默认一致。 */
  port: 7890,
  /** 空闲多久后自动关闭（毫秒）。**仅在 `resident` 为 false 时生效。** */
  idleMs: 120000,
  /** 守护轮询间隔（毫秒）。 */
  tickMs: 15000,
  /** 内核启动超时（毫秒）。 */
  startTimeoutMs: 30000,
  /**
   * 常驻模式。**默认 false** —— 也就是「用完自动关」（本插件存在的核心理由）。
   *
   * ## 2026-10-13 的回退（用户原话）
   *
   * > 「完成任务自动关为什么删？不是有个开关吗？」
   *
   * 我先前一度把它默认改成 true，还把空闲倒计时和「续期」按钮一起藏了 ——
   * 那等于**悄悄删掉了这个功能**，用户当然不满。现在恢复原状：默认就是
   * 空闲自动关，常驻只是设置里一个**可选开关**（关掉它才常驻）。
   *
   * 注意这和「系统代理独立开关」不冲突：内核起停与系统代理是两件事 ——
   * 内核空闲自动关，系统代理跟着内核一起收（onStopped 钩子）。
   * 想让内核一直开着（省掉每次 1~2 秒启动等待）就把设置里的常驻打开。
   */
  resident: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProxyCore {
  constructor({ dir, exe, config, log = () => {}, gate = null, gameWatch = null, peerGate = null, activityWatch = null, proxyHook = null, ...opts }) {
    this.dir = dir;
    this.exePath = join(dir, exe);
    this.configPath = join(dir, config);
    this.log = log;
    this.cfg = { ...DEFAULTS, ...opts };

    /**
     * 起核前的闸门回调（由 index.js 注入，内部调 games.js 的 gameGate）。
     * 返回 { blocked, message?, reason? }。**未注入时不做任何拦截。**
     *
     * 为什么用回调而不是直接 import games.js：core.js 只管进程，判据与设置
     * 都属上层；注入让 core 能被单独测试，也让「谁拦的」一目了然。
     */
    this.gate = gate;
    /**
     * 每个守护 tick 调一次的游戏观察回调，用于 stopOnGame（检测到游戏时把
     * 已在跑的内核也关掉）。返回 { gameRunning, what? }。**默认 null = 不查**，
     * 因为用户默认选了「只拦新的，已有的不动」。
     */
    this.gameWatch = gameWatch;
    /**
     * 起核前的「礼让」闸门回调（由 index.js 注入，内部调 peers.js 的 peerGate）。
     * 检测到别的代理已经占了代理端口时，安静让路、不启动自己的内核。
     * 接收 `{ ownAlive }`（由 core 算好传进去），返回 `{ blocked, message? }`。
     * **未注入时不做任何拦截。**
     */
    this.peerGate = peerGate;
    /**
     * 每个守护 tick 的「代理是否仍有真流量」观察，用于**自动续租**。
     *
     * 返回 `{ active, detail? }`。**默认 null = 不查**（保持旧行为）。
     * 修的是「用户正在用代理（浏览器访问 GitHub），倒计时却照样走完把内核杀掉」
     * 这个事故 —— 详见 checkIdle() 里的注释。
     */
    this.activityWatch = activityWatch;
    /**
     * 系统代理钩子（由 index.js 注入，内部调 systemproxy.js）。
     *
     * 约定四件事，**每一件都必须是幂等的**（可能被重复调用）：
     *   · `onStarted()`   —— 内核真的起来之后调用，把系统代理指向我们；
     *   · `onStopped()`   —— 内核关掉之后调用，精确还原用户原设置；
     *   · `onBooting()`   —— 起核之前调用（可选，用于先抢在别人前面记录原值）；
     *   · `adopt()`       —— 首次加载时把上次崩溃残留的现场收拾干净。
     *
     * **未注入时一律不碰系统设置**（保持"纯内核"行为，方便单测）。
     * 注意：这个钩子只在「内核真的起来/真的停掉」前后被调用 —— 游戏闸门
     * 在内核启动**之前**就拦掉了，所以打游戏时系统代理不会被碰。
     */
    this.proxyHook = proxyHook;

    this.pidPath = join(dir, 'core.pid');
    this.leasePath = join(dir, 'lease.json');
    this.busyPath = join(dir, 'busy.json');
    this.coreLogPath = join(dir, 'core.log');

    this.child = null;
    this.timer = null;
    this.stats = {
      starts: 0,
      stops: 0,
      autoStops: 0,
      renewals: 0,
      /** 被游戏闸门拦下的次数。 */
      blocked: 0,
      /** 因游戏运行而被主动关掉的次数。 */
      gameStops: 0,
      /** 因检测到其它代理而礼让（不启动）的次数。 */
      peerBlocked: 0,
      /** 端口已被别的代理占用、直接复用对方代理的次数（不抢也不起）。 */
      peerYields: 0,
      startedAt: null,
      lastStartMs: null,
      lastError: null,
      /** 最近一次被拦的说明。 */
      lastBlockedReason: null,
      /** 最近一次因礼让而放弃启动的说明。 */
      lastPeerReason: null,
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

  // ── 启停 ──────────────────────────────────────────────────────────────────
  /**
   * 保证内核在跑。
   *
   * ⚠ 闸门只在**需要新起内核**时生效 —— 内核已经在跑就直接续租返回。
   * 这正是用户选的「只拦新的，已有的不动」：游戏开始时代理若已在跑就保持现状。
   *
   * 端口被别人占着时（多半是 FlClash），这里**不抢**，直接标记 external 返回：
   * 命令照常能用（走的是别人已经建好的代理），而我们自己一个进程都不起。
   * 这就是「检测到其它代理就自动静默」在正常路径上的形态 —— 礼让闸门只在
   * 端口空闲、我们准备自己起内核时才需要开口拦人。
   */
  async ensureRunning() {
    if (await this.ownCoreAlive()) { await this.writeLease(); return { started: false }; }
    if (await this.portUp()) {
      // 端口被别的进程占：不抢，标记 external 后照常可用
      await this.writeLease();
      this.stats.peerYields = (this.stats.peerYields ?? 0) + 1;
      return { started: false, external: true, peer: true };
    }
    return this.start();
  }

  /**
   * 问一次闸门。返回 `{ blocked, message }`；没有闸门回调时永远放行。
   * 闸门自身抛错时**放行**（宁可放过，也不要让检测问题把代理锁死）。
   */
  async checkGate() {
    if (!this.gate) return { blocked: false };
    try {
      const g = await this.gate();
      if (g?.blocked) {
        this.stats.blocked += 1;
        this.stats.lastBlockedReason = g.message ?? '被闸门拦下';
        return { blocked: true, message: g.message, reason: g.reason, detail: g.detail };
      }
      return { blocked: false };
    } catch (e) {
      this.log?.('warn', `游戏闸门检查失败，按放行处理：${String(e?.message ?? e)}`);
      return { blocked: false };
    }
  }

  /**
   * 问一次「礼让」闸门：别的代理是不是已经在跑了？
   *
   * 把 ownAlive 算好再传给上层 —— 因为「7890 有人监听」这件事，只有
   * core 知道那是不是我们自己。上层（index.js）拿不到这个判断依据。
   *
   * 与 checkGate 同样的宽容度：**礼让闸门自身抛错时放行**。
   */
  async checkPeerGate() {
    if (!this.peerGate) return { blocked: false };
    try {
      const ownAlive = await this.ownCoreAlive();
      const g = await this.peerGate({ ownAlive });
      if (g?.blocked) {
        this.stats.peerBlocked += 1;
        this.stats.lastPeerReason = g.message ?? '检测到其它代理正在运行';
        return { blocked: true, message: g.message, reason: g.reason, detail: g.detail };
      }
      return { blocked: false };
    } catch (e) {
      this.log?.('warn', `代理礼让检测失败，按放行处理：${String(e?.message ?? e)}`);
      return { blocked: false };
    }
  }

  async start() {
    // 起核前先过两道闸门。
    //
    // 顺序有讲究：**礼让闸门在前**。理由——如果别的代理已经占了端口，
    // 那"能不能起"这件事根本轮不到游戏状态来回答；先让路可以少探一次
    // 系统状态，也让被拦的原因更准确（用户看到的是"别人在跑"而不是
    // 一个碰巧同时成立的游戏判定）。
    const peer = await this.checkPeerGate();
    if (peer.blocked) {
      const err = new Error(peer.message ?? '检测到其它代理正在运行，已自动静默让路');
      err.code = 'PEER_BLOCKED';
      err.gate = peer;
      throw err;
    }

    // 再过游戏闸门（这是「检测到游戏运行时禁止启用代理」的落点）
    const gate = await this.checkGate();
    if (gate.blocked) {
      const err = new Error(gate.message ?? '检测到游戏正在运行，已按设置禁止启用代理');
      err.code = 'GAME_BLOCKED';
      err.gate = gate;
      throw err;
    }

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
      if (await this.portUp()) {
        this.stats.starts += 1;
        this.stats.startedAt = Date.now();
        this.stats.lastStartMs = Date.now() - t0;
        // ⚠️ 顺序要紧：**端口确认可用之后**才动系统代理。
        //    如果内核没起来就把系统代理指过去，用户会整个断网 ——
        //    那比"没开代理"糟糕得多。
        await this.notifyProxyOn();
        return { started: true, pid: child.pid, ms: Date.now() - t0 };
      }
      await sleep(300);
    }
    const tail = await this.tailLog();
    this.stats.lastError = `内核启动超时：${tail}`;
    throw new Error(`内核启动超时（${this.cfg.startTimeoutMs}ms）。日志尾部：\n${tail}`);
  }

  /**
   * 通知钩子「内核起来了」。
   *
   * 钩子抛错**只记日志、不影响启动结果** —— 系统代理设置失败（比如被组策略
   * 锁了）不应该让整个代理功能不可用，用户至少还能手动配代理端口。
   */
  async notifyProxyOn() {
    if (!this.proxyHook?.onStarted) return;
    try {
      await this.proxyHook.onStarted();
    } catch (e) {
      this.stats.lastError = `设置系统代理失败：${String(e?.message ?? e)}`;
      this.log?.('warn', this.stats.lastError);
    }
  }

  /** 通知钩子「内核关掉了」—— 这里失败要吵一点，因为可能把用户留在断网状态。 */
  async notifyProxyOff(reason) {
    if (!this.proxyHook?.onStopped) return;
    try {
      await this.proxyHook.onStopped(reason);
    } catch (e) {
      this.stats.lastError = `还原系统代理失败：${String(e?.message ?? e)}`;
      this.log?.('error', this.stats.lastError);
    }
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
    if (!(await this.ownCoreAlive()) && !(await this.portUp())) return { alive: false };
    this.stats.renewals += 1;
    await this.writeLease();
    return { alive: true, deadline: Date.now() + this.cfg.idleMs };
  }

  /** 停止由本插件拉起的内核。 */
  async stop(reason = 'manual') {
    const j = await this.readJson(this.pidPath);
    let killed = false;
    if (j?.pid && (await this.pidAlive(j.pid))) {
      try { process.kill(j.pid); killed = true; } catch { /* 已退出 */ }
    }
    this.stats.stops += 1;
    if (reason === 'idle') this.stats.autoStops += 1;
    if (reason === 'game') this.stats.gameStops += 1;
    await Promise.allSettled([
      fsp.unlink(this.pidPath),
      fsp.unlink(this.leasePath),
      fsp.unlink(this.busyPath),
    ]);
    // 内核已经停了 —— 系统代理必须跟着还原，否则浏览器还在往一个
    // 已经死掉的端口上送请求，用户会整个上不了网。
    //
    // 放在 unlink 之后：先确保"我们不再持有内核"这个事实落盘，再做还原。
    // 即使还原失败，下次启动的 adopt() 也会兜底收拾。
    await this.notifyProxyOff(reason);
    return { killed, reason };
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
      if (this.activityWatch) {
        let a = null;
        try { a = await this.activityWatch(); } catch { /* 观察失败不影响空闲逻辑 */ }
        if (a?.active === true) {
          // 只有内核是我们自己起的才续租（别人家的内核我们不能替他续）。
          if (await this.ownCoreAlive()) {
            await this.writeLease();
            this.stats.autoRenews = (this.stats.autoRenews ?? 0) + 1;
            this.stats.lastActivityAt = Date.now();
            this.log?.('debug', `检测到代理仍有流量（${a.detail ?? ''}），已自动续租`);
          }
          return;
        }
      }

      // ── 游戏观察（可选，只在 stopOnGame 打开时才注入）──
      //
      // 2026-10-13 回退到原样。用户原话：
      //
      // > 「留内核关代理啊，都说了开游戏只是不能启动代理插件，你没事动游戏闸做什么」
      // > 选：「回到原样：游戏时只禁止启动插件，别的什么都不动」
      //
      // 所以游戏闸门只做一件事：**在启动之前拦住**（见 this.gate，由 index.js 注入）。
      // 已经在跑的内核不动、系统代理也不摘 —— 那两件事用户没要求。
      //
      // 唯一例外是用户**显式**打开的老设置 `stopOnGame`：那时才把已在跑的内核也关掉。
      if (this.gameWatch && this.cfg.stopOnGame === true) {
        let g = null;
        try { g = await this.gameWatch(); } catch { /* 观察失败不影响空闲逻辑 */ }
        if (g?.gameRunning && (await this.ownCoreAlive())) {
          this.stats.lastBlockedReason = g.what ?? null;
          this.log?.('info', `检测到游戏运行（${g.what ?? '未知'}），按设置关闭代理内核`);
          await this.stop('game');
          return;
        }
      }

      // ── 常驻模式：内核不因空闲而关 ────────────────────────────────────────
      //
      // 用户的选择：「不该跟 Fl 一样内核一直开着再单独搞个开关吗」→ 是。
      // 常驻时这里直接返回，**只有手动关闭 / 宿主退出才会停内核**。
      // 租约机制仍然保留（手动 stop 时要用），但不再由空闲驱动。
      if (this.cfg.resident !== false) return;

      const lease = await this.readJson(this.leasePath);
      if (!lease?.deadline) return;                 // 没有租约 = 没在用
      if (Date.now() < lease.deadline) return;      // 还没到期
      if (!(await this.ownCoreAlive())) {           // 内核不是我们起的：不碰
        await fsp.unlink(this.leasePath).catch(() => {});
        return;
      }
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
    const port = await this.portUp();
    return {
      coreAlive: alive,
      portUp: port,
      externalPort: port && !alive,
      pid: alive ? pidInfo?.pid ?? null : null,
      idleMs: this.cfg.idleMs,
      remainingMs: lease?.deadline ? Math.max(0, lease.deadline - Date.now()) : 0,
      ...this.stats,
    };
  }
}

export { DEFAULTS as CORE_DEFAULTS, dirname };
