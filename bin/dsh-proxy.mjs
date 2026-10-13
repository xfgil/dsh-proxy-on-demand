#!/usr/bin/env node
/**
 * dsh-proxy-on-demand 命令行工具。
 *
 * 用途：不经过宿主、直接在命令行按需拉起代理跑一条命令，跑完自动关。
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；本 CLI 不依赖宿主，
 *           宿主没起来时也能单独用。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 * 自动安装提醒：首次 `start` / `prepare` 会联网下载内核（约 61MB）到 runtime/。
 *
 * 用法：
 *   node bin/dsh-proxy.mjs status              查看状态
 *   node bin/dsh-proxy.mjs start               启动内核
 *   node bin/dsh-proxy.mjs stop                关闭内核
 *   node bin/dsh-proxy.mjs prepare             下载内核 + 准备配置
 *   node bin/dsh-proxy.mjs import-flclash      从本机 FlClash 导入配置
 *   node bin/dsh-proxy.mjs -- <命令> [参数...]  带着代理跑一条命令
 *
 * 最后一种是最常用的：跑完命令后内核不会立刻关，而是等空闲超时自动关；
 * 传 --idle 0 可以让它在命令结束后立刻关。
 *
 * 它直接调库，不经过宿主 HTTP 面 —— 这样在宿主没起来时也能用。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureKernel, latestVersion, DEFAULT_MIRRORS } from '../lib/downloader.js';
import { findFlClashConfig, materialize, exampleConfig } from '../lib/config.js';
import { ProxyCore } from '../lib/core.js';
import { configSummary, readSettings, writeSettings } from '../lib/settings.js';
import { describeHit, detectGames, gameGate, clearGameCache } from '../lib/games.js';
import { describePeer, detectPeers, peerGate as peerGateFn } from '../lib/peers.js';
import { disposeProbe } from '../lib/probe.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = process.env.DSH_PROXY_RUNTIME || join(ROOT, 'runtime');

/** 自动安装提醒：只在真的要下载时说一次，别每次命令都刷屏。 */
function noticeAutoInstall() {
  if (existsSync(join(RUNTIME, 'mihomo.exe'))) return;
  console.error('[提醒] 首次使用：将从 MetaCubeX/mihomo 官方 Release 自动下载内核（约 61MB）');
  console.error('       到 ' + RUNTIME + ' —— 不需要手动安装；删掉该目录即可完全清除。');
  console.error('       上游以 GPL-3.0 授权，本插件不修改其二进制。');
}

const argv = process.argv.slice(2);
const log = (l, m) => console.error(`[${l}] ${m}`);

/** 解析 `--idle N` 之类的选项，返回 {opts, rest}。 */
function parse(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a === '--idle') { opts.idle = Number(argv[++i]); continue; }
    if (a === '--port') { opts.port = Number(argv[++i]); continue; }
    if (a === '--no-wait') { opts.noWait = true; continue; }
    if (a === '--no-gate') { opts.noGate = true; continue; }
    if (a === '--no-peer') { opts.noPeer = true; continue; }
    if (a === '--allow') { opts.allow = argv[++i]; continue; }
    if (a === '--allow-fg') { opts.allowFg = true; continue; }
    if (a === '--unallow') { opts.unallow = argv[++i]; continue; }
    if (a === '--json') { opts.json = true; continue; }
    rest.push(a);
  }
  return { opts, rest };
}

const { opts, rest } = parse(argv);
const cmd = rest[0];

const settings = await readSettings(RUNTIME);
const port = opts.port || settings.port || 7890;
const idleMs = opts.idle != null ? opts.idle * 1000 : (settings.idleMs ?? 120000);

/**
 * 游戏闸门（与宿主侧同一条规则，见 lib/games.js）。
 *
 * CLI 也遵守「游戏运行时禁止启用代理」——否则用户在游戏里跑一条
 * `dsh-proxy -- curl ...` 就绕过了整个保护，那这个功能就没意义了。
 * 显式传 --no-gate 可以绕过（用户明确知道自己要什么）。
 */
const gate = opts.noGate ? null : () => gameGate({
  blockOnGame: settings.blockOnGame !== false,
  allow: settings.gameAllow ?? [],
  runtimeDir: RUNTIME,
});

