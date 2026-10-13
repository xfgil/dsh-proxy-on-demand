/**
 * 系统代理自动开关。
 *
 * 用途：dsh-proxy-on-demand 的「最后一公里」—— 内核起来时把 Windows 的系统
 *       代理指向本插件，内核关掉时**精确还原**成原来的样子。
 * 上游：无。只用 Windows 自带能力（注册表 + wininet 的 InternetSetOption）。
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；只用 Node 内建模块。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 *
 * ## 为什么必须有它（2026-10-13 用户原话）
 *
 * > 「肯定A啊，要不然为什么我不让你在我打游戏的时候运行插件？肯定是因为他是系统代理啊」
 *
 * 之前插件只负责「起内核 + 开 7890」，但**系统代理要用户自己开** ——
 * 于是用户点了「立即启动」，内核在跑、端口在听，浏览器却仍然直连，
 * GitHub 照样打不开（实测 `ERR_CONNECTION_RESET`）。所谓「按需代理」
 * 落到实处就是：**开内核必须连带开系统代理，关内核必须连带还原**。
 *
 * ## 三条硬约束
 *
 * 1. **绝不残留**：改之前先把原值（ProxyEnable/ProxyServer/ProxyOverride/
 *    AutoConfigURL）完整备份到 `runtime/proxy-backup.json`，还原时逐字段写回。
 *    备份落盘而不是只放内存 —— 宿主崩溃重启后仍然还原得回来。
 * 2. **不抢别人的**：如果系统代理**已经**开着且指向别的服务器（多半是 FlClash），
 *    我们**不覆盖**，只如实报告，让用户自己决定。这对应「检测到其它代理就
 *    自动静默让路」那条既有约束。
 * 3. **不打游戏**：本模块**不做任何游戏判断** —— 它由 core 在「内核真的起来了」
 *    之后才调用。游戏闸门会在内核启动前就把整条链路拦掉，所以打游戏时
 *    系统代理根本不会被碰（这是用户最在意的一点）。
 *
 * ## 为什么走 PowerShell 而不是直接改注册表
 *
 * Node 没有操作注册表的内建 API（`node:fs` 够不到 HKCU）。改注册表本身可以用
 * `reg.exe`，但**改完必须调 `wininet.InternetSetOption` 通知系统刷新**，
 * 否则设置要等下一次登录才生效 —— 那对「按需」来说毫无意义。
 * 这两件事在同一条 PowerShell 里做最省进程往返。
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

/** 注册表位置（当前用户，不需要管理员）。 */
const REG_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * 一次 PowerShell 调用的超时（毫秒）。
 *
 * 15 秒很宽松：实测冷启动 PowerShell 约 400ms，加上 Add-Type 也不到 1 秒。
 * 设大一点是为了容忍开机后第一次调用的磁盘冷读。
 */
const PS_TIMEOUT_MS = 15000;

