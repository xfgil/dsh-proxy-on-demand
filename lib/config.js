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
import net from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_TEST_URL } from './nodes.js';

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
export async function materialize(srcFile, outDir, { controllerPort, controllerSecret } = {}) {
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

  // 顺带修 DNS 端口冲突：FlClash 与本机其它服务都可能占 1053。
  // 这一步是**必须的**：DNS 起不来 → 域名解析不了 → 所有节点测速全部超时
  // （2026-10-13 实测：1053 被 FlClashCore 占着，143 个节点全报超时）。
  const conflict = [];
  const dnsListen = text.match(/listen:\s*"?([0-9.]+):(\d+)"?/);
  if (dnsListen) conflict.push({ key: 'dns.listen', value: dnsListen[0] });
  // ⚠️ 必须 await：forceDnsPort 是 async（端口探测是异步的）。
  //    漏掉 await 的话 dnsFix 是个 Promise，`.text` 为 undefined，
  //    整个 config.yaml 会被写成垃圾（实测出现过字面量 "undefined"）。
  const dnsFix = await forceDnsPort(text);
  text = dnsFix.text;

  // ⚠️ 这里**故意不动**分组里的测速地址（`url:`）。
  //
  // 2026-10-13 我曾加过 `forceTestUrl()` 把 9 处 `url: gstatic/generate_204`
  // 改成国内的 miui —— 当时误判成「gstatic 在国内被墙 → 全部超时」。
  // **那个诊断是错的**，12 样本对照（3 个自动组 × 4 成员，测完回读面板读的
  // 顶层 history）：
  //   · 不传 url（内核用分组自己的目标）→ 11/12 = 92%
  //   · 显式传分组自己的 testUrl        → 10/12 = 83%
  //   · 改传 miui                       → 10/12 = 83%
  // 三者基本等价 —— 测速请求是**从节点那一端发出去**的，走节点所在地的网络，
  // 不是本机直连，所以 gstatic 对节点完全可达。
  //
  // 「全超时」的真根因是 DNS 端口冲突（见上面的 forceDnsPort），已单独修好。
  // 而擅自改写用户的测速目标，反而**偏离**了 FlClash 的行为（用户 2026-10-13
  // 明确要求「更接近 FlClash 做法」）—— FlClash 从不改这一项，它让每个分组
  // 用自己的 `url:`，我们也照做。

  // 打开管理 API —— 「列出/切换节点」全靠它。导入的 FlClash 配置里这一项是
  // 空字符串，不处理的话节点面板永远读不到东西（见 forceExternalController 注释）。
  let controller = null;
  if (Number.isInteger(controllerPort) && controllerPort > 0) {
    const r = forceExternalController(text, controllerPort, controllerSecret ?? '');
    text = r.text;
    controller = { port: controllerPort, added: r.added };
  }

  const outFile = join(outDir, 'config.yaml');
  await fsp.writeFile(outFile, text, 'utf8');

  return {
    outFile,
    rulesTotal: found.size,
    copied,
    missing,
    warnings: conflict,
    controller,
    dnsPort: dnsFix.port,
  };
}

/**
 * 把 DNS 监听端口改到一个**空闲**端口。
 *
 * ## 为什么必须做（2026-10-13 实测事故：「测速全部超时」）
 *
 * 现象：点「测延迟」后 143 个节点**全部超时**。查下来不是节点坏了，也不是测速
 * 地址被墙 —— 内核日志里一直在刷：
 *
 * ```
 * level=error msg="Start DNS server(UDP) error: listen udp :1053: bind: Only one usage..."
 * ```
 *
 * **1053 被 FlClashCore 占着**（本机实测 pid 13360）。于是我们的内核 DNS 起不来
 * → 域名解析不了 → 任何测速请求都到不了目标 → 全部 503/504。
 *
 * 讽刺的地方：插件的「礼让」机制只在**代理端口 7890** 上让路，而 **DNS 端口
 * 1053 撞车却没人管** —— 所以只要用户开着 FlClash，本插件的内核就是个「能起来
 * 但其实废了」的状态：端口在听、命令能跑，却连不上任何东西。
 *
 * @param text - 原始 YAML
 * @param startPort - 起始端口（从它开始找第一个空闲的）
 * @returns {{ text: string, port: number|null, changed: boolean }}
 */
