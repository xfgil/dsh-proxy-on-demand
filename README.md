# dsh-proxy-on-demand

> 需要时才拉起代理内核，用完自动关。平时不占端口、不留后台进程。

[English](README.en.md) | 中文

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

| | |
|---|---|
| **`dsh-proxy-on-demand`** — 按需代理，用完自动关（本仓库） |
| [`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) — 改完插件源码不用重启 |
| [`dsh-session-clock`](https://github.com/xfgil/dsh-session-clock) — 按会话授时与空闲间隔 |
| [`dsh-onebot-guard`](https://github.com/xfgil/dsh-onebot-guard) — QQ 通道出站闸 |

> [!IMPORTANT]
> **首次运行会自动联网下载内核。** 本插件不含内核二进制，第一次要用时会从
> [mihomo](https://github.com/MetaCubeX/mihomo) 的官方 GitHub Release 自动下载
> `mihomo-windows-amd64`（约 **61MB**）到插件目录下的 `runtime/`，之后离线可用。
> 不需要你手动装任何东西；删掉 `runtime/` 即可完全清除，磁盘上不留残余。
> 不想自动下载就在配置里设 `autoDownload: false` 并自行放好内核。

> [!WARNING]
> **自用工具，请自行评估风险。** 本插件按「原样」提供，不附带任何明示或默示担保。
> 代理内核、节点与订阅的来源及合法性由使用者自行负责；请遵守你所在地的法律法规
> 与所使用服务的条款。作者不对使用本软件造成的任何直接或间接后果承担责任。

---

## 目录

- [这是什么](#这是什么)
- [它到底解决了什么问题](#它到底解决了什么问题)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [设置界面](#设置界面)
- [配置](#配置)
- [HTTP 接口](#http-接口)
- [它是怎么做到的](#它是怎么做到的)
- [上游程序](#上游程序)
- [已知限制](#已知限制)
- [实现说明](#实现说明)
- [开发](#开发)
- [免责声明](#免责声明)
- [License](#license)

---

## 这是什么

`dsh-proxy-on-demand` 是一个 DeepSeek Harness（DSH）插件，给你一个**随叫随到、用完就走**的代理。

它把 [mihomo](https://github.com/MetaCubeX/mihomo)（Clash Meta 内核）包进插件里：

- **需要时自动拉起** —— 第一次要用的时候自己下载内核、准备配置、启动进程。
- **空闲后自动关闭** —— 默认 2 分钟没人用就杀掉内核、清掉状态文件。
- **平时什么都不占** —— 没有常驻进程，7890 端口是空的，不会和你自己开的 Clash/FlClash 抢端口。

## 它到底解决了什么问题

用 Clash 系客户端（Clash Verge、FlClash、ClashX…）的人都有这个体验：

```
要用一下代理 → 打开客户端 → 等它起内核、拉订阅
→ 用完 → 忘了关 → 它一直挂在托盘里，占着 7890，开着系统代理
```

对**脚本、CI、爬虫、偶尔抓一次墙外数据**这类场景，这个模型是反的：代理只在几秒钟里被需要，却要一直养着一个常驻进程。

这个插件把模型倒过来：**代理是函数的调用栈，不是常驻服务**。

```bash
dsh-proxy -- curl.exe -sS https://api.github.com/repos/MetaCubeX/mihomo
# 内核按需启动 → 命令跑完 → 空闲超时后内核自动退出
```

在 DSH 里，Agent 需要抓墙外内容时直接调 `POST /dsh-proxy/fetch`，插件会顺手启动内核、抓完续一次租约，用完自己关。

### 为什么不用 FlClash 的内核

FlClash 自带的 `FlClashCore.exe` **不是标准 mihomo**，而是 GUI 专用的 IPC 从属进程。它的 `main()` 长这样：

```go
func main() {
    args := os.Args
    if len(args) <= 1 { os.Exit(1) }
    go exitOnTermination()
    startServer(args[1])   // args[1] 是管道名
}

func startServer(arg string) {
    dialed, err := dial(arg)   // 连不上就 panic
    if err != nil { panic(err.Error()) }
}
```

配置全部由界面经 IPC 下发，**无法脱离 GUI 独立启动**（实测 `FlClashCore.exe -v` 会 `panic: dial unix -v`，因为它把 `-v` 当成了管道名）。所以本插件用上游标准内核。

## 环境要求

- Node.js **≥ 22**
- DeepSeek Harness **0.2.0-rc.2**（Electron 44.0.0）—— 开发与验证所用的版本；
  作为插件运行需要它。命令行部分（`dsh-proxy`）可脱离宿主独立使用。
- 一份 Clash/mihomo 配置，来源三选一：
  - 订阅链接
  - 本机 FlClash 的 `config.yaml`（自动导入并修正路径）
  - 手动粘贴

## 安装

```bash
dsh plugin --profile <你的profile> add link:<本目录绝对路径>
```

例如：

```bash
dsh plugin --profile desktop add link:D:/path/to/plugins/dsh-proxy-on-demand
```

从 npm 安装（如果你是用发布版）：

```bash
dsh plugin --profile <你的profile> add dsh-proxy-on-demand
```

装完之后，profile 清单（`dsh.profile.bundles`）会被自动更新。宿主自带的 HMR 监听到清单变化后会自己 reconcile，插件即刻生效 —— **不需要重启**。

> 手工安装（不走 CLI）也可以：在 profile 的 `package.json` 里加
> `"dsh-proxy-on-demand": "link:D:/path/to/plugins/dsh-proxy-on-demand"`，
> 并在 `dsh.profile.bundles` 数组里补上 `"dsh-proxy-on-demand"`；
> 然后在 profile 的 `node_modules` 下建一个指向插件目录的链接（`mklink /J` 或符号链接均可）。

## 使用

### 在 DSH 里

装上之后，**设置 → 按需代理**（设置侧栏里独立的一页，不是「设置 → 插件」里的卡片）会出现完整界面（见下节）。也可以用 HTTP 接口：

```bash
curl -X POST http://127.0.0.1:19387/dsh-proxy/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.github.com/repos/MetaCubeX/mihomo/releases/latest"}'
```

### 命令行

插件自带 `dsh-proxy` 命令，**不依赖宿主进程**，宿主没起来也能用：

```bash
dsh-proxy status                     # 看状态
dsh-proxy prepare                    # 下载内核 + 准备配置
dsh-proxy import-flclash             # 从本机 FlClash 导入配置
dsh-proxy start                      # 启动内核，守着直到空闲自动关
dsh-proxy stop                       # 立刻关掉
dsh-proxy -- <命令> [参数...]         # 带着代理跑一条命令
```

常用的是最后一种：

```bash
dsh-proxy -- git clone https://github.com/some/repo
dsh-proxy --idle 0 -- curl.exe -sS https://api.ipify.org    # 跑完立刻关
dsh-proxy --idle 600 -- npm install                          # 空闲 10 分钟才关
```

它给子进程注入：

| 变量 | 值 |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | `http://127.0.0.1:<端口>` |
| `NO_PROXY` | `localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*` |

`NO_PROXY` 很重要 —— 否则连本机服务（比如 DSH 自己的 19387）也会被绕进代理。

## 设置界面

装上插件后，**设置**侧栏里会多出一页「按需代理」，分三块：

**状态** — 运行中 / 端口被占用 / 未运行；内核 PID；距离自动关还剩几秒；「立即启动」「立即关闭」「续期空闲计时」三个按钮。每 4 秒自动刷新。

**节点配置** — 三种填节点的方式：

| 方式 | 说明 |
|---|---|
| 订阅地址 | 粘贴后点「拉取订阅」，插件下载并改写成相对路径 |
| 从 FlClash 导入 | 读本机 FlClash 的 `config.yaml`，自动把规则文件的绝对路径改成相对路径 |
| 手动粘贴 | 直接贴一份 Clash/mihomo YAML |

**参数** — 代理端口、空闲多久自动关（秒）、启用插件、首次是否自动导入 FlClash 配置。改完立即生效。

> 端口改动需要重启内核才生效：先「立即关闭」，再「立即启动」。

界面**不走 DSH 的 settings 服务**，而是直接读写信件文件 + 自己的 HTTP 端点。原因见[实现说明](#实现说明)。

## 配置

插件自己的设置存在 `<插件>/runtime/settings.json`：

```json
{
  "enabled": true,
  "port": 7890,
  "idleMs": 120000,
  "subscriptionUrl": "",
  "autoImportFlClash": true,
  "configSource": "flclash",
  "lastSyncAt": 1760000000000,
  "lastSyncNote": "已从 FlClash 导入（规则 44 条）"
}
```

`runtime/` 目录（已被 `.gitignore` 排除）里放的是运行期产物：

| 文件 | 作用 |
|---|---|
| `mihomo.exe` | 内核（首次用时自动下载） |
| `config.yaml` | 喂给内核的配置 |
| `providers/rules/` | rule-provider 规则文件 |
| `settings.json` | 上面那份用户设置 |
| `core.pid` | 当前内核 PID（只用来杀自己启动的那个） |
| `lease.json` | 租约，记录「用到什么时候为止」 |
| `busy.json` | 忙锁，记录「哪条长命令正在用」（按 PID 判存活） |
| `core.log` | 内核日志 |

## HTTP 接口

全部只监听 **loopback**（`127.0.0.1` / `::1`），非本机请求返回 403。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-proxy/status` | 状态：内核是否在跑、PID、剩余秒数 |
| GET | `/dsh-proxy/settings` | 读设置 + 当前配置概况 |
| POST | `/dsh-proxy/settings` | 写设置 |
| POST | `/dsh-proxy/prepare` | 下载内核 + 准备配置 |
| POST | `/dsh-proxy/start` | 启动内核 |
| POST | `/dsh-proxy/stop` | 关闭内核 |
| POST | `/dsh-proxy/renew` | 续期空闲计时 |
| POST | `/dsh-proxy/config/from-subscription` | `{"url":"..."}` 拉订阅 |
| POST | `/dsh-proxy/config/import-flclash` | 从本机 FlClash 导入 |
| POST | `/dsh-proxy/config/manual` | `{"text":"..."}` 手动写配置 |
| GET | `/dsh-proxy/config/example` | 取一份模板 |
| POST | `/dsh-proxy/fetch` | `{"url":"https://..."}` 经代理抓一次 |

## 它是怎么做到的

### 空闲自动关：租约 + 守护

```
任何一次使用 ──renew()──> 写 lease.json { deadline: now + idleMs }
                              │
守护定时器（每 15s）───────────┘
   有命令正持忙锁？──是──> 绝不关（busy.json，按 PID 判定存活）
        │否
   deadline 到期？──否──> 继续睡
        │是
        └─> 内核是**我们**起的？──否──> 只删租约，不碰进程
                 │是
                 └─> 杀 core.pid 里的那个 PID，删 pid/lease/busy 文件
```

四个刻意的设计：

1. **只杀自己启动的 PID。** 状态文件里记着 `core.pid`，绝不按进程名扫杀 —— 否则会误杀用户自己开的 FlClash 或其他 mihomo。
2. **端口被占时不抢。** 如果 7890 已经被别的程序监听（比如用户开了 FlClash），插件不启动内核，只标记 `external` 后照常可用，也**不会**在空闲时去关那个不属于自己的进程。
3. **长命令期间持忙锁。** `dsh-proxy -- <命令>` 跑起来时会写 `busy.json`（内容是自己的 PID）并持续续租。只要锁在，`checkIdle()` 一律不动内核 —— 否则一条比 `idleMs` 更久的命令（比如 `npm install`、`git clone`）会在跑到一半时被自己的守护掐断，表现为 `ConnectionReset`。持有者进程若已消失，锁按 PID 自动失效，不会永久卡住。
4. **命令行守到最后。** 守护定时器是 `unref()` 的（不阻止 Node 退出）。所以 `dsh-proxy start` 与 `dsh-proxy -- <命令>` 都会一直守着，直到内核真的被自动关掉才返回 —— 否则命令一跑完就退出，没人执行「到期杀内核」那一步，内核会一直挂着，正是本插件要消灭的情况。

### 内核获取：自包含下载 + 解压

不引入任何第三方依赖：

- **下载**：`node:https` + 手动跟随 302（GitHub release 必跳一次到 `objects.githubusercontent.com`）
- **解压**：手写 zip 解析（EOCD 签名 `0x06054b50` → 中央目录 `0x02014b50` → 本地头 `0x04034b50`），method 0 直接取、method 8 走 `zlib.inflateRaw`

**镜像回退**是必需的：直连 `github.com` 的 release 下载在国内会**挂死**（TCP 连得上、请求发得出去、响应永远不来，实测 12 秒后 socket hang up），而不是快速失败。所以每个源都有 12 秒首字节超时，超时就换下一个：

```js
export const DEFAULT_MIRRORS = [
  '',                          // 直连
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://ghfast.top/',
];
```

实测：直连超时 12s → `gh-proxy.com` 7.8 秒下完 61MB 并解压成功。

### 配置路径：两个必踩的坑

**坑 1 — SAFE_PATHS 沙盒。** mihomo 只允许访问 `-d` 目录内的**相对路径**。FlClash 的配置里 rule-provider 写的是绝对路径，直接启动会：

```
Parse config error: path is not subpath of home directory or SAFE_PATHS:
C:\Users\<user>\AppData\Roaming\com.follow\clash\profiles\...\rules\59aaf94a...
allowed paths: [D:\path\to\plugins\dsh-proxy-on-demand\runtime]
```

修法：把规则文件拷进 `runtime/providers/rules/`，路径改写成 `providers/rules/<hash>`。

**坑 2 — YAML 里是双反斜杠。** 文件里写作 `C:\\Users\\暝\\...`。如果按**单**反斜杠写 `-replace`，会**静默不匹配** —— 而且此时再查「还剩几个单反斜杠」同样返回 0，造成「已经改好了」的假象。必须按字面的双反斜杠匹配：

```js
const SEP = '\\\\\\\\?';   // 一个或两个字面反斜杠都认
```

## 上游程序

本插件**不含**代理内核，只负责按需拉起和关掉它。真正的代理能力来自上游：

| | |
|---|---|
| 项目 | [mihomo](https://github.com/MetaCubeX/mihomo)（即 Clash.Meta 内核） |
| 版权 | © MetaCubeX 及 mihomo 贡献者 |
| 授权 | **GPL-3.0**（独立于本仓库的 MIT） |
| 本插件与它的关系 | 仅在其官方 GitHub Release 下载 `mihomo-windows-amd64` 二进制，**不修改、不重新打包、不静态链接**；以独立进程方式调用 |
| 实测版本 | `v1.19.32`（`Mihomo Meta v1.19.32 windows amd64 with go1.26.8`），约 61MB |
| 版本策略 | 默认取 `/releases/latest`；可用配置项 `kernelVersion` 固定版本 |

上游程序的许可证、行为与安全性由上游项目负责。若你要分发本插件，请注意
**下载** GPL-3.0 程序与**再分发**它是两回事：本仓库只做前者。

## 已知限制

- **Windows 优先。** 内核资产名目前写死 `mihomo-windows-amd64`。换平台需要改 `lib/index.js` 的 `prepareKernel()`。
- **首次要联网下内核**（约 61MB）。下好之后缓存在 `runtime/`，之后离线可用。
- **端口被占时不自启。** 这是刻意的：宁可复用别人已经开着的代理，也不去抢端口。
- **`settings.json` 与 `config.yaml` 分开存。** 换订阅不会丢你的开关和端口设置，但反过来，手动改 `config.yaml` 不会同步进界面显示的「节点数」以外的字段。
- **不接管系统代理。** 插件只提供本地 HTTP 代理端口，要不要设 `HTTP_PROXY` 是调用方的事。

## 实现说明

几个不那么显然的决定：

**界面不依赖 `settings` 服务。** 常规做法是宿主侧 `ctx.settings.installSection(ctx, NS, Config, defaults, hooks)`，其中 `Config` 是 `@deepseek-ai/schemastery` 的 `z.object({...})`。但 profile 侧经常解析不到 `schemastery`（本机就是：包里只有 `LICENSE`/`package.json`/`README.md`，**没有 `lib`**）。导出非 schema 对象会让 loader 投影 config 时报错。所以本插件的界面全部走自己的 HTTP 端点，宿主侧只读写 `settings.json`。

**不导出 Config schema。** 同上原因。

**统计放 `globalThis[Symbol.for(...)]`。** 热重载会重新执行模块顶层代码，普通模块级变量会归零；挂在 `globalThis` 上的 Symbol 键能跨重载累计。

**客户端半边不用打包。** `package.json` 里声明 `dsh.client = { platform: "web", inject: [...] }`，入口 `lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 形式，内部 `require("react")`，导出 `apply` / `inject` / `name`。

**注册到 `settings.section` slot。** 这个 slot 是「设置」侧栏里独立的一页（不是「设置 → 插件」里的一张卡片）：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'dsh-proxy-on-demand',
  order: 60,
  label: () => '按需代理',
  icon: 'settings',
}, Card));
```

**踩坑：`settings.plugin.item` 在本机 DSH 0.2.0-rc.2 里并不存在。** 这个 slot 名是从 `dsh-session-manager` 源码里抄来的，但用 `cordis_inspect_query(client/Slots/listSubTree {root:'settings.plugin.item'})` 实测返回 `{"requestedRoot":{"name":"settings.plugin.item","available":false}}` —— 该名字根本不在 slot 树里。更麻烦的是**注册到不存在的 slot 不会报错**，整块界面只是静默不渲染，`plugin_manager` 里插件的 `fiberPhase` 照样是 `active`。

用 `listSubTree {root:'settings.section'}` 才看到真实拓扑与 `occupants` 列表，确认自己的 id 有没有进去：

```json
{ "registrant": "dsh-proxy-on-demand-client", "id": "dsh-proxy-on-demand",
  "order": 60, "active": true }