/** 检测到游戏时是否关掉已在运行的内核（默认关，与「只拦新的」一致）。 */
const gameWatch = opts.noGate ? null : () => {
  if (settings.stopOnGame !== true) return Promise.resolve({ gameRunning: false });
  return detectGames({ runtimeDir: RUNTIME, allow: settings.gameAllow ?? [] })
    .then((d) => ({ gameRunning: d.gameRunning, what: describeHit(d) }));
};

/**
 * 礼让闸门（与宿主侧同一条规则，见 lib/peers.js）。
 *
 * 别的代理（FlClash 等）已经在跑时，本插件不启动自己的内核 —— 不抢端口、
 * 不改网络环境。只看端口占用，不认软件名字。--no-peer 可本次强行启用。
 *
 * ⚠ ownAlive 由 core 算好传进来：我们自己就监听这个端口，不排除自己的话
 *   内核一跑起来就会把自己当成「别的代理」，从此永远自我阻断。
 */
const peerGate = opts.noPeer ? null : ({ ownAlive } = {}) => peerGateFn({
  yieldToPeer: settings.yieldToPeer !== false,
  ownPort: port,
  ownAlive: ownAlive === true,
});

const core = new ProxyCore({
  dir: RUNTIME, exe: 'mihomo.exe', config: 'config.yaml',
  port, idleMs, log, gate, gameWatch, peerGate,
});

/** 确保内核与配置就位。 */
async function prepare() {
  await fsp.mkdir(RUNTIME, { recursive: true });
  if (!(await exists(join(RUNTIME, 'mihomo.exe')))) {
    noticeAutoInstall();
    const tag = await latestVersion('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest', { onLog: (m) => log('info', m) });
    const ver = tag.startsWith('v') ? tag : `v${tag}`;
    log('info', `下载内核 ${ver} …`);
    const k = await ensureKernel({
      dir: RUNTIME,
      url: `https://github.com/MetaCubeX/mihomo/releases/download/${ver}/mihomo-windows-amd64-${ver}.zip`,
      entry: 'mihomo-windows-amd64.exe',
      exe: 'mihomo.exe',
      mirrors: DEFAULT_MIRRORS,
      onLog: (m) => log('info', m),
    });
    log('info', `内核就绪（${Math.round(k.bytes / 1e6)}MB）`);
  }
  if (!(await exists(join(RUNTIME, 'config.yaml')))) {
    const found = await findFlClashConfig();
    if (found.found) {
      const r = await materialize(found.path, RUNTIME);
      log('info', `已从 FlClash 导入（规则 ${r.rulesTotal} 条，新拷 ${r.copied}）`);
    } else {
      await fsp.writeFile(join(RUNTIME, 'config.yaml'), exampleConfig(port), 'utf8');
      log('warn', '未找到 FlClash 配置，已生成模板；请填入节点后再用');
    }
  }
}

const exists = (p) => fsp.stat(p).then(() => true, () => false);

/**
 * 守到内核自己消失为止。
 *
 * 为什么需要：守护定时器是 `unref()` 的（不阻止进程退出）。命令行跑完就走
 * 的话，没人执行"空闲到期杀内核"这一步 —— 内核会一直挂着，正是本插件要
 * 消灭的情况。所以 CLI 的 start 默认在这里守着，直到自动关掉才返回。
 */
async function waitGone(verbose = false) {
  for (let i = 0; i < 24 * 60 * 2; i++) {   // 最多守 24 分钟
    if (!(await core.ownCoreAlive())) return true;
    // 守护定时器 15 秒才 tick 一次；这里自己催，否则 idle 比 tick 短时会白等一整个 tick。
    // checkIdle() 在租约未到期时只是一次读文件，很便宜。
    await core.checkIdle();
    await new Promise((r) => setTimeout(r, 500));
    if (verbose && i % 20 === 19) {
      const st = await core.status();
      log('info', `等待空闲关闭…还剩 ${Math.ceil((st.remainingMs ?? 0) / 1000)} 秒`);
    }
  }
  return false;
}