export async function forceDnsPort(text, startPort = 1053) {
  const line = (p) => `  listen: 127.0.0.1:${p}`;

  // 只在 **dns 段内部**改 listen：配置里可能还有别的 listen（tun / redir 等），
  // 误伤会让网络栈整个错乱。先定位 `dns:`，再在它内部找缩进的 listen。
  const lines = text.split(/\r?\n/);
  const dnsIdx = lines.findIndex((l) => /^dns:[ \t]*$/.test(l));
  if (dnsIdx < 0) return { text, port: null, changed: false };

  let listenIdx = -1;
  for (let i = dnsIdx + 1; i < lines.length; i += 1) {
    if (!/^[ \t]/.test(lines[i])) break;          // 回到顶层 = dns 段结束
    if (/^[ \t]+listen:[ \t]/.test(lines[i])) { listenIdx = i; break; }
  }

  const port = await pickFreePort(startPort);
  if (listenIdx < 0) {
    // 没有 listen 就紧跟着 `dns:` 补一条。
    lines.splice(dnsIdx + 1, 0, line(port));
    return { text: lines.join('\n'), port, changed: true };
  }

  const before = lines[listenIdx];
  lines[listenIdx] = line(port);
  return { text: lines.join('\n'), port, changed: before !== lines[listenIdx] };
}

/**
 * 把配置里所有「分组测速地址」从 gstatic 换成国内可达的 204 端点。
 *
 * ## ⚠️ 这个函数现在**保留但不再被调用** —— 它的立论是错的，如实记在这里
 *
 * 起因：2026-10-13 用户报「咋又全超时了」，我查到配置里 9 处 `url:` 指向
 * `https://www.gstatic.com/generate_204`，又在**本机直连**下实测它不通，
 * 于是判定「gstatic 被墙 → 节点测速必然全失败」，写了这个替换器并接进了
 * `materialize` 与 `ensureControllerInConfig`。
 *
 * **那条因果链是错的。** 分组测速是 mihomo 内核**经由节点**发出的请求，
 * 走的是节点所在地区的出口，与「本机能不能直连 gstatic」毫无关系。
 * 后来的对照实验（同一批节点，在同一分组上只换测速目标）：
 *
 *   · 用分组自己的 `testUrl`（就是 gstatic）→ **4/4 成功，266~715 ms**
 *   · 不传 url（内核回落同一目标）          → 只探到 2/4，其余尾条 `delay: 0`
 *   · 改传 miui                             → 3/4 成功
 *
 * 即：gstatic 对节点完全可达，替换它**没有修好任何东西**；「全超时」的真根因
 * 是 DNS 端口冲突（已由 `forceDnsPort` 单独修好）。而且擅自改写用户的测速目标，
 * 反而让插件行为**偏离** FlClash —— 用户 2026-10-13 明确要求「更接近 FlClash
 * 做法」，FlClash 从不改这一项，它让每个分组用自己配置的 `url:`，我们也照做
 * （见 `lib/nodes.js` 的 `testGroupDelay`：默认取分组自带的目标）。
 *
 * 保留函数只为「将来真要统一测速目标时，这里已有安全实现」。真要启用，
 * 请连同 `materialize` 里的注释一起改，别再把它当 bug 修复。
 *
 * ## 只改 `url:`，不碰别的
 *
 * 配置里还有两处 `connectivitycheck.gstatic.com` 出现在 DNS 段的
 * `fake-ip-filter` 白名单里 —— 那是「这些域名不要劫持」的清单，
 * **语义完全不同，绝不能动**。所以这里只认行首（缩进后）的 `url:` 键。
 *
 * @param text - 原始 YAML
 * @param target - 替换成什么（默认 `DEFAULT_TEST_URL`）
 * @returns `{{ text, changed, count }}`
 */
export function forceTestUrl(text, target = DEFAULT_TEST_URL) {
  const lines = text.split(/\r?\n/);
  let count = 0;
  const out = lines.map((l) => {
    // 只认「键为 url」的行，值是被墙的 gstatic 测速端点。
    const m = l.match(/^(\s*)url:\s*"?https?:\/\/www\.gstatic\.com\/generate_204"?\s*$/);
    if (!m) return l;
    count += 1;
    return `${m[1]}url: "${target}"`;
  });
  return { text: out.join('\n'), changed: count > 0, count };
}

/**
 * 从 startPort 起找第一个没人在听的本机端口（**异步**）。
 *
 * ⚠️ 这里踩过一个坑：最初写成「同步」—— 起一个 `net.connect` 后立刻检查
 * `connecting`。但 TCP 连接是异步的，`connecting` 在下一 tick 之前**永远是
 * true**，于是 `up` 恒为 false，函数**永远返回 startPort**。
 * 实测表现：`dnsPort` 一直等于 1053（那个被 FlClashCore 占着的端口），
 * DNS 冲突根本没有真正避开。
 *
 * 所以必须用 Promise 等 'connect' 或 'error' 事件，不能靠同步快照。
 */
