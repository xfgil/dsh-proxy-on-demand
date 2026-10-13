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
};

export function settingsPath(runtimeDir) {
  return join(runtimeDir, 'settings.json');
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
export async function applySubscription(runtimeDir, url, { timeoutMs = 60000 } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('订阅地址必须是 http(s)');
  const text = await fetchText(url, timeoutMs);
  if (!/^\s*(mixed-port|port|proxies|proxy-providers|proxy-groups|rules)\s*:/m.test(text)) {
    throw new Error('订阅返回的内容不像 Clash/mihomo 配置（缺少 mixed-port/proxies/rules 等字段）');
  }
  const out = join(runtimeDir, 'config.yaml');
  await fsp.mkdir(runtimeDir, { recursive: true });
  await fsp.writeFile(out, normalizePaths(text, runtimeDir), 'utf8');
  return { bytes: text.length, file: out, nodeCount: countProxies(text) };
}

/** 统计节点数（用于界面显示"识别到 N 个节点"）。 */
export function countProxies(text) {
  const m = text.match(/^proxies:\s*$/m);
  if (!m) return 0;
  const after = text.slice(m.index + m[0].length);
  const stop = after.search(/^\S/m);
  const block = stop >= 0 ? after.slice(0, stop) : after;
  return (block.match(/^\s*-\s+name\s*:/gm) || []).length
    || (block.match(/^\s*-\s*\{/gm) || []).length
    || (block.match(/^\s*-\s*$/gm) || []).length;
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
      ruleCount: (t.match(/^\s*-\s*(DOMAIN|IP-CIDR|GEOIP|GEOSITE|MATCH|PROCESS)/gm) || []).length,
      mtime: (await fsp.stat(p)).mtimeMs,
    };
  } catch (e) {
    return { exists: false, error: String(e?.message ?? e) };
  }
}