switch (cmd) {
  case 'status': {
    const st = await core.status();
    const cfg = await configSummary(RUNTIME);
    const out = { ok: true, runtime: RUNTIME, port, idleMs, ...st, config: cfg };
    console.log(opts.json ? JSON.stringify(out, null, 2) : format(out));
    break;
  }
  case 'prepare': {
    await prepare();
    console.log(JSON.stringify({ ok: true, runtime: RUNTIME, config: await configSummary(RUNTIME) }, null, 2));
    break;
  }
  case 'start': {
    await prepare();
    let r;
    try {
      r = await core.ensureRunning();
    } catch (e) {
      if (e?.code === 'GAME_BLOCKED') {
        console.error('');
        console.error('⛔ ' + (e.gate?.message ?? e.message));
        console.error('   如果这是误判（比如某个程序的无边框全屏被当成了游戏）：');
        console.error('     dsh-proxy game           # 看看系统当前状态与前台程序');
        console.error('   想本次强行启动，加 --no-gate。');
        process.exit(3);
      }
      if (e?.code === 'PEER_BLOCKED') {
        console.error('');
        console.error('⛔ ' + (e.gate?.message ?? e.message));
        console.error('   本插件不跟别的代理抢端口，这是设计如此。');
        console.error('     dsh-proxy peers          # 看看是哪个端口被占了');
        console.error('   想本次强行启动，加 --no-peer。');
        process.exit(4);
      }
      throw e;
    }
    core.startIdleWatcher();
    console.log(JSON.stringify({ ok: true, ...r, proxy: `http://127.0.0.1:${port}`, idleMs }, null, 2));
    if (!r.started && !r.external) log('info', '内核已在运行');
    if (opts.noWait) {
      // 只留给宿主或别的常驻进程接管；CLI 自己不管，内核可能一直不关
      log('warn', '--no-wait：本进程退出后不会再有人替你关内核');
    } else {
      log('info', `守着内核，空闲 ${Math.round(idleMs / 1000)} 秒后自动关闭（Ctrl+C 退出，内核交给宿主守护）`);
      await waitGone(true);
      log('info', '内核已按空闲策略自动关闭');
    }
    break;
  }
  case 'game': {
    // dsh-proxy game [--json] [--allow <名字或路径>] [--allow-fg] [--unallow <条目>]
    // 注意 rest[0] 是 'game' 本身，子命令在 rest[1]
    const sub = rest[1];
    if (sub === 'allow' || opts.allow || opts.allowFg) {
      const cur = settings.gameAllow ?? [];
      let entry = opts.allow ? String(opts.allow).trim() : '';
      if (!entry && opts.allowFg) {
        const d = await detectGames({ runtimeDir: RUNTIME, force: true, allow: cur });
        entry = d.fg?.name || d.fg?.path || '';
        if (!entry) { console.error('当前没有可加入白名单的前台程序'); process.exit(1); }
      }
      if (!entry && sub === 'allow') entry = String(rest[2] ?? '').trim();
      if (!entry) {
        console.error('用法：dsh-proxy game allow <进程名或完整路径>');
        console.error('  或：dsh-proxy game --allow-fg   （把当前前台程序加进来）');
        process.exit(1);
      }
      const lower = entry.toLowerCase();
      if (cur.some((x) => String(x).toLowerCase() === lower)) {
        console.log(`「${entry}」已在白名单里：${JSON.stringify(cur)}`);
        break;
      }
      const next = await writeSettings(RUNTIME, { gameAllow: [...cur, entry] });
      clearGameCache();
      console.log(`已把「${entry}」加进游戏检测白名单`);
      console.log(`  当前白名单：${JSON.stringify(next.gameAllow)}`);
      break;
    }
    if (sub === 'unallow' || opts.unallow) {
      const entry = String(opts.unallow ?? rest[2] ?? '').trim();
      if (!entry) { console.error('用法：dsh-proxy game unallow <条目>'); process.exit(1); }
      const cur = settings.gameAllow ?? [];
      const next = await writeSettings(RUNTIME, {
        gameAllow: cur.filter((x) => String(x).toLowerCase() !== entry.toLowerCase()),
      });
      clearGameCache();
      console.log(`已从白名单移除「${entry}」`);
      console.log(`  当前白名单：${JSON.stringify(next.gameAllow)}`);
      break;
    }
    if (sub === 'list') {
      const cur = settings.gameAllow ?? [];
      console.log(cur.length ? `白名单（${cur.length} 项）：` : '白名单为空（本插件不预置任何名单）');
      for (const x of cur) console.log(`  ${x}`);
      break;
    }

    const d = await detectGames({ runtimeDir: RUNTIME, force: true, allow: settings.gameAllow ?? [] });
    if (opts.json) { console.log(JSON.stringify(d, null, 2)); break; }
    console.log(`游戏检测：${d.gameRunning ? '⛔ 检测到游戏运行' : '✓ 没有检测到游戏'}`);
    console.log(`  系统状态：${d.qunsName ?? '-'}（QUNS ${d.quns ?? '-'}）`);
    console.log(`  探测：${d.probeOk ? `正常（${d.probeMs ?? '-'}ms）` : `不可用（${d.probeError ?? '未知'}）`}`);
    if (d.fg) console.log(`  前台程序：${d.fg.name || '未知'}${d.fg.path ? `  ${d.fg.path}` : ''}`);
    if (d.allowed) {
      console.log(`  白名单：当前前台程序命中（按${d.allowHit === 'path' ? '路径' : '名字'}），因此不拦`);
    }
    const curAllow = settings.gameAllow ?? [];
    console.log(`  白名单：${curAllow.length ? `${curAllow.length} 项` : '空（本插件不预置任何名单）'}`);
    if (d.gameRunning) console.log(`  原因：${describeHit(d)}`);
    console.log(`  判定用时：${d.ms}ms`);
    console.log('');
    console.log('  误判时：dsh-proxy game allow <进程名>   或   dsh-proxy game --allow-fg');
    break;
  }
  case 'peers': {
    // dsh-proxy peers [--json]
    const ownAlive = await core.ownCoreAlive();
    const d = await detectPeers({ ownPort: port, ownAlive, force: true });
    if (opts.json) { console.log(JSON.stringify({ ...d, ownAlive }, null, 2)); break; }
    console.log(`代理礼让：${d.peerRunning ? '⛔ 检测到其它代理在运行' : '✓ 没有检测到其它代理'}`);
    console.log(`  本插件端口：${port}${ownAlive ? '（本插件内核正在使用）' : ''}`);
    if (d.hits?.length) {
      for (const h of d.hits) console.log(`  占用：端口 ${h.port}${h.kind === 'own-port' ? '（本插件要用的端口）' : ''}`);
    }
    console.log(`  探测端口数：${d.probed}　用时：${d.ms}ms`);
    console.log(`  结论：${describePeer(d)}`);
    break;
  }
  case 'stop': {
    const r = await core.stop('manual');
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
    break;
  }
  case 'import-flclash': {
    const found = await findFlClashConfig();
    if (!found.found) { console.error('本机没有找到 FlClash 配置'); process.exit(1); }
    const r = await materialize(found.path, RUNTIME);
    await writeSettings(RUNTIME, { configSource: 'flclash', lastSyncAt: Date.now() });
    console.log(JSON.stringify({ ok: true, source: found.path, ...r, config: await configSummary(RUNTIME) }, null, 2));
    break;
  }
  case 'run': {
    // 显式形式：dsh-proxy run -- cmd
    await runCommand(rest.slice(1));
    break;
  }
  default: {
    if (rest.length > 0) await runCommand(rest);
    else {
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
    }
  }
}