export async function pickFreePort(startPort, tries = 20, timeoutMs = 400) {
  for (let p = startPort; p < startPort + tries; p += 1) {
    // 串行探测：并发起 20 个 socket 会瞬间耗尽本地端口，也没必要。
    const up = await probePort(p, timeoutMs);
    if (!up) return p;
  }
  return startPort;
}

/** 探一个 loopback 端口有没有人在听。 */
export function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (up) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* ignore */ }
      resolve(up);
    };
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('connect', () => finish(true));
    s.on('error', () => finish(false));
    s.setTimeout(timeoutMs, () => finish(false));
  });
}

/**
 * 强制把 `external-controller` 写成本机的随机端口，并写入 `secret`。
 *
 * ## 为什么必须做（2026-10-13）
 *
 * 导入的 FlClash 配置里这一项是**空字符串**：
 *
 * ```yaml
 * external-controller: ""
 * secret: ""
 * ```
 *
 * 于是 mihomo 的管理 API 根本没开 —— 而「列出节点 / 切换节点」全靠它
 * （`GET /proxies`、`PUT /proxies/<组>`）。没有它，143 个节点配 14 个分组
 * 在界面上就是一块死数据。
 *
 * ## 安全边界（对应「打游戏时零打扰」那条硬约束）
 *
 *   · **只绑 127.0.0.1** —— 绝不监听 0.0.0.0，外网碰不到；
 *   · **随机 secret** —— 即使本机别的进程扫到这个端口，没有密钥也调不动；
 *   · **只在内核运行期间存在** —— 内核一停（空闲自动关 / 手动停 / 被游戏闸门
 *     拦下）端口随之消失，所以平时并不新增任何监听面。
 *
 * ## 覆盖而不是追加
 *
 * 原配置可能写的是 `""`、别的端口、甚至没有这一行。三种情况都要处理成
 * 「唯一一条、值正确」。用 `^external-controller:` 匹配行首，避免误伤
 * `external-controller-pipe` / `-unix` / `-tls` / `-cors` 这些兄弟键。
 *
 * @param text - 原始 YAML 文本
 * @param port - 管理 API 端口
 * @param secret - 访问密钥
 * @returns {{ text: string, changed: boolean, added: boolean }}
 */
export function forceExternalController(text, port, secret) {
  const line = `external-controller: 127.0.0.1:${port}`;
  const secretLine = `secret: "${secret}"`;
  let changed = false;
  let added = false;

  // 1. external-controller：只认「行首、后接冒号」的那一个键。
  const ecRe = /^external-controller:[ \t]*.*$/m;
  if (ecRe.test(text)) {
    const before = text;
    text = text.replace(ecRe, line);
    if (text !== before) changed = true;
  } else {
    // 没有这一行时**追加到文件末尾**，绝不插到开头 —— 插到开头会在文件首行是
    // 注释/文档分隔符（如 `---`）时把 YAML 结构打断。
    text = `${text.replace(/\s+$/, '')}\n${line}\n`;
    changed = true;
    added = true;
  }

  // 2. secret：同样只认顶层那个。注意 `secret:` 也可能出现在别处（如
  //    proxy-provider 的鉴权段），所以只在**行首无缩进**时替换。
  const secRe = /^secret:[ \t]*.*$/m;
  if (secRe.test(text)) {
    text = text.replace(secRe, secretLine);
  } else {
    text = text.replace(/^(external-controller:.*)$/m, `$1\n${secretLine}`);
  }

  // 3. 记住选过的节点：否则内核一重启（空闲自动关是常态）选择就丢了。
  //    只认顶层 `store-selected:`，没有就补在 `profile:` 段下。
  const ssRe = /^(\s*)store-selected:[ \t]*.*$/m;
  if (ssRe.test(text)) {
    text = text.replace(ssRe, '$1store-selected: true');
  } else if (/^profile:[ \t]*$/m.test(text)) {
    text = text.replace(/^profile:[ \t]*$/m, 'profile:\n  store-selected: true');
  }

  return { text, changed, added };
}

/**
 * 从配置文本里读回管理 API 的端口与密钥（内核已在跑时要用它调 API）。
 * @returns {{ port: number|null, secret: string, host: string }}
 */
export function readExternalController(text) {
  const m = /^external-controller:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/m.exec(text);
  const s = /^secret:[ \t]*["']?([^"'\n]*)["']?[ \t]*$/m.exec(text);
  let host = '127.0.0.1';
  let port = null;
  if (m) {
    const v = m[1];
    const idx = v.lastIndexOf(':');
    if (idx > 0) {
      host = v.slice(0, idx) || '127.0.0.1';
      const p = Number(v.slice(idx + 1));
      if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
    }
  }
  return { host, port, secret: s ? s[1] : '' };
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
