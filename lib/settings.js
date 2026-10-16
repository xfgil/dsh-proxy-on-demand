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
 *   settings.state —— 本插件的开关/端口/空闲时间/订阅地址（界面读写这个）
 *   config.yaml   —— 真正喂给内核的配置（由订阅或导入生成）
 *
 * 这样界面上的「填节点」不会和内核配置互相踩，也让"从 FlClash 导入"
 * 与"填订阅链接"两条路能共存、可切换。
 */

import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { forceDnsPort, forceExternalController, forceMixedPort } from './config.js';

export const SETTINGS_DEFAULTS = {
  enabled: true,
  /**
   * 自己的内核监听哪个端口。
   *
   * ⚠️ **故意不是 7890**（2026-10-16 改）：7890 是 FlClash / Clash 系的默认端口，
   * 本插件过去也用它，于是「插件内核先起 → 占住 7890 → FlClash 内核起不来」。
   * 详见 core.js 的 DEFAULTS.port 注释。
   *
   * 注：本机已经有代理在跑时（FlClash / Clash Verge / v2rayN …）本插件**根本
   * 不启动自己的内核**，直接借道对方的端口 —— 所以这个值大部分时候用不上。
   */
  port: 7899,
  idleMs: 120000,
  /** 订阅地址（填了就优先用它拉配置）。 */
  subscriptionUrl: '',
  /** 是否允许首次自动从本机 FlClash 导入。 */
  autoImportFlClash: true,
  /** 配置来源：subscription | flclash | manual | example */
  configSource: '',
  /** 最后一次同步时间。 */
  lastSyncAt: null,
  /** 最后一次同步结果说明。 */
  lastSyncNote: '',
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
};

/**
 * 设置文件名。
 *
 * ⚠️ **不能用 `.json` 扩展名**：宿主监视插件目录，实测只有 `.json` 会触发热重载
 * （2026-10-14 的 21 种扩展名矩阵），于是「改个设置 → 插件重建」——
 * 设置要重启才生效、旧实例还会在 dispose 里做多余的事。
 * 详见 `core.js` 里 `pidPath` 附近的说明。
 *
 * `LEGACY_SUFFIX` 是旧版本用的名字；启动时 `migrateStateFiles()` 会把它 rename
 * 过来（见 `lib/index.js`），这里只是让「万一还没迁移」时也读得到。
 */
export function settingsPath(runtimeDir) {
  return join(runtimeDir, 'settings.state');
}

/** 旧版本的设置文件名（迁移用）。 */
export function legacySettingsPath(runtimeDir) {
  return join(runtimeDir, 'settings.json');
}

export async function readSettings(runtimeDir) {
  // 先读新名 `settings.state`；读不到再读旧版 `settings.json` —— 兼容「刚升级、
  // 迁移还没跑」的那一次读取。旧文件留着还会触发热重载，所以迁移是必须的，
  // 这里只是别让用户在那之前丢掉自己的设置。
  for (const p of [settingsPath(runtimeDir), legacySettingsPath(runtimeDir)]) {
    try {
      const raw = await fsp.readFile(p, 'utf8');
      const j = JSON.parse(raw);
      // ⚠️ 只认 SETTINGS_DEFAULTS 里声明过的键，别用 `{...DEFAULTS, ...j}` 全量展开。
      //
      // 2026-10-13 吃过这个亏：我把 `resident` 的默认值从 true 改回 false（恢复
      // 用户要的「用完自动关」），但**上一版自己写进 settings.json 的
      // `resident: true` 还在文件里** —— 展开后它原样盖掉了新默认值，
      // 等于我的改动完全没生效，而界面上看起来"设置是对的"。
      // `pauseProxyOnGame` 同理：这个键已经从 SETTINGS_DEFAULTS 删掉了，
      // 但文件里还留着，全量展开会让它一直阴魂不散。
      //
      // 白名单过滤能同时解决两件事：被删掉的键自动消失，
      // 未知键不会污染内存里的设置对象。
      const out = { ...SETTINGS_DEFAULTS };
      for (const k of Object.keys(SETTINGS_DEFAULTS)) {
        if (j[k] !== undefined) out[k] = j[k];
      }
      // ── 端口迁移：7890 → 7899（2026-10-16）─────────────────────────────
      //
      // 7890 是 FlClash / Clash 系的默认混合端口。旧版本的默认值就是它，
      // 于是**每个老用户的 settings.state 里都存着 7890** —— 白名单过滤会
      // 忠实地把它读进来，结果端口隔离白做：插件照旧和 FlClash 抢 7890，
      // 用户报的「插件一代理，FlClash 内核就连不上」原样复现。
      //
      // 升级规则：**等于旧默认值 7890 的一律迁到 7899**。用户如果真手动
      // 填过 7890，那也是要避开的那个值，一起迁走没有坏处。
      // 幂等：迁完再读就命不中了。落盘靠下一次 writeSettings()。
      if (Number(out.port) === 7890) out.port = 7899;
      return out;
    } catch {
      /* 试下一个 */
    }
  }
  return { ...SETTINGS_DEFAULTS };
}