```

本机 slot 树里与设置/插件相关的真实名字：`settings.section`（设置侧栏一页）、`settings.plugins.tab`（Plugins 设置区里的一页）、`settings.general.item`（General 区里的一行偏好）、`plugins.bundle.config`（keyed，key = 包名）、`plugins.row.config`（keyed，`<包名>#<行 id>`）、`plugins.detail.section`。写客户端界面时**先 `listSubTree` 确认，再注册**。

**HTTP 面注册后 pathname 仍带前缀。** `webServer.register({ kind: 'prefix', path: '/dsh-proxy', handler })` 之后，`url.pathname` 依然是 `/dsh-proxy/status`，需要自己剥：

```js
const path = url.pathname.replace(/^\/dsh-proxy(?=-|\/|$)/, '') || '/';
```

**https 目标必须先 CONNECT。** 把 https 请求直接打到明文代理端口会失败，报 `Client network socket disconnected before secure TLS connection was established` —— 这不是代理坏了，是用法错了。`lib/index.js` 的 `proxyGet()` 里手写了 CONNECT 隧道。

## 开发

```bash
node --check lib/index.js          # 语法检查
node test/client-render-test.mjs   # 客户端界面渲染（离线，18 项，不需要内核）
node test/dl-test.mjs              # 只测内核下载（快）
node test/busy-test.mjs            # 忙锁回归：命令比 idleMs 更久时内核必须活着
node test/selftest.mjs             # 端到端：导入配置 → 下内核 → 启动 → 出国 → 空闲自关
```