/**
 * 跑一段 PowerShell，返回 stdout 文本。
 *
 * 用 `-NoProfile` 跳过用户配置（更快、更可预测）；`-NonInteractive` 保证
 * 不会因为意外提示符而挂死。输出统一按 UTF-8 解 —— 中文路径与中文
 * 备注都要能正确穿过管道。
 */
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => done(reject, new Error(`无法启动 PowerShell：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) done(resolve, out);
      else done(reject, new Error(`PowerShell 退出码 ${code}：${(err || out).trim().slice(0, 300)}`));
    });

    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done(reject, new Error(`PowerShell 超时（${PS_TIMEOUT_MS}ms）`));
    }, PS_TIMEOUT_MS);
    t.unref?.();
    child.on('close', () => clearTimeout(t));
  });
}

/**
 * 通知系统「Internet 设置变了」。
 *
 * 不做这一步的话，注册表虽然改了，但已经在跑的浏览器/系统组件**继续用旧设置**，
 * 用户会以为「改了没用」。39 = SETTINGS_CHANGED，37 = REFRESH。
 */
const NOTIFY_SNIPPET = `
$sig = @'
[DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@
$w = Add-Type -MemberDefinition $sig -Name WinInet -Namespace DshProxy -PassThru -ErrorAction SilentlyContinue
if ($w) {
  [void]$w::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
  [void]$w::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
}
`;

/**
 * 读取当前系统代理设置。
 *
 * @returns `{ enable: 0|1, server: string, override: string, autoConfig: string, pac: boolean }`
 */
export async function readSystemProxy() {
  const script = `
$k = '${REG_KEY}'
$p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
$o = [ordered]@{
  enable     = if ($p -and $null -ne $p.ProxyEnable) { [int]$p.ProxyEnable } else { 0 }
  server     = if ($p -and $p.ProxyServer) { [string]$p.ProxyServer } else { '' }
  override   = if ($p -and $p.ProxyOverride) { [string]$p.ProxyOverride } else { '' }
  autoConfig = if ($p -and $p.AutoConfigURL) { [string]$p.AutoConfigURL } else { '' }
}
$o | ConvertTo-Json -Compress
`;
  const out = await runPowerShell(script);
  let j;
  try {
    j = JSON.parse(out.trim());
  } catch {
    throw new Error(`解析系统代理设置失败，原始输出：${out.trim().slice(0, 200)}`);
  }
  return {
    enable: Number(j.enable) === 1 ? 1 : 0,
    server: String(j.server ?? ''),
    override: String(j.override ?? ''),
    autoConfig: String(j.autoConfig ?? ''),
    pac: String(j.autoConfig ?? '').length > 0,
  };
}

/**
 * 把系统代理指向本机端口。**调用前请务必先 readSystemProxy() 并落盘备份。**
 *
 * @param port - 代理端口（通常 7890）
 * @param bypass - 绕过列表。**不传则自动合并**（见 mergeBypass）——
 *                 千万别直接用 DEFAULT_BYPASS 覆盖：本机实测用户原有列表里
 *                 有 `*zhihu.com;*zhimg.com;*jd.com;...` 这类自定义直连项，
 *                 覆盖掉会让这些站点突然走代理（用户会觉得"你把我设置改了"）。
 */
export async function enableSystemProxy(port, bypass) {
  // ⚠️ mergeBypass 是 async（它可能要读当前系统值），必须 await。
  //    漏掉的话 ov 是个 Promise，`.replace` 直接抛 TypeError。
  const ov = await mergeBypass(bypass ?? null);
  const script = `
$k = '${REG_KEY}'
Set-ItemProperty -Path $k -Name ProxyEnable   -Value 1 -Type DWord  -ErrorAction Stop
Set-ItemProperty -Path $k -Name ProxyServer   -Value '127.0.0.1:${port}' -Type String -ErrorAction Stop
Set-ItemProperty -Path $k -Name ProxyOverride -Value '${ov.replace(/'/g, "''")}' -Type String -ErrorAction Stop
${NOTIFY_SNIPPET}
Write-Output 'ok'
`;
  await runPowerShell(script);
  return { enable: 1, server: `127.0.0.1:${port}`, override: ov };
}

/**
 * 合并绕过列表：**保留用户的原有项**，只补上必需的自环保护。
 *
 * 用户原列表（本机实测）长这样：
 *   `*zhihu.com;*zhimg.com;*jd.com;100ime-iat-api.xfyun.cn;*360buyimg.com;localhost;*.local;127.*;...`
 * 前面几个是用户自己要求直连的站点，**必须原样保留**。
 *
 * 合并规则：
 *   · 以 `userList` 为准（null 时取当前系统值）；
 *   · 把 NEVER_PROXY 里**缺失的**项补到末尾（顺序稳定，便于比对）；
 *   · 去重时不区分大小写（Windows 的绕过匹配本身不区分）。
 *
 * @param userList - 用户/系统原有的绕过串；null 表示"去读当前系统值"
 */
export async function mergeBypass(userList) {
  let base = userList;
  if (base === null) {
    // 读当前系统的（多半就是用户自己的）
    try {
      base = (await readSystemProxy()).override;
    } catch {
      base = '';
    }
  }
  const parts = String(base ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  const seen = new Set(parts.map((s) => s.toLowerCase()));
  for (const need of NEEDED_BYPASS) {
    if (!seen.has(need.toLowerCase())) {
      parts.push(need);
      seen.add(need.toLowerCase());
    }
  }
  return parts.join(';');
}

/**
 * **必须**绕过的项：少一样就可能自环或连不上本机服务。
 *
 *   · `localhost` / `127.*` —— 本机对 7890（代理）与 9090（管理 API）的访问
 *     一旦被送进代理，就形成自环；
 *   · 局域网段 —— 打印机、NAS、内网服务不该走代理；
 *   · `*.local` —— mDNS 名称解析。
 */
const NEEDED_BYPASS = [
  'localhost', '127.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*',
  '172.2*', '172.30.*', '172.31.*', '192.168.*', '*.local',
];

/**
 * 精确还原成备份里的样子。
 *
 * 每个字段都要写回 —— 包括 `ProxyEnable=0` 这种情况（用户原本就没开代理，
 * 那还原后也必须是不开，绝不能"顺手"给他开上）。
 *
 * @param backup - 来自 readSystemProxy() 的快照
 */
export async function restoreSystemProxy(backup) {
  if (!backup) return { restored: false, reason: '没有备份可还原' };
  const esc = (s) => String(s ?? '').replace(/'/g, "''");
  const script = `
$k = '${REG_KEY}'
Set-ItemProperty -Path $k -Name ProxyEnable   -Value ${Number(backup.enable) === 1 ? 1 : 0} -Type DWord  -ErrorAction Stop
Set-ItemProperty -Path $k -Name ProxyServer   -Value '${esc(backup.server)}'   -Type String -ErrorAction Stop
Set-ItemProperty -Path $k -Name ProxyOverride -Value '${esc(backup.override)}' -Type String -ErrorAction Stop
Set-ItemProperty -Path $k -Name AutoConfigURL -Value '${esc(backup.autoConfig)}' -Type String -ErrorAction Stop
${NOTIFY_SNIPPET}
Write-Output 'ok'
`;
  await runPowerShell(script);
  return { restored: true, ...backup };
}

/**
 * 默认绕过列表。
 *
 * 必须包含 `127.*` 与 `localhost` —— 否则本机对插件端口（7890）与管理 API
 * （9090）的访问也会被送进代理，形成自环。局域网段一并绕过，和 FlClash
 * 的默认值保持一致（本机实测 FlClash 用的就是这一串）。
 */
export const DEFAULT_BYPASS = [
  'localhost', '127.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*',
  '172.2*', '172.30.*', '172.31.*', '192.168.*', '*.local',
].join(';');

/** 备份文件路径。 */
export function backupPath(runtimeDir) {
  return join(runtimeDir, 'proxy-backup.json');
}

/**
 * 把备份落盘。
 *
 * 为什么必须落盘而不是只留内存：宿主进程崩了/被杀了，内存里的备份就没了，
 * 而**系统代理还指着我们那个已经死掉的端口** —— 用户的浏览器会整个上不了网。
 * 落盘之后下次启动还能把现场收拾干净。
 */
export async function saveBackup(runtimeDir, backup) {
  const p = backupPath(runtimeDir);
  await fsp.writeFile(p, JSON.stringify({ ...backup, savedAt: Date.now() }, null, 2), 'utf8');
  return p;
}

/** 读回落盘的备份（没有则返回 null）。 */
export async function loadBackup(runtimeDir) {
  try {
    return JSON.parse(await fsp.readFile(backupPath(runtimeDir), 'utf8'));
  } catch {
    return null;
  }
}

/** 删除备份（还原成功后调用）。 */
export async function clearBackup(runtimeDir) {
  await fsp.unlink(backupPath(runtimeDir)).catch(() => {});
}

/**
 * 判断「当前系统代理是不是已经指向我们自己」。
 *
 * 用途：避免重复设置，也用于还原后自检。
 */
export function pointsAtUs(current, port) {
  if (!current || Number(current.enable) !== 1) return false;
  const s = String(current.server ?? '');
  return s === `127.0.0.1:${port}` || s === `localhost:${port}`;
}

/**
 * 判断「系统代理正被别的程序占着」。
 *
 * 对应既有约束「检测到其它代理正在运行就自动静默让路」：如果用户开着 FlClash
 * 并且它已经接管了系统代理，我们**不抢** —— 抢过来会让 FlClash 的设置失效，
 * 而且两个程序都会以为自己管着系统代理，还原时互相踩。
 */
export function occupiedByOther(current, port) {
  if (!current || Number(current.enable) !== 1) return false;
  if (pointsAtUs(current, port)) return false;
  return true;
}
