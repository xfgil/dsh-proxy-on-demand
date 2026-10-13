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
  /** 空闲多久后自动关闭（毫秒）。 */
  idleMs: 120000,
  /** 守护轮询间隔（毫秒）。 */
  tickMs: 15000,
  /** 内核启动超时（毫秒）。 */
  startTimeoutMs: 30000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProxyCore {
  constructor({ dir, exe, config, log = () => {}, gate = null, gameWatch = null, peerGate = null, ...opts }) {
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
        return { started: true, pid: child.pid, ms: Date.now() - t0 };
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

      // ── 游戏观察（可选，仅当用户打开 stopOnGame 时注入）──
      // 放在租约判断**之前**：即使租约还没到期，游戏一起来也要按设置把内核关掉。
      if (this.gameWatch) {
        let g = null;
        try { g = await this.gameWatch(); } catch { /* 观察失败不影响空闲逻辑 */ }
        if (g?.gameRunning) {
          if (!(await this.ownCoreAlive())) {
            // 内核不是我们起的（多半是 FlClash）：不碰，只是提醒
            this.stats.lastBlockedReason = g.what ?? null;
            return;
          }
          await this.stop('game');
          this.log?.('info', `检测到游戏运行（${g.what ?? '未知'}），已按设置关闭代理内核`);
          return;
        }
      }

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
