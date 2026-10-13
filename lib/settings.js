/**
 * 用户设置与订阅管理。
 *
 * 用途：dsh-proxy-on-demand 的设置侧 —— 开关 / 端口 / 空闲时长 / 订阅地址，
 *       以及「填订阅」「手填配置」这两条生成内核配置的路径。
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 *       （本文件生成的 config.yaml 就是喂给它的）
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；只用 Node 内建模块。
 * 自用免责：按「原样」提供、无担保；节点/订阅的来源与合法性由使用者自负。
 * 联网说明：只有 applySubscription() 会去拉订阅地址，其余函数只碰本地文件。
 *
 * 与 mihomo 的 config.yaml 分开存：
 *   settings.json —— 本插件的开关/端口/空闲时间/订阅地址（界面读写这个）
 *   config.yaml   —— 真正喂给内核的配置（由订阅或导入生成）
 *
 * 这样界面上的「填节点」不会和内核配置互相踩，也让"从 FlClash 导入"
 * 与"填订阅链接"两条路能共存、可切换。
 */

import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { GAME_DEFAULTS } from './games.js';
import { PEER_DEFAULTS } from './peers.js';
import { forceExternalController } from './config.js';

export const SETTINGS_DEFAULTS = {
  enabled: true,
  port: 7890,
  idleMs: 120000,
  /** 订阅地址（填了就优先用它拉配置）。 */
  subscriptionUrl: '',
  /** 订阅更新间隔（毫秒）；0 = 不自动更新。 */
  subscriptionIntervalMs: 0,
  /** 是否允许首次自动从本机 FlClash 导入。 */
  autoImportFlClash: true,
  /** 配置来源：subscription | flclash | manual | example */
  configSource: '',
  /** 最后一次同步时间。 */
  lastSyncAt: null,
  /** 最后一次同步结果说明。 */
  lastSyncNote: '',
  // ── 游戏检测闸门（见 games.js）──
  /** 检测到游戏运行时禁止启用代理。 */
  blockOnGame: GAME_DEFAULTS.blockOnGame,
  /** 检测到游戏运行时，把已经在跑的内核也一并关掉（默认关，见 GAME_DEFAULTS）。 */
  stopOnGame: GAME_DEFAULTS.stopOnGame,
  /**
   * 用户白名单：这些程序在前台时不算"游戏"（默认空，由用户自己填）。
   * 裸名字按进程名比对，含路径的按全路径比对。
   */
  gameAllow: GAME_DEFAULTS.gameAllow,
  // ── 礼让闸门（见 peers.js）──
  /** 检测到其它代理正在运行（常见代理端口有人监听）时，本插件不启动自己的内核。 */
  yieldToPeer: PEER_DEFAULTS.yieldToPeer,
  // ── 系统代理联动（见 systemproxy.js）──
  /**
   * 内核起来时把 Windows 系统代理一起打开、内核关掉时精确还原。
   *
   * 默认 **true**：这就是「按需代理」的最后一公里 —— 之前内核起来了端口在听，
   * 浏览器却仍直连，GitHub 照样打不开（用户实测 `ERR_CONNECTION_RESET`）。
   * 用户明确要求"开内核就连带开系统代理"（2026-10-13）。
   *
   * 关掉它的场景：用户自己用 FlClash 管着系统代理、只想让本插件提供额外端口。
   * 另外即使开着，检测到系统代理已被别的程序占用时也会**静默让路**，不抢。
   */
  systemProxy: true,
  /**
   * 内核是否常驻（不因空闲而关）。
   *
   * 默认 **false** —— 也就是「用完了自己关掉」，这是本插件从一开始就有的
   * 核心行为（见 core.js 文件头）。用户 2026-10-13 明确问过
   * 「完成任务自动关为什么删？不是有个开关吗？」——
   * 我先前把它默认改成 true 并把倒计时/续期藏了起来，等于**悄悄删掉了这个功能**，
   * 那是错的。现在恢复原默认，常驻只作为**可选开关**保留给想省启动等待的人。
   */
  resident: false,
  /**
   * 启动内核时是否自动打开系统代理（用户手动按的开关见 /system-proxy）。
   *
   * 默认 true —— 否则用户点了「启动」却发现浏览器还是打不开 GitHub，
   * 会以为插件坏了。
   */
  proxyOnStart: true,
};

export function settingsPath(runtimeDir) {
  return join(runtimeDir, 'settings.json');
}

/**
 * 把任意输入整理成字符串数组：只接受数组、去空、按小写去重、限 200 项。
 *
 * 限长是因为 settings.json 是用户可手改的纯文本，界面也是直接 POST 进来；
 * 不做约束的话一次误操作就能把设置文件写到几十兆，之后每次读设置都变慢。
 */
function strList(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of v) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 200) break;
  }
  return out;
}

