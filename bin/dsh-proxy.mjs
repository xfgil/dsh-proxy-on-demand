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

const core = new ProxyCore({
  dir: RUNTIME, exe: 'mihomo.exe', config: 'config.yaml',
  port, idleMs, log,
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
    const r = await core.ensureRunning();
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

async function runCommand(args) {
  if (!args.length) { console.error('缺少要执行的命令'); process.exit(1); }
  await prepare();
  const r = await core.ensureRunning();
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
  dsh-proxy -- <命令> [参数...]         带着代理跑一条命令

选项：
  --idle <秒>   空闲多久自动关（0 = 命令结束立刻关）
  --port <端口> 覆盖代理端口
  --no-wait     配合 start：立刻返回，不守着内核
  --json        以 JSON 输出

环境变量：
  DSH_PROXY_RUNTIME  覆盖运行时目录（默认 <插件>/runtime）
`;
