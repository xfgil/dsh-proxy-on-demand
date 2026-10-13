/**
 * 前台状态探测 —— 游戏闸门的采集层。
 *
 * 用途：回答「此刻系统是否处于全屏 / 不可打扰状态」。这是
 *       「打游戏时不要有任何可能的弹窗与网络环境变化」这条需求的判据来源，
 *       由 lib/games.js 消费，最终决定代理能不能启用。
 *
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 *       （本文件与内核无关，只做本机窗口状态读取）
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；只用 Node 内建模块 +
 *           Windows 自带组件（.NET Framework 的 csc.exe、user32/shell32）。
 * 自用免责：按「原样」提供、无担保。探测结果仅供参考。
 * 联网说明：**本文件完全不联网**。只读窗口状态，不修改任何系统状态。
 *
 * ── 为什么是「常驻子进程」而不是每次调 PowerShell ────────────────────────────
 *
 *   实测（本机，2026-10）：
 *     · PowerShell + Add-Type 每次现编译 C#：编译 480ms + 调用 4ms  ≈ 484ms/次
 *     · csc.exe 编译成 exe 后每次起进程调用：                        ≈ 349ms/次
 *     · csc.exe 编译成 DLL 再 Assembly.LoadFrom：                    ≈ 8ms/次
 *     · **本方案：常驻 exe + stdin/stdout 协议**  冷启动 364ms，热往返 **0.17ms/次**
 *
 *   界面每 4 秒轮询、闸门每次起核都要问一次，几百毫秒的抖动是不可接受的。
 *   常驻进程把「起进程」这个固定成本摊掉，之后每次查询是亚毫秒级。
 *
 *   编译只做一次，产物落在 runtime/gameprobe.exe（runtime/ 已在 .gitignore 里，
 *   不会进仓库）。csc.exe 是 Windows 自带的 .NET Framework 组件，无需装 SDK。
 *
 * ── 两个判据，一个主一个辅 ─────────────────────────────────────────────────
 *
 *   1. SHQueryUserNotificationState（QUNS）—— **主判据**
 *      系统自己的「现在能不能打扰用户」。实测取值：
 *        1 = NOT_PRESENT      锁屏
 *        2 = BUSY             忙碌（**无边框全屏会返回这个**）
 *        3 = D3D_FULL_SCREEN  独占全屏（真全屏游戏）
 *        4 = PRESENTATION     演示模式
 *        5 = ACCEPTS_NOTIF    可以打扰（正常桌面）
 *        6 = QUIET_TIME       免打扰时段
 *        7 = APP              应用自定
 *      受控实验：弹一个 FormBorderStyle=None + 覆盖全屏 + TopMost 的窗口，
 *      QUNS 从 5 翻到 **2**，关掉后回到 5 —— 证明它能识别**无边框全屏**，
 *      不只是独占 D3D 全屏。这正是我们最关心的场景。
 *
 *   2. 前台窗口特征（无标题栏 + 精确覆盖显示器）—— **辅助判据**
 *      ⚠ 单用它会误报。实测朴素判据「矩形覆盖屏幕且无 WS_CAPTION」把
 *        TextInputHost.exe（输入法候选，矩形 0,0,2560,1600）和 explorer.exe
 *        （桌面，矩形 0,0,1920,1080）都判成了全屏 —— 而同一时刻 QUNS = 5，
 *        系统明确认为「可以打扰」。所以辅助判据必须**排除系统外壳进程**，
 *        并且只在 QUNS 不可用时（探测 exe 编译不出来）才单独使用。
 *
 * ── 协议 ───────────────────────────────────────────────────────────────────
 *
 *   往子进程 stdin 写一行（任意非 'q' 内容）→ stdout 回一行 JSON：
 *     {"ok":true,"quns":5,"pid":1788,"caption":true,"full":false,
 *      "rect":[236,102,1518,1004],"mon":[0,0,1920,1080],"work":[0,0,1920,1032],
 *      "fgPath":"C:\\...\\x.exe","title":"..."}
 *   写 'q' → 子进程退出。
 *
 *   stdout 是**逐行**协议，故用队列 + 令牌匹配请求与响应；超时的槽位标记
 *   失效后跳过（不能让一次超时把后续响应错位对上）。
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 探测 exe 的文件名（编译产物，落在 runtime/ 下）。 */
export const PROBE_EXE = 'gameprobe.exe';
/** 内嵌 C# 源码的文件名（编译用，同样落在 runtime/ 下）。 */
const PROBE_CS = 'gameprobe.cs';
/** 单次查询超时。热往返 0.17ms，给 800ms 已经极宽松。 */
const QUERY_TIMEOUT_MS = 800;