export async function readSettings(runtimeDir) {
  try {
    const raw = await fsp.readFile(settingsPath(runtimeDir), 'utf8');
    const j = JSON.parse(raw);
    return { ...SETTINGS_DEFAULTS, ...j };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

export async function writeSettings(runtimeDir, patch) {
  const cur = await readSettings(runtimeDir);
  // 只接受已知键，避免界面把任意内容写进来
  const next = { ...cur };
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  // 归一化
  next.port = Number(next.port) || 7890;
  next.idleMs = Math.max(10000, Number(next.idleMs) || 120000);
  next.subscriptionUrl = String(next.subscriptionUrl ?? '').trim();
  next.enabled = Boolean(next.enabled);
  // blockOnGame 默认开（只有显式 false 才关）；stopOnGame 默认关（只有显式 true 才开）
  next.blockOnGame = next.blockOnGame !== false;
  next.stopOnGame = next.stopOnGame === true;
  // 白名单只收数组、去空、去重（按小写判重）、限 200 项 —— 防止设置文件被写爆
  next.gameAllow = strList(next.gameAllow);
  // yieldToPeer 默认开（只有显式 false 才关）
  next.yieldToPeer = next.yieldToPeer !== false;
  await fsp.mkdir(runtimeDir, { recursive: true });
  await fsp.writeFile(settingsPath(runtimeDir), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 下载订阅内容并写成内核配置。
 *
 * 订阅返回的就是一份 Clash/mihomo YAML，所以直接落盘即可 —— 但**要先走一遍
 * 路径改写**（rule-provider 可能是绝对路径），否则内核启动会被 SAFE_PATHS 拦下。
 */
export async function applySubscription(runtimeDir, url, { timeoutMs = 60000, controllerPort, controllerSecret } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('订阅地址必须是 http(s)');
  const text = await fetchText(url, timeoutMs);
  if (!/^\s*(mixed-port|port|proxies|proxy-providers|proxy-groups|rules)\s*:/m.test(text)) {
    throw new Error('订阅返回的内容不像 Clash/mihomo 配置（缺少 mixed-port/proxies/rules 等字段）');
  }
  let body = normalizePaths(text, runtimeDir);
  // 与 materialize 同样处理：订阅里 external-controller 常是空的，
  // 不打开就永远读不到节点列表（见 config.js 的 forceExternalController）。
  if (Number.isInteger(controllerPort) && controllerPort > 0) {
    body = forceExternalController(body, controllerPort, controllerSecret ?? '').text;
  }
  const out = join(runtimeDir, 'config.yaml');
  await fsp.mkdir(runtimeDir, { recursive: true });
  await fsp.writeFile(out, body, 'utf8');
  return { bytes: text.length, file: out, nodeCount: countProxies(text) };
}

/**
 * 统计 `proxies:` 段里的节点数（用于界面显示「N 个节点」）。
 *
 * ## 为什么不能只看「`- ` 后面紧跟 `name:`」（2026-10-13 实测事故）
 *
 * 原实现只认三种行首形态：`- name:`、`- {`、光秃秃的 `- `。而 **mihomo 与
 * FlClash 写出来的都是「规范化输出」**：每个节点的键按字母序重排，于是
 * `hop-interval` 排在 `name` 前面，列表项以 `- hop-interval:` 开头：
 *
 * ```yaml
 * proxies:
 *   - hop-interval: 30
 *     max-connection-receive-window: 83886080
 *     name: "悦·🇭🇰香港1 · A"        # ← name 不在行首，三种模式全部失配
 * ```
 *
 * 结果：**节点确实导入了（config.yaml 里 143 个），但计数恒为 0**，
 * 界面显示「当前配置：0 个节点」——用户看到的就是「节点根本导入不进去」。
 * 本机实测：`runtime/config.yaml` 与 FlClash 的 `config.yaml` **双双返回 0**。
 *
 * 修法：按 **YAML 列表语义**数，而不是按行首关键字数 ——
 * 找出 `proxies:` 段，再数缩进 2 空格（或更浅）的列表项起始行（`- `）。
 * 这样无论键序如何、无论节点是流式 `{...}` 还是块式，都能数对。
 *
 * @param text - 一份 Clash/mihomo 配置文本。
 * @returns 节点数；找不到 `proxies:` 段时返回 0。
 */
export function countProxies(text) {
  if (typeof text !== 'string') return 0;

  // 1. 定位 `proxies:` 段（允许行尾有注释/空白）。
  const m = text.match(/^proxies:[ \t]*(?:#.*)?$/m);
  if (!m) return 0;

  // 2. 取到下一个顶层键（行首无缩进的 `key:`）为止。
  const after = text.slice(m.index + m[0].length);
  const stop = after.search(/^\S/m);
  const block = stop >= 0 ? after.slice(0, stop) : after;

  // 3. 数列表项：`proxies:` 下的条目缩进固定为 2 空格（mihomo 的输出风格），
  //    但也容忍更多缩进 —— 关键是「同一层」的 `- ` 起始行各算一个。
  const items = block.match(/^\s*-\s+\S/gm) || [];
  if (items.length > 0) return items.length;

  // 4. 兜底：空列表或纯 `- ` 行（`proxies:\n  - \n` 这种畸形写法）。
  return (block.match(/^\s*-\s*$/gm) || []).length;
}

/** 把配置里的绝对路径改写为相对路径（并尽量拷贝依赖文件）。 */
export function normalizePaths(text, runtimeDir) {
  // 见 config.js 的注释：YAML 里是双反斜杠，正则必须两种都认
  const SEP = '\\\\\\\\?';
  const re = new RegExp(
    `([A-Za-z]:${SEP}(?:[^\\r\\n"'#]*?${SEP})?providers${SEP}(?:[^\\r\\n"'#]*?${SEP})?)rules${SEP}([0-9a-fA-F]{8,})`,
    'g',
  );
  let out = text;
  for (const m of text.matchAll(re)) {
    out = out.split(m[0]).join(`providers/rules/${m[2]}`);
  }
  return out;
}

/** 带超时的取文本（走系统代理环境变量，若设置了的话）。 */
async function fetchText(url, timeoutMs) {
  const https = await import('node:https');
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'dsh-proxy-on-demand' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).href, timeoutMs));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`订阅下载失败 HTTP ${res.statusCode}`)); return; }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('订阅下载超时')); });
  });
}