// 探测是一个**常驻**子进程（见 lib/probe.js），它的 stdio 管道会让 Node
// 的事件循环一直非空 —— 不加这一句，`dsh-proxy game` 之类的短命令会跑完
// 却不退出，看起来像卡死。这里显式收掉探测进程再让脚本自然结束。
try { await disposeProbe(); } catch { /* 收不掉也不该影响退出码 */ }

async function runCommand(args) {
  if (!args.length) { console.error('缺少要执行的命令'); process.exit(1); }
  await prepare();
  let r;
  try {
    r = await core.ensureRunning();
  } catch (e) {
    if (e?.code === 'GAME_BLOCKED') {
      console.error('');
      console.error('⛔ ' + (e.gate?.message ?? e.message));
      console.error('   如果这是误判，先 dsh-proxy game 看看系统状态；加 --no-gate 可本次强行启用。');
      process.exit(3);
    }
    if (e?.code === 'PEER_BLOCKED') {
      console.error('');
      console.error('⛔ ' + (e.gate?.message ?? e.message));
      console.error('   先 dsh-proxy peers 看看是哪个端口被占了；加 --no-peer 可本次强行启用。');
      process.exit(4);
    }
    throw e;
  }
  core.startIdleWatcher();
  if (r.started) log('info', `内核已启动（pid=${r.pid}, ${r.ms}ms）`);
  else if (r.external) log('info', `${port} 端口已被其他程序占用，直接复用`);
  else log('info', '内核已在运行');

  const proxy = `http://127.0.0.1:${port}`;
  // 命令跑着的时候必须持续续租 + 持忙锁：否则只要命令耗时超过 idleMs，
  // 守护就会以为"没人用了"而把内核杀掉，命令中途被掐断（表现为连接被重置）。
  await core.acquireBusy();
  // Ctrl+C / 被 kill：别把忙锁留下，否则要等到下次启动才发现持有者已死
  const cleanup = () => { clearInterval(keepAlive); void core.releaseBusy(); };
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  const keepAlive = setInterval(() => { void core.renew(); }, Math.max(1000, Math.min(15000, Math.floor(idleMs / 2) || 15000)));
  const child = spawn(args[0], args.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      // 本地与内网不走代理，否则连本机服务会被绕一圈
      NO_PROXY: 'localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*',
      DSH_PROXY_ACTIVE: '1',
    },
    shell: process.platform === 'win32',
  });

  const code = await new Promise((res) => child.on('exit', (c) => res(c ?? 0)));
  clearInterval(keepAlive);
  // 命令结束：先摘忙锁，再续一次租约，让"用完"从这一刻开始计时
  await core.releaseBusy();
  await core.renew();
  if (idleMs === 0) {
    await core.stop('manual');
    log('info', '命令结束，内核已关闭');
    process.exit(code);
  }
  log('info', `命令结束（退出码 ${code}），内核将在空闲 ${Math.round(idleMs / 1000)} 秒后自动关闭`);
  // 守护定时器是 unref() 的：这里直接退出的话没人执行"到期杀内核"。
  // 守着直到真的关掉，才不违背"用完自动关"这个承诺。
  if (await waitGone(false)) log('info', '内核已按空闲策略自动关闭');
  else log('warn', '等待空闲关闭超时，内核可能仍在运行');
  process.exit(code);
}