/**
 * csc.exe 的位置。Windows 自带 .NET Framework 4.x，**不需要装 SDK**。
 * 优先 64 位目录（本机是 64 位 Windows）。
 */
const CSC_CANDIDATES = [
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];

/**
 * 内嵌的 C# 源码。用 String.raw 保证反斜杠原样传给 csc。
 *
 * 注意几处 P/Invoke 的坑（都是实测踩出来的）：
 *   · GetMonitorInfoW / GetWindowTextW / QueryFullProcessImageNameW 必须显式写
 *     W 后缀或 CharSet=Unicode —— 默认按 Ansi 找 *A 版本，**这些函数没有 A 版**，
 *     会抛 EntryPointNotFoundException。
 *   · 取窗口样式用 GetWindowLongW（不是 GetWindowLongPtrW）：WS_CAPTION 在低 32 位，
 *     而 64 位 user32 里 GetWindowLongW 依然存在，两个位数下都能跑。
 *   · OpenProcess 用 PROCESS_QUERY_LIMITED_INFORMATION(0x1000)，普通权限即可拿到
 *     进程路径；用 PROCESS_QUERY_INFORMATION 在跨权限时会失败。
 */
const CS_SOURCE = String.raw`using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

class DshGameProbe {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }

  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLongW(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW")] static extern bool GetMonitorInfoW(IntPtr hMon, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW")] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder sb, ref int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const int GWL_STYLE = -16;
  const int WS_CAPTION = 0x00C00000;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint MONITOR_DEFAULTTONEAREST = 2;

  static string Q(string s) {
    if (s == null) return "null";
    var sb = new StringBuilder(s.Length + 2);
    sb.Append('"');
    foreach (char c in s) {
      if (c == '"') sb.Append("\\\"");
      else if (c == '\\') sb.Append("\\\\");
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\r') sb.Append("\\r");
      else if (c == '\t') sb.Append("\\t");
      else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    sb.Append('"');
    return sb.ToString();
  }

  static string ProcPath(uint pid) {
    if (pid == 0) return null;
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var sb = new StringBuilder(1024);
      int size = sb.Capacity;
      if (QueryFullProcessImageNameW(h, 0, sb, ref size)) return sb.ToString(0, size);
      return null;
    } catch { return null; } finally { CloseHandle(h); }
  }

  static string Sample() {
    int quns = -1;
    try { int st; if (SHQueryUserNotificationState(out st) == 0) quns = st; } catch { }

    IntPtr h = GetForegroundWindow();
    uint pid = 0;
    if (h != IntPtr.Zero) GetWindowThreadProcessId(h, out pid);

    RECT r = new RECT();
    bool hasRect = h != IntPtr.Zero && GetWindowRect(h, out r);

    int style = h != IntPtr.Zero ? GetWindowLongW(h, GWL_STYLE) : 0;
    bool caption = (style & WS_CAPTION) != 0;

    var title = new StringBuilder(512);
    if (h != IntPtr.Zero) GetWindowTextW(h, title, title.Capacity);

    int ml = 0, mt = 0, mr = 0, mb = 0, wl = 0, wt = 0, wr = 0, wb = 0;
    IntPtr hm = h != IntPtr.Zero ? MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) : IntPtr.Zero;
    if (hm != IntPtr.Zero) {
      var mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (GetMonitorInfoW(hm, ref mi)) {
        ml = mi.rcMonitor.Left; mt = mi.rcMonitor.Top; mr = mi.rcMonitor.Right; mb = mi.rcMonitor.Bottom;
        wl = mi.rcWork.Left; wt = mi.rcWork.Top; wr = mi.rcWork.Right; wb = mi.rcWork.Bottom;
      }
    }

    bool full = hasRect && hm != IntPtr.Zero
      && r.Left <= ml && r.Top <= mt && r.Right >= mr && r.Bottom >= mb;

    var o = new StringBuilder(512);
    o.Append("{\"ok\":true");
    o.Append(",\"quns\":").Append(quns);
    o.Append(",\"pid\":").Append(pid);
    o.Append(",\"caption\":").Append(caption ? "true" : "false");
    o.Append(",\"full\":").Append(full ? "true" : "false");
    o.Append(",\"rect\":[").Append(r.Left).Append(',').Append(r.Top).Append(',').Append(r.Right).Append(',').Append(r.Bottom).Append(']');
    o.Append(",\"mon\":[").Append(ml).Append(',').Append(mt).Append(',').Append(mr).Append(',').Append(mb).Append(']');
    o.Append(",\"work\":[").Append(wl).Append(',').Append(wt).Append(',').Append(wr).Append(',').Append(wb).Append(']');
    o.Append(",\"fgPath\":").Append(Q(ProcPath(pid)));
    o.Append(",\"title\":").Append(Q(title.ToString()));
    o.Append('}');
    return o.ToString();
  }

  static void Main() {
    var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.AutoFlush = true;
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Length > 0 && (line[0] == 'q' || line[0] == 'Q')) break;
      stdout.WriteLine(Sample());
    }
  }
}
`;