export async function writeSettings(runtimeDir, patch) {
  const cur = await readSettings(runtimeDir);
  // 只接受已知键，避免界面把任意内容写进来
  const next = { ...cur };
  for (const k of Object.keys(SETTINGS_DEFAULTS)) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  // 归一化
  next.port = Number(next.port) || 7899;
  next.idleMs = Math.max(10000, Number(next.idleMs) || 120000);
  next.subscriptionUrl = String(next.subscriptionUrl ?? '').trim();
  next.enabled = Boolean(next.enabled);
  await fsp.mkdir(runtimeDir, { recursive: true });
  await fsp.writeFile(settingsPath(runtimeDir), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 下载订阅内容并写成内核配置。
 *
 * 订阅返回的就是一份 Clash/mihomo YAML，所以直接落盘即可 —— 但**要先走一遍
 * 路径改写**（rule-provider 可能是绝对路径），否则内核启动会被 SAFE_PATHS 拦下。
 *
 * ⚠️ 这条路径与 `materialize()` 是**并列的两条写配置入口**，所以 materialize
 * 做的修补这里也得做一遍 —— 2026-10-13 就漏过一次：只补了管理 API，忘了
 * DNS 端口，于是走订阅导入的用户会撞上「1053 被 FlClash 占着 → DNS 起不来
 * → 测速全超时」。加新修补时记得两边一起加。
 */
export async function applySubscription(runtimeDir, url, { timeoutMs = 60000, controllerPort, controllerSecret, port } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('订阅地址必须是 http(s)');
  const text = await fetchText(url, timeoutMs);
  if (!/^\s*(mixed-port|port|proxies|proxy-providers|proxy-groups|rules)\s*:/m.test(text)) {
    throw new Error('订阅返回的内容不像 Clash/mihomo 配置（缺少 mixed-port/proxies/rules 等字段）');
  }
  let body = normalizePaths(text, runtimeDir);
  // 与 materialize 同样处理其一：别撞 DNS 端口（见 config.js 的 forceDnsPort）。
  // ⚠️ 必须 await —— 漏掉的话 `.text` 是 undefined，整份配置会变成垃圾。
  const dnsFix = await forceDnsPort(body);
  body = dnsFix.text;
  // 与 materialize 同样处理其二：订阅里的 mixed-port 多半也是 7890（机场模板
  // 的惯例），照抄会和 FlClash 抢端口 —— 换到插件自己的端口上。
  const portFix = forceMixedPort(body, port);
  body = portFix.text;
  // 与 materialize 同样处理其三：订阅里 external-controller 常是空的，
  // 不打开就永远读不到节点列表（见 config.js 的 forceExternalController）。
  if (Number.isInteger(controllerPort) && controllerPort > 0) {
    body = forceExternalController(body, controllerPort, controllerSecret ?? '').text;
  }
  const out = join(runtimeDir, 'config.yaml');
  await fsp.mkdir(runtimeDir, { recursive: true });
  await fsp.writeFile(out, body, 'utf8');
  return {
    bytes: text.length,
    file: out,
    nodeCount: countProxies(text),
    dnsPort: dnsFix.port,
    proxyPort: Number.isInteger(port) && port > 0 ? port : null,
    portChangedFrom: portFix.changed ? portFix.from : null,
  };
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

/**
 * 手动写入一份配置文本（界面里"粘贴配置"用）。
 *
 * 与 `applySubscription` 一致：**路径改写 + 换掉 mixed-port + 避开 DNS 端口
 * 冲突**，不碰用户的测速目标。（手贴的通常是同一份机场配置，`dns.listen` 默认
 * 1053、`mixed-port` 默认 7890，而这两样 FlClash 都占着 —— 不修就是「内核能
 * 起来但什么都连不上」，或者干脆把 FlClash 的内核顶掉。）
 */
export async function writeManualConfig(runtimeDir, text, { port } = {}) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('配置内容为空');
  if (!/^\s*(mixed-port|port|proxies|proxy-groups|rules)\s*:/m.test(text)) {
    throw new Error('这不像一份 Clash/mihomo 配置');
  }
  await fsp.mkdir(runtimeDir, { recursive: true });
  // ⚠️ 必须 await —— 漏掉的话 `.text` 是 undefined，整份配置会变成垃圾。
  const dnsFix = await forceDnsPort(normalizePaths(text, runtimeDir));
  const portFix = forceMixedPort(dnsFix.text, port);
  const out = join(runtimeDir, 'config.yaml');
  await fsp.writeFile(out, portFix.text, 'utf8');
  return {
    bytes: text.length,
    file: out,
    nodeCount: countProxies(text),
    dnsPort: dnsFix.port,
    proxyPort: Number.isInteger(port) && port > 0 ? port : null,
    portChangedFrom: portFix.changed ? portFix.from : null,
  };
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
 * 于是 `ruleCount` 恒为 0，而 `settings.state` 里写着「已从 FlClash 导入
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
