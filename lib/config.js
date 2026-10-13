/**
 * 配置准备：把 mihomo 配置放到本插件的 runtime 目录，并处理两个必踩的坑。
 *
 * 用途：dsh-proxy-on-demand 的配置侧 —— 把 FlClash / 订阅 / 手填的 mihomo 配置
 *       整理成内核能直接吃的形式（规则文件落位 + 绝对路径改相对）。
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；本文件只用 Node 内建模块。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 * 本文件不联网、不下载任何东西（下载见 downloader.js）。
 *
 * 坑 1 — SAFE_PATHS 沙盒
 *   mihomo 只允许访问 `-d` 目录内的**相对路径**。而 FlClash 的 config.yaml
 *   里 rule-provider 的 path 是绝对路径：
 *     C:\Users\<user>\AppData\Roaming\com.follow\clash\profiles\providers\...\rules\xxx
 *   直接启动会 fatal:
 *     Parse config error: path is not subpath of home directory or SAFE_PATHS
 *   修法：把这些规则文件拷进 runtime/providers/rules/，再把路径改成相对形式。
 *
 * 坑 2 — YAML 里是**双反斜杠**
 *   文件里写作 `C:\\Users\\暝\\...`。若按单反斜杠去 -replace，会**静默不匹配**，
 *   而且此时再查询"还剩几个单反斜杠"同样是 0 —— 造成"已经改好了"的假象。
 *   必须按字面的双反斜杠匹配。这个坑我踩过一次，代价是误判成功。
 */

import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** FlClash 在本机的配置目录（Windows）。可配置覆盖。 */
const FLCLASH_DIRS = [
  'com.follow\\clash',
  'com.follow.clash',
];

export function defaultFlClashDir(home) {
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  return join(appData, 'com.follow', 'clash');
}

/**
 * 把一份 mihomo 配置整理到目标目录。
 *
 * @param {string} srcFile 源 config.yaml
 * @param {string} outDir  目标 runtime 目录
 * @returns 改动统计
 */
export async function materialize(srcFile, outDir) {
  const srcDir = dirname(resolve(srcFile));
  let text = await fsp.readFile(srcFile, 'utf8');

  await fsp.mkdir(join(outDir, 'providers', 'rules'), { recursive: true });

  // 找出所有 rule-provider 的绝对路径。
  //
  // 关键：YAML 里写作**双反斜杠**（`C:\\Users\\暝\\...`），而下面还要按同样形式
  // 替换回去。这里用 `\\\\?` 让每个分隔符既接受单反斜杠也接受双反斜杠，
  // 并保证同一条路径内形式一致。踩过一次：只按单反斜杠写正则 → 匹配 0 条，
  // 而"'还剩几个单反斜杠'"也返回 0，看起来像成功，其实是假象。
  const SEP = '\\\\\\\\?'; // 正则里匹配一个或两个字面反斜杠
  const absRe = new RegExp(
    `([A-Za-z]:${SEP}(?:[^\\r\\n"'#]*?${SEP})?providers${SEP}(?:[^\\r\\n"'#]*?${SEP})?)rules${SEP}([0-9a-fA-F]{8,})`,
    'g',
  );
  const found = new Map(); // absPath -> {file, relForm}
  for (const m of text.matchAll(absRe)) {
    const abs = m[0];          // 保留文件中的原样形式（含双反斜杠）
    const file = m[2];
    found.set(abs, { file });
  }

  let copied = 0;
  const missing = [];
  for (const [abs, info] of found) {
    const dst = join(outDir, 'providers', 'rules', info.file);
    if (!existsSync(dst)) {
      try {
        // 拷贝要用**真实路径**：把 YAML 里的双反斜杠还原成单反斜杠
        const real = abs.replace(/\\\\/g, '\\');
        await fsp.copyFile(real, dst);
        copied += 1;
      } catch {
        missing.push(info.file);
      }
    }
    // 替换用文件中**原样出现的形式**（通常是双反斜杠），两种都兜一遍
    text = text.split(abs).join(`providers/rules/${info.file}`);
    const alt = abs.includes('\\\\') ? abs.replace(/\\\\/g, '\\') : abs.replace(/\\/g, '\\\\');
    if (alt !== abs) text = text.split(alt).join(`providers/rules/${info.file}`);
  }

  // 顺带修 DNS 端口冲突：FlClash 与本机其它服务都可能占 1053
  const conflict = [];
  const dnsListen = text.match(/listen:\s*"?([0-9.]+):(\d+)"?/);
  if (dnsListen) conflict.push({ key: 'dns.listen', value: dnsListen[0] });

  const outFile = join(outDir, 'config.yaml');
  await fsp.writeFile(outFile, text, 'utf8');

  return {
    outFile,
    rulesTotal: found.size,
    copied,
    missing,
    warnings: conflict,
  };
}

/**
 * 从本机 FlClash 配置目录导入（若存在）。
 * @returns {{found:boolean, path?:string}}
 */
export async function findFlClashConfig(extraDir) {
  const candidates = [extraDir, defaultFlClashDir(process.env.USERPROFILE || process.env.HOME || '')]
    .filter(Boolean)
    .flatMap((d) => [join(d, 'config.yaml'), ...FLCLASH_DIRS.map((s) => join(d, s, 'config.yaml'))]);
  for (const c of candidates) {
    if (existsSync(c)) return { found: true, path: c };
  }
  return { found: false };
}

/** 生成一个最小可用模板（没有任何节点，用户自己填）。 */
export function exampleConfig(port = 7890) {
  return `# dsh-proxy-on-demand 配置模板
# 把你的订阅内容填到 proxies / proxy-providers 里即可。
# 不想手写的话：把本机 FlClash 的 config.yaml 复制到同目录，
# 或调用 PUT /dsh-proxy/import-from-flclash 让插件自动导入。

mixed-port: ${port}
allow-lan: false
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:9090

dns:
  enable: true
  listen: 127.0.0.1:1053
  enhanced-mode: fake-ip
  nameserver:
    - https://doh.pub/dns-query
    - https://dns.alidns.com/dns-query

proxies:
  # - name: "我的节点"
  #   type: ss
  #   server: 1.2.3.4
  #   port: 8388
  #   cipher: aes-128-gcm
  #   password: "xxxx"

proxy-groups:
  # - name: "PROXY"
  #   type: select
  #   proxies: ["我的节点"]

rules:
  - MATCH,DIRECT
`;
}