// ── 常驻子进程管理 ──────────────────────────────────────────────────────────

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
/** 等待响应的槽位队列（与 stdout 的行一一对应）。 */
let queue = [];
/** 诊断计数，挂在模块级，热重载后不清零（与 index.js 的统计同一思路）。 */
const stats = (globalThis[Symbol.for('dsh-proxy-on-demand.probe')] ??= {
  spawns: 0, queries: 0, timeouts: 0, errors: 0, lastError: null, lastMs: null, generations: 0,
});
stats.generations += 1;

/** 排空队列：子进程死了，所有在等的请求都失败。 */
function failAll(reason) {
  const pending = queue;
  queue = [];
  for (const slot of pending) {
    if (slot.done) continue;
    slot.done = true;
    clearTimeout(slot.timer);
    stats.errors += 1;
    stats.lastError = reason;
    slot.resolve({ ok: false, error: reason });
  }
}

function startChild(exe) {
  if (child) return child;
  const c = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child = c;
  stats.spawns += 1;

  let buf = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const slot = queue.shift();
      if (!slot) continue;          // 无主响应（理论上不该有）
      if (slot.done) continue;      // 已超时，丢弃
      slot.done = true;
      clearTimeout(slot.timer);
      try {
        slot.resolve({ source: 'exe', ...JSON.parse(line) });
      } catch (e) {
        stats.errors += 1;
        stats.lastError = `探测响应不是 JSON：${String(e?.message ?? e)}`;
        slot.resolve({ ok: false, error: stats.lastError });
      }
    }
  });
  c.on('error', (e) => {
    stats.errors += 1;
    stats.lastError = `探测进程错误：${String(e?.message ?? e)}`;
    failAll(stats.lastError);
    child = null;
  });
  c.on('exit', () => {
    if (child === c) child = null;
    failAll('探测进程已退出');
  });
  // stdin 出错（子进程没了）不要让宿主崩
  c.stdin.on('error', () => { /* 由 exit 分支统一收尾 */ });
  return c;
}

/** 关掉常驻探测进程（插件 dispose / 测试收尾时调用）。 */
export function disposeProbe() {
  const c = child;
  child = null;
  failAll('探测已关闭');
  if (c) {
    try { c.stdin.write('q\n'); } catch { /* ignore */ }
    try { c.kill(); } catch { /* ignore */ }
  }
}

export function probeStatus() {
  return { ...stats, running: !!child, pending: queue.length };
}

// ── 编译 ────────────────────────────────────────────────────────────────────