function format(o) {
  const lines = [
    `运行时目录 : ${o.runtime}`,
    `端口       : ${o.port}`,
    `空闲自动关 : ${Math.round(o.idleMs / 1000)} 秒`,
    `内核状态   : ${o.coreAlive ? `运行中（pid ${o.pid}）` : (o.portUp ? '端口被其他程序占用' : '未运行')}`,
    `剩余计时   : ${o.remainingMs > 0 ? Math.ceil(o.remainingMs / 1000) + ' 秒' : '-'}`,
  ];
  if (o.config?.exists) {
    lines.push(`配置       : ${o.config.nodeCount} 个节点，${o.config.ruleCount} 条规则`);
  } else {
    lines.push('配置       : 尚未准备（运行 prepare 或 import-flclash）');
  }
  return lines.join('\n');
}

const USAGE = `
dsh-proxy-on-demand —— 按需代理

  dsh-proxy status                     查看状态
  dsh-proxy prepare                    下载内核并准备配置
  dsh-proxy start                      启动内核（空闲后自动关）
  dsh-proxy stop                       立即关闭内核
  dsh-proxy import-flclash             从本机 FlClash 导入配置
  dsh-proxy game                       查看游戏检测结果（系统状态 + 前台程序）
  dsh-proxy game list                  列出游戏检测白名单
  dsh-proxy game allow <名字或路径>     把程序加进白名单（误判时用）
  dsh-proxy game unallow <条目>         从白名单移除
  dsh-proxy peers                      查看是否有其它代理在运行（端口占用）
  dsh-proxy -- <命令> [参数...]         带着代理跑一条命令

选项：
  --idle <秒>   空闲多久自动关（0 = 命令结束立刻关）
  --port <端口> 覆盖代理端口
  --no-wait     配合 start：立刻返回，不守着内核
  --no-gate     本次跳过游戏检测（游戏运行时也强行启用）
  --no-peer     本次跳过礼让检测（别的代理在跑也强行启用）
  --allow-fg    把当前前台程序加进游戏白名单
  --json        以 JSON 输出

环境变量：
  DSH_PROXY_RUNTIME  覆盖运行时目录（默认 <插件>/runtime）
`;
