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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureKernel, latestVersion, DEFAULT_MIRRORS } from './downloader.js';
import { exampleConfig, findFlClashConfig, materialize } from './config.js';
import { ProxyCore } from './core.js';
import { disposeProbe, ensureProbe, probeStatus } from './probe.js';
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

  const core = new ProxyCore({
    dir: runtimeDir,
    exe: KERNEL_EXE,
    config: 'config.yaml',
    port: base.port,
    idleMs: base.idleMs,
    log,
    // stopOnGame 打开时才给守护挂观察；关着就传 null（守护不做无谓的检测）
    gameWatch: () => (user.stopOnGame === true ? gameWatch() : Promise.resolve({ gameRunning: false })),
    gate,
    peerGate: peerGateFn,
  });

  /** 把用户设置同步到 core 的参数上。 */
  async function syncSettings() {
    user = await readSettings(runtimeDir);
    core.cfg.port = user.port;
    core.cfg.idleMs = user.idleMs;
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
    return () => { core.dispose(); disposeProbe(); };
  });

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
    if (existsSync(configPath) && !forceImport) return { source: 'existing' };

    if (base.configFile && existsSync(base.configFile)) {
      const r = await materialize(base.configFile, runtimeDir);
      return { source: 'configFile', ...r };
    }

    const s = await readSettings(runtimeDir);
    if (s.autoImportFlClash !== false) {
      const found = await findFlClashConfig();
      if (found.found) {
        const r = await materialize(found.path, runtimeDir);
        stats.imports += 1;
        await writeSettings(runtimeDir, { configSource: 'flclash', lastSyncAt: Date.now(), lastSyncNote: `已从 FlClash 导入（规则 ${r.rulesTotal} 条）` });
        return { source: 'flclash', ...r };
      }
    }

    await fsp.writeFile(configPath, exampleConfig(base.port), 'utf8');
    await writeSettings(runtimeDir, { configSource: 'example', lastSyncAt: Date.now(), lastSyncNote: '生成了模板配置' });
    return { source: 'example' };
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
            send({
              ok: true, enabled: user.enabled !== false, ...st, game, peer,
              plugin: {
                kernelVersion: stats.kernelVersion, generations: stats.generations,
                requests: stats.requests, lastError: stats.lastError,
                probe: probeStatus(),
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
            const r = await applySubscription(runtimeDir, sub);
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
            const r = await materialize(found.path, runtimeDir);
            stats.imports += 1;
            const summary = await configSummary(runtimeDir);
            await writeSettings(runtimeDir, {
              configSource: 'flclash', lastSyncAt: Date.now(),
              lastSyncNote: `已从 FlClash 导入（规则 ${r.rulesTotal} 条）`,
            });
            send({ ok: true, ...r, nodeCount: summary.nodeCount ?? 0, note: `已从 FlClash 导入：${found.path}` });
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
};

export default { name, apply };