`test/client-render-test.mjs` 用一个最小 React 替身把 `lib/client.js` 的组件
在「数据未到位 / 数据到位 / 出错」三种状态下各渲染一遍，**不联网、不下内核**。
它抓的是两类静默失败：注册到不存在的 slot（宿主不报错，界面只是不出现）、
以及 `settings.json` 被手工改坏后渲染期抛异常（`subscriptionUrl: null` 会让
`subInput.trim()` 抛 `Cannot read properties of null`）。输入数据用的是宿主
`/dsh-proxy/status` 与 `/settings` 的实测返回形状。

`test/busy-test.mjs` 针对一个真实踩过的坑：`--idle 3` 配一条要跑 10 秒的命令，
修复前守护会在第 3 秒杀掉内核、命令最后一步报 `ConnectionReset`。现在 6 项全过
（命令拿到出口 IP、内核按策略自动关、忙锁已释放）。

`test/selftest.mjs` 用**本机真实的 FlClash 配置**跑全链路，14 项检查：

```
PASS  1  找到本机 FlClash 配置
PASS  2  识别出 rule-provider 绝对路径  (共 44 条，新拷 44)
PASS  2b 绝对路径已全部改为相对路径  (残留 0 处)
PASS  2c 相对路径已写入  (44/44)
PASS  2d 规则文件已拷贝到位
PASS  3  取到最新内核版本  (v1.19.32)
PASS  3b 内核下载并解压成功  (61MB)
PASS  4  内核启动成功  (pid=8524 564ms)
PASS  4b 端口已监听  (port=7891)
PASS  5  能连上代理端口
PASS  5b 走内核代理能出国（CONNECT 隧道）  (HTTP 200 ip=42.200.172.28)
PASS  6  内核 PID 已记录  (pid=8524)
PASS  6b 空闲后已自动关闭  (pid=8524 alive=false)
PASS  6c 租约文件已清理
RESULT: 14/14 passed
```

## 免责声明

**这是作者自用的工具，请自行评估风险后再用。**

- 本软件按「原样」（AS IS）提供，**不附带任何明示或默示的担保**，包括但不限于
  适销性、特定用途适用性与不侵权担保。
- 作者**不对**因使用或无法使用本软件而产生的任何直接、间接、偶然、特殊或
  后果性损害承担责任。
- **代理内核、节点与订阅的来源及合法性由使用者自行负责。** 本插件只是把
  [mihomo](https://github.com/MetaCubeX/mihomo) 拉起来又关掉，它不提供、
  不内置、不分发任何节点或订阅。
- 请遵守你所在地的法律法规，以及你所使用服务的使用条款。
- 内核来自上游官方 Release，作者不对上游二进制的行为或安全性作任何保证。

## License

本插件自身代码：[MIT](LICENSE)

其中下载并调用的上游内核 [mihomo](https://github.com/MetaCubeX/mihomo)
版权归 MetaCubeX 及贡献者所有，以 **GPL-3.0** 授权 —— 详见 [LICENSE](LICENSE) 末尾说明。