function findCsc() {
  for (const p of CSC_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/**
 * 确保探测 exe 存在（必要时用 csc.exe 现编译）。
 *
 * 编译条件是「exe 不存在」或「cs 源比 exe 新」——插件升级后源码变了要重编。
 *
 * @returns {Promise<{ok:boolean, exe:string|null, compiled:boolean, ms:number, error?:string}>}
 */
export async function ensureProbe({ runtimeDir, onLog } = {}) {
  const t0 = Date.now();
  if (!runtimeDir) return { ok: false, exe: null, compiled: false, ms: 0, error: '缺少 runtimeDir' };

  const exe = join(runtimeDir, PROBE_EXE);
  const cs = join(runtimeDir, PROBE_CS);

  try {
    mkdirSync(runtimeDir, { recursive: true });
  } catch (e) {
    return { ok: false, exe: null, compiled: false, ms: Date.now() - t0, error: `建 runtime 目录失败：${String(e?.message ?? e)}` };
  }

  // 源码变了就重写（也覆盖"用户手改过"的情况）
  let needWrite = true;
  try {
    needWrite = !existsSync(cs) || statSync(cs).size !== Buffer.byteLength(CS_SOURCE);
  } catch { /* 当作需要重写 */ }
  if (needWrite) {
    try { writeFileSync(cs, CS_SOURCE, 'utf8'); } catch (e) {
      return { ok: false, exe: null, compiled: false, ms: Date.now() - t0, error: `写 C# 源码失败：${String(e?.message ?? e)}` };
    }
  }

  // exe 比源码新就不用重编
  try {
    if (existsSync(exe) && statSync(exe).size > 0 && statSync(exe).mtimeMs >= statSync(cs).mtimeMs) {
      return { ok: true, exe, compiled: false, ms: Date.now() - t0 };
    }
  } catch { /* 落到编译 */ }

  const csc = findCsc();
  if (!csc) {
    return { ok: false, exe: null, compiled: false, ms: Date.now() - t0, error: '找不到 csc.exe（需要 Windows 自带的 .NET Framework 4.x）' };
  }

  onLog?.(`编译游戏探测程序（一次性，约 0.3 秒）…`);
  const r = await new Promise((resolve) => {
    execFile(csc, ['/nologo', '/target:exe', '/optimize+', '/r:System.dll', `/out:${exe}`, cs], {
      timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 << 20,
    }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`, err }));
  });

  const ms = Date.now() - t0;
  if (!r.ok || !existsSync(exe)) {
    const detail = String(r.out || r.err?.message || '').trim().split(/\r?\n/).slice(0, 3).join(' / ');
    const error = `编译探测程序失败：${detail || '未知错误'}`;
    stats.errors += 1;
    stats.lastError = error;
    return { ok: false, exe: null, compiled: false, ms, error };
  }

  onLog?.(`探测程序已就绪（编译耗时 ${ms}ms）`);
  return { ok: true, exe, compiled: true, ms };
}

// ── 查询 ────────────────────────────────────────────────────────────────────

/**
 * 查一次前台状态。**热路径**：常驻进程已在跑时约 0.2ms。
 *
 * @returns {Promise<{
 *   ok:boolean, source?:'exe', quns?:number, pid?:number, caption?:boolean,
 *   full?:boolean, rect?:number[], mon?:number[], work?:number[],
 *   fgPath?:string|null, title?:string, ms?:number, error?:string
 * }>}
 */
export function sampleForeground({ runtimeDir, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  const exe = runtimeDir ? join(runtimeDir, PROBE_EXE) : null;
  if (!exe || !existsSync(exe)) {
    return Promise.resolve({ ok: false, error: '探测程序不存在（先调用 ensureProbe）' });
  }

  const c = startChild(exe);
  const t0 = Date.now();
  stats.queries += 1;

  return new Promise((resolve) => {
    const slot = {
      done: false,
      timer: null,
      resolve: (r) => {
        const ms = Date.now() - t0;
        stats.lastMs = ms;
        if (!r.ok) { stats.errors += 1; stats.lastError = r.error ?? null; }
        resolve({ ...r, ms });
      },
    };
    slot.timer = setTimeout(() => {
      if (slot.done) return;
      slot.done = true;
      stats.timeouts += 1;
      stats.lastError = `探测查询超时（${timeoutMs}ms）`;
      resolve({ ok: false, error: stats.lastError, ms: Date.now() - t0 });
    }, timeoutMs);
    queue.push(slot);
    try {
      c.stdin.write('s\n');
    } catch (e) {
      slot.done = true;
      clearTimeout(slot.timer);
      stats.errors += 1;
      stats.lastError = `写探测请求失败：${String(e?.message ?? e)}`;
      resolve({ ok: false, error: stats.lastError, ms: Date.now() - t0 });
    }
  });
}