/** 手动写入一份配置文本（界面里"粘贴配置"用）。 */
export async function writeManualConfig(runtimeDir, text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('配置内容为空');
  if (!/^\s*(mixed-port|port|proxies|proxy-groups|rules)\s*:/m.test(text)) {
    throw new Error('这不像一份 Clash/mihomo 配置');
  }
  await fsp.mkdir(runtimeDir, { recursive: true });
  const out = join(runtimeDir, 'config.yaml');
  await fsp.writeFile(out, normalizePaths(text, runtimeDir), 'utf8');
  return { bytes: text.length, file: out, nodeCount: countProxies(text) };
}

/** 当前配置概况（界面显示用）。 */
export async function configSummary(runtimeDir) {
  const p = join(runtimeDir, 'config.yaml');
  if (!existsSync(p)) return { exists: false };
  try {
    const t = await fsp.readFile(p, 'utf8');
    const port = t.match(/^mixed-port:\s*(\d+)/m)?.[1] ?? null;
    return {
      exists: true,
      bytes: t.length,
      port: port ? Number(port) : null,
      nodeCount: countProxies(t),
      ruleCount: countRules(t),
      mtime: (await fsp.stat(p)).mtimeMs,
    };
  } catch (e) {
    return { exists: false, error: String(e?.message ?? e) };
  }
}

/**
 * 统计 `rules:` 段里的规则条数。
 *
 * 与 `countProxies` 同一族的坑（2026-10-13 一起修的）：原实现是
 * `/^\s*-\s*(DOMAIN|IP-CIDR|…)/`，要求 `- ` 后面**直接**跟规则类型。
 * 但 mihomo / FlClash 规范化输出会把规则**加引号**：
 *
 * ```yaml
 * rules:
 *   - "DOMAIN-SUFFIX,zoom.com.cn,DIRECT"      # ← 引号挡住了正则
 *   - "AND,((NETWORK,UDP),(DST-PORT,443)),REJECT"
 * ```
 *
 * 于是 `ruleCount` 恒为 0，而 `settings.json` 里写着「已从 FlClash 导入
 * （规则 44 条）」—— 界面与记录自相矛盾。
 *
 * 修法：允许条目两侧有引号，并覆盖 mihomo 的全部规则类型（含逻辑组合
 * `AND`/`OR`/`NOT` 与 `RULE-SET`/`PROCESS-NAME` 等）。
 *
 * @param text - 一份 Clash/mihomo 配置文本。
 * @returns 规则条数；找不到 `rules:` 段时返回 0。
 */
export function countRules(text) {
  if (typeof text !== 'string') return 0;
  const m = text.match(/^rules:[ \t]*(?:#.*)?$/m);
  if (!m) return 0;
  const after = text.slice(m.index + m[0].length);
  const stop = after.search(/^\S/m);
  const block = stop >= 0 ? after.slice(0, stop) : after;

  const TYPES =
    'DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|DOMAIN-REGEX|GEOSITE|GEOIP|IP-CIDR|IP-CIDR6|IP-SUFFIX|IP-ASN|' +
    'SRC-GEOIP|SRC-IP-CIDR|SRC-PORT|DST-PORT|IN-PORT|IN-TYPE|IN-USER|IN-NAME|PROCESS-PATH|PROCESS-PATH-REGEX|' +
    'PROCESS-NAME|PROCESS-NAME-REGEX|UID|NETWORK|DSCP|RULE-SET|AND|OR|NOT|MATCH|SUB-RULE';
  // 条目形态：`- "TYPE,..."` / `- TYPE,...` / `- 'TYPE,...'`
  const re = new RegExp(`^\\s*-\\s*["']?(?:${TYPES})\\b`, 'gmi');
  return (block.match(re) || []).length;
}
